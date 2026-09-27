// 게임 스크린샷 / 로그 감시 (원본 eft-where-am-i 의 FileSystemWatcher, LogWatcherService 이식)
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFile } = require('child_process');
const { EventEmitter } = require('events');

// 스크린샷 파일명 예: 2026-01-10[03-59]_-318.44, 24.84, -107.49_0.00000, 0.82497, 0.00000, 0.56518_3.98 (0).png
const POSITION_REGEX = /_(-?\d+(?:\.\d+)?), (-?\d+(?:\.\d+)?), (-?\d+(?:\.\d+)?)_(-?\d+(?:\.\d+)?), (-?\d+(?:\.\d+)?), (-?\d+(?:\.\d+)?), (-?\d+(?:\.\d+)?)/;

function parseScreenshotName(fileName) {
    const m = POSITION_REGEX.exec(fileName);
    if (!m) return null;
    const [x, y, z, rx, ry, rz, rw] = m.slice(1).map(Number);
    // TarkovMonitor 와 동일한 방식으로 쿼터니언 → 방향(도)
    const sinyCosp = 2 * (rw * ry + rx * rz);
    const cosyCosp = 1 - 2 * (rz * rz + ry * ry);
    const yaw = (Math.atan2(sinyCosp, cosyCosp) * 180) / Math.PI;
    return { position: { x, y, z }, rotation: yaw, file: fileName };
}

function getLatestScreenshot(dir) {
    if (!dir || !fs.existsSync(dir)) return null;
    let latest = null;
    for (const name of fs.readdirSync(dir)) {
        if (!name.toLowerCase().endsWith('.png')) continue;
        try {
            const stat = fs.statSync(path.join(dir, name));
            if (!latest || stat.mtimeMs > latest.mtime) latest = { name, mtime: stat.mtimeMs };
        } catch { /* 삭제 중인 파일 */ }
    }
    return latest ? latest.name : null;
}

class ScreenshotWatcher extends EventEmitter {
    constructor() {
        super();
        this.watcher = null;
        this.dir = null;
        this.seen = new Map();
    }

    start(dir) {
        this.stop();
        if (!dir || !fs.existsSync(dir)) return false;
        this.dir = dir;
        this.watcher = fs.watch(dir, (event, name) => {
            if (!name || !name.toLowerCase().endsWith('.png')) return;
            const now = Date.now();
            if (now - (this.seen.get(name) || 0) < 3000) return;
            // 오래된 기록은 지워서 스크린샷이 쌓여도 메모리가 늘지 않게 한다
            for (const [n, t] of this.seen) if (now - t >= 3000) this.seen.delete(n);
            this.seen.set(name, now);
            // 게임이 파일 쓰기를 마칠 때까지 잠시 대기
            setTimeout(() => {
                if (!fs.existsSync(path.join(dir, name))) return;
                const parsed = parseScreenshotName(name);
                if (parsed) this.emit('position', parsed);
            }, 500);
        });
        this.watcher.on('error', () => this.stop());
        return true;
    }

    stop() {
        if (this.watcher) this.watcher.close();
        this.watcher = null;
    }
}

const MAP_REGEX = /scene preset path:maps\/([^.]+)\.bundle/;
const TRANSIT_END_REGEX = /\[Transit\] `([a-f0-9]+)` Count:(\d+), EventPlayer:(True|False)/;

class LogWatcher extends EventEmitter {
    constructor() {
        super();
        this.timer = null;
        this.base = null;
        this.folder = null;
        this.file = null;
        this.position = 0;
        this.lastFolderCheck = 0;
    }

    start(base) {
        this.stop();
        if (!base || !fs.existsSync(base)) return false;
        this.base = base;
        this.findLatestFolder();
        this.timer = setInterval(() => this.tick(), 2000);
        return true;
    }

    stop() {
        if (this.timer) clearInterval(this.timer);
        this.timer = null;
        this.file = null;
        this.position = 0;
    }

    tick() {
        try {
            if (Date.now() - this.lastFolderCheck > 30000) {
                this.findLatestFolder();
                this.lastFolderCheck = Date.now();
            }
            if (this.folder) this.findLatestFile();
            this.readNew();
        } catch { /* 다음 폴링에서 재시도 */ }
    }

    findLatestFolder() {
        let latest = null;
        for (const d of fs.readdirSync(this.base, { withFileTypes: true })) {
            if (!d.isDirectory()) continue;
            const full = path.join(this.base, d.name);
            const t = fs.statSync(full).birthtimeMs;
            if (!latest || t > latest.t) latest = { full, t };
        }
        if (latest && latest.full !== this.folder) {
            this.folder = latest.full;
            this.file = null;
            this.findLatestFile();
        }
    }

    findLatestFile() {
        let latest = null;
        for (const name of fs.readdirSync(this.folder)) {
            if (!/application.*\.log$/i.test(name)) continue;
            const full = path.join(this.folder, name);
            const t = fs.statSync(full).mtimeMs;
            if (!latest || t > latest.t) latest = { full, t };
        }
        if (latest && latest.full !== this.file) {
            this.file = latest.full;
            // 새 파일은 끝에서부터 읽기 시작 (이전 기록 무시)
            this.position = fs.statSync(latest.full).size;
        }
    }

    readNew() {
        if (!this.file || !fs.existsSync(this.file)) return;
        const size = fs.statSync(this.file).size;
        if (size < this.position) this.position = 0;
        if (size === this.position) return;
        const fd = fs.openSync(this.file, 'r');
        try {
            const buf = Buffer.alloc(size - this.position);
            fs.readSync(fd, buf, 0, buf.length, this.position);
            this.position = size;
            for (const line of buf.toString('utf8').split(/\r?\n/)) {
                const m = MAP_REGEX.exec(line);
                if (m) {
                    this.emit('map', m[1]);
                    continue;
                }
                if (TRANSIT_END_REGEX.test(line)) this.emit('raid-ended');
            }
        } finally {
            fs.closeSync(fd);
        }
    }
}

// ---------- 경로 자동 탐지 ----------
function findScreenshotDir(documentsDir) {
    const candidates = [
        path.join(documentsDir, 'Escape from Tarkov', 'Screenshots'),
        path.join(documentsDir, 'Escape From Tarkov', 'Screenshots'),
        path.join(os.homedir(), 'OneDrive', 'Documents', 'Escape from Tarkov', 'Screenshots'),
        path.join(os.homedir(), 'OneDrive', '문서', 'Escape from Tarkov', 'Screenshots'),
        path.join(os.homedir(), 'Documents', 'Escape from Tarkov', 'Screenshots'),
    ];
    return candidates.find((p) => fs.existsSync(p)) || '';
}

function regQueryInstallLocation() {
    return new Promise((resolve) => {
        execFile('reg', ['query', 'HKLM\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\EscapeFromTarkov', '/v', 'InstallLocation'],
            { windowsHide: true }, (err, stdout) => {
                if (err) return resolve('');
                const m = /InstallLocation\s+REG_\w+\s+(.+)/.exec(stdout);
                resolve(m ? m[1].trim() : '');
            });
    });
}

async function findLogDir() {
    const candidates = [];
    const install = await regQueryInstallLocation();
    if (install) candidates.push(path.join(install, 'Logs'));
    candidates.push(
        'C:\\Battlestate Games\\EFT\\Logs',
        'C:\\Battlestate Games\\Escape from Tarkov\\Logs',
        path.join(process.env.LOCALAPPDATA || '', 'Battlestate Games', 'EFT', 'Logs'),
    );
    return candidates.find((p) => p && fs.existsSync(p)) || '';
}

function cleanupScreenshots(dir) {
    if (!dir || !fs.existsSync(dir)) return 0;
    let deleted = 0;
    for (const name of fs.readdirSync(dir)) {
        if (!name.toLowerCase().endsWith('.png')) continue;
        try {
            fs.unlinkSync(path.join(dir, name));
            deleted++;
        } catch { /* 사용 중 */ }
    }
    return deleted;
}

module.exports = {
    parseScreenshotName,
    getLatestScreenshot,
    ScreenshotWatcher,
    LogWatcher,
    findScreenshotDir,
    findLogDir,
    cleanupScreenshots,
};
