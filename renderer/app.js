/* global TarkovMap */
const $ = (sel) => document.querySelector(sel);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const QUEST_COLORS = ['#f2c94c', '#5bd46b', '#5ab8f2', '#f2994a', '#c38cf2', '#f25c7a', '#4de0c8', '#e0e04d', '#9aa6ff', '#ff8fd1'];
const TRADER_ORDER = ['prapor', 'therapist', 'fence', 'skier', 'peacekeeper', 'mechanic', 'ragman', 'jaeger', 'ref', 'lightkeeper', 'btr-driver'];
const LEVEL_NAMES = {
    '2nd Floor': '2층', '3rd Floor': '3층', '4th Floor': '4층', '5th Floor': '5층',
    'Underground': '지하', 'Tunnels': '터널', 'Bunkers': '벙커', 'Garage': '주차장',
    'Second Level': '2층', 'Technical': '기술층', 'Infirmary': '의무실', 'Helipad': '헬리패드',
    'Gym/Canteen': '체육관/식당', 'Accommodation (lower)': '숙소 (하층)', 'Accommodation (mid)': '숙소 (중층)',
    'Accommodation (upper)': '숙소 (상층)', "Officers' Deck": '장교 갑판', 'Stairs (blocked)': '계단 (막힘)',
    'Bridge': '함교', 'Bridge Roof': '함교 지붕', 'Control Room': '제어실', 'Engine Room': '기관실',
    'Engine Room (upper)': '기관실 (상층)', 'Fuel Pumps (lower)': '연료 펌프 (하층)', 'Fuel Pumps': '연료 펌프',
    'Storage/Security': '창고/보안실',
};
// 게임 로그 scene 이름 → 맵 키 (원본 LogWatcherService 매핑)
const LOG_MAP_NAMES = {
    woods_preset: 'woods', customs_preset: 'customs', bigmap: 'customs', shoreline_preset: 'shoreline',
    shopping_mall: 'interchange', rezerv_base_preset: 'reserve', rezervbase: 'reserve', lighthouse_preset: 'lighthouse',
    city_preset: 'streets-of-tarkov', tarkovstreets: 'streets-of-tarkov', factory_day_preset: 'factory',
    factory_night_preset: 'factory', factory4_day: 'factory', factory4_night: 'factory', sandbox_preset: 'ground-zero',
    sandbox_high_preset: 'ground-zero', sandbox: 'ground-zero', sandbox_high: 'ground-zero',
    laboratory_preset: 'the-lab', laboratory: 'the-lab', labyrinth_preset: 'the-labyrinth',
};

const state = {
    settings: null,
    data: null,
    taskIndex: new Map(),
    currentMap: null,
    tarkovMap: null,
    lastPosition: null,
    picker: { checked: new Set(), tab: 'normal' },
};

// ---------------- 공통 ----------------
let toastTimer = null;
function toast(text, level = 'info') {
    const el = $('#toast');
    el.textContent = text;
    el.className = `toast show ${level}`;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove('show'), 3500);
}

async function saveSettings(patch) {
    state.settings = await window.api.setSettings(patch);
}

function registeredIds(mapKey = state.currentMap?.key) {
    return state.settings.registered[mapKey] || [];
}

function taskById(id) {
    return state.taskIndex.get(id);
}

function isTaskOnMap(task, mapInfo, includeAnyMap) {
    if (task.mapIds.some((id) => mapInfo.apiIds.includes(id))) return true;
    return includeAnyMap && task.mapIds.length === 0;
}

// 이벤트 퀘스트 표시 (종료된 이벤트는 점선 배지)
function eventBadge(task) {
    const e = task.event;
    if (!e) return '';
    const title = `${e.name}${e.date ? ` · ${e.date}` : ''}${e.active ? ' · 진행 중' : ' · 종료된 이벤트'}`;
    return `<span class="badge ${e.active ? 'event' : 'ended'}" title="${esc(title)}">🎉 ${e.active ? '이벤트' : '종료 이벤트'}</span>`;
}

function traderRank(task) {
    const i = TRADER_ORDER.indexOf(task.trader.normalizedName || '');
    return i === -1 ? 99 : i;
}

// ---------------- 초기화 ----------------
async function init() {
    state.settings = await window.api.getSettings();
    applySidebarWidth(state.settings.sidebarWidth);
    $('#modeSelect').value = state.settings.gameMode;
    $('#quickAutoScreenshot').checked = state.settings.autoScreenshot;
    $('#toggleExtracts').checked = state.settings.showExtracts;

    state.tarkovMap = new TarkovMap($('#map'), {
        onLevelChange: renderLevelControl,
        levelName: (name) => LEVEL_NAMES[name] || name,
        onMouseCoord: ({ x, z }) => { $('#coordReadout').textContent = `X ${x.toFixed(1)}  Z ${z.toFixed(1)}`; },
    });

    bindUi();
    bindIpc();
    await loadData(false);
}

async function loadData(force) {
    $('#dataStatus').textContent = '데이터 불러오는 중…';
    try {
        state.data = JSON.parse(await window.api.loadData(state.settings.gameMode, force));
        const traderMap = Object.fromEntries(state.data.traders.map((t) => [t.id, t]));
        for (const t of state.data.tasks) t.trader.normalizedName = traderMap[t.trader.id]?.normalizedName;
        state.taskIndex = new Map(state.data.tasks.map((t) => [t.id, t]));
        const d = new Date(state.data.loadedAt);
        $('#dataStatus').textContent = `tarkov.dev ${state.data.mode === 'pve' ? 'PvE' : 'PvP'} · 퀘스트 ${state.data.tasks.length}개 · ${d.toLocaleString('ko-KR')}`;
        populateMapSelect();
        const key = state.data.maps.some((m) => m.key === state.settings.latestMap) ? state.settings.latestMap : state.data.maps[0].key;
        await selectMap(key);
        if (force) toast('데이터를 새로 받았습니다.');
    } catch (err) {
        $('#dataStatus').textContent = '데이터를 불러오지 못했습니다.';
        toast(`데이터 로드 실패: ${err.message}`, 'error');
    }
}

function populateMapSelect() {
    const sel = $('#mapSelect');
    sel.innerHTML = state.data.maps.map((m) => `<option value="${m.key}">${esc(m.name)}</option>`).join('');
}

async function selectMap(key) {
    const mapInfo = state.data.maps.find((m) => m.key === key);
    if (!mapInfo) return;
    state.currentMap = mapInfo;
    $('#mapSelect').value = key;
    if (state.settings.latestMap !== key) await saveSettings({ latestMap: key });
    renderQuestList();
    $('#mapLoading').classList.remove('hidden');
    try {
        await state.tarkovMap.setMap(mapInfo, state.settings.mapStyle);
    } catch (err) {
        toast(`지도 로드 실패: ${err.message}`, 'error');
    }
    $('#mapLoading').classList.add('hidden');
    renderStyleControl();
    state.tarkovMap.setExtracts(state.settings.showExtracts);
    refreshQuestMarkers();
    renderQuestList();
    if (state.lastPosition && state.lastPosition.mapKey === key) showPosition(state.lastPosition, false);
}

// ---------------- 지도 컨트롤 ----------------
function renderLevelControl(activeIndex) {
    const box = $('#levelControl');
    const layers = state.tarkovMap.layers;
    if (!layers.length) {
        box.innerHTML = '';
        return;
    }
    const baseActive = activeIndex === -1;
    box.innerHTML = '<div class="level-title">층</div>'
        + `<button class="level-btn ${baseActive ? 'active' : ''}" data-level="-1">1층</button>`
        + layers.map((l, i) => `<button class="level-btn ${i === activeIndex ? 'active' : ''}" data-level="${i}">${esc(LEVEL_NAMES[l.name] || l.name)}</button>`).join('');
}

function renderStyleControl() {
    const styles = state.tarkovMap.availableStyles();
    const box = $('#styleControl');
    if (styles.length < 2) {
        box.innerHTML = '';
        box.classList.add('hidden');
        return;
    }
    box.classList.remove('hidden');
    const label = { svg: '도면', tile: '위성' };
    box.innerHTML = styles.map((s) => `<button data-style="${s}" class="${s === state.tarkovMap.style ? 'active' : ''}">${label[s]}</button>`).join('');
}

function refreshQuestMarkers() {
    if (!state.tarkovMap.map) return;
    const completed = new Set(Object.keys(state.settings.completedObjectives || {}));
    const entries = registeredIds()
        .map((id, i) => ({ task: taskById(id), color: QUEST_COLORS[i % QUEST_COLORS.length], number: i + 1, completed }))
        .filter((e) => e.task);
    state.tarkovMap.setQuestMarkers(entries);
}

// ---------------- 등록된 퀘스트 목록 (왼쪽 UI) ----------------
function renderQuestList() {
    const list = $('#questList');
    const ids = registeredIds();
    const tasks = ids.map(taskById).filter(Boolean);
    $('#registeredCount').textContent = tasks.length;
    $('#btnClearAll').classList.toggle('hidden', tasks.length === 0);
    if (!tasks.length) {
        list.innerHTML = `<div class="empty">이 맵에 등록된 퀘스트가 없습니다.<br><b>＋ 퀘스트 등록</b>을 눌러 원하는 퀘스트를<br>여러 개 체크해서 등록하세요.</div>`;
        return;
    }
    const done = state.settings.completedObjectives || {};
    const collapsed = state.settings.collapsedTasks || {};
    const mapInfo = state.currentMap;
    list.innerHTML = tasks.map((task, i) => {
        const color = QUEST_COLORS[i % QUEST_COLORS.length];
        const total = task.objectives.length;
        const doneCount = task.objectives.filter((o) => done[o.id]).length;
        const objectives = task.objectives.map((o) => {
            const otherMap = o.maps.length > 0 && !o.maps.some((m) => mapInfo.apiIds.includes(m));
            const tags = [];
            if (o.optional) tags.push('<span class="obj-tag">(선택)</span>');
            if (o.count > 1) tags.push(`<span class="obj-tag">×${o.count}</span>`);
            if (o.questItem) tags.push(`<span class="obj-tag item">📦 ${esc(o.questItem.name)}</span>`);
            if (otherMap) tags.push('<span class="obj-tag">(다른 맵)</span>');
            const locate = state.tarkovMap.hasTarget(o.id)
                ? `<button class="locate-btn" data-locate="${o.id}" title="지도에서 보기">📍</button>` : '';
            return `<li class="objective ${done[o.id] ? 'done' : ''} ${otherMap ? 'other-map' : ''}">
                <input type="checkbox" data-obj="${o.id}" ${done[o.id] ? 'checked' : ''} title="완료 표시">
                <span class="obj-text">${esc(o.description)}<span class="obj-tags">${tags.join('')}</span></span>
                ${locate}
            </li>`;
        }).join('');
        const badges = [
            `<span class="badge progress ${doneCount === total ? 'all' : ''}">${doneCount}/${total}</span>`,
            task.minPlayerLevel ? `<span class="badge">Lv.${task.minPlayerLevel}</span>` : '',
            task.kappaRequired ? '<span class="badge kappa">카파</span>' : '',
            task.lightkeeperRequired ? '<span class="badge lk">등대지기</span>' : '',
            eventBadge(task),
        ].join('');
        const extra = task.requires.length ? `<div class="quest-extra">선행 퀘스트: ${task.requires.map(esc).join(', ')}</div>` : '';
        return `<div class="quest-card ${collapsed[task.id] ? 'collapsed' : ''}" style="--qc:${color}" data-task="${task.id}">
            <div class="quest-head" data-toggle="${task.id}">
                <span class="quest-num">${i + 1}</span>
                <div class="quest-title">
                    <div class="quest-name">${esc(taskTitle(task))}</div>
                    <div class="quest-meta">${task.trader.image ? `<img src="${esc(task.trader.image)}" alt="">` : ''}${esc(task.trader.name)} ${badges}</div>
                </div>
                <div class="quest-btns">
                    <button class="mini-btn" data-up="${task.id}" title="위로">▲</button>
                    <button class="mini-btn" data-wiki="${task.id}" title="상세 정보 보기 (tarkov.dev / 위키)">🔗</button>
                    <button class="mini-btn danger" data-remove="${task.id}" title="등록 해제">✕</button>
                </div>
            </div>
            <ul class="objectives">${objectives}</ul>
            ${extra}
        </div>`;
    }).join('');
}

async function setRegistered(ids) {
    const registered = { ...state.settings.registered, [state.currentMap.key]: ids };
    await saveSettings({ registered });
    refreshQuestMarkers();
    renderQuestList();
}

function bindQuestList() {
    $('#questList').addEventListener('click', async (e) => {
        const t = e.target.closest('button, input, [data-toggle]');
        if (!t) return;
        if (t.dataset.obj) {
            const completedObjectives = { ...state.settings.completedObjectives };
            if (t.checked) completedObjectives[t.dataset.obj] = true;
            else delete completedObjectives[t.dataset.obj];
            await saveSettings({ completedObjectives });
            refreshQuestMarkers();
            renderQuestList();
        } else if (t.dataset.locate) {
            state.tarkovMap.focusObjective(t.dataset.locate);
        } else if (t.dataset.remove) {
            await setRegistered(registeredIds().filter((id) => id !== t.dataset.remove));
        } else if (t.dataset.up) {
            const ids = [...registeredIds()];
            const i = ids.indexOf(t.dataset.up);
            if (i > 0) {
                [ids[i - 1], ids[i]] = [ids[i], ids[i - 1]];
                await setRegistered(ids);
            }
        } else if (t.dataset.wiki) {
            const task = taskById(t.dataset.wiki);
            window.api.openExternal(task.link || `https://tarkov.dev/task/${task.normalizedName}`);
        } else if (t.dataset.toggle) {
            const collapsedTasks = { ...state.settings.collapsedTasks };
            if (collapsedTasks[t.dataset.toggle]) delete collapsedTasks[t.dataset.toggle];
            else collapsedTasks[t.dataset.toggle] = true;
            await saveSettings({ collapsedTasks });
            renderQuestList();
        }
    });
}

// ---------------- 퀘스트 등록 모달 (다중 체크) ----------------
function openPicker() {
    if (!state.data) return;
    state.picker.checked = new Set(registeredIds());
    $('#pickerMapName').textContent = state.currentMap.name;
    const traders = [...new Map(state.data.tasks.map((t) => [t.trader.id, t])).values()]
        .sort((a, b) => traderRank(a) - traderRank(b))
        .map((t) => t.trader);
    $('#pickerTrader').innerHTML = '<option value="">전체 상인</option>'
        + traders.map((t) => `<option value="${t.id}">${esc(t.name)}</option>`).join('');
    $('#pickerSearch').value = '';
    // 이벤트 목록 (진행 중 먼저, 최근 이벤트 순)
    const events = [...new Map(state.data.tasks.filter((t) => t.event).map((t) => [eventKey(t.event), t.event])).values()].sort(compareEvents);
    const prevEvent = $('#pickerEvent').value;
    $('#pickerEvent').innerHTML = '<option value="">전체 이벤트</option>'
        + events.map((e) => `<option value="${esc(eventKey(e))}">${esc(e.name)}${e.active ? ' (진행 중)' : ''}</option>`).join('');
    if (events.some((e) => eventKey(e) === prevEvent)) $('#pickerEvent').value = prevEvent;
    const activeCount = state.data.tasks.filter((t) => t.event?.active).length;
    $('#pickerEventActive').textContent = activeCount ? `진행 중 ${activeCount}` : '';
    setPickerTab(state.picker.tab);
    $('#pickerModal').classList.remove('hidden');
    renderPicker();
    $('#pickerSearch').focus();
}

// 이벤트 퀘스트는 일반 퀘스트와 따로 (탭으로 구분)
const eventKey = (e) => `${e.enName}|${e.date}`;
const eventTime = (e) => Date.parse(e.date) || 0;
const compareEvents = (a, b) => (b.active - a.active) || (eventTime(b) - eventTime(a));

function setPickerTab(tab) {
    state.picker.tab = tab;
    $('#pickerModal .picker').classList.toggle('event-tab', tab === 'event');
    document.querySelectorAll('[data-picker-tab]').forEach((b) => b.classList.toggle('active', b.dataset.pickerTab === tab));
}

function pickerVisibleTasks() {
    const q = $('#pickerSearch').value.trim().toLowerCase();
    const trader = $('#pickerTrader').value;
    const eventTab = state.picker.tab === 'event';
    const kappa = !eventTab && $('#pickerKappa').checked;
    const anyMap = $('#pickerAnyMap').checked;
    const eventFilter = $('#pickerEvent').value;
    const ended = $('#pickerEnded').checked;
    const tasks = state.data.tasks
        .filter((t) => (eventTab ? !!t.event : !t.event))
        .filter((t) => !eventTab || ((ended || t.event.active) && (!eventFilter || eventKey(t.event) === eventFilter)))
        .filter((t) => isTaskOnMap(t, state.currentMap, anyMap))
        .filter((t) => !trader || t.trader.id === trader)
        .filter((t) => !kappa || t.kappaRequired)
        .filter((t) => !q || t.name.toLowerCase().includes(q) || (t.enName || '').toLowerCase().includes(q) || t.objectives.some((o) => o.description.toLowerCase().includes(q)))
        .sort((a, b) => traderRank(a) - traderRank(b) || a.minPlayerLevel - b.minPlayerLevel || a.name.localeCompare(b.name, 'ko'));
    // 이벤트 탭은 이벤트별로 묶는다 (같은 이벤트 안에서는 상인 순, sort 는 안정 정렬)
    return eventTab ? tasks.sort((a, b) => compareEvents(a.event, b.event) || eventKey(a.event).localeCompare(eventKey(b.event))) : tasks;
}

function renderPicker() {
    const tasks = pickerVisibleTasks();
    const checked = state.picker.checked;
    let html = '';
    let lastTrader = null;
    let lastEvent = null;
    for (const t of tasks) {
        if (t.event && eventKey(t.event) !== lastEvent) {
            lastEvent = eventKey(t.event);
            lastTrader = null;
            const e = t.event;
            html += `<div class="picker-event-head">🎉 ${esc(e.name)}${e.enName && e.enName !== e.name ? ` <span class="muted">(${esc(e.enName)})</span>` : ''}`
                + `<span class="badge ${e.active ? 'event' : 'ended'}">${e.active ? '진행 중' : '종료'}</span>${e.date ? `<span class="muted">${esc(e.date)}</span>` : ''}</div>`;
        }
        if (t.trader.id !== lastTrader) {
            lastTrader = t.trader.id;
            html += `<div class="picker-trader-head">${t.trader.image ? `<img src="${esc(t.trader.image)}" alt="">` : ''}${esc(t.trader.name)}</div>`;
        }
        const objs = t.objectives.slice(0, 4).map((o) => `<li>${esc(o.description)}</li>`).join('')
            + (t.objectives.length > 4 ? `<li class="muted">외 ${t.objectives.length - 4}개</li>` : '');
        html += `<label class="picker-item ${checked.has(t.id) ? 'checked' : ''}">
            <input type="checkbox" data-pick-task="${t.id}" ${checked.has(t.id) ? 'checked' : ''}>
            <div>
                <div class="p-name">${esc(taskTitle(t))}</div>
                <div class="p-meta">${t.minPlayerLevel ? `<span class="badge">Lv.${t.minPlayerLevel}</span>` : ''}${t.kappaRequired ? '<span class="badge kappa">카파</span>' : ''}${t.lightkeeperRequired ? '<span class="badge lk">등대지기</span>' : ''}${t.mapIds.length === 0 ? '<span class="badge">맵 무관</span>' : ''}${eventBadge(t)}</div>
                <ul class="p-obj">${objs}</ul>
            </div>
        </label>`;
    }
    const emptyHint = state.picker.tab === 'event' && !$('#pickerEnded').checked
        ? '<br><span class="muted small">종료된 이벤트의 퀘스트를 보려면 "종료된 이벤트 포함"을 켜세요.</span>' : '';
    $('#pickerList').innerHTML = html || `<div class="empty">조건에 맞는 퀘스트가 없습니다.${emptyHint}</div>`;
    $('#pickerVisibleCount').textContent = `${tasks.length}개 표시 중`;
    updatePickerCount();
}

function updatePickerCount() {
    const before = new Set(registeredIds());
    const now = state.picker.checked;
    const added = [...now].filter((id) => !before.has(id)).length;
    const removed = [...before].filter((id) => !now.has(id)).length;
    $('#pickerSelectedCount').textContent = `선택 ${now.size}개` + (added ? ` · 추가 ${added}` : '') + (removed ? ` · 해제 ${removed}` : '');
    $('#pickerApply').textContent = `등록 (${now.size}개)`;
}

async function applyPicker() {
    const now = state.picker.checked;
    const keep = registeredIds().filter((id) => now.has(id));
    const added = [...now].filter((id) => !keep.includes(id));
    await setRegistered([...keep, ...added]);
    closeModals();
    if (added.length) toast(`퀘스트 ${added.length}개를 등록했습니다.`);
}

function bindPicker() {
    $('#btnOpenPicker').addEventListener('click', openPicker);
    ['#pickerSearch', '#pickerTrader', '#pickerKappa', '#pickerAnyMap', '#pickerEvent', '#pickerEnded'].forEach((s) =>
        $(s).addEventListener('input', renderPicker));
    document.querySelectorAll('[data-picker-tab]').forEach((b) => b.addEventListener('click', () => {
        setPickerTab(b.dataset.pickerTab);
        renderPicker();
    }));
    $('#pickerList').addEventListener('change', (e) => {
        const id = e.target.dataset.pickTask;
        if (!id) return;
        if (e.target.checked) state.picker.checked.add(id);
        else state.picker.checked.delete(id);
        e.target.closest('.picker-item').classList.toggle('checked', e.target.checked);
        updatePickerCount();
    });
    $('#pickerSelectVisible').addEventListener('click', () => {
        pickerVisibleTasks().forEach((t) => state.picker.checked.add(t.id));
        renderPicker();
    });
    $('#pickerClearVisible').addEventListener('click', () => {
        pickerVisibleTasks().forEach((t) => state.picker.checked.delete(t.id));
        renderPicker();
    });
    $('#pickerApply').addEventListener('click', applyPicker);
}

// ---------------- 설정 모달 ----------------
function openSettings() {
    const s = state.settings;
    $('#setScreenshotPath').value = s.screenshotPath || '';
    $('#setLogPath').value = s.logPath || '';
    document.querySelectorAll('[data-setting]').forEach((el) => {
        const v = s[el.dataset.setting];
        if (el.type === 'checkbox') el.checked = !!v;
        else el.value = v;
    });
    $('#deadZoneValue').textContent = `${s.deadZonePercent}%`;
    $('#settingsModal').classList.remove('hidden');
}

function bindSettings() {
    $('#btnSettings').addEventListener('click', openSettings);
    document.querySelectorAll('[data-setting]').forEach((el) => {
        el.addEventListener('input', async () => {
            const key = el.dataset.setting;
            const value = el.type === 'checkbox' ? el.checked : Number(el.value);
            if (key === 'deadZonePercent') $('#deadZoneValue').textContent = `${value}%`;
            await saveSettings({ [key]: value });
            if (key === 'autoScreenshot') $('#quickAutoScreenshot').checked = value;
        });
    });
    document.querySelectorAll('[data-pick]').forEach((btn) => {
        btn.addEventListener('click', async () => {
            const key = btn.dataset.pick;
            const dir = await window.api.pickFolder(state.settings[key]);
            if (!dir) return;
            await saveSettings({ [key]: dir });
            openSettings();
        });
    });
    $('#btnDetectPaths').addEventListener('click', async () => {
        const found = await window.api.detectPaths();
        const patch = {};
        if (found.screenshotPath) patch.screenshotPath = found.screenshotPath;
        if (found.logPath) patch.logPath = found.logPath;
        await saveSettings(patch);
        openSettings();
        toast(Object.keys(patch).length ? '경로를 찾았습니다.' : '경로를 찾지 못했습니다. 직접 지정해주세요.', Object.keys(patch).length ? 'info' : 'warn');
    });
    $('#btnRefreshData').addEventListener('click', async () => {
        closeModals();
        await loadData(true);
    });
}

function closeModals() {
    document.querySelectorAll('.modal').forEach((m) => m.classList.add('hidden'));
}

// ---------------- 위치 ----------------
function showPosition(p, announce = true) {
    state.lastPosition = { ...p, mapKey: state.currentMap.key };
    const s = state.settings;
    state.tarkovMap.setPlayer(p, { autoFloor: s.autoFloor, autoPan: s.autoPan, deadZonePercent: s.deadZonePercent });
    const { x, y, z } = p.position;
    const time = new Date().toLocaleTimeString('ko-KR');
    $('#locationStatus').innerHTML = `<b>${esc(state.currentMap.name)}</b> · X ${x.toFixed(1)} / Z ${z.toFixed(1)} / 높이 ${y.toFixed(1)} <span class="muted">(${time})</span>`;
    if (announce) toast('위치를 표시했습니다.');
}

function resolveLogMap(raw) {
    const r = raw.toLowerCase();
    if (LOG_MAP_NAMES[r]) return LOG_MAP_NAMES[r];
    const stripped = r.replace(/_preset$/, '');
    const byNameId = state.data.maps.find((m) => m.nameIds.includes(stripped) || m.nameIds.includes(r));
    if (byNameId) return byNameId.key;
    const byKey = state.data.maps.find((m) => stripped.includes(m.key.replace(/^the-/, '')) || m.key.includes(stripped));
    return byKey ? byKey.key : null;
}

function bindIpc() {
    window.api.on('position', (p) => {
        if (!state.currentMap) return;
        showPosition(p);
    });
    window.api.on('map-detected', async (raw) => {
        if (!state.data) return;
        const key = resolveLogMap(raw);
        if (!key) return;
        if (key !== state.currentMap?.key) {
            state.tarkovMap.clearPlayer();
            state.lastPosition = null;
            await selectMap(key);
            toast(`레이드 감지: ${state.currentMap.name}(으)로 전환했습니다.`);
        }
    });
    window.api.on('status', ({ level, text }) => toast(text, level));
}

// ---------------- UI 바인딩 ----------------
function applySidebarWidth(w) {
    $('#sidebar').style.width = `${w}px`;
}

function bindUi() {
    bindQuestList();
    bindPicker();
    bindSettings();

    $('#mapSelect').addEventListener('change', (e) => {
        state.tarkovMap.clearPlayer();
        state.lastPosition = null;
        selectMap(e.target.value);
    });
    $('#modeSelect').addEventListener('change', async (e) => {
        await saveSettings({ gameMode: e.target.value });
        await loadData(false);
    });
    $('#btnLocate').addEventListener('click', async () => {
        const r = await window.api.latestLocation();
        if (r.error) {
            toast(r.error, 'warn');
            return;
        }
        showPosition(r);
    });
    $('#quickAutoScreenshot').addEventListener('change', (e) => saveSettings({ autoScreenshot: e.target.checked }));
    $('#toggleExtracts').addEventListener('change', async (e) => {
        await saveSettings({ showExtracts: e.target.checked });
        state.tarkovMap.setExtracts(e.target.checked);
    });
    $('#btnClearAll').addEventListener('click', async () => {
        if (confirm(`${state.currentMap.name}에 등록된 퀘스트를 모두 해제할까요?`)) await setRegistered([]);
    });
    $('#levelControl').addEventListener('click', (e) => {
        const b = e.target.closest('[data-level]');
        if (b) state.tarkovMap.setLevel(Number(b.dataset.level));
    });
    $('#styleControl').addEventListener('click', async (e) => {
        const b = e.target.closest('[data-style]');
        if (!b || b.dataset.style === state.tarkovMap.style) return;
        await saveSettings({ mapStyle: b.dataset.style });
        await selectMap(state.currentMap.key);
    });
    $('#btnToggleSidebar').addEventListener('click', () => {
        const app = $('#app');
        app.classList.toggle('collapsed');
        $('#btnToggleSidebar').textContent = app.classList.contains('collapsed') ? '⟩' : '⟨';
        setTimeout(() => state.tarkovMap.invalidate(), 50);
    });
    document.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', closeModals));
    document.querySelectorAll('.modal').forEach((m) => m.addEventListener('mousedown', (e) => {
        if (e.target === m) closeModals();
    }));
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') closeModals();
    });

    // 사이드바 너비 조절
    const resizer = $('#resizer');
    resizer.addEventListener('mousedown', (e) => {
        e.preventDefault();
        resizer.classList.add('dragging');
        const move = (ev) => {
            const w = Math.min(Math.max(ev.clientX, 280), 700);
            applySidebarWidth(w);
            state.tarkovMap.invalidate();
        };
        const up = (ev) => {
            resizer.classList.remove('dragging');
            window.removeEventListener('mousemove', move);
            window.removeEventListener('mouseup', up);
            saveSettings({ sidebarWidth: Math.min(Math.max(ev.clientX, 280), 700) });
        };
        window.addEventListener('mousemove', move);
        window.addEventListener('mouseup', up);
    });
    window.addEventListener('resize', () => state.tarkovMap.invalidate());
}

init();
