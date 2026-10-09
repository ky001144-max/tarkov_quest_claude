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
    'Storage/Security': '창고/보안실', 'Parking': '주차장',
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

// 위키 지도 타일 만드는 진행률: 지도를 띄우기 전에는 가운데 카드, 띄운 뒤에는 아래쪽 작은 표시
function showTileProgress(ratio) {
    const pct = `${Math.round(ratio * 100)}%`;
    if (!$('#mapLoading').classList.contains('hidden')) setMapLoading(`위키 지도 준비 중 (처음 한 번) ${pct}`, ratio);
    $('#mapBuildingPct').textContent = pct;
    $('#mapBuilding').classList.toggle('hidden', ratio >= 1 || !$('#mapLoading').classList.contains('hidden'));
}

// 지도 불러오는 중 표시 (ratio 를 모르면 흐르는 막대)
function setMapLoading(text, ratio) {
    $('#mapLoadingText').textContent = text;
    $('#mapLoading').classList.toggle('indeterminate', ratio === undefined);
    $('#mapLoadingBar').style.width = ratio === undefined ? '' : `${Math.round(ratio * 100)}%`;
}

function renderExtractFilter() {
    const f = state.settings.extractFilter || {};
    document.querySelectorAll('#extractFilter [data-filter]').forEach((c) => { c.checked = f[c.dataset.filter] !== false; });
    const o = state.settings.overlayFilter || {};
    document.querySelectorAll('#extractFilter [data-overlay]').forEach((c) => { c.checked = !!o[c.dataset.overlay]; });
}

function renderModeSeg() {
    document.querySelectorAll('#modeSeg [data-mode]').forEach((b) => b.classList.toggle('active', b.dataset.mode === state.settings.gameMode));
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
    renderModeSeg();
    $('#quickAutoScreenshot').checked = state.settings.autoScreenshot;
    renderExtractFilter();
    renderHelpBar();
    renderPanels();

    state.tarkovMap = new TarkovMap($('#map'), {
        onLevelChange: renderLevelControl,
        levelName: (name) => LEVEL_NAMES[name] || name,
        onMouseCoord: ({ x, z }) => { $('#coordReadout').textContent = `X ${x.toFixed(1)}  Z ${z.toFixed(1)}`; },
        onLoadProgress: showTileProgress,
        onMapContextMenu: (p, latlng) => addMemo(p, latlng),
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
    // 다른 맵으로 바꾸면 이전 맵의 위치 표시를 지운다
    if (state.lastPosition?.mapKey !== key) $('#locationStatus').textContent = '스크린샷을 찍으면 위치가 표시됩니다.';
    if (state.settings.latestMap !== key) await saveSettings({ latestMap: key });
    renderQuestList();
    $('#levelControl').classList.remove('open');
    $('#mapBuilding').classList.add('hidden');
    setMapLoading('지도 불러오는 중…');
    $('#mapLoading').classList.remove('hidden');
    try {
        await state.tarkovMap.setMap(mapInfo, state.settings.mapStyle);
    } catch (err) {
        toast(`지도 로드 실패: ${err.message}`, 'error');
    }
    $('#mapLoading').classList.add('hidden');
    // 지도는 떴지만 고해상도 타일을 아직 만드는 중이면 아래쪽에 진행률을 보여 준다
    if (state.tarkovMap.wikiSource && state.tarkovMap.tileProgress < 1) showTileProgress(state.tarkovMap.tileProgress);
    renderStyleControl();
    state.tarkovMap.setExtracts(state.settings.extractFilter);
    state.tarkovMap.setBosses(!!state.settings.overlayFilter?.boss);
    renderBossList();
    renderMemos();
    refreshQuestMarkers();
    renderQuestList();
    if (state.lastPosition && state.lastPosition.mapKey === key) showPosition(state.lastPosition, false);
}

// ---------------- 지도 컨트롤 ----------------
// 층 버튼이 이보다 많으면 접는다
const LEVELS_COLLAPSE_OVER = 6;

function renderLevelControl(activeIndex) {
    const box = $('#levelControl');
    const layers = state.tarkovMap.layers;
    // 층이 없는 맵은 층 패널을 숨긴다
    $('#levelPanel').classList.toggle('hidden', !layers.length);
    if (!layers.length) {
        box.innerHTML = '';
        return;
    }
    const names = ['1층', ...layers.map((l) => LEVEL_NAMES[l.name] || l.name)];
    // 패널 머리에 지금 층을 보여 준다 (패널을 닫아 둬도 보이게)
    $('#levelCur').textContent = names[activeIndex + 1] || '1층';
    // 층이 많으면(Icebreaker) 현재 층만 보이고 펼쳐서 고른다
    const many = names.length > LEVELS_COLLAPSE_OVER;
    box.classList.toggle('many', many);
    box.innerHTML = names.map((n, k) => `<button class="level-btn ${k - 1 === activeIndex ? 'active' : ''}" data-level="${k - 1}">${esc(n)}</button>`).join('')
        + (many ? `<button class="lv-more" data-more>${box.classList.contains('open') ? '접기 ▴' : `전체 층 ${names.length}개 ▾`}</button>` : '');
    renderLocation();
}

const STYLE_LABELS = { wiki: '위키', svg: '도면' };

function renderStyleControl() {
    const styles = state.tarkovMap.availableStyles();
    const box = $('#styleControl');
    // 지도 종류가 하나뿐이면 패널을 숨긴다
    $('#stylePanel').classList.toggle('hidden', styles.length < 2);
    if (styles.length < 2) {
        box.innerHTML = '';
        return;
    }
    $('#styleCur').textContent = STYLE_LABELS[state.tarkovMap.style] || '';
    box.innerHTML = styles.map((s) => `<button data-style="${s}" class="${s === state.tarkovMap.style ? 'active' : ''}">${STYLE_LABELS[s]}</button>`).join('');
}

// 지도 위쪽 패널(도움말 · 층 · 지도 종류 · 마커 표시) 열림 상태 (기본: 모두 열림)
function renderPanels() {
    const open = state.settings.panels || {};
    document.querySelectorAll('#topBar .top-panel').forEach((p) => {
        const closed = open[p.dataset.panel] === false;
        p.classList.toggle('closed', closed);
        p.querySelector('.panel-head').setAttribute('aria-expanded', String(!closed));
    });
}

function refreshQuestMarkers() {
    if (!state.tarkovMap.map) return;
    const completed = new Set(Object.keys(state.settings.completedObjectives || {}));
    // 왼쪽 목록과 같은 번호·색을 쓰도록, 지금 데이터에 없는 퀘스트(모드 전환 등)를 먼저 빼고 번호를 매긴다
    const entries = registeredIds()
        .map(taskById)
        .filter(Boolean)
        .map((task, i) => ({ task, color: QUEST_COLORS[i % QUEST_COLORS.length], number: i + 1, completed }));
    state.tarkovMap.setQuestMarkers(entries);
}

// 그중 하나만 있으면 되는 아이템들 → "A 또는 B" (많으면 앞의 3개만)
function itemChoices(list) {
    const names = [...new Set(list.map((it) => it.name))];
    const head = names.slice(0, 3).join(' 또는 ');
    return names.length > 3 ? `${head} 외 ${names.length - 3}개` : head;
}

// 목표 위치(이 맵의 구역·후보 위치)가 있는 층 이름들 (층이 없는 맵이거나 위치를 모르면 빈 목록)
function objectiveFloors(o, mapInfo) {
    const t = state.tarkovMap;
    if (!t.map || t.mapInfo !== mapInfo || !t.layers.length) return [];
    const onMap = (id) => mapInfo.apiIds.includes(id);
    const spots = [
        ...o.zones.filter((z) => onMap(z.map) && z.position).map((z) => [z.position, z.top, z.bottom]),
        ...(o.locations || []).filter((l) => onMap(l.map)).flatMap((l) => l.positions.map((p) => [p])),
    ].filter(([p]) => typeof p.y === 'number' && t.containsPosition(p));
    return [...new Set(spots.map(([p, top, bottom]) => t.floorOf(p, top, bottom)).filter(Boolean))];
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
            for (const group of o.keys || []) tags.push(`<span class="obj-tag key" title="필요한 열쇠">🔑 ${esc(itemChoices(group))}</span>`);
            if (o.bring?.length) tags.push(`<span class="obj-tag bring" title="가져가야 하는 아이템">🎒 ${esc(itemChoices(o.bring))}</span>`);
            const floors = objectiveFloors(o, mapInfo);
            if (floors.length) tags.push(`<span class="obj-tag floor" title="목표 위치의 층">🏢 ${esc(floors.join(' · '))}</span>`);
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
        // 퀘스트 전체에 필요한 열쇠를 한눈에 (목표마다 붙은 열쇠를 모은 것)
        const keyNames = [...new Set(task.objectives.flatMap((o) => (o.keys || []).map(itemChoices)))];
        const extra = [
            keyNames.length ? `<div class="quest-extra">필요 열쇠: ${keyNames.map(esc).join(', ')}</div>` : '',
            task.requires.length ? `<div class="quest-extra">선행 퀘스트: ${task.requires.map(esc).join(', ')}</div>` : '',
        ].join('');
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
            <div class="q-progress ${doneCount === total ? 'all' : ''}"><i style="width:${total ? Math.round((doneCount / total) * 100) : 0}%"></i></div>
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
            // 지금 데이터에 없어 목록에 안 보이는 퀘스트는 건너뛰고 바로 위에 보이는 퀘스트와 바꾼다
            let j = i - 1;
            while (j >= 0 && !taskById(ids[j])) j--;
            if (j >= 0) {
                [ids[j], ids[i]] = [ids[i], ids[j]];
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
    state.hotkeyCapture = null;
    renderHotkeys();
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
            const dir = await window.api.pickFolder(state.settings[key], key);
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
    state.hotkeyCapture = null;
    document.querySelectorAll('.modal').forEach((m) => m.classList.add('hidden'));
}

// ---------------- 위치 ----------------
function showPosition(p, announce = true) {
    state.lastPosition = { ...p, mapKey: state.currentMap.key };
    const s = state.settings;
    state.tarkovMap.setPlayer(p, { autoFloor: s.autoFloor, autoPan: s.autoPan, deadZonePercent: s.deadZonePercent });
    state.lastPosition.time = new Date().toLocaleTimeString('ko-KR');
    renderLocation();
    // 스크린샷 파일 이름에는 맵 정보가 없어서, 다른 맵에서 찍은 스크린샷이면 엉뚱한 곳에 찍힌다
    if (state.tarkovMap.map && !state.tarkovMap.containsPosition(p.position)) {
        toast(`이 좌표는 ${state.currentMap.name} 지도 범위 밖입니다. 다른 맵에서 찍은 스크린샷인지, 맵 선택이 맞는지 확인하세요.`, 'warn');
    } else if (announce) toast('위치를 표시했습니다.');
}

// 위치 카드: 맵 · 층 · 좌표 칩 (지금 맵의 위치일 때만)
function renderLocation() {
    const p = state.lastPosition;
    if (!p || p.mapKey !== state.currentMap?.key || !p.time) return;
    const { x, y, z } = p.position;
    const t = state.tarkovMap;
    const layer = t.layers[t.levelIndex];
    const level = layer ? (LEVEL_NAMES[layer.name] || layer.name) : (t.layers.length ? '1층' : '');
    $('#locationStatus').innerHTML = `<div class="loc-chips"><span class="loc-chip map">${esc(state.currentMap.name)}</span>`
        + (level ? `<span class="loc-chip level">${esc(level)}</span>` : '')
        + `<span class="loc-chip"><b>X</b>${x.toFixed(1)}</span><span class="loc-chip"><b>Z</b>${z.toFixed(1)}</span>`
        + `<span class="loc-chip"><b>높이</b>${y.toFixed(1)}</span><span class="loc-time">${esc(p.time)}</span></div>`;
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

// 이 맵 보스와 출현 확률 (지도 라벨 대신 오른쪽 "보스" 아래에 보여 준다, 확률이 하나로 정해지지 않으면 "변동")
function renderBossList() {
    const box = $('#bossList');
    const show = $('#extractFilter [data-overlay="boss"]').checked;
    const bosses = state.currentMap?.bosses || [];
    box.classList.toggle('hidden', !show || !bosses.length);
    box.innerHTML = bosses.map((b) => `<div class="boss-row" title="${esc(b.enName)}"><span>${esc(b.name)}</span>`
        + `<b>${b.chance === null ? '<span class="muted" title="같은 보스가 여러 번 등록되어 확률이 하나로 정해지지 않음">변동</span>' : `${Math.round(b.chance * 100)}%`}</b></div>`).join('');
}

// ---------------- 내 메모 마커 (지도 우클릭) ----------------
function mapMemos(key = state.currentMap?.key) {
    return state.settings.memos?.[key] || [];
}

async function saveMemos(list) {
    await saveSettings({ memos: { ...state.settings.memos, [state.currentMap.key]: list } });
    renderMemos();
}

function renderMemos() {
    const show = state.settings.overlayFilter?.memos !== false;
    state.tarkovMap.setMemos(show ? mapMemos() : [], {
        onEdit: (memo) => state.tarkovMap.openMemoEditor(state.tarkovMap.latLngOf(memo), memo.text, (text) =>
            saveMemos(mapMemos().map((m) => (m.id === memo.id ? { ...m, text } : m)))),
        onDelete: (memo) => saveMemos(mapMemos().filter((m) => m.id !== memo.id)),
    });
}

function addMemo(p, latlng) {
    const t = state.tarkovMap;
    // 적은 층을 같이 저장해, 다른 층을 볼 때는 흐리게 층 이름을 붙인다
    const level = t.layers[t.levelIndex]?.name ?? null;
    t.openMemoEditor(latlng, '', async (text) => {
        await saveMemos([...mapMemos(), { id: Date.now().toString(36), x: +p.x.toFixed(1), z: +p.z.toFixed(1), level, text }]);
        if (state.settings.overlayFilter?.memos === false) toast('메모를 저장했습니다. 지도에 보이려면 오른쪽 "내 메모"를 켜세요.');
    });
}

// ---------------- 필요 아이템 모아보기 ----------------
function openItems() {
    if (!state.data || !state.currentMap) return;
    $('#itemsMapName').textContent = $('#itemsAllMaps').checked ? '모든 맵' : state.currentMap.name;
    renderItems();
    $('#itemsModal').classList.remove('hidden');
}

// 등록한 퀘스트의 (남은) 목표에 필요한 아이템 → { key | bring | quest: Map(이름 → [{ task, number, color, mapName }]) }
function collectNeededItems() {
    const includeDone = $('#itemsIncludeDone').checked;
    const allMaps = $('#itemsAllMaps').checked;
    const done = state.settings.completedObjectives || {};
    const groups = { key: new Map(), bring: new Map(), quest: new Map() };
    const mapKeys = allMaps ? state.data.maps.map((m) => m.key) : [state.currentMap.key];
    for (const mk of mapKeys) {
        const mapInfo = state.data.maps.find((m) => m.key === mk);
        registeredIds(mk).map(taskById).filter(Boolean).forEach((task, i) => {
            const who = { task, number: i + 1, color: QUEST_COLORS[i % QUEST_COLORS.length], mapName: mapInfo.name };
            for (const o of task.objectives) {
                if (!includeDone && done[o.id]) continue;
                // 다른 맵에서 하는 목표는 이 맵 레이드에 챙길 필요가 없다
                if (o.maps.length && !o.maps.some((m) => mapInfo.apiIds.includes(m))) continue;
                const add = (kind, name) => {
                    const list = groups[kind].get(name) || [];
                    if (!list.some((w) => w.task === task && w.mapName === who.mapName)) list.push(who);
                    groups[kind].set(name, list);
                };
                for (const g of o.keys || []) add('key', itemChoices(g));
                if (o.bring?.length) add('bring', itemChoices(o.bring));
                if (o.questItem) add('quest', o.questItem.name);
            }
        });
    }
    return groups;
}

function renderItems() {
    const allMaps = $('#itemsAllMaps').checked;
    $('#itemsMapName').textContent = allMaps ? '모든 맵' : state.currentMap.name;
    const groups = collectNeededItems();
    const sections = [
        ['key', '🔑 필요한 열쇠', '목표 장소에 들어가려면 필요'],
        ['bring', '🎒 가져갈 아이템', '설치·표시·사용할 아이템'],
        ['quest', '📦 찾을 퀘스트 아이템', '레이드에서 찾아 가지고 나올 아이템'],
    ];
    const chip = (w) => `<span class="q-chip" style="--qc:${w.color}" title="${esc(`${allMaps ? `[${w.mapName}] ` : ''}${taskTitle(w.task)}`)}">${allMaps ? `${esc(w.mapName)} ` : ''}${w.number}</span>`;
    const html = sections.map(([kind, title, note]) => {
        const rows = [...groups[kind]].sort((a, b) => a[0].localeCompare(b[0], 'ko'));
        if (!rows.length) return '';
        return `<div class="items-section"><div class="items-head">${title} <span class="count">${rows.length}</span><span class="muted small">${note}</span></div>`
            + rows.map(([name, who]) => `<div class="item-row"><span class="item-name">${esc(name)}</span><span class="item-quests">${who.map(chip).join('')}</span></div>`).join('')
            + '</div>';
    }).join('');
    $('#itemsList').innerHTML = html || '<div class="empty">챙길 아이템이 없습니다.<br><span class="muted small">퀘스트를 등록하거나 "완료한 목표 포함"을 켜 보세요.</span></div>';
}

// ---------------- 단축키 ----------------
// [동작, 설명, 기본 키]
const HOTKEY_ACTIONS = [
    ['levelUp', '위층으로', 'PageUp'],
    ['levelDown', '아래층으로', 'PageDown'],
    ['levelBase', '1층으로', 'Home'],
    ['centerPlayer', '내 위치로 지도 이동', 'C'],
    ['locate', '내 위치 확인 (최근 스크린샷)', 'L'],
    ['toggleSidebar', '왼쪽 패널 접기·펼치기', 'B'],
    ['items', '필요 아이템 보기', 'I'],
];

// 동작 → 키 ('' = 지정 안 함)
function hotkeyMap() {
    return { ...Object.fromEntries(HOTKEY_ACTIONS.map(([a, , k]) => [a, k])), ...(state.settings.hotkeys || {}) };
}

// 키 입력 → "Ctrl+Shift+K" (조합 키만 누른 동안은 null). 글자·숫자는 자판 배열과 관계없이 같은 이름
function comboOf(e) {
    if (['Control', 'Shift', 'Alt', 'Meta', 'Process', 'HangulMode'].includes(e.key)) return null;
    let key = e.key === ' ' ? 'Space' : e.key.length === 1 ? e.key.toUpperCase() : e.key;
    if (/^Key[A-Z]$/.test(e.code)) key = e.code.slice(3);
    else if (/^Digit\d$/.test(e.code)) key = e.code.slice(5);
    return [e.ctrlKey && 'Ctrl', e.altKey && 'Alt', e.shiftKey && 'Shift', key].filter(Boolean).join('+');
}

// 지도 위쪽 도움말 패널: 메모 사용법과 지금 단축키
function renderHelpBar() {
    const bar = $('#helpBar');
    const keys = hotkeyMap();
    const short = { levelUp: '위층', levelDown: '아래층', levelBase: '1층', centerPlayer: '내 위치로', locate: '위치 확인', toggleSidebar: '패널 접기', items: '필요 아이템' };
    const hotkeys = HOTKEY_ACTIONS.filter(([a]) => keys[a])
        .map(([a]) => `<span class="help-key"><kbd>${esc(keys[a])}</kbd>${esc(short[a])}</span>`).join('');
    bar.innerHTML = '<div class="help-line"><b>📌 메모</b><span>지도 <kbd>우클릭</kbd> → 입력 → <kbd>Enter</kbd> 저장 (<kbd>Shift+Enter</kbd> 줄바꿈)</span>'
        + '<span class="help-dim">핀을 누르면 수정·삭제</span></div>'
        + `<div class="help-line"><b>⌨ 단축키</b>${hotkeys || '<span class="help-dim">지정된 단축키 없음</span>'}`
        + '<span class="help-dim">설정 ⚙에서 변경</span></div>';
}

function renderHotkeys() {
    const keys = hotkeyMap();
    $('#hotkeyList').innerHTML = HOTKEY_ACTIONS.map(([action, label]) => {
        const capturing = state.hotkeyCapture === action;
        return `<div class="hotkey-row"><span>${esc(label)}</span><button class="hotkey-btn ${capturing ? 'capturing' : ''}" data-hotkey="${action}">${capturing ? '키를 누르세요…' : esc(keys[action] || '없음')}</button></div>`;
    }).join('');
}

function moveLevel(step) {
    const t = state.tarkovMap;
    if (!t.map || !t.layers.length) return;
    const order = t.levelsByHeight();
    let i = order.indexOf(t.levelIndex);
    // 기본 판과 같은 층 버튼만 목록에 있으면(Icebreaker) 기본 층은 그 버튼 자리
    if (i === -1) i = Math.max(0, order.indexOf(t.layers.findIndex((l) => l.show)));
    const next = order[i + step];
    if (next !== undefined) t.setLevel(next);
}

const HOTKEY_RUN = {
    levelUp: () => moveLevel(1),
    levelDown: () => moveLevel(-1),
    levelBase: () => state.tarkovMap.map && state.tarkovMap.setLevel(-1),
    centerPlayer: () => {
        if (state.tarkovMap.playerMarker) state.tarkovMap.centerOnPlayer();
        else toast('아직 표시된 내 위치가 없습니다.', 'warn');
    },
    locate: () => $('#btnLocate').click(),
    toggleSidebar: () => $('#btnToggleSidebar').click(),
    items: () => ($('#itemsModal').classList.contains('hidden') ? openItems() : closeModals()),
};

function onHotkey(e) {
    // 단축키 지정 중: 누른 키를 저장 (Esc 취소, Backspace·Delete 지우기)
    if (state.hotkeyCapture) {
        if (e.key === 'Escape') {
            e.preventDefault();
            e.stopPropagation();
            state.hotkeyCapture = null;
            renderHotkeys();
            return;
        }
        const combo = ['Backspace', 'Delete'].includes(e.key) ? '' : comboOf(e);
        if (combo === null) return;
        e.preventDefault();
        e.stopPropagation();
        const keys = hotkeyMap();
        // 같은 키를 쓰던 다른 동작은 비운다
        for (const a of Object.keys(keys)) if (combo && keys[a] === combo) keys[a] = '';
        keys[state.hotkeyCapture] = combo;
        state.hotkeyCapture = null;
        saveSettings({ hotkeys: keys }).then(() => {
            renderHotkeys();
            renderHelpBar();
        });
        return;
    }
    const el = e.target;
    if (el.closest?.('input, textarea, select, [contenteditable="true"]')) return;
    // 필요 아이템 창을 닫는 단축키 말고는 창이 열려 있는 동안 동작하지 않는다
    const modalOpen = [...document.querySelectorAll('.modal')].some((m) => !m.classList.contains('hidden'));
    const combo = comboOf(e);
    if (!combo) return;
    const action = Object.entries(hotkeyMap()).find(([, k]) => k && k === combo)?.[0];
    if (!action || (modalOpen && action !== 'items')) return;
    e.preventDefault();
    HOTKEY_RUN[action]();
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
    $('#modeSeg').addEventListener('click', async (e) => {
        const mode = e.target.closest('[data-mode]')?.dataset.mode;
        if (!mode || mode === state.settings.gameMode) return;
        await saveSettings({ gameMode: mode });
        renderModeSeg();
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
    $('#extractFilter').addEventListener('change', async (e) => {
        if (e.target.dataset.overlay) {
            const overlayFilter = Object.fromEntries([...document.querySelectorAll('#extractFilter [data-overlay]')].map((c) => [c.dataset.overlay, c.checked]));
            state.tarkovMap.setBosses(!!overlayFilter.boss);
            renderBossList();
            await saveSettings({ overlayFilter });
            renderMemos();
            return;
        }
        if (!e.target.dataset.filter) return;
        // 체크 상자 상태를 그대로 쓴다 (저장이 끝나기 전에 연달아 바꿔도 앞의 변경을 잃지 않게)
        const extractFilter = Object.fromEntries([...document.querySelectorAll('#extractFilter [data-filter]')].map((c) => [c.dataset.filter, c.checked]));
        state.tarkovMap.setExtracts(extractFilter);
        await saveSettings({ extractFilter });
    });
    $('#btnClearAll').addEventListener('click', async () => {
        if (confirm(`${state.currentMap.name}에 등록된 퀘스트를 모두 해제할까요?`)) await setRegistered([]);
    });
    $('#levelControl').addEventListener('click', (e) => {
        if (e.target.closest('[data-more]')) {
            $('#levelControl').classList.toggle('open');
            renderLevelControl(state.tarkovMap.levelIndex);
            return;
        }
        const b = e.target.closest('[data-level]');
        if (b) {
            $('#levelControl').classList.remove('open');
            state.tarkovMap.setLevel(Number(b.dataset.level));
        }
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
        if (e.key === 'Escape' && !state.hotkeyCapture) closeModals();
    });
    // 단축키 지정 중의 Esc 가 창을 닫지 않도록 먼저 받는다
    document.addEventListener('keydown', onHotkey, true);
    $('#btnItems').addEventListener('click', openItems);
    // 지도 위쪽 패널 열고 닫기 (상태 저장)
    $('#topBar').addEventListener('click', async (e) => {
        const head = e.target.closest('[data-panel-toggle]');
        if (!head) return;
        const key = head.dataset.panelToggle;
        const panels = { ...state.settings.panels };
        panels[key] = panels[key] === false;
        await saveSettings({ panels });
        renderPanels();
    });
    ['#itemsIncludeDone', '#itemsAllMaps'].forEach((s) => $(s).addEventListener('change', renderItems));
    $('#hotkeyList').addEventListener('click', (e) => {
        const b = e.target.closest('[data-hotkey]');
        if (!b) return;
        state.hotkeyCapture = state.hotkeyCapture === b.dataset.hotkey ? null : b.dataset.hotkey;
        renderHotkeys();
    });
    $('#btnHotkeyReset').addEventListener('click', async () => {
        state.hotkeyCapture = null;
        await saveSettings({ hotkeys: null });
        renderHotkeys();
        renderHelpBar();
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
