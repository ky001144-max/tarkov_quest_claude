/* global GameFiles */
// 웹(GitHub Pages) 버전의 window.api — 데스크톱 preload.js 와 같은 모양이라 renderer 코드를 그대로 쓴다
// - 설정: localStorage
// - 데이터: GitHub Actions 가 6시간마다 만들어 두는 data/{mode}.json
// - 스크린샷·로그 폴더: File System Access API (Chrome/Edge). 폴더를 연결하면 주기적으로 새 파일을 확인한다
//   지원하지 않는 브라우저는 "내 위치 확인" 때 스크린샷 파일을 직접 고른다
(function () {
    const SETTINGS_KEY = 'eft-where-am-i-ko:settings';
    const WIKI_API = 'https://escapefromtarkov.fandom.com/api.php';
    const PHOTOS_KEY = 'eft-where-am-i-ko:quest-photos';
    // 데스크톱 data.js 의 QUEST_PHOTOS_VERSION 과 같이 올린다
    const PHOTOS_VERSION = 3;
    const PHOTOS_MAX_AGE_MS = 3 * 24 * 3600 * 1000;
    const DEFAULT_SETTINGS = {
        gameMode: 'regular',
        latestMap: 'customs',
        screenshotPath: '',
        logPath: '',
        autoScreenshot: true,
        autoMap: true,
        autoFloor: true,
        autoPan: true,
        deadZonePercent: 70,
        autoCleanup: false,
        mapStyle: 'wiki',
        mapStyleVersion: 2,
        extractFilter: { pmc: true, scav: true, transit: true },
        sidebarWidth: 380,
        registered: {},
        completedObjectives: {},
        collapsedTasks: {},
        overlayFilter: { boss: false, memos: true },
        memos: {},
        hotkeys: null,
        panels: {},
    };
    const WATCHER_KEYS = ['screenshotPath', 'logPath', 'autoScreenshot', 'autoMap'];
    const SCREENSHOT_POLL_MS = 1000;
    const LOG_POLL_MS = 2000;
    const canPickFolder = typeof window.showDirectoryPicker === 'function';

    const listeners = {};
    let wikiIndex = null;
    const emit = (channel, payload) => (listeners[channel] || []).forEach((cb) => cb(payload));
    const status = (level, text) => emit('status', { level, text });

    let settings = { ...DEFAULT_SETTINGS };
    try {
        const raw = JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}');
        settings = { ...DEFAULT_SETTINGS, ...raw };
        // 예전 탈출구 켜기/끄기 하나 → 종류별 표시
        if (!raw.extractFilter && raw.showExtracts === false) settings.extractFilter = { pmc: false, scav: false, transit: false };
        // 위키 지도가 생기기 전 설정은 한 번만 위키 지도로 바꾼다
        if ((raw.mapStyleVersion || 1) < DEFAULT_SETTINGS.mapStyleVersion) {
            settings.mapStyle = DEFAULT_SETTINGS.mapStyle;
            settings.mapStyleVersion = DEFAULT_SETTINGS.mapStyleVersion;
        }
        delete settings.showExtracts;
    } catch { /* 기본값 사용 */ }
    const saveSettings = () => {
        try {
            localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
        } catch { /* 저장 불가 (시크릿 모드 등) */ }
    };

    // ---------- 폴더 핸들 (새로고침해도 다시 고르지 않도록 IndexedDB 에 보관) ----------
    const handles = { screenshotPath: null, logPath: null };
    function idb(mode, fn) {
        return new Promise((resolve, reject) => {
            const req = indexedDB.open('eft-where-am-i-ko', 1);
            req.onupgradeneeded = () => req.result.createObjectStore('handles');
            req.onerror = () => reject(req.error);
            req.onsuccess = () => {
                const tx = req.result.transaction('handles', mode);
                const r = fn(tx.objectStore('handles'));
                tx.oncomplete = () => resolve(r?.result);
                tx.onerror = () => reject(tx.error);
            };
        });
    }
    const ready = (async () => {
        if (!canPickFolder) return;
        for (const key of Object.keys(handles)) {
            try {
                handles[key] = (await idb('readonly', (s) => s.get(key))) || null;
            } catch { /* 보관된 핸들 없음 */ }
        }
    })();

    async function permitted(handle, request) {
        if (!handle) return false;
        const opts = { mode: 'read' };
        try {
            if ((await handle.queryPermission(opts)) === 'granted') return true;
            return request && (await handle.requestPermission(opts)) === 'granted';
        } catch {
            return false;
        }
    }

    async function pngFiles(dir) {
        const files = [];
        for await (const [name, h] of dir.entries()) {
            if (h.kind === 'file' && name.toLowerCase().endsWith('.png')) files.push({ name, handle: h });
        }
        return files;
    }

    // ---------- 스크린샷 감시 ----------
    const shots = { timer: null, seen: new Set(), primed: false, busy: false };
    async function pollScreenshots() {
        const dir = handles.screenshotPath;
        if (shots.busy || !(await permitted(dir, false))) return;
        shots.busy = true;
        try {
            const files = await pngFiles(dir);
            // 감시를 시작할 때 이미 있던 스크린샷은 건너뛴다
            if (!shots.primed) {
                files.forEach((f) => shots.seen.add(f.name));
                shots.primed = true;
                return;
            }
            for (const f of files) {
                if (shots.seen.has(f.name)) continue;
                shots.seen.add(f.name);
                const parsed = GameFiles.parseScreenshotName(f.name);
                if (parsed) emit('position', parsed);
            }
        } catch { /* 폴더가 바뀌거나 권한이 사라짐: 다음 확인 때 다시 */ } finally {
            shots.busy = false;
        }
    }

    // ---------- 게임 로그 감시 (자동 맵 전환) ----------
    const log = { timer: null, file: null, position: 0, primed: false, busy: false };
    async function pollLog() {
        const base = handles.logPath;
        if (log.busy || !(await permitted(base, false))) return;
        log.busy = true;
        try {
            // 로그 폴더 이름에 날짜·시간이 들어 있어 이름순 마지막이 가장 최근
            let folder = null;
            for await (const [name, h] of base.entries()) {
                if (h.kind === 'directory' && (!folder || name > folder.name)) folder = { name, handle: h };
            }
            if (!folder) return;
            let latest = null;
            for await (const [name, h] of folder.handle.entries()) {
                if (h.kind !== 'file' || !/application.*\.log$/i.test(name)) continue;
                const file = await h.getFile();
                if (!latest || file.lastModified > latest.file.lastModified) latest = { id: `${folder.name}/${name}`, file };
            }
            if (!latest) return;
            if (latest.id !== log.file) {
                // 감시 시작 때 있던 로그만 끝부터 읽고, 그 뒤에 생긴 로그는 처음부터 읽는다 (맵 로딩 줄을 놓치지 않도록)
                log.file = latest.id;
                log.position = log.primed ? 0 : latest.file.size;
            }
            log.primed = true;
            const size = latest.file.size;
            if (size < log.position) log.position = 0;
            if (size === log.position) return;
            const text = await latest.file.slice(log.position, size).text();
            log.position = size;
            for (const line of text.split(/\r?\n/)) {
                const m = GameFiles.MAP_REGEX.exec(line);
                if (m) {
                    if (settings.autoMap) emit('map-detected', m[1]);
                    continue;
                }
                if (GameFiles.TRANSIT_END_REGEX.test(line)) emit('raid-ended');
            }
        } catch { /* 다음 확인 때 다시 */ } finally {
            log.busy = false;
        }
    }

    async function applyWatchers() {
        clearInterval(shots.timer);
        clearInterval(log.timer);
        shots.timer = null;
        log.timer = null;
        if (settings.autoScreenshot && handles.screenshotPath) {
            shots.seen.clear();
            shots.primed = false;
            pollScreenshots();
            shots.timer = setInterval(pollScreenshots, SCREENSHOT_POLL_MS);
        }
        if (settings.autoMap && handles.logPath) {
            log.primed = false;
            log.file = null;
            pollLog();
            log.timer = setInterval(pollLog, LOG_POLL_MS);
        }
    }

    // 스크린샷 파일 하나를 직접 고르기 (폴더 연결을 지원하지 않는 브라우저)
    function pickScreenshotFile() {
        return new Promise((resolve) => {
            const input = document.createElement('input');
            input.type = 'file';
            input.accept = 'image/png';
            input.addEventListener('change', () => {
                const file = input.files?.[0];
                if (!file) return resolve({ error: '스크린샷 파일을 선택하지 않았습니다.' });
                resolve(GameFiles.parseScreenshotName(file.name) || { error: `좌표를 읽을 수 없는 파일명입니다: ${file.name}` });
            });
            input.addEventListener('cancel', () => resolve({ error: '스크린샷 파일을 선택하지 않았습니다.' }));
            input.click();
        });
    }

    async function connectFolder(key) {
        let handle;
        try {
            handle = await window.showDirectoryPicker({ id: key, mode: 'read', startIn: 'documents' });
        } catch {
            return null;
        }
        handles[key] = handle;
        try {
            await idb('readwrite', (s) => s.put(handle, key));
        } catch { /* 이번 세션에서만 사용 */ }
        return handle;
    }

    async function latestScreenshot(dir) {
        let latest = null;
        for (const f of await pngFiles(dir)) {
            const file = await f.handle.getFile();
            if (!latest || file.lastModified > latest.mtime) latest = { name: f.name, mtime: file.lastModified };
        }
        if (!latest) return { error: '스크린샷 폴더에 파일이 없습니다.' };
        return GameFiles.parseScreenshotName(latest.name) || { error: `좌표를 읽을 수 없는 파일명입니다: ${latest.name}` };
    }

    window.api = {
        getSettings: async () => {
            await ready;
            applyWatchers();
            if (canPickFolder && (handles.screenshotPath || handles.logPath)) {
                const ok = await permitted(handles.screenshotPath || handles.logPath, false);
                // 화면 쪽 알림 연결이 끝난 뒤에 보여준다
                if (!ok) setTimeout(() => status('info', '연결한 게임 폴더를 다시 쓰려면 "내 위치 확인"을 한 번 눌러 접근을 허용하세요.'), 1500);
            }
            return { ...settings };
        },
        setSettings: async (patch) => {
            const needWatchers = Object.keys(patch).some((k) => WATCHER_KEYS.includes(k));
            settings = { ...settings, ...patch };
            saveSettings();
            if (needWatchers) applyWatchers();
            return { ...settings };
        },
        loadData: async (mode, force = false) => {
            const res = await fetch(`data/${mode}.json${force ? `?t=${Date.now()}` : ''}`, { cache: force ? 'reload' : 'default' });
            if (!res.ok) throw new Error(`데이터 파일을 받지 못했습니다 (HTTP ${res.status})`);
            return res.text();
        },
        // 위키 지도 이미지는 사이트에 함께 넣어 둔 파일에서 (wiki-maps/index.json)
        getWikiImage: async (url) => {
            wikiIndex ||= fetch('wiki-maps/index.json').then((r) => (r.ok ? r.json() : {})).catch(() => ({}));
            const entry = (await wikiIndex)[url];
            if (!entry) throw new Error('위키 지도 이미지 없음');
            const res = await fetch(`wiki-maps/${entry.file}`);
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            return { data: await res.arrayBuffer(), type: entry.type };
        },
        // 위키 퀘스트 문서의 위치 사진 [{ url, caption, map }] (localStorage 에 며칠 저장)
        getQuestPhotos: async (title) => {
            if (!title || !window.WikiQuestPhotos) return [];
            const key = `${PHOTOS_KEY}:${title}`;
            let hit = null;
            try {
                hit = JSON.parse(localStorage.getItem(key) || 'null');
            } catch { /* 없음 */ }
            if (hit?.v === PHOTOS_VERSION && Date.now() - hit.at < PHOTOS_MAX_AGE_MS) return hit.photos;
            const fetchJson = async (url) => {
                const res = await fetch(`${url}&origin=*`);
                if (!res.ok) throw new Error(`HTTP ${res.status}`);
                return res.json();
            };
            try {
                const photos = await window.WikiQuestPhotos.fetchQuestPhotos(WIKI_API, title, fetchJson);
                try {
                    localStorage.setItem(key, JSON.stringify({ v: PHOTOS_VERSION, at: Date.now(), photos }));
                } catch { /* 저장 못 해도 그만 */ }
                return photos;
            } catch (err) {
                if (hit?.v === PHOTOS_VERSION) return hit.photos;
                throw err;
            }
        },
        getSvg: async (url) => {
            if (!/^https:\/\/assets\.tarkov\.dev\//.test(url)) throw new Error('허용되지 않은 SVG 주소');
            const res = await fetch(url);
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            return res.text();
        },
        // 웹에서는 경로 대신 폴더 이름을 돌려준다 (실제 접근은 보관한 폴더 핸들로)
        pickFolder: async (current, key) => {
            if (!canPickFolder) {
                status('warn', '이 브라우저는 폴더 연결을 지원하지 않습니다. Chrome이나 Edge에서 열어 주세요.');
                return null;
            }
            const handle = await connectFolder(key);
            return handle ? handle.name : null;
        },
        latestLocation: () => {
            // 파일 선택 창은 클릭 직후 바로 열어야 하므로 await 전에 분기한다
            if (!canPickFolder) return pickScreenshotFile();
            return (async () => {
                await ready;
                let dir = handles.screenshotPath;
                if (!dir) {
                    dir = await connectFolder('screenshotPath');
                    if (!dir) return { error: '스크린샷 폴더(문서\\Escape from Tarkov\\Screenshots)를 연결해 주세요.' };
                    settings = { ...settings, screenshotPath: dir.name };
                    saveSettings();
                } else if (!(await permitted(dir, true))) {
                    return { error: '스크린샷 폴더 접근이 허용되지 않았습니다.' };
                }
                // 같은 클릭으로 로그 폴더 접근도 다시 허용받는다
                if (handles.logPath) await permitted(handles.logPath, true);
                applyWatchers();
                return latestScreenshot(dir);
            })();
        },
        openExternal: async (url) => {
            if (/^https?:\/\//.test(url)) window.open(url, '_blank', 'noopener');
        },
        detectPaths: async () => ({ screenshotPath: '', logPath: '' }),
        on: (channel, cb) => {
            if (!['position', 'map-detected', 'raid-ended', 'status'].includes(channel)) return;
            (listeners[channel] ||= []).push(cb);
        },
    };
}());
