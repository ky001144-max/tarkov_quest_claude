const { app, BrowserWindow, ipcMain, dialog, shell, Menu, session } = require('electron');
const fs = require('fs');
const path = require('path');
const { DataService } = require('./src/data');
const {
    parseScreenshotName,
    getLatestScreenshot,
    ScreenshotWatcher,
    LogWatcher,
    findScreenshotDir,
    findLogDir,
    cleanupScreenshots,
} = require('./src/watchers');

const DEFAULT_SETTINGS = {
    gameMode: 'regular',            // regular(PvP) | pve
    latestMap: 'customs',
    screenshotPath: '',
    logPath: '',
    autoScreenshot: true,           // 스크린샷 자동 감지 → 위치 표시
    autoMap: true,                  // 로그 기반 자동 맵 전환
    autoFloor: true,                // 높이 기반 자동 층 전환
    autoPan: true,                  // 위치 마커 따라가기
    deadZonePercent: 70,
    autoCleanup: false,             // 레이드 종료 시 스크린샷 삭제
    mapStyle: 'wiki',               // wiki | svg | tile
    mapStyleVersion: 2,             // 2: 위키 지도를 기본으로 바꾼 버전
    extractFilter: { pmc: true, scav: true, transit: true },  // 탈출구 종류별 표시 (transit = 지역 이동 + Co-op)
    sidebarWidth: 380,
    registered: {},                 // { [mapKey]: [taskId, ...] }
    completedObjectives: {},        // { [objectiveId]: true }
    collapsedTasks: {},             // { [taskId]: true }
    hardwareAcceleration: false,    // GPU 가속 (끄면 메모리·GPU 사용량 감소, 재시작 후 적용)
    overlayFilter: { boss: false, memos: true },  // 보스·메모 표시
    memos: {},                      // { [mapKey]: [{ id, x, z, level, text }] }
    hotkeys: null,                  // { [동작]: 'Ctrl+PageUp' } (null 이면 기본 단축키)
    panels: {},                     // 지도 위쪽 패널 열림 { help, level, style, filter: false 면 닫힘 }
};

let mainWindow = null;
let settings = { ...DEFAULT_SETTINGS };
const settingsFile = () => path.join(app.getPath('userData'), 'settings.json');
const screenshotWatcher = new ScreenshotWatcher();
const logWatcher = new LogWatcher();
let dataService = null;

function loadSettings() {
    try {
        const raw = JSON.parse(fs.readFileSync(settingsFile(), 'utf8'));
        settings = { ...DEFAULT_SETTINGS, ...raw };
        // 예전 탈출구 켜기/끄기 하나 → 종류별 표시
        if (!raw.extractFilter && raw.showExtracts === false) settings.extractFilter = { pmc: false, scav: false, transit: false };
        delete settings.showExtracts;
        // 위키 지도가 생기기 전 설정은 한 번만 위키 지도로 바꾼다 (이후 고른 스타일은 유지)
        if ((raw.mapStyleVersion || 1) < DEFAULT_SETTINGS.mapStyleVersion) {
            settings.mapStyle = DEFAULT_SETTINGS.mapStyle;
            settings.mapStyleVersion = DEFAULT_SETTINGS.mapStyleVersion;
        }
    } catch {
        settings = { ...DEFAULT_SETTINGS };
    }
}

function saveSettings() {
    fs.mkdirSync(path.dirname(settingsFile()), { recursive: true });
    fs.writeFileSync(settingsFile(), JSON.stringify(settings, null, 2), 'utf8');
}

function send(channel, payload) {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, payload);
}

function applyWatchers() {
    if (settings.autoScreenshot) {
        const ok = screenshotWatcher.start(settings.screenshotPath);
        if (!ok) send('status', { level: 'warn', text: '스크린샷 폴더를 찾을 수 없습니다. 설정에서 경로를 지정하세요.' });
    } else {
        screenshotWatcher.stop();
    }
    if (settings.autoMap || settings.autoCleanup) {
        const ok = logWatcher.start(settings.logPath);
        if (!ok && settings.autoMap) send('status', { level: 'warn', text: '게임 로그 폴더를 찾을 수 없어 자동 맵 전환이 꺼져 있습니다.' });
    } else {
        logWatcher.stop();
    }
}

screenshotWatcher.on('position', (p) => send('position', p));
logWatcher.on('map', (raw) => {
    if (settings.autoMap) send('map-detected', raw);
});
logWatcher.on('raid-ended', () => {
    send('raid-ended');
    if (settings.autoCleanup) {
        setTimeout(() => {
            const n = cleanupScreenshots(settings.screenshotPath);
            if (n > 0) send('status', { level: 'info', text: `레이드 종료: 스크린샷 ${n}개 삭제` });
        }, 3000);
    }
});

function createWindow() {
    mainWindow = new BrowserWindow({
        width: 1500,
        height: 920,
        minWidth: 900,
        minHeight: 600,
        backgroundColor: '#15171a',
        title: 'EFT Where Am I KO',
        icon: path.join(__dirname, 'assets', 'icon.ico'),
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            contextIsolation: true,
            nodeIntegration: false,
            spellcheck: false,
            enableWebSQL: false,
            backgroundThrottling: true,
        },
    });
    Menu.setApplicationMenu(null);
    mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
    mainWindow.webContents.setWindowOpenHandler(({ url }) => {
        if (/^https?:\/\//.test(url)) shell.openExternal(url);
        return { action: 'deny' };
    });
    mainWindow.webContents.on('before-input-event', (e, input) => {
        if (input.type === 'keyDown' && input.key === 'F12') mainWindow.webContents.toggleDevTools();
        if (input.type === 'keyDown' && input.key === 'F5') mainWindow.webContents.reload();
    });
}

ipcMain.handle('settings:get', () => settings);
ipcMain.handle('settings:set', (e, patch) => {
    const watcherKeys = ['screenshotPath', 'logPath', 'autoScreenshot', 'autoMap', 'autoCleanup'];
    const needWatchers = Object.keys(patch).some((k) => watcherKeys.includes(k));
    settings = { ...settings, ...patch };
    saveSettings();
    if (needWatchers) applyWatchers();
    return settings;
});
ipcMain.handle('data:load', (e, { mode, force }) => dataService.load(mode, force));
ipcMain.handle('svg:get', (e, url) => dataService.getSvg(url));
ipcMain.handle('wikimap:get', (e, url) => dataService.getWikiImage(url));
ipcMain.handle('wikimap:drop', (e, url) => dataService.dropWikiImage(url));
ipcMain.handle('quest:photos', (e, title) => dataService.getQuestPhotos(title));
ipcMain.handle('wikiphoto:get', (e, url) => dataService.getWikiPhoto(url));
ipcMain.handle('dialog:folder', async (e, current) => {
    const r = await dialog.showOpenDialog(mainWindow, { properties: ['openDirectory'], defaultPath: current || undefined });
    return r.canceled ? null : r.filePaths[0];
});
ipcMain.handle('location:latest', () => {
    const name = getLatestScreenshot(settings.screenshotPath);
    if (!name) return { error: '스크린샷 폴더에 파일이 없습니다.' };
    const parsed = parseScreenshotName(name);
    if (!parsed) return { error: `좌표를 읽을 수 없는 파일명입니다: ${name}` };
    return parsed;
});
ipcMain.handle('shell:open', (e, url) => {
    if (/^https?:\/\//.test(url)) shell.openExternal(url);
});
ipcMain.handle('paths:detect', async () => {
    const screenshotPath = findScreenshotDir(app.getPath('documents'));
    const logPath = await findLogDir();
    return { screenshotPath, logPath };
});

loadSettings();
if (!settings.hardwareAcceleration) app.disableHardwareAcceleration();
// 메모리 절약: 미리 띄워 두는 여분 렌더러 프로세스·쓰지 않는 미디어/가림 감지 기능을 끈다
app.commandLine.appendSwitch('disable-features', 'SpareRendererForSitePerProcess,HardwareMediaKeyHandling,MediaSessionService,CalculateNativeWinOcclusion');
// 디스크 절약: 웹 캐시(지도 SVG·상인 이미지)는 20MB 까지만, GPU 셰이더 캐시는 디스크에 두지 않는다
const DISK_CACHE_BYTES = 20 * 1024 * 1024;
app.commandLine.appendSwitch('disk-cache-size', String(DISK_CACHE_BYTES));
app.commandLine.appendSwitch('disable-gpu-shader-disk-cache');
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
    app.quit();
} else {
    // 쓰지 않는 맞춤법 사전·GPU 캐시 폴더는 Chromium 이 뜨기 전에 지운다
    // (이미 실행 중인 창이 있으면 지우지 않고, 아직 닫히는 중이라 잠긴 파일이 있으면 다음 실행 때 지운다)
    for (const dir of ['Dictionaries', 'GPUCache', 'GrShaderCache', 'ShaderCache', 'GraphiteDawnCache', 'DawnGraphiteCache', 'DawnWebGPUCache', 'GPUPersistentCache']) {
        try {
            fs.rmSync(path.join(app.getPath('userData'), dir), { recursive: true, force: true });
        } catch { /* 다음 실행 때 */ }
    }

    app.on('second-instance', () => {
        if (mainWindow) {
            if (mainWindow.isMinimized()) mainWindow.restore();
            mainWindow.focus();
        }
    });

    app.whenReady().then(async () => {
        // 맞춤법 검사는 쓰지 않는다 (사전 다운로드 막기)
        session.defaultSession.setSpellCheckerEnabled(false);
        session.defaultSession.setSpellCheckerLanguages([]);
        // 제한을 두기 전에 쌓인 웹 캐시는 줄어들지 않아서, 제한보다 크면 비운다
        session.defaultSession.getCacheSize().then((n) => {
            if (n > DISK_CACHE_BYTES) session.defaultSession.clearCache();
        }).catch(() => {});
        dataService = new DataService(path.join(app.getPath('userData'), 'cache'), path.join(__dirname, 'assets', 'maps.json'));
        // 지난번에 타일로 잘라 둔 위키 지도 원본 이미지 정리 (타일이 없는 지도는 열 때 다시 받는다)
        dataService.dropWikiImage();
        if (!settings.screenshotPath || !fs.existsSync(settings.screenshotPath)) {
            settings.screenshotPath = findScreenshotDir(app.getPath('documents'));
        }
        if (!settings.logPath || !fs.existsSync(settings.logPath)) {
            settings.logPath = await findLogDir();
        }
        saveSettings();
        createWindow();
        mainWindow.webContents.once('did-finish-load', applyWatchers);
    });

    app.on('window-all-closed', () => {
        screenshotWatcher.stop();
        logWatcher.stop();
        app.quit();
    });
}
