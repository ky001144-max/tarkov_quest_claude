// 타르코프 위키(escapefromtarkov.fandom.com) 기준 탈출구·이동 지점
// 맵 문서의 Extractions / Transits 표를 탈출구 목록의 기준으로 삼는다.
// 위키 인터랙티브 지도(Map:*) 이미지를 같은 이름의 탈출구·스위치로 게임 좌표에 맞추고(변환이 정확한 맵에서만),
// 그 변환으로 위키 지도를 바탕 이미지로 쓰며 탈출구 좌표도 위키 마커 위치를 우선한다.

const WIKI_API = 'https://escapefromtarkov.fandom.com/api.php';

// tarkov.dev 맵 normalizedName → 위키 문서 제목
const WIKI_TITLES = {
    customs: 'Customs',
    factory: 'Factory',
    'ground-zero': 'Ground Zero',
    icebreaker: 'Icebreaker',
    interchange: 'Interchange',
    lighthouse: 'Lighthouse',
    reserve: 'Reserve',
    shoreline: 'Shoreline',
    'streets-of-tarkov': 'Streets of Tarkov',
    terminal: 'Terminal',
    'the-lab': 'The Lab',
    'the-labyrinth': 'The Labyrinth',
    woods: 'Woods',
};

// 위키 지도 좌표 → 게임 좌표 변환을 믿을 수 있는 기준 (미터)
const FIT_TOLERANCE = 20;
const FIT_MIN_INLIERS = 6;
// 이보다 멀리 떨어진 위키 마커는 지도 옆에 따로 그린 건물·지하 확대도 위에 있는 것으로 본다 (미터)
const MAX_WIKI_SHIFT = 60;

// 위키 지도 구성. 위키 좌표는 mapBounds 기준 왼쪽 아래 원점.
// panels: 한 이미지에 층·구역을 나눠 그린 지도의 판. 앞에서부터 영역이 맞는 판을 고르고, area 가 없는 판(기본 판)이 나머지 전체
//   area: 판이 그려진 위키 좌표 다각형
//   select: 이 판에 그릴 게임 좌표 { height: [아래, 위), bounds: [[x, z], [x, z]] }
//   shift: 기본 판과 같은 그림을 위키 좌표로 이만큼 옮겨 그린 판 (기본 판과 위치를 함께 맞춘다)
//   ignore: 확대도 등 게임 좌표에 맞추지 않는 영역
//   y: 위키 마커(높이 없음)를 놓을 높이
//   level: 이 판 그림을 보여 줄 tarkov.dev 층 이름 (층 버튼을 누르면 기본 판 자리에 겹쳐 그린다)
//   view: 기본 판에서 보여 줄 영역 (다른 판들은 층을 고를 때만 보인다)
//   층마다 축척·방향은 같고, shift 가 없는 판은 위치만 따로 맞춘다
// extraLayers: tarkov.dev 에 없는 층 버튼 (위키 지도에만 따로 그려진 층)
// scale: 이름이 같은 기준점이 모자랄 때 물체 배치로 처음 위치를 찾으며 볼 축척 범위 (m/px)
// seed: 맞출 기준점이 없는 지도에 미리 재어 둔 변환 { matrix, offset } (상자·스폰으로 다듬지 않는다)
// imageRect: 위키 이미지가 놓이는 위키 좌표 범위 [x1, y1, x2, y2] (없으면 mapBounds 전체 = [0, 0, 너비, 높이])
const rect = (x1, y1, x2, y2) => [[x1, y1], [x2, y1], [x2, y2], [x1, y2]];
const icebreakerDecks = () => {
    // 왼쪽부터 Bridge Roof(10) … Lower Automation(-3) 갑판을 544px 간격으로 그렸다. Infirmary(1)가 기본 판
    const decks = [
        [[43.8, 1e4], 'Bridge Roof'], [[40.7, 43.8], 'Bridge'], [[37.6, 40.7], 'Stairs (blocked)'], [[34.5, 37.6], "Officers' Deck"],
        [[31.4, 34.5], 'Accommodation (upper)'], [[28.3, 31.4], 'Accommodation (mid)'], [[25.3, 28.3], 'Accommodation (lower)'],
        [[22.2, 25.3], 'Gym/Canteen'], [[19.57, 22.2], 'Helipad'], null, [[15, 18.92], 'Storage/Security'],
        [[8.8, 15], ['Fuel Pumps', 'Fuel Pumps (lower)']], [[3.6, 8.8], ['Engine Room', 'Engine Room (upper)']], [[-1e4, 3.6], 'Control Room'],
    ];
    const base = 9;
    const center = (k) => 303 + 544 * k;
    const column = (k) => rect(center(k) - 272, 1500, center(k) + 272, 4320);
    return [
        // 아래쪽 배 옆모습·범례
        { area: rect(0, 0, 7680, 1500), ignore: true },
        ...decks.map((deck, k) => (k === base ? null : {
            area: column(k),
            shift: [544 * (k - base), 0],
            select: { height: deck[0] },
            level: deck[1],
            y: deck[0][0] < -1e3 ? 2 : deck[0][1] > 1e3 ? 45 : (deck[0][0] + deck[0][1]) / 2,
        })).filter(Boolean),
        { y: 19.2, level: 'Infirmary', view: column(base) },
    ];
};
const INTERCHANGE_MALL = [[120, 218], [-222, -327]];
const WIKI_LAYOUTS = {
    // 왼쪽 Technical Level(지하), 가운데 First Level(기본), 오른쪽 위 Second Level
    'the-lab': {
        panels: [
            { area: rect(0, 0, 1090, 2189), select: { height: [-1e4, -0.9] }, y: -3, level: 'Technical' },
            { area: rect(2460, 966, 3820, 2189), select: { height: [3, 1e4], bounds: [[-101, -422], [-271, -270]] }, y: 5.5, level: 'Second Level' },
            { y: 1, view: [[1090, 0], [3820, 0], [3820, 966], [2460, 966], [2460, 2189], [1090, 2189]] },
        ],
    },
    // 왼쪽부터 Top Floor · Middle Floor · Ground Floor(기본) · Tunnels 를 같은 간격으로
    factory: {
        scale: [0.03, 0.08],
        panels: [
            { area: rect(0, 0, 3255, 6656), shift: [-6512, 0], select: { height: [6, 1e4] }, y: 7, level: '3rd Floor' },
            { area: rect(3255, 0, 6515, 6656), shift: [-3256, 0], select: { height: [3, 6] }, y: 4, level: '2nd Floor' },
            { area: rect(9775, 0, 13440, 6656), shift: [3268, 0], select: { height: [-1e4, -1] }, y: -2.5, level: 'Tunnels' },
            { y: 0.5, view: rect(6515, 0, 9775, 6656) },
        ],
    },
    // 왼쪽 바깥 지도(기본), 오른쪽에 쇼핑몰 주차장 · 1층 · 2층과 발전소 내부·지하·조감도
    interchange: {
        scale: [0.12, 0.26],
        panels: [
            { area: rect(8616, 1202, 9576, 1922), ignore: true },
            { area: rect(8640, 842, 9264, 1178), ignore: true },
            { area: rect(5090, 120, 6460, 1270), ignore: true },
            { area: rect(5376, 1226, 7018, 4106), select: { height: [-1e4, 25], bounds: INTERCHANGE_MALL }, y: 22, level: 'Parking' },
            { area: rect(7018, 1178, 8602, 4178), select: { height: [25, 34], bounds: INTERCHANGE_MALL }, y: 27.5, level: '2nd Floor' },
            { area: rect(8616, 1994, 9576, 3818), select: { height: [34, 1e4], bounds: INTERCHANGE_MALL }, y: 37, level: '3rd Floor' },
            { view: rect(0, 0, 5090, 5402) },
        ],
        // 주차장은 tarkov.dev 에 층이 없어 버튼을 더한다
        extraLayers: [{ name: 'Parking', extents: [{ height: [-1e4, 25], bounds: [INTERCHANGE_MALL] }] }],
    },
    icebreaker: { scale: [0.04, 0.1], panels: icebreakerDecks() },
    // 위키 이미지가 4145×3840 → 4800×4320 으로 바뀌며 왼쪽 655px·아래 480px 여백이 더해졌는데 마커 좌표는 예전 그대로라,
    // 새 이미지를 늘리지 않고 여백만큼 옮겨 놓는다 (tarkov.dev 미궁 지도와 지형 6곳을 맞춰 확인: 오차 약 1m)
    'the-labyrinth': { scale: [0.02, 0.06], imageRect: [-655, -480, 4145, 3840] },
    // tarkov.dev 에 탈출구·상자가 없고 스폰 목록도 위키와 달라, tarkov.dev Terminal 도면과 탱크 12개 위치를 맞춰 잰 변환
    // (탱크 평균 0.3m, 300~430m 떨어진 잠긴 문 2곳 1.0m·1.6m)
    terminal: { seed: { matrix: [0.026727, 0.100613, -0.100613, 0.026727], offset: [-443.1, 454.16] } },
};
const SINGLE_PANEL = [{}];

// 변환을 다듬는 기준점: 위키 지도 마커 분류 → tarkov.dev 물체 종류 (상자·스폰·잠긴 문·고정 화기·스위치)
const REF_TYPES = {
    container_safe: 'safe',
    container_pc: 'pc-block',
    container_tool: 'toolbox',
    container_weapon: 'weapon-box',
    container_ammo: 'wooden-ammo-box',
    container_duffle: 'duffle-bag',
    container_jacket: 'jacket',
    container_drawer: 'drawer',
    container_medcase: 'medcase',
    container_medical: 'medbag',
    container_grenade: 'grenade-box',
    container_cash: 'cash-register',
    container_crate: 'wooden-crate',
    container_suitcase: 'suitcase',
    container_stash: 'cache',
    container_dead: 'body',
    container_greencrate: 'supply',
    spawn_pmc: 'spawn-pmc',
    spawn_scav: 'spawn-scav',
    spawn_boss: 'spawn-scav',
    spawn_rogueraider: 'spawn-scav',
    spawn_sniper: 'spawn-scav',
    spawn_cultist: 'spawn-scav',
    locked: 'lock',
    stationarygun: 'gun',
    lever: 'switch',
};
// 다듬기: 같은 종류의 가장 가까운 물체를 짝으로 삼는 거리(미터, 반복할수록 좁힌다)와 최소 짝 수
const REFINE_STEPS = [20, 20, 10, 10, 10, 10];
const REFINE_MIN_PAIRS = 10;

function inPolygon([x, y], poly) {
    let inside = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
        const [xi, yi] = poly[i];
        const [xj, yj] = poly[j];
        if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
}

function wikiUrl() {
    const titles = Object.values(WIKI_TITLES).flatMap((t) => [t, `Map:${t}`]).join('|');
    return `${WIKI_API}?action=query&prop=revisions&rvprop=content&rvslots=main&format=json&formatversion=2&titles=${encodeURIComponent(titles)}`;
}

const normName = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
// 기준점 짝짓기용 (위키 "... button" ↔ tarkov.dev "... Switch"/"... Button")
const refName = (s) => normName(String(s || '').replace(/\bbutton\b/gi, 'switch'));

function cleanWikitext(s) {
    const icons = [];
    const text = String(s || '')
        // 요금 이미지 (예: 5000 Roubles.png, 2400 Euros icon.png) → 금액
        .replace(/\[\[File:([\d,.]+) (Roubles|Dollars|Euros)[^\]]*\]\]/gi, ' $1 $2 ')
        // 아이템 아이콘 (link=아이템) → 아이템 이름 (같은 이름이 글에도 있으면 생략)
        .replace(/\[\[File:[^\]]*\|link=([^\]|]+)[^\]]*\]\]/g, (m, name) => {
            icons.push(name.trim());
            return ` \u0000${icons.length - 1}\u0000 `;
        })
        .replace(/\[\[File:[^\]]*\]\]/g, '');
    const withoutIcons = text.replace(/\u0000\d+\u0000/g, '');
    return text
        .replace(/\u0000(\d+)\u0000/g, (m, i) => (withoutIcons.includes(icons[i]) ? '' : icons[i]))
        .replace(/\[\[(?:[^\]|]*\|)?([^\]]*)\]\]/g, '$1')
        .replace(/<br\s*\/?>/gi, ' / ')
        .replace(/<[^>]+>/g, '')
        .replace(/'''?/g, '')
        .replace(/\s+/g, ' ')
        .replace(/^[\s/]+|[\s/]+$/g, '')
        .trim();
}

// "== 제목 ==" 섹션의 첫 번째 표를 [{헤더: 값}] 로
function parseSectionTable(text, section) {
    const start = text.search(new RegExp(`^==\\s*${section}\\s*==\\s*$`, 'm'));
    if (start < 0) return [];
    const body = text.slice(start).split(/\n==[^=]/)[0];
    const tableStart = body.indexOf('{|');
    if (tableStart < 0) return [];
    const table = body.slice(tableStart, body.indexOf('\n|}', tableStart) >>> 0);
    const rows = table.split(/\n\|-[^\n]*/);
    const header = rows[0].split('\n').filter((l) => l.startsWith('!')).map((l) => cleanWikitext(l.slice(1).replace(/^[^|]*=\s*"[^"]*"\s*\|/, '')));
    return rows.slice(1).map((row) => {
        const cells = [];
        for (const line of row.split('\n')) {
            if (!line.trim()) continue;
            if (/^[!|]/.test(line)) cells.push(line.slice(1).replace(/^\s*style="[^"]*"\s*\|/, ''));
            else if (cells.length) cells[cells.length - 1] += `\n${line}`;
        }
        const cell = (name) => {
            const i = header.indexOf(name);
            return i < 0 ? undefined : cells[i] || '';
        };
        const yesNo = (raw) => {
            if (raw === undefined) return undefined;
            const text = cleanWikitext(raw);
            if (/PMC\s*:|Scav\s*:/i.test(text)) return text.replace(/✔/g, 'O').replace(/✘/g, 'X');
            if (text.includes('✔')) return true;
            if (text.includes('✘')) return false;
            return text || undefined;
        };
        const dash = (s) => (s && s !== '-' ? s : '');
        return {
            name: cleanWikitext(cell('Name')),
            faction: cleanWikitext(cell('Faction') ?? ''),
            alwaysAvailable: yesNo(cell('Always available')),
            singleUse: yesNo(cell('Single-Use')),
            requirements: dash(cleanWikitext(cell('Requirements'))),
            notes: dash(cleanWikitext(cell('Notes'))),
        };
    }).filter((r) => r.name);
}

// 위키 API 응답(JSON 문자열) → { mapKey: { extracts, transits, markers } }
function parseWikiResponse(text) {
    const pages = Object.fromEntries((JSON.parse(text).query?.pages || []).map((p) => [p.title, p.revisions?.[0]?.slots?.main?.content]));
    const result = {};
    for (const [key, title] of Object.entries(WIKI_TITLES)) {
        const article = pages[title];
        if (!article) continue;
        const extracts = parseSectionTable(article, 'Extractions');
        const transits = parseSectionTable(article, 'Transits');
        let markers = [];
        let image = null;
        let refs = [];
        let bosses = [];
        try {
            const map = JSON.parse(pages[`Map:${title}`]);
            // 보스·광신도·레이더 출현 마커 (이름은 설명의 위키 링크 [[Shturman]], 없으면 제목)
            bosses = map.markers.filter((m) => /^spawn_(boss|cultist|rogueraider)/.test(m.categoryId))
                .map((m) => ({ name: (m.popup?.description || '').match(/\[\[([^\]|]+)/)?.[1] || m.popup?.title || '', position: m.position }));
            markers = map.markers.filter((m) => /^(exfil|lever)/.test(m.categoryId))
                .map((m) => ({ name: m.popup?.title || '', category: m.categoryId, position: m.position }));
            // 마커 좌표는 mapBounds 기준 (왼쪽 아래 원점), 이미지는 이 크기로 늘여 그린다
            if (map.mapImage && map.mapBounds) image = { file: map.mapImage, size: map.mapBounds[1] };
            refs = map.markers.filter((m) => REF_TYPES[m.categoryId]).map((m) => ({ type: REF_TYPES[m.categoryId], position: m.position }));
        } catch { /* 지도 없음 */ }
        // 탈출구 표가 없는 맵(Terminal)도 위키 지도가 있으면 넣는다
        if (extracts.length || transits.length || image) result[key] = { extracts, transits, markers, image, refs, bosses };
    }
    return result;
}

// 최소제곱 NxN (가우스 소거)
function solveLeastSquares(rows, values) {
    const n = rows[0].length;
    const M = Array.from({ length: n }, () => new Array(n).fill(0));
    const v = new Array(n).fill(0);
    rows.forEach((r, i) => {
        for (let a = 0; a < n; a++) {
            v[a] += r[a] * values[i];
            for (let b = 0; b < n; b++) M[a][b] += r[a] * r[b];
        }
    });
    for (let i = 0; i < n; i++) {
        let p = i;
        for (let r = i + 1; r < n; r++) if (Math.abs(M[r][i]) > Math.abs(M[p][i])) p = r;
        [M[i], M[p]] = [M[p], M[i]];
        [v[i], v[p]] = [v[p], v[i]];
        if (Math.abs(M[i][i]) < 1e-9) return null;
        for (let r = 0; r < n; r++) {
            if (r === i) continue;
            const f = M[r][i] / M[i][i];
            for (let c = 0; c < n; c++) M[r][c] -= f * M[i][c];
            v[r] -= f * v[i];
        }
    }
    return v.map((x, i) => x / M[i][i]);
}

const baseIndex = (panels) => Math.max(0, panels.findIndex((p) => !p.area));
// 위키 좌표가 그려진 판 (어느 영역에도 없으면 기본 판)
const panelIndex = (panels, w) => {
    const i = panels.findIndex((p) => p.area && inPolygon(w, p.area));
    return i < 0 ? baseIndex(panels) : i;
};
const inGameBounds = (b, p) => p.x >= Math.min(b[0][0], b[1][0]) && p.x <= Math.max(b[0][0], b[1][0])
    && p.z >= Math.min(b[0][1], b[1][1]) && p.z <= Math.max(b[0][1], b[1][1]);
// 게임 좌표를 그릴 판 (select 가 맞는 판, 없으면 기본 판)
const gamePanelIndex = (panels, p) => {
    const i = panels.findIndex((x) => x.select
        && (!x.select.height || (p.y >= x.select.height[0] && p.y < x.select.height[1]))
        && (!x.select.bounds || inGameBounds(x.select.bounds, p)));
    return i < 0 ? baseIndex(panels) : i;
};
// 위치를 함께 맞추는 판 (같은 그림을 옮긴 판은 기본 판과 함께)
const column = (panels, i) => (panels[i].shift ? baseIndex(panels) : i);
const unshift = (panels, i, w) => (panels[i].shift ? [w[0] - panels[i].shift[0], w[1] - panels[i].shift[1]] : w);

// 위키 → 게임 변환 (축척·방향 matrix [a, b, c, d] 는 공통, offsets: 위치를 맞춘 판 번호 → [x, z])
// f(w, i): 판 i(생략하면 w 가 속한 판)에 그려진 위키 좌표 w 의 게임 좌표 (위치를 모르는 판이면 null)
function makeTransform(matrix, offsets, panels) {
    const [a, b, c, d] = matrix;
    const f = (w, i = panelIndex(panels, w)) => {
        const t = panels[i].ignore ? null : offsets.get(column(panels, i));
        if (!t) return null;
        const [x, y] = unshift(panels, i, w);
        return { x: a * x + b * y + t[0], z: c * x + d * y + t[1], y: panels[i].y };
    };
    f.matrix = matrix;
    f.offsets = offsets;
    f.axes = [[a, c], [b, d]];
    return f;
}

// 축척·방향은 공통, 위치만 판별로 다른 아핀 변환 (확대도 판의 점은 쓰지 않는다)
function fitAffine(pairs, panels, keep) {
    const usable = pairs.map((p) => ({ ...p, i: p.panel ?? panelIndex(panels, p.wiki) })).filter((p) => !panels[p.i].ignore);
    if (usable.length < 3) return null;
    const cols = [...new Set(usable.map((p) => column(panels, p.i)))];
    const rows = usable.map((p) => {
        const w = unshift(panels, p.i, p.wiki);
        const col = column(panels, p.i);
        return [w[0], w[1], ...cols.map((c) => (c === col ? 1 : 0))];
    });
    const cx = solveLeastSquares(rows, usable.map((p) => p.game.x));
    const cz = solveLeastSquares(rows, usable.map((p) => p.game.z));
    if (!cx || !cz || [...cx, ...cz].some((n) => !Number.isFinite(n))) return null;
    // 이번 짝이 없는 판의 위치는 keep(이전 변환)에서 이어받는다
    const offsets = new Map(keep ? keep.offsets : []);
    cols.forEach((c, k) => offsets.set(c, [cx[2 + k], cz[2 + k]]));
    return makeTransform([cx[0], cx[1], cz[0], cz[1]], offsets, panels);
}

// 위키 지도가 실제 비율대로 그려졌는지 (두 축의 축척이 비슷하고 서로 직각)
function isTrueScale(f) {
    const [u, v] = f.axes;
    const lu = Math.hypot(...u);
    const lv = Math.hypot(...v);
    return lu / lv > 0.85 && lu / lv < 1.18 && Math.abs(u[0] * v[0] + u[1] * v[1]) / (lu * lv) < 0.17;
}

const pairDistance = (f, p) => {
    const g = f(p.wiki, p.panel);
    return g ? Math.hypot(g.x - p.game.x, g.z - p.game.z) : Infinity;
};

// 이름이 같은 탈출구·스위치로 맞춘 위키 → 게임 변환 (잘못 놓인 마커는 걸러낸다). 믿을 수 없으면 null
function wikiToGameTransform(pairs, panels) {
    pairs = pairs.filter((p) => !panels[panelIndex(panels, p.wiki)].ignore);
    if (pairs.length < FIT_MIN_INLIERS) return null;
    let best = [];
    if (panels.length > 1) {
        // 판별 위치까지 맞춰야 해서 세 점 조합 대신, 전체로 맞춘 뒤 가장 어긋난 기준점을 하나씩 뺀다
        best = pairs.slice();
        while (best.length > FIT_MIN_INLIERS) {
            const f = fitAffine(best, panels);
            if (!f) return null;
            const worst = best.reduce((a, b) => (pairDistance(f, b) > pairDistance(f, a) ? b : a));
            if (pairDistance(f, worst) < FIT_TOLERANCE) break;
            best = best.filter((p) => p !== worst);
        }
        const f = fitAffine(best, panels);
        if (!f) return null;
        best = best.filter((p) => pairDistance(f, p) < FIT_TOLERANCE);
    } else {
        for (let i = 0; i < pairs.length; i++) {
            for (let j = i + 1; j < pairs.length; j++) {
                for (let k = j + 1; k < pairs.length; k++) {
                    const f = fitAffine([pairs[i], pairs[j], pairs[k]], panels);
                    if (!f) continue;
                    const inliers = pairs.filter((p) => pairDistance(f, p) < FIT_TOLERANCE);
                    if (inliers.length > best.length) best = inliers;
                }
            }
        }
    }
    // 대부분의 기준점이 맞아야 지도가 실제 비율과 같다고 본다
    if (best.length < FIT_MIN_INLIERS || best.length < pairs.length * 0.7) return null;
    const f = fitAffine(best, panels);
    if (!f || !isTrueScale(f)) return null;
    f.pairs = best;
    return f;
}

// 위키 마커·tarkov.dev 물체를 종류와 판으로 묶는다 (같은 판에 그려지는 같은 종류끼리만 짝짓는다)
function groupRefs(wikiRefs, devRefs, panels) {
    const dev = new Map();
    for (const d of devRefs || []) {
        const key = `${d.type}|${column(panels, gamePanelIndex(panels, d.position))}|${gamePanelIndex(panels, d.position)}`;
        if (!dev.has(key)) dev.set(key, []);
        dev.get(key).push(d.position);
    }
    return (wikiRefs || []).map((r) => {
        const i = panelIndex(panels, r.position);
        return { wiki: r.position, panel: i, candidates: panels[i].ignore ? [] : dev.get(`${r.type}|${column(panels, i)}|${i}`) || [] };
    }).filter((r) => r.candidates.length);
}

// 같은 종류 물체끼리 짝지었을 때 가장 많이 겹치는 위치를 투표로 찾는다 (matrix 고정, 판 col 의 위치)
function voteOffset(matrix, refs, panels, col, bin = 4) {
    const [a, b, c, d] = matrix;
    const votes = new Map();
    let best = null;
    for (const r of refs) {
        if (column(panels, r.panel) !== col) continue;
        const [x, y] = unshift(panels, r.panel, r.wiki);
        const gx = a * x + b * y;
        const gz = c * x + d * y;
        const seen = new Set();
        for (const p of r.candidates) {
            const kx = Math.round((p.x - gx) / bin);
            const kz = Math.round((p.z - gz) / bin);
            const key = `${kx},${kz}`;
            if (seen.has(key)) continue;
            seen.add(key);
            const n = (votes.get(key) || 0) + 1;
            votes.set(key, n);
            if (!best || n > best.n) best = { n, t: [kx * bin, kz * bin] };
        }
    }
    return best;
}

// 이름이 같은 기준점이 모자란 지도: 회전·축척을 훑어 물체 배치가 가장 많이 겹치는 변환을 찾는다
function bootstrapTransform(refs, panels, [lo, hi]) {
    const col = baseIndex(panels);
    let best = null;
    for (let deg = 0; deg < 360; deg += 2) {
        const rad = (deg * Math.PI) / 180;
        for (let s = lo; s <= hi; s *= 1.02) {
            const matrix = [s * Math.cos(rad), -s * Math.sin(rad), s * Math.sin(rad), s * Math.cos(rad)];
            const v = voteOffset(matrix, refs, panels, col);
            if (v && (!best || v.n > best.n)) best = { n: v.n, matrix, t: v.t };
        }
    }
    // 기준점이 적거나 우연히 겹친 정도면 믿지 않는다
    if (!best || best.n < Math.max(FIT_MIN_INLIERS, refs.filter((r) => column(panels, r.panel) === col).length * 0.25)) return null;
    return makeTransform(best.matrix, new Map([[col, best.t]]), panels);
}

// 위치를 모르는 판(이름이 같은 기준점이 없는 판)은 공통 축척·방향으로 물체 배치를 맞춰 위치를 찾는다
function fillPanelOffsets(f, refs, panels) {
    const offsets = new Map(f.offsets);
    panels.forEach((p, i) => {
        if (p.ignore || p.shift || offsets.has(i)) return;
        const v = voteOffset(f.matrix, refs, panels, i);
        if (v && v.n >= 3) offsets.set(i, v.t);
    });
    const next = makeTransform(f.matrix, offsets, panels);
    next.pairs = f.pairs;
    return next;
}

// 처음 변환을 위키 지도의 상자·스폰 등 수백 개 마커로 다듬는다.
// 위키 마커를 지금 변환으로 옮겨 같은 종류(같은 판)의 가장 가까운 tarkov.dev 물체와 짝지어 다시 맞추기를 반복하고,
// 짝이 모자라거나 결과가 나빠지면 처음 변환을 쓴다
function refineTransform(transform, refs, panels) {
    if (!refs.length) return transform;
    const nearest = (f, r) => {
        const g = f(r.wiki, r.panel);
        if (!g) return null;
        let best = null;
        for (const c of r.candidates) {
            const d = Math.hypot(c.x - g.x, c.z - g.z);
            if (!best || d < best.d) best = { d, game: c };
        }
        return best;
    };
    // 짝 거리 중앙값 (40m 넘게 떨어진 것은 확대도 위 마커 등으로 보고 뺀다)
    const score = (f) => {
        const ds = refs.map((r) => nearest(f, r)?.d ?? Infinity).filter((d) => d < 40).sort((a, b) => a - b);
        return ds.length >= REFINE_MIN_PAIRS ? ds[ds.length >> 1] : Infinity;
    };
    let f = transform;
    for (const limit of REFINE_STEPS) {
        const pairs = [];
        for (const r of refs) {
            const n = nearest(f, r);
            if (n && n.d < limit) pairs.push({ wiki: r.wiki, panel: r.panel, game: n.game });
        }
        if (pairs.length < REFINE_MIN_PAIRS) break;
        const next = fitAffine([...pairs, ...(transform.pairs || [])], panels, f);
        if (!next || !isTrueScale(next)) break;
        f = next;
    }
    if (f === transform || !(score(f) < score(transform))) return transform;
    f.pairs = transform.pairs;
    return f;
}

// 위키 조건 문구 중 자주 나오는 것만 한국어로 (나머지는 원문 유지)
const REQUIREMENT_KO = [
    [/Shoot a green flare into the sky while inside the signal flare area\.[^/]*/i, '신호탄 구역 안에서 녹색 신호탄을 하늘로 쏘기 '],
    [/Only available (\d+) min after raid start\.?/gi, '레이드 시작 $1분 후부터 이용 가능'],
    [/in the time period of (\d+:\d+)-(\d+:\d+)/gi, '($1~$2 사이)'],
    [/Green flares? = Open/gi, '녹색 신호탄 = 열림'],
    [/^Scav \+ PMC$/i, '스캐브 + PMC 협동'],
    [/No backpack equipped\.?/gi, '가방 미착용'],
    [/No armor vest equipped\.?/gi, '방탄조끼 미착용'],
    [/Maximum of (\d+) players/gi, '최대 $1명'],
    [/per player/gi, '(1인당)'],
    [/Note with code word/gi, '암호 쪽지:'],
];

function koRequirement(text) {
    return REQUIREMENT_KO.reduce((s, [re, ko]) => s.replace(re, ko), text || '').replace(/\s+/g, ' ').trim();
}

function factionClass(wikiFaction) {
    const f = wikiFaction.toLowerCase();
    if (f === 'pmc') return 'pmc';
    if (f === 'scav') return 'scav';
    return 'shared';
}

// 위키 탈출구 표의 진영 → 위키 지도 마커 분류
const MARKER_CATEGORY = { pmc: 'exfil_pmc', scav: 'exfil_scav', transit: 'exfil_transit' };

// tarkov.dev 탈출구/이동 지점을 위키 목록 기준으로 다시 만든다 (위치도 위키 지도가 우선)
// dev: [{ name(영문), label(표시 이름), faction, position, top, bottom }]
// markerLevel: 위키 마커가 그려진 판의 층 이름 (층을 나눠 그린 지도만, 기본 판은 null)
// 탈출 구역(게임 좌표 다각형) 밖으로 이 거리(미터)보다 멀면 구역 경계로 옮긴다 (위키 아이콘은 구역 근처 길·문에 찍히기도 해 여유를 둔다)
const ZONE_TOLERANCE = 8;
function snapToZone(g, outline) {
    const poly = outline.map((p) => [p.x, p.z]);
    let inside = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
        const [xi, zi] = poly[i];
        const [xj, zj] = poly[j];
        if ((zi > g.z) !== (zj > g.z) && g.x < ((xj - xi) * (g.z - zi)) / (zj - zi) + xi) inside = !inside;
    }
    if (inside) return g;
    let best = null;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
        const [ax, az] = poly[j];
        const [bx, bz] = poly[i];
        const len = (bx - ax) ** 2 + (bz - az) ** 2;
        const t = len ? Math.min(1, Math.max(0, ((g.x - ax) * (bx - ax) + (g.z - az) * (bz - az)) / len)) : 0;
        const x = ax + t * (bx - ax);
        const z = az + t * (bz - az);
        const d = Math.hypot(g.x - x, g.z - z);
        if (!best || d < best.d) best = { d, x, z };
    }
    return best.d > ZONE_TOLERANCE ? { ...g, x: best.x, z: best.z } : g;
}

function mergeWithWiki(wikiRows, devPoints, markers, transform, allDevPoints, inBounds, isTransit, markerLevel) {
    const out = [];
    for (const row of wikiRows) {
        const faction = factionClass(row.faction);
        const matches = devPoints.filter((d) => normName(d.name) === normName(row.name));
        // 진영이 같은 좌표를 우선, "All" 이면 대표 좌표 하나만
        const pick = matches.find((d) => d.faction === faction) || matches[0];
        const info = {
            alwaysAvailable: row.alwaysAvailable,
            singleUse: row.singleUse,
            requirements: koRequirement(row.requirements),
            notes: row.notes,
        };
        const base = { name: row.name, label: pick ? pick.label : row.name, faction, wiki: info };

        // 위키 지도 마커 위치 (같은 진영 분류의 마커 우선)
        const named = markers.filter((m) => /^exfil/.test(m.category) && normName(m.name) === normName(row.name));
        const category = MARKER_CATEGORY[isTransit ? 'transit' : faction];
        const marker = named.find((m) => m.category === category) || named[0];
        // 층: 위키 지도에서 마커가 그려진 층 그림 (위치를 tarkov.dev 에서 가져와도 층은 위키 그림 기준)
        const level = marker && markerLevel ? markerLevel(marker.position) : undefined;
        if (level !== undefined) base.level = level;
        let g = marker && transform ? transform(marker.position) : null;
        // 위키 지도의 별도 영역(지도 밖)에 그려진 마커는 쓰지 않는다
        if (g && !inBounds(g)) g = null;
        // 위키 마커가 tarkov.dev 실제 탈출 구역에서 많이 벗어나 있으면 구역 경계의 가장 가까운 자리로 옮긴다
        if (g && pick?.outline?.length >= 3) g = snapToZone(g, pick.outline);

        // 위키 지도 마커 위치를 쓴다 (위키에 없거나, 지도 옆 확대도 위에 그려진 마커면 tarkov.dev 좌표)
        const shift = pick && g ? Math.hypot(pick.position.x - g.x, pick.position.z - g.z) : 0;
        if (pick && (!g || shift > MAX_WIKI_SHIFT)) {
            out.push({ ...pick, ...base, source: 'tarkov.dev' });
            continue;
        }
        if (!g) {
            out.push({ ...base, position: null, source: 'wiki' });
            continue;
        }
        // 높이: 층이 나뉜 위키 지도면 그 층의 높이, 아니면 같은 탈출구 또는 가장 가까운 기존 탈출구의 높이
        let y = g.y;
        if (y === undefined && pick) y = pick.position.y;
        if (y === undefined) {
            let nearest = null;
            for (const d of allDevPoints) {
                const dd = Math.hypot(d.position.x - g.x, d.position.z - g.z);
                if (!nearest || dd < nearest.d) nearest = { d: dd, y: d.position.y };
            }
            y = nearest ? nearest.y : 0;
        }
        // tarkov.dev 의 높이 범위는 같은 층일 때만 쓴다
        const keepRange = pick && pick.top !== undefined && y >= pick.bottom && y <= pick.top;
        out.push({
            ...base,
            position: { x: +g.x.toFixed(2), y, z: +g.z.toFixed(2) },
            top: keepRange ? pick.top : undefined,
            bottom: keepRange ? pick.bottom : undefined,
            source: 'wiki',
        });
    }
    return out;
}

// 위키 지도 → 게임 좌표 변환: 이름이 같은 탈출구·스위치로 맞추고(모자라면 물체 배치로 처음 위치를 찾고),
// 위치를 모르는 판을 채운 뒤 상자·스폰 등으로 다듬는다
function buildTransform(wiki, dev, mapKey) {
    const layout = WIKI_LAYOUTS[mapKey] || {};
    const panels = layout.panels || SINGLE_PANEL;
    // 탈출구·이동 지점과 스위치(버튼)를 이름으로 짝짓는다
    const named = [...dev.extracts, ...dev.transits, ...(dev.switches || [])].filter((d) => d.position);
    const pairs = [];
    for (const m of wiki.markers) {
        const d = named.find((p) => refName(p.name) === refName(m.name));
        if (d) pairs.push({ wiki: m.position, game: d.position });
    }
    const refs = groupRefs(wiki.refs, dev.refs, panels);
    if (layout.seed) {
        return { transform: makeTransform(layout.seed.matrix, new Map([[baseIndex(panels), layout.seed.offset]]), panels), panels };
    }
    let transform = wikiToGameTransform(pairs, panels);
    if (!transform && layout.scale) transform = bootstrapTransform(refs, panels, layout.scale);
    if (!transform) return { transform: null, panels };
    transform = fillPanelOffsets(transform, refs, panels);
    return { transform: refineTransform(transform, refs, panels), panels };
}

// dev: { extracts, transits, switches, refs } (name/label/faction/position/top/bottom, refs: 변환을 다듬는 물체 [{ type, position }])
// bounds: tarkov.dev 지도 범위 [[x, z], [x, z]]
function applyWikiExtracts(wiki, dev, bounds, mapKey) {
    if (!wiki) return null;
    const allDev = [...dev.extracts, ...dev.transits].filter((d) => d.position);
    const { transform, panels } = buildTransform(wiki, dev, mapKey);
    // 지도 범위: tarkov.dev 설정 범위가 실제 물체보다 좁은 맵(Icebreaker)도 있어 물체 위치까지 넓힌다
    const known = [...allDev, ...(dev.refs || [])].map((d) => d.position).filter(Boolean);
    const xs = [...(bounds ? [bounds[0][0], bounds[1][0]] : []), ...known.map((p) => p.x)];
    const zs = [...(bounds ? [bounds[0][1], bounds[1][1]] : []), ...known.map((p) => p.z)];
    const area = xs.length ? [[Math.min(...xs) - 10, Math.min(...zs) - 10], [Math.max(...xs) + 10, Math.max(...zs) + 10]] : null;
    const inBounds = (g) => !area || inGameBounds(area, g);
    // 위키 문서에 탈출구 표가 없으면(Terminal) 위키 지도의 탈출구 마커로 목록을 만든다
    const markerRows = [...new Map(wiki.markers.filter((m) => /^exfil_(pmc|scav)/.test(m.category))
        .map((m) => [normName(m.name), { name: m.name.trim(), faction: m.category === 'exfil_pmc' ? 'PMC' : 'Scav' }])).values()];
    const extractRows = wiki.extracts.length ? wiki.extracts : markerRows;
    // 높이를 모르는 위키 마커는 가장 가까운 tarkov.dev 탈출구·물체의 높이를 쓴다
    const heightRefs = [...allDev, ...(dev.refs || []).filter((d) => d.position)];
    const markerLevel = transform && panels.length > 1 ? (w) => {
        const panel = panels[panelIndex(panels, w)];
        return panel.ignore ? undefined : [].concat(panel.level || [])[0] ?? null;
    } : null;
    const extracts = extractRows.length
        ? mergeWithWiki(extractRows, dev.extracts, wiki.markers, transform, heightRefs, inBounds, false, markerLevel)
        : dev.extracts;
    const transits = wiki.transits.length
        ? mergeWithWiki(wiki.transits.map((t) => ({ ...t, faction: '' })), dev.transits, wiki.markers, transform, heightRefs, inBounds, true, markerLevel)
        : dev.transits;
    // 보스 출현 마커 → 게임 좌표 (높이는 모름: 층이 나뉜 위키 지도면 그 판의 높이·층)
    const bosses = transform ? (wiki.bosses || []).flatMap((m) => {
        const g = transform(m.position);
        if (!g || !inBounds(g)) return [];
        const level = markerLevel ? markerLevel(m.position) : undefined;
        return [{ name: m.name.trim(), position: { x: +g.x.toFixed(1), y: g.y, z: +g.z.toFixed(1) }, level }];
    }) : null;
    return { extracts, transits, bosses, wikiMap: transform && wiki.image ? wikiMapLayout(wiki.image, transform, panels, WIKI_LAYOUTS[mapKey] || {}) : null };
}

// 위키 지도 이미지 좌표계 정보: 게임 좌표 = matrix · 위키 좌표 + 판별 offset
// (위키 좌표는 mapBounds 기준 왼쪽 아래 원점. area: 판이 그려진 위키 좌표 다각형, levels: 이 판을 보여 줄 층 이름, view: 기본 판에서 보여 줄 영역)
// 확대도는 빼고(위치를 모르는 판은 offset null), 기본 판(area 없음)은 맨 뒤
function wikiMapLayout(image, transform, panels, layout) {
    const [a, b, c, d] = transform.matrix;
    const out = [];
    panels.forEach((p, i) => {
        if (p.ignore) return;
        const t = transform.offsets.get(column(panels, i));
        const [sx, sy] = p.shift || [0, 0];
        // 위치를 못 맞춘 판(Interchange 쇼핑몰 2층)도 층 판단에 쓰도록 남긴다 (그림은 겹치지 않는다)
        out.push({
            offset: t ? [t[0] - (a * sx + b * sy), t[1] - (c * sx + d * sy)] : null,
            area: p.area || null,
            levels: [].concat(p.level || []),
            view: p.view || null,
            select: p.select || null,
        });
    });
    if (!out.some((p) => !p.area && p.offset)) return null;
    return {
        file: image.file,
        size: image.size,
        imageRect: layout.imageRect || [0, 0, image.size[0], image.size[1]],
        matrix: transform.matrix,
        panels: out,
        extraLayers: layout.extraLayers || [],
    };
}

// 위키 지도 이미지 파일 이름들 → 이미지 주소를 묻는 위키 API 주소
function wikiImageInfoUrl(files) {
    const titles = files.map((f) => `File:${f}`).join('|');
    return `${WIKI_API}?action=query&prop=imageinfo&iiprop=url&format=json&formatversion=2&titles=${encodeURIComponent(titles)}`;
}

// 위키 API 응답 → { 파일 이름: 이미지 주소 }
function parseWikiImageInfo(text) {
    const out = {};
    for (const p of JSON.parse(text).query?.pages || []) {
        const url = p.imageinfo?.[0]?.url;
        if (url) out[p.title.replace(/^File:/, '')] = url;
    }
    return out;
}

module.exports = {
    WIKI_API, WIKI_TITLES, normName, cleanWikitext, wikiUrl, parseWikiResponse, applyWikiExtracts, wikiImageInfoUrl, parseWikiImageInfo,
};
