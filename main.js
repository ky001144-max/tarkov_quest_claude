const { app, BrowserWindow, ipcMain, dialog, shell, Menu } = require('electron');
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

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
    app.quit();
} else {
    app.on('second-instance', () => {
        if (mainWindow) {
            if (mainWindow.isMinimized()) mainWindow.restore();
            mainWindow.focus();
        }
    });

    app.whenReady().then(async () => {
        dataService = new DataService(path.join(app.getPath('userData'), 'cache'), path.join(__dirname, 'assets', 'maps.json'));
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
