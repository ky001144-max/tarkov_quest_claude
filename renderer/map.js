/* global L */
// tarkov.dev 인터랙티브 맵 렌더링 (the-hideout/tarkov-dev src/pages/map 의 좌표계/층 로직 이식)

function applyRotation(latLng, rotation) {
    if (!latLng.lng && !latLng.lat) return L.latLng(0, 0);
    if (!rotation) return latLng;
    const rad = (rotation * Math.PI) / 180;
    const cos = Math.cos(rad);
    const sin = Math.sin(rad);
    const { lng: x, lat: y } = latLng;
    return L.latLng(x * sin + y * cos, x * cos - y * sin);
}

function getCRS(cfg) {
    let scaleX = 1, scaleY = 1, marginX = 0, marginY = 0;
    if (cfg.transform) {
        scaleX = cfg.transform[0];
        scaleY = cfg.transform[2] * -1;
        marginX = cfg.transform[1];
        marginY = cfg.transform[3];
    }
    return L.extend({}, L.CRS.Simple, {
        transformation: new L.Transformation(scaleX, marginX, scaleY, marginY),
        projection: L.extend({}, L.Projection.LonLat, {
            project: (latLng) => L.Projection.LonLat.project(applyRotation(latLng, cfg.coordinateRotation)),
            unproject: (point) => applyRotation(L.Projection.LonLat.unproject(point), cfg.coordinateRotation * -1),
        }),
    });
}

// 이 거리(미터) 안에 있는 퀘스트 마커는 하나로 합쳐 표시한다
const MERGE_DISTANCE = 3;
const MERGE_HEIGHT = 2.5;
const CHIP_SIZE = 22;
const CHIP_GAP = 2;

// 위키 지도를 보는 동안의 좌표계 (null 이면 tarkov.dev 지도: Leaflet 좌표 = 게임 좌표)
let wikiView = null;

// 게임 좌표 → Leaflet 좌표 (tarkov.dev 지도: lat = z, lng = x / 위키 지도: lat = 위키 y, lng = 위키 x)
function pos(p) {
    if (wikiView) {
        const [x, y] = wikiView.toWiki(p);
        return [y, x];
    }
    return [p.z, p.x];
}

// 게임 좌표 범위 [[x, z], [x, z]] → Leaflet 범위 (네 모서리를 감싸는 범위)
function getBounds(b) {
    const [[x1, z1], [x2, z2]] = b;
    return L.latLngBounds([[x1, z1], [x2, z1], [x1, z2], [x2, z2]].map(([x, z]) => pos({ x, z })));
}

// 게임 좌표가 게임 좌표 범위 [[x, z], [x, z]] 안에 있는지
function inGameBounds(b, p) {
    const [[x1, z1], [x2, z2]] = b;
    return p.x >= Math.min(x1, x2) && p.x <= Math.max(x1, x2) && p.z >= Math.min(z1, z2) && p.z <= Math.max(z1, z2);
}

function inPolygon([x, y], poly) {
    let inside = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
        const [xi, yi] = poly[i];
        const [xj, yj] = poly[j];
        if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
}

// 위키 지도 이미지 좌표 ↔ 게임 좌표 (게임 = matrix · 위키 + offset).
// 층·구역을 나눠 그린 지도(The Lab, Factory, Interchange, Icebreaker)는 기본 판 좌표로 보여 주고,
// 다른 판 그림은 기본 판 자리로 옮겨(같은 축척·방향이라 평행 이동) 그 층을 고를 때 겹쳐 그린다
class WikiView {
    constructor(wikiMap) {
        const [a, b, c, d] = wikiMap.matrix;
        this.m = { a, b, c, d, det: a * d - b * c };
        this.panels = wikiMap.panels;
        this.base = this.panels.find((p) => !p.area) || this.panels[0];
        this.size = wikiMap.size;
        // 위키 이미지가 놓이는 위키 좌표 범위
        this.rect = wikiMap.imageRect || [0, 0, ...wikiMap.size];
    }

    // 게임 → 위키 좌표 (기본 판 기준)
    toWiki(p) {
        const { a, b, c, d, det } = this.m;
        const dx = p.x - this.base.offset[0];
        const dz = p.z - this.base.offset[1];
        return [(d * dx - b * dz) / det, (a * dz - c * dx) / det];
    }

    // 판 그림을 기본 판 자리로 옮기는 위키 좌표 이동량
    shiftOf(panel) {
        const { a, b, c, d, det } = this.m;
        const dx = panel.offset[0] - this.base.offset[0];
        const dz = panel.offset[1] - this.base.offset[1];
        return [(d * dx - b * dz) / det, (a * dz - c * dx) / det];
    }

    // 게임 좌표가 위키 지도 이미지 안에 그려지는지
    contains(p) {
        const [x, y] = this.toWiki(p);
        const [x1, y1, x2, y2] = this.rect;
        return x >= x1 && y >= y1 && x <= x2 && y <= y2;
    }

    // Leaflet 좌표 → 게임 좌표
    toGame(latlng) {
        const { a, b, c, d } = this.m;
        const [x, y] = [latlng.lng, latlng.lat];
        return { x: a * x + b * y + this.base.offset[0], z: c * x + d * y + this.base.offset[1] };
    }

    // 게임 방향(rotation 0 = +z, 90 = +x)이 화면에서 위쪽 기준 시계 방향으로 몇 도인지
    screenAngle(rotation) {
        const r = (rotation * Math.PI) / 180;
        const { a, b, c, d, det } = this.m;
        const gx = Math.sin(r);
        const gz = Math.cos(r);
        const wx = (d * gx - b * gz) / det;
        const wy = (a * gz - c * gx) / det;
        return (Math.atan2(wx, wy) * 180) / Math.PI;
    }
}

// 한 층 버튼에 지하·위층이 함께 그려진 층 (연구소 기술층): [높이 상한, 실제 층 이름] 순서대로
// 높이 구간은 tarkov.dev 연구소 층 높이 (기술층 < -0.9 ≤ 1층 < 3 ≤ 2층)
const FLOOR_BY_HEIGHT = {
    'the-lab': { Technical: [[-0.9, '지하'], [3, '1층'], [Infinity, '2층']] },
};

// 좌표가 지도 밖인 탈출구를 놓을 자리 (게임 좌표). 탈출 구역 중 지도 안에 걸친 맵 끝 위험 지대 쪽으로,
// 위키 지도와 도면에서 함께 맞춰 본 자리 (없으면 insidePosition 으로 지도 안쪽에 들인다)
const OFF_MAP_SPOTS = {
    // 철로 끝: 도면의 붉은 점선 위험 구역 안, 위키 지도의 맵 경계 너머 철로 옆
    customs: [{ name: /^Railroad Passage/, x: 175, z: -272 }],
};

// 층 extents 안에 위치가 있는지: 'full' | 'partial' | false
function onExtents(extents, p, top, bottom) {
    if (!extents) return 'full';
    const t = top ?? p.y;
    const b = bottom ?? p.y;
    for (const ext of extents) {
        if (t >= ext.height[0] && b < ext.height[1]) {
            const type = b >= ext.height[0] && t <= ext.height[1] ? 'full' : 'partial';
            if (!ext.bounds) return type;
            for (const bounds of ext.bounds) {
                if (inGameBounds(bounds, p)) return type;
            }
        }
    }
    return false;
}

// 탈출구 표시 필터: PMC / 스캐브 / 트랜짓·Co-op (Co-op 이 아닌 공용 탈출구는 PMC·스캐브 중 하나라도 켜면 보인다)
const isCoopExtract = (item) => /co-?op/i.test(item.name || '') || /협동/.test(item.wiki?.requirements || '');
function extractVisible(item, cls, filter) {
    if (!filter) return false;
    if (cls === 'transit' || isCoopExtract(item)) return !!filter.transit;
    if (cls === 'pmc') return !!filter.pmc;
    if (cls === 'scav') return !!filter.scav;
    return !!(filter.pmc || filter.scav);
}

const FACTION_KO = { pmc: 'PMC 전용', scav: '스캐브 전용', shared: 'PMC·스캐브 공용', transit: '지역 이동' };

// 위키 탈출구 정보 (조건·1회용 등)
function extractInfoRows(item) {
    const w = item.wiki;
    if (!w) return [];
    const yesNo = (v) => (v === true ? '예' : v === false ? '아니요' : String(v).replace(/: O/g, ': 예').replace(/: X/g, ': 아니요'));
    const rows = [];
    if (w.alwaysAvailable !== undefined) rows.push(['항상 열림', yesNo(w.alwaysAvailable)]);
    if (w.singleUse !== undefined) rows.push(['1회용', yesNo(w.singleUse)]);
    if (w.requirements) rows.push(['조건', w.requirements]);
    if (w.notes) rows.push(['메모', w.notes]);
    return rows;
}

// 탈출 조건 꼬리표 (위키 조건 문구에서 찾는다, 이름은 "Power Station" 처럼 겹쳐 쓰지 않는다):
// [찾을 문구, 짧은 글 (문자열 또는 찾은 문구 → 글), 뜻, 종류(색)]
const EXTRACT_CONDITIONS = [
    [/Roubles|Euros|Dollars|루블|유로|달러/i, '유료', '돈을 내야 탈출', 'pay'],
    // "녹색 신호탄 = 열림"은 열린 탈출구 위로 신호탄이 오른다는 안내라 조건이 아니다 (직접 쏘는 탈출구만)
    [/신호탄을 하늘로|shoot a green flare/i, '신호탄', '녹색 신호탄을 쏴야 열림', 'item'],
    [/가방 미착용/, '가방 X', '가방을 메면 탈출 불가', 'no'],
    [/방탄조끼 미착용/, '조끼 X', '방탄조끼를 입으면 탈출 불가', 'no'],
    [/power|lever|button|switch|전원|레버/i, '전원', '전원·레버를 켜야 열림', 'act'],
    [/keycard|key\b|열쇠|키카드/i, '열쇠', '열쇠·키카드 필요', 'item'],
    [/(\d+)분 후부터/, (m) => `${m[1]}분 후`, '레이드 시작 후 일정 시간이 지나야 열림', 'time'],
    [/암호 쪽지/, '쪽지', '암호 쪽지 필요', 'item'],
    [/ice pick|paracord/i, '등반 장비', '등반 장비(얼음 도끼·파라코드) 필요', 'item'],
    [/minefield map/i, '지뢰 지도', '지뢰 지도 필요', 'item'],
];

// 탈출구의 조건 꼬리표 목록 [{ text, title, kind }]
function extractConditions(item) {
    const w = item.wiki || {};
    const req = w.requirements || '';
    const list = [];
    for (const [re, text, title, kind] of EXTRACT_CONDITIONS) {
        const m = req.match(re);
        if (m) list.push({ text: typeof text === 'function' ? text(m) : text, title, kind });
    }
    if (isCoopExtract(item)) list.push({ text: '협동', title: '스캐브와 협동해야 탈출', kind: 'act' });
    // 차량(택시) 탈출 V-Ex: 유료 · 1회용 · 랜덤은 택시 탈출이면 늘 같으므로 "택시 탈출" 하나로 묶는다
    if (/V-?Ex\b/i.test(item.name || '')) {
        return [
            { text: '택시 탈출', title: '차량 탈출 — 돈을 내고 타며 한 명(파티)만 쓸 수 있고, 레이드마다 오지 않을 수도 있음', kind: 'pay' },
            ...list.filter((c) => c.text !== '유료'),
        ];
    }
    if (w.singleUse === true) list.push({ text: '1회용', title: '한 명이 쓰면 닫힘', kind: 'time' });
    if (w.alwaysAvailable === false) list.push({ text: '랜덤', title: '레이드마다 열릴 수도, 닫혀 있을 수도 있음', kind: 'time' });
    return list;
}

const conditionTags = (conds) => conds.map((c) => `<span class="cond ${c.kind}">${escapeHtml(c.text)}</span>`).join('');

function extractInfoText(item) {
    return extractInfoRows(item).map(([k, v]) => `${k}: ${v}`).join('\n');
}

function extractPopupHtml(item, cls, label) {
    const conds = extractConditions(item);
    const rows = (conds.length ? `<div class="popup-conds">${conds.map((c) => `<div><span class="cond ${c.kind}">${escapeHtml(c.text)}</span>${escapeHtml(c.title)}</div>`).join('')}</div>` : '')
        + extractInfoRows(item).map(([k, v]) => `<div class="popup-extract-row"><span>${k}</span>${escapeHtml(v)}</div>`).join('');
    const source = item.source === 'wiki' ? '<div class="popup-elev">위치: 위키 지도 기준</div>' : '';
    return `<div class="popup-task extract-${cls}">${escapeHtml(label)}</div><div class="popup-item">${FACTION_KO[cls] || ''}</div>${rows}${source}`;
}

// 퀘스트 제목: 한국어 (영문 원문)
function taskTitle(task) {
    const en = task.enName || '';
    return en && en !== task.name ? `${task.name} (${en})` : task.name;
}

const escapeHtml = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

class TarkovMap {
    constructor(el, { onLevelChange, onMouseCoord, levelName, onLoadProgress, onMapContextMenu } = {}) {
        this.el = el;
        this.map = null;
        this.levelName = levelName || ((n) => n);
        this.onLevelChange = onLevelChange || (() => {});
        this.onMouseCoord = onMouseCoord || (() => {});
        // 지도 우클릭 (게임 좌표, Leaflet 좌표) → 메모 추가
        this.onMapContextMenu = onMapContextMenu || (() => {});
        // 위키 지도를 처음 열 때 타일 만드는 진행률 (0~1)
        this.onLoadProgress = onLoadProgress || (() => {});
        this.levelIndex = -1;
        this.objectiveTargets = {};
        this.playerMarker = null;
        this.loadToken = 0;
    }

    get layers() {
        // 위키 지도에만 따로 그려진 층(Interchange 주차장)은 위키 지도를 볼 때만 버튼을 더한다
        const extra = this.style === 'wiki' ? this.mapInfo?.wikiMap?.extraLayers || [] : [];
        return [...(this.cfg?.layers || []), ...extra];
    }

    availableStyles(mapInfo = this.mapInfo) {
        const cfg = mapInfo?.config;
        const s = [];
        // 위키 지도 이미지는 Referer 가 필요해 데스크톱(메인 프로세스가 받아 줌)에서만
        if (mapInfo?.wikiMap && window.api.getWikiImage) s.push('wiki');
        if (cfg?.svgPath) s.push('svg');
        if (cfg?.tilePath) s.push('tile');
        return s;
    }

    async setMap(mapInfo, preferredStyle) {
        const token = ++this.loadToken;
        const cfg = mapInfo.config;
        if (this.map) {
            this.map.remove();
            this.map = null;
        }
        this.cfg = cfg;
        this.mapInfo = mapInfo;
        this.levelTile = null;
        this.playerMarker = null;
        this.objectiveTargets = {};
        this.svgGroups = [];
        this.wikiPanels = [];
        wikiView = null;
        this.wikiSource?.close();
        this.wikiSource = null;
        // 지도를 불러오는 동안 이전 지도의 레이어에 마커를 넣지 않도록 비워 둔다
        this.extractLayer = null;
        this.questLayer = null;
        this.playerLayer = null;
        this.bossLayer = null;
        this.memoLayer = null;

        const styles = this.availableStyles(mapInfo);
        this.style = styles.includes(preferredStyle) ? preferredStyle : styles[0];

        // 위키 지도: 타일을 먼저 준비하고 (처음 여는 지도면 이미지를 받아 자른다, 못 하면 tarkov.dev 지도로) 위키 이미지 좌표계로 연다
        let wikiSource = null;
        this.tileProgress = 1;
        if (this.style === 'wiki') {
            const wiki = mapInfo.wikiMap;
            try {
                wikiSource = await WikiTiles.open({
                    file: wiki.file,
                    url: wiki.url,
                    rect: wiki.imageRect || [0, 0, ...wiki.size],
                    loadImage: () => window.api.getWikiImage(wiki.url),
                    onProgress: (r) => {
                        if (token !== this.loadToken) return;
                        this.tileProgress = r;
                        this.onLoadProgress(r);
                    },
                });
            } catch (err) {
                this.style = styles.find((st) => st !== 'wiki');
                if (!this.style) throw err;
            }
            if (token !== this.loadToken) {
                wikiSource?.close();
                return;
            }
        }
        this.wikiSource = wikiSource;
        if (wikiSource) wikiView = new WikiView(mapInfo.wikiMap);

        const maxZoom = Math.max(cfg.maxZoom + 2, 7);
        const bounds = getBounds(cfg.bounds);
        this.bounds = bounds;
        let map;
        if (wikiSource) {
            // 위키 지도는 위키 페이지처럼 이미지를 똑바로 세운 좌표계 (이미지 1px = 1). 처음에는 기본 판 영역을 보여 준다
            const [x1, y1, x2, y2] = wikiView.rect;
            const imageBounds = L.latLngBounds([y1, x1], [y2, x2]);
            const view = wikiView.base.view;
            const viewBounds = view ? L.latLngBounds(view.map(([x, y]) => [y, x])) : imageBounds;
            map = L.map(this.el, {
                crs: L.CRS.Simple,
                zoomSnap: 0.1,
                zoomDelta: 0.5,
                wheelPxPerZoomLevel: 120,
                attributionControl: false,
                minZoom: -6,
                maxZoom: 3,
                maxBounds: viewBounds.pad(0.3),
            });
            map.fitBounds(viewBounds);
            map.setMinZoom(map.getZoom() - 1);
            this.focusZoom = map.getZoom() + 1.5;
            this.baseLayer = new WikiTiles.WikiTileLayer(wikiSource, {
                className: 'base-map wiki-map',
                clip: view,
                bounds: viewBounds,
            }).addTo(map);
            // 다른 판 그림: 기본 판 자리로 옮기고 그 판 영역만 그린다 (층을 고를 때 setLevel 에서 켠다)
            this.wikiPanels = wikiView.panels.filter((p) => p.area && p.offset && p.levels.length).map((p) => {
                const [sx, sy] = wikiView.shiftOf(p);
                const area = p.area.map(([x, y]) => [x + sx, y + sy]);
                const layer = new WikiTiles.WikiTileLayer(wikiSource, {
                    className: 'wiki-map',
                    pane: 'levelPane',
                    clip: area,
                    shift: [sx, sy],
                    bounds: L.latLngBounds(area.map(([x, y]) => [y, x])),
                });
                return { levels: p.levels, layer };
            });
        } else {
            map = L.map(this.el, {
                crs: getCRS(cfg),
                zoomSnap: 0.1,
                zoomDelta: 0.5,
                wheelPxPerZoomLevel: 120,
                attributionControl: false,
                minZoom: cfg.minZoom,
                maxZoom,
                maxBounds: bounds.pad(0.6),
            });
            map.fitBounds(bounds);
            this.focusZoom = cfg.minZoom + 2;
        }
        this.map = map;
        map.createPane('levelPane').style.zIndex = 420;
        map.createPane('zonePane').style.zIndex = 440;

        const tileSize = cfg.tileSize || 256;
        this.tileOptions = { tileSize, bounds, maxZoom, maxNativeZoom: cfg.maxZoom };

        if (this.style === 'svg') {
            const svgBounds = cfg.svgBounds ? getBounds(cfg.svgBounds) : bounds;
            const svgEl = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
            svgEl.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
            this.baseLayer = L.svgOverlay(svgEl, svgBounds, { className: 'base-map' }).addTo(map);
            try {
                const text = await window.api.getSvg(cfg.svgPath);
                if (token !== this.loadToken) return;
                svgEl.innerHTML = text;
                const inner = svgEl.children[0];
                svgEl.setAttribute('viewBox', inner.getAttribute('viewBox'));
                this.svgGroups = [...inner.children].filter((c) => c.nodeName === 'g' && !!c.id);
                for (const g of this.svgGroups) {
                    if (g.id === cfg.svgLayer || g.dataset.keepWithGroup === cfg.svgLayer) {
                        g.classList.add('base-layer');
                    } else {
                        g.classList.add('overlay-layer', 'hidden-layer');
                    }
                }
            } catch (err) {
                if (cfg.tilePath) {
                    this.baseLayer.remove();
                    this.style = 'tile';
                    this.baseLayer = L.tileLayer(cfg.tilePath, this.tileOptions).addTo(map);
                } else {
                    throw err;
                }
            }
        } else if (this.style === 'tile') {
            this.baseLayer = L.tileLayer(cfg.tilePath, this.tileOptions).addTo(map);
        }
        if (token !== this.loadToken) return;

        this.bossLayer = L.layerGroup().addTo(map);
        this.extractLayer = L.layerGroup().addTo(map);
        this.memoLayer = L.layerGroup().addTo(map);
        this.questLayer = L.layerGroup().addTo(map);
        this.playerLayer = L.layerGroup().addTo(map);

        map.on('zoomend viewreset resize', () => this.scheduleExtractLabelLayout());
        map.on('mousemove', (e) => this.onMouseCoord(this.toGame(e.latlng)));
        map.on('contextmenu', (e) => this.onMapContextMenu(this.toGame(e.latlng), e.latlng));

        const defaultLevel = this.layers.findIndex((l) => l.show);
        this.setLevel(defaultLevel);
    }

    // Leaflet 좌표 → 게임 좌표 (높이 없음)
    toGame(latlng) {
        return wikiView ? wikiView.toGame(latlng) : { x: latlng.lng, z: latlng.lat };
    }

    baseElement() {
        if (!this.baseLayer) return null;
        return this.baseLayer._image || this.baseLayer.getContainer?.() || null;
    }

    setLevel(index) {
        if (!this.map) return;
        this.levelIndex = index;
        if (this.levelTile) {
            this.levelTile.remove();
            this.levelTile = null;
        }
        for (const g of this.svgGroups) {
            if (g.classList.contains('overlay-layer')) g.classList.add('hidden-layer');
        }
        const layer = this.layers[index];
        let overlay = false;
        // 위키 지도: 고른 층의 판 그림을 기본 판 자리에 겹쳐 그린다
        for (const p of this.wikiPanels || []) {
            const on = !!layer && p.levels.includes(layer.name);
            if (on && !this.map.hasLayer(p.layer)) p.layer.addTo(this.map);
            if (!on) p.layer.remove();
            overlay ||= on;
        }
        if (layer && this.style !== 'wiki') {
            const svgGroup = this.style === 'svg' && layer.svgLayer
                ? this.svgGroups.find((g) => g.id === layer.svgLayer)
                : null;
            if (svgGroup) {
                svgGroup.classList.remove('hidden-layer');
                overlay = true;
            } else if (layer.tilePath) {
                this.levelTile = L.tileLayer(layer.tilePath, { ...this.tileOptions, pane: 'levelPane' }).addTo(this.map);
                overlay = true;
            }
        }
        // 다른 층을 보는 동안 기본 층 지도를 흐리게 (위키 지도는 위에 겹쳐 그릴 층 그림이 있을 때만)
        const base = this.baseElement();
        if (base) base.classList.toggle('off-level', !!layer && !layer.show && (this.style !== 'wiki' || overlay));
        this.refreshMarkerLevels();
        this.onLevelChange(index);
    }

    // 층을 나눠 그린 위키 지도를 보는 중인지 (층을 위키 판 기준으로 정한다)
    get wikiLevels() {
        return !!wikiView && wikiView.panels.length > 1;
    }

    // 층 이름 → 층 번호 (기본 층·기본 판과 같은 층 이름이면 -1)
    levelIndexOf(name) {
        if (!name || wikiView?.base.levels.includes(name)) return -1;
        return this.layers.findIndex((l) => l.name === name);
    }

    // 지금 보는 층 (기본 판과 같은 층 버튼(Icebreaker 의무실)도 기본 층으로 본다)
    get activeLevel() {
        const layer = this.layers[this.levelIndex];
        return layer ? this.levelIndexOf(layer.name) : -1;
    }

    // 위키 지도에서 게임 좌표가 그려지는 판의 층 (판 고르기 규칙: 높이·위치 범위)
    wikiLevelOf(p) {
        const panel = wikiView.panels.find((x) => x.select
            && (!x.select.height || (p.y >= x.select.height[0] && p.y < x.select.height[1]))
            && (!x.select.bounds || inGameBounds(x.select.bounds, p))) || wikiView.base;
        return this.levelIndexOf(panel.levels[0]);
    }

    // 해당 위치가 현재 보이는 층에 있는지 (tarkov-dev markerIsOnActiveLayer 와 동일한 규칙)
    // level: 위키 지도에서 이 마커가 그려진 층 이름 (탈출구, null = 기본 층)
    isOnActiveLevel(p, top, bottom, level) {
        if (this.wikiLevels) return (level !== undefined ? this.levelIndexOf(level) : this.wikiLevelOf(p)) === this.activeLevel;
        return this.isOnLevel(this.levelIndex, p, top, bottom);
    }

    // 해당 위치가 index 층(-1 = 기본 층)에 보이는지
    isOnLevel(index, p, top, bottom) {
        for (let i = 0; i < this.layers.length; i++) {
            const layer = this.layers[i];
            if (i === index || !layer.extents) continue;
            const hasBounds = layer.extents.some((e) => e.bounds);
            if (hasBounds && onExtents(layer.extents, p, top, bottom) === 'full') return false;
        }
        const active = this.layers[index];
        if (active) return !!onExtents(active.extents, p, top, bottom);
        const baseExtents = [{ height: this.cfg.heightRange || [-1e9, 1e9], bounds: [this.cfg.bounds] }];
        return !!onExtents(baseExtents, p, top, bottom);
    }

    // 탈출구가 있는 층 하나 (-1 = 기본 층). 위키 지도에 그려진 층이 있으면 그 층,
    // 없으면 탈출 구역이 걸친 층 중 탈출 지점 높이에 가장 가까운 층 (기본 층은 0.5m 여유를 둔다)
    extractLevel(o) {
        if (this.wikiLevels) return o.level !== undefined ? this.levelIndexOf(o.level) : this.wikiLevelOf(o.gamePos);
        if (o.level) {
            const index = this.layers.findIndex((l) => l.name === o.level);
            if (index !== -1) return index;
        }
        const p = o.gamePos;
        const gap = (extents) => {
            let best = Infinity;
            for (const e of extents) {
                if (e.bounds && !e.bounds.some((b) => inGameBounds(b, p))) continue;
                const [lo, hi] = e.height;
                best = Math.min(best, p.y < lo ? lo - p.y : p.y >= hi ? p.y - hi : 0);
            }
            return best;
        };
        const score = (i) => (i === -1
            ? Math.max(0, gap([{ height: this.cfg.heightRange || [-1e9, 1e9] }]) - 0.5)
            : gap(this.layers[i].extents || [{ height: [-1e9, 1e9] }]));
        const all = [-1, ...this.layers.keys()];
        const on = all.filter((i) => this.isOnLevel(i, p, o.top, o.bottom));
        return (on.length ? on : all).reduce((a, b) => (score(b) < score(a) ? b : a));
    }

    // 지금 보는 층 번호 (extractLevel 과 같은 기준)
    get currentLevel() {
        return this.wikiLevels ? this.activeLevel : this.levelIndex;
    }

    // 층 번호(-1 = 기본 층) → 표시할 층 이름. 한 층 버튼에 여러 실제 층이 함께 그려진 층이면 높이로 실제 층 이름을 쓴다
    levelLabel(index, y) {
        if (index === -1) {
            const baseName = this.wikiLevels ? wikiView.base.levels[0] : null;
            return baseName ? this.levelName(baseName) : '1층';
        }
        const layer = this.layers[index];
        const floors = FLOOR_BY_HEIGHT[this.mapInfo?.key]?.[layer.name];
        if (floors && y !== undefined) return floors.find(([below]) => y < below)[1];
        return this.levelName(layer.name);
    }

    // 게임 좌표가 있는 층 이름 (층이 없는 맵이면 '')
    floorOf(p, top, bottom) {
        if (!this.map || !this.layers.length) return '';
        return this.levelLabel(this.extractLevel({ gamePos: p, top, bottom }), p.y);
    }

    // 층 번호(-1 = 기본 층)를 낮은 층부터 (층 단축키 위·아래 이동용).
    // 층마다 높이 구간 가운데의 중앙값으로 비교한다 (끝이 열린 구간은 열린 쪽으로 3m)
    levelsByHeight() {
        const mid = ([lo, hi]) => {
            const open = (v) => Math.abs(v) >= 1e3;
            if (open(lo) && open(hi)) return null;
            if (open(lo)) return hi - 3;
            if (open(hi)) return lo + 3;
            return (lo + hi) / 2;
        };
        const median = (vals) => {
            const v = vals.filter((x) => x !== null).sort((a, b) => a - b);
            return v.length ? v[Math.floor(v.length / 2)] : null;
        };
        const heights = this.layers.map((l) => median((l.extents || []).map((e) => mid(e.height))));
        // 기본 층: heightRange 가 있으면 그 가운데, 없으면 다른 층들 아래쪽 끝 중 가장 낮은 곳 바로 아래
        let base = this.cfg?.heightRange ? mid(this.cfg.heightRange) : null;
        if (base === null) {
            const los = this.layers.flatMap((l) => (l.extents || []).map((e) => e.height[0])).filter((v) => Math.abs(v) < 1e3);
            base = los.length ? Math.min(...los) - 1.5 : 0;
        }
        // 기본 판과 같은 층 버튼이 있으면(Icebreaker 의무실) 그 버튼만 쓴다
        const sameAsBase = this.wikiLevels && wikiView.base.levels.length > 0;
        return [...(sameAsBase ? [] : [-1]), ...this.layers.keys()]
            .map((i) => ({ i, h: i === -1 ? base : heights[i] ?? base }))
            .sort((a, b) => a.h - b.h)
            .map((x) => x.i);
    }

    detectLevel(p) {
        if (this.wikiLevels) {
            // 기본 판에 층 버튼이 따로 있으면(Icebreaker 의무실) 그 버튼을 고른다
            const index = this.wikiLevelOf(p);
            const baseName = wikiView.base.levels[0];
            return index === -1 && baseName ? this.layers.findIndex((l) => l.name === baseName) : index;
        }
        for (let i = 0; i < this.layers.length; i++) {
            const layer = this.layers[i];
            if (!layer.extents || !layer.extents.some((e) => e.bounds)) continue;
            if (onExtents(layer.extents, p)) return i;
        }
        return -1;
    }

    refreshMarkerLevels() {
        if (!this.map) return;
        // 현재 층이 아니면 그 마커가 속한 층 이름을 돌려준다 (현재 층이면 null)
        const otherLevelName = (o) => {
            if (this.isOnActiveLevel(o.gamePos, o.top, o.bottom, o.level)) return null;
            if (this.wikiLevels) {
                const index = o.level !== undefined ? this.levelIndexOf(o.level) : this.wikiLevelOf(o.gamePos);
                if (index !== -1) return this.levelName(this.layers[index].name);
                // 기본 층: 기본 판에 층 이름이 있으면(Icebreaker 의무실) 그 이름
                const baseName = wikiView.base.levels[0];
                return baseName ? this.levelName(baseName) : '1층';
            }
            const index = this.detectLevel(o.gamePos);
            if (index === -1) return this.levelIndex === -1 ? '' : '1층';
            return this.levelName(this.layers[index].name);
        };
        // 퀘스트 마커·탈출구는 층과 관계없이 항상 선명하게 보이고, 다른 층이면 층 이름만 붙인다
        const applyQuest = (layer) => {
            const o = layer.options || {};
            if (!o.gamePos || !layer._icon) return;
            const name = otherLevelName(o);
            layer._icon.classList.toggle('other-level', name !== null);
            layer._icon.dataset.level = name || '';
        };
        const applyExtract = (layer) => {
            const o = layer.options || {};
            const label = layer._icon?.querySelector('.extract-label');
            if (!o.gamePos || !label) return;
            // 탈출구는 한 층에만 속하게 해, 고른 층의 탈출구만 선명하고 나머지는 층 이름을 붙인다
            const home = this.extractLevel(o);
            const name = home !== this.currentLevel ? this.levelLabel(home, o.gamePos.y) : null;
            label.innerHTML = escapeHtml(name ? `${o.label} (${name})` : o.label)
                + (o.icons ? `<span class="extract-conds">${o.icons}</span>` : '');
            // 현재 층이 아닌 탈출구는 반투명하게
            layer._icon.classList.toggle('other-level', name !== null);
        };
        // 보스: 다른 층이면 반투명
        const applyBoss = (layer) => {
            const o = layer.options || {};
            if (!o.gamePos || !layer._icon) return;
            layer._icon.classList.toggle('other-level', this.extractLevel({ gamePos: o.gamePos }) !== this.currentLevel);
        };
        // 메모: 적어 둔 층이 아니면 반투명하고 층 이름을 붙인다
        const currentName = this.layers[this.levelIndex]?.name ?? null;
        const applyMemo = (layer) => {
            const o = layer.options || {};
            const label = layer._icon?.querySelector('.memo-label');
            if (!label) return;
            const other = !!this.layers.length && (o.memoLevel ?? null) !== currentName;
            const index = this.layers.findIndex((l) => l.name === o.memoLevel);
            label.textContent = other ? `${o.memoText} (${index === -1 ? '1층' : this.levelName(o.memoLevel)})` : o.memoText;
            layer._icon.classList.toggle('other-level', other);
        };
        this.questLayer?.eachLayer((l) => (l.eachLayer ? l.eachLayer(applyQuest) : applyQuest(l)));
        this.extractLayer?.eachLayer(applyExtract);
        this.bossLayer?.eachLayer(applyBoss);
        this.memoLayer?.eachLayer(applyMemo);
        this.scheduleExtractLabelLayout();
    }

    // 보스 출현 위치 표시 (show: 켬/끔). 지도 라벨에는 이름만, 확률은 팝업과 오른쪽 보스 목록에 쓴다
    // (확률이 하나로 정해지지 않은 보스(chance: null)는 확률을 쓰지 않는다)
    setBosses(show) {
        if (!this.bossLayer) return;
        this.bossLayer.clearLayers();
        const info = this.mapInfo;
        const inside = (p) => this.containsPosition(p);
        if (show) {
            // 같은 자리에 나오는 보스(세관 요새의 르샬라·나이트·사제 등)는 마커 하나로 묶는다
            const spots = new Map();
            for (const b of info.bosses || []) {
                for (const loc of b.locations) {
                    loc.positions.forEach((p) => {
                        if (!inside(p)) return;
                        const key = `${Math.round(p.x)},${Math.round(p.z)}`;
                        const spot = spots.get(key) || { p, entries: [] };
                        if (!spot.entries.some((e) => e.b === b)) spot.entries.push({ b, loc });
                        spots.set(key, spot);
                    });
                }
            }
            const pct = (v) => (v === null || v === undefined ? '' : `${Math.round(v * 100)}%`);
            // 보스 종류·확률은 오른쪽 보스 목록에 있으므로 지도에는 아이콘만 (이름은 마우스를 올렸을 때·팝업)
            for (const { p, entries } of spots.values()) {
                const m = L.marker(pos(p), {
                    icon: L.divIcon({ className: 'boss-marker', html: '<span class="boss-dot">💀</span>', iconSize: [0, 0] }),
                    gamePos: p,
                    title: entries.map((e) => e.b.name).join(' · '),
                });
                m.bindPopup(entries.map(({ b, loc }) => {
                    const escorts = b.escorts ? ` · 호위 ${b.escorts[0] === b.escorts[1] ? b.escorts[0] : `${b.escorts[0]}~${b.escorts[1]}`}명` : '';
                    const chance = pct(b.chance);
                    const line = [chance && `출현 확률 ${chance}`, escorts.replace(/^ · /, '')].filter(Boolean).join(' · ');
                    const locChance = pct(loc.chance);
                    return `<div class="popup-task">💀 ${escapeHtml(b.name)}${b.enName !== b.name ? ` <span class="muted">(${escapeHtml(b.enName)})</span>` : ''}</div>`
                        + (line ? `<div class="popup-item">${line}</div>` : '')
                        + `<div class="popup-elev">출현 구역: ${escapeHtml(loc.name)}${locChance ? ` (이 구역 ${locChance})` : ''}</div>`;
                }).join('<hr class="popup-sep">'));
                m.on('add', () => this.refreshMarkerLevels());
                m.addTo(this.bossLayer);
            }
        }
        this.refreshMarkerLevels();
    }

    // memos: [{ id, x, z, level, text }], onEdit(memo) / onDelete(memo)
    setMemos(memos, { onEdit, onDelete } = {}) {
        if (!this.memoLayer) return;
        this.memoLayer.clearLayers();
        for (const memo of memos || []) {
            const p = { x: memo.x, z: memo.z };
            if (!this.containsPosition(p)) continue;
            const m = L.marker(pos(p), {
                icon: L.divIcon({ className: 'memo-marker', html: `<span class="memo-pin">📌</span><span class="memo-label">${escapeHtml(memo.text)}</span>`, iconSize: [0, 0] }),
                memoText: memo.text,
                memoLevel: memo.level,
            });
            const box = document.createElement('div');
            box.className = 'memo-popup';
            box.innerHTML = `<div class="memo-text">${escapeHtml(memo.text)}</div>`
                + '<div class="memo-actions"><button class="ghost-btn small" data-act="edit">수정</button><button class="ghost-btn small danger" data-act="delete">삭제</button></div>';
            box.addEventListener('click', (e) => {
                const act = e.target.closest('[data-act]')?.dataset.act;
                if (!act) return;
                m.closePopup();
                if (act === 'edit') onEdit?.(memo);
                if (act === 'delete') onDelete?.(memo);
            });
            m.bindPopup(box);
            m.on('add', () => this.refreshMarkerLevels());
            m.addTo(this.memoLayer);
        }
        this.refreshMarkerLevels();
    }

    // 메모 입력 창 (지도 위 팝업). onSave(text) — 빈 글이면 저장하지 않는다
    openMemoEditor(latlng, text, onSave) {
        if (!this.map) return;
        const box = document.createElement('div');
        box.className = 'memo-editor';
        box.innerHTML = `<textarea rows="3" maxlength="200" placeholder="메모 (Enter 저장 · Shift+Enter 줄바꿈)">${escapeHtml(text || '')}</textarea>`
            + '<div class="memo-actions"><button class="ghost-btn small" data-act="cancel">취소</button><button class="accent-btn small" data-act="save">저장</button></div>';
        const popup = L.popup({ minWidth: 220 }).setLatLng(latlng).setContent(box).openOn(this.map);
        const area = box.querySelector('textarea');
        const save = () => {
            const value = area.value.trim();
            this.map.closePopup(popup);
            if (value) onSave(value);
        };
        box.addEventListener('click', (e) => {
            const act = e.target.closest('[data-act]')?.dataset.act;
            if (act === 'save') save();
            if (act === 'cancel') this.map.closePopup(popup);
        });
        area.addEventListener('keydown', (e) => {
            e.stopPropagation();
            if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                save();
            }
            if (e.key === 'Escape') this.map.closePopup(popup);
        });
        L.DomEvent.disableClickPropagation(box);
        setTimeout(() => area.focus(), 0);
    }

    // 메모의 Leaflet 좌표
    latLngOf(p) {
        return L.latLng(pos(p));
    }

    scheduleExtractLabelLayout() {
        if (this.labelLayoutFrame) return;
        this.labelLayoutFrame = requestAnimationFrame(() => {
            this.labelLayoutFrame = null;
            this.layoutExtractLabels();
        });
    }

    // 탈출구 라벨끼리 겹치면 점(마커)은 그대로 두고 라벨만 Y축으로 밀어 서로 비켜 놓는다
    layoutExtractLabels() {
        if (!this.map || !this.extractLayer) return;
        const GAP = 2;
        const items = [];
        this.extractLayer.eachLayer((layer) => {
            const label = layer._icon?.querySelector('.extract-label');
            if (!label) return;
            label.style.transform = '';
            const w = label.offsetWidth;
            const h = label.offsetHeight;
            if (!w || !h) return;
            const p = this.map.latLngToContainerPoint(layer.getLatLng());
            // .extract-label 의 CSS 위치(left: 10px, top: -10px)와 같은 기준
            items.push({ label, x: p.x + 10, y: p.y - 10, w, h, dy: 0, group: null });
        });
        items.sort((a, b) => a.y - b.y || a.x - b.x);
        const placed = [];
        for (const it of items) {
            let top = it.y;
            // 가로로 겹치는 이미 놓인 라벨과 세로로도 겹치면 그 아래로 내린다 (더 겹치지 않을 때까지)
            for (let moved = true; moved;) {
                moved = false;
                for (const o of placed) {
                    if (it.x >= o.x + o.w || o.x >= it.x + it.w) continue;
                    const oTop = o.y + o.dy;
                    if (top < oTop + o.h + GAP && oTop < top + it.h + GAP) {
                        top = oTop + o.h + GAP;
                        if (!it.group) it.group = o.group;
                        else if (it.group !== o.group) {
                            const old = o.group;
                            for (const m of old.members) { m.group = it.group; it.group.members.push(m); }
                        }
                        moved = true;
                    }
                }
            }
            it.dy = top - it.y;
            if (!it.group) it.group = { members: [] };
            it.group.members.push(it);
            placed.push(it);
        }
        // 아래로만 밀면 무리가 한쪽으로 쏠리므로, 겹친 무리 전체를 밀린 양의 절반만큼 위로 되돌려 점 주변에 고르게 둔다
        // (되돌린 뒤 다른 라벨과 새로 겹치면 되돌리지 않는다)
        const overlaps = (a, b) => !(a.x >= b.x + b.w || b.x >= a.x + a.w)
            && a.y + a.dy < b.y + b.dy + b.h + GAP && b.y + b.dy < a.y + a.dy + a.h + GAP;
        for (const g of new Set(items.map((it) => it.group))) {
            if (g.members.length < 2) continue;
            const shift = Math.max(...g.members.map((m) => m.dy)) / 2;
            for (const m of g.members) m.dy -= shift;
            const clash = g.members.some((m) => items.some((o) => o.group !== g && overlaps(m, o)));
            if (clash) for (const m of g.members) m.dy += shift;
        }
        for (const it of items) {
            if (it.dy) it.label.style.transform = `translateY(${Math.round(it.dy)}px)`;
        }
    }

    // filter: { pmc, scav, transit } 종류별 표시 여부, icons: 탈출 조건 아이콘 표시 (기본 켬)
    setExtracts(filter) {
        if (!this.extractLayer) return;
        this.extractLayer.clearLayers();
        this.unplacedControl?.remove();
        this.unplacedControl = null;
        const info = this.mapInfo;
        const showIcons = filter?.icons !== false;
        const unplaced = [];
        const add = (item, cls, label) => {
            if (!extractVisible(item, cls, filter)) return;
            if (!item.position) {
                unplaced.push({ item, cls, label });
                return;
            }
            // 지도 밖 좌표(맵 끝 조명탄 탈출구 등)는 가장 가까운 지도 안쪽 자리에 놓는다
            const spot = OFF_MAP_SPOTS[info.key]?.find((s) => s.name.test(label));
            const edge = this.offMap(item.position)
                ? (spot ? { x: spot.x, y: item.position.y, z: spot.z } : this.insidePosition(item.position))
                : null;
            // 탈출 조건 아이콘은 라벨 뒤에 붙인다 (뜻은 팝업과 마우스를 올렸을 때)
            const icons = showIcons ? conditionTags(extractConditions(item)) : '';
            const m = L.marker(pos(edge || item.position), {
                icon: L.divIcon({
                    className: `extract-marker ${cls}${edge ? ' off-map' : ''}`,
                    html: `<span class="extract-dot"></span><span class="extract-label">${escapeHtml(label)}</span>`,
                    iconSize: [0, 0],
                }),
                gamePos: item.position,
                top: item.top,
                bottom: item.bottom,
                level: item.level,
                label,
                icons,
                title: extractConditions(item).map((c) => `${c.text}: ${c.title}`).join('\n'),
                interactive: true,
            });
            m.bindPopup(extractPopupHtml(item, cls, label)
                + (edge ? '<div class="popup-elev">실제 위치는 지도 밖 맵 끝 (표시 위치는 가장 가까운 지도 안쪽)</div>' : ''));
            m.on('add', () => this.refreshMarkerLevels());
            m.addTo(this.extractLayer);
        };
        for (const e of info.extracts) {
            const cls = e.faction === 'pmc' ? 'pmc' : e.faction === 'scav' ? 'scav' : 'shared';
            add(e, cls, e.name);
        }
        for (const t of info.transits) {
            add(t, 'transit', t.name);
        }
        // 위키에는 있지만 지도 위치를 알 수 없는 탈출구는 목록으로 보여준다
        if (unplaced.length) {
            const control = L.control({ position: 'bottomleft' });
            control.onAdd = () => {
                const div = L.DomUtil.create('div', 'unplaced-extracts');
                div.innerHTML = '<div class="unplaced-title">위치 미표시 탈출구</div>'
                    + unplaced.map(({ item, cls, label }) => `<div class="extract-marker ${cls}" title="${escapeHtml(extractInfoText(item))}"><span class="extract-label">${escapeHtml(label)}</span></div>`).join('');
                L.DomEvent.disableClickPropagation(div);
                return div;
            };
            this.unplacedControl = control.addTo(this.map);
        }
        this.refreshMarkerLevels();
    }

    // entries: [{ task, color, number, completed:Set }]
    // 여러 퀘스트(또는 한 퀘스트의 여러 목표)가 같은 지점을 쓰면 마커가 겹쳐 하나만 보이므로,
    // 같은 지점의 마커는 하나로 합쳐 퀘스트 번호를 나란히 보여주고 팝업에 목표를 모두 적는다
    setQuestMarkers(entries) {
        if (!this.questLayer) return;
        this.questLayer.clearLayers();
        this.objectiveTargets = {};
        const apiIds = this.mapInfo.apiIds;
        const spots = [];
        const addToSpot = (position, top, bottom, item) => {
            let spot = spots.find((s) => Math.hypot(s.position.x - position.x, s.position.z - position.z) < MERGE_DISTANCE
                && Math.abs((s.position.y || 0) - (position.y || 0)) < MERGE_HEIGHT);
            if (!spot) {
                spot = { position, top, bottom, items: [] };
                spots.push(spot);
            }
            spot.items.push(item);
        };
        for (const { task, color, number, completed } of entries) {
            for (const obj of task.objectives) {
                const done = completed.has(obj.id);
                const popupHtml = (p, approx) => `<div class="popup-task" style="border-color:${color}">${escapeHtml(taskTitle(task))}</div>`
                    + `<div class="popup-obj">${escapeHtml(obj.description)}</div>`
                    + (obj.questItem ? `<div class="popup-item">퀘스트 아이템: ${escapeHtml(obj.questItem.name)}</div>` : '')
                    + (obj.keys || []).map((g) => `<div class="popup-item">필요 열쇠: ${escapeHtml([...new Set(g.map((k) => k.name))].join(' 또는 '))}</div>`).join('')
                    + (obj.bring?.length ? `<div class="popup-item">가져갈 아이템: ${escapeHtml([...new Set(obj.bring.map((k) => k.name))].join(' 또는 '))}</div>` : '')
                    + (approx ? '<div class="popup-elev">위키 가이드 지도 기준 대략 위치</div>' : `<div class="popup-elev">높이: ${p.y.toFixed(1)}</div>`);
                for (const zone of obj.zones) {
                    if (!apiIds.includes(zone.map)) continue;
                    if (!this.containsPosition(zone.position)) continue;
                    if (zone.outline.length >= 3) {
                        L.polygon(zone.outline.map(pos), {
                            color, weight: 2, fillOpacity: 0.15, pane: 'zonePane', interactive: false,
                            gamePos: zone.position, top: zone.top, bottom: zone.bottom,
                            className: done ? 'done-zone' : '',
                        }).addTo(this.questLayer);
                    }
                    addToSpot(zone.position, zone.top, zone.bottom, {
                        kind: 'zone', color, number, done, objId: obj.id, popup: popupHtml(zone.position, zone.approx),
                    });
                }
                for (const loc of obj.locations) {
                    if (!apiIds.includes(loc.map)) continue;
                    for (const p of loc.positions) {
                        if (!this.containsPosition(p)) continue;
                        addToSpot(p, undefined, undefined, { kind: 'item', color, number, done, objId: obj.id, popup: popupHtml(p) });
                    }
                }
            }
        }
        for (const spot of spots) {
            // 번호 칩은 퀘스트·표시 종류마다 하나 (같은 퀘스트의 목표 여러 개는 칩 하나로)
            const chips = [];
            for (const it of spot.items) {
                const chip = chips.find((c) => c.number === it.number && c.kind === it.kind);
                if (chip) chip.done = chip.done && it.done;
                else chips.push({ number: it.number, kind: it.kind, color: it.color, done: it.done });
            }
            chips.sort((a, b) => a.number - b.number);
            const width = chips.length * CHIP_SIZE + (chips.length - 1) * CHIP_GAP;
            const html = chips.map((c) => (c.kind === 'zone'
                ? `<span class="qm-chip zone${c.done ? ' done' : ''}" style="background:${c.color}">${c.number}</span>`
                : `<span class="qm-chip item${c.done ? ' done' : ''}" style="border-color:${c.color}">${c.number}</span>`)).join('');
            const popups = [...new Set(spot.items.map((it) => it.popup))];
            const marker = L.marker(pos(spot.position), {
                icon: L.divIcon({
                    className: `quest-marker${chips.every((c) => c.done) ? ' done' : ''}`,
                    html: `<div class="qm-chips">${html}</div>`,
                    iconSize: [width, CHIP_SIZE],
                    iconAnchor: [width / 2, CHIP_SIZE / 2],
                }),
                riseOnHover: true,
                gamePos: spot.position,
                top: spot.top,
                bottom: spot.bottom,
            }).bindPopup(popups.join('<hr class="popup-sep">'), { maxHeight: 320 });
            marker.addTo(this.questLayer);
            for (const objId of new Set(spot.items.map((it) => it.objId))) {
                (this.objectiveTargets[objId] ||= []).push({ marker, position: spot.position });
            }
        }
        this.refreshMarkerLevels();
    }

    hasTarget(objId) {
        return !!this.objectiveTargets[objId];
    }

    focusObjective(objId) {
        const targets = this.objectiveTargets[objId];
        if (!targets?.length || !this.map) return;
        const current = targets.__cursor ?? -1;
        const next = (current + 1) % targets.length;
        targets.__cursor = next;
        const t = targets[next];
        this.setLevel(this.detectLevel(t.position));
        // 확대 없이 현재 배율 그대로 위치만 표시
        this.map.panTo(pos(t.position), { animate: true, duration: 0.4 });
        setTimeout(() => t.marker.openPopup(), 450);
    }

    // 지금 보는 지도 스타일과 상관없이, tarkov.dev 지도 범위나 위키 이미지 범위 중 하나라도 벗어나는지
    offMap(p) {
        if (!inGameBounds(this.cfg.bounds, p)) return true;
        return !!this.mapInfo.wikiMap && !new WikiView(this.mapInfo.wikiMap).contains(p);
    }

    // 지도 밖 게임 좌표 → 지도 안쪽 게임 좌표 (맵 끝 지뢰 지대 쪽).
    // 위키·도면·위성 지도에서 같은 자리에 보이도록 tarkov.dev 지도 범위와 위키 이미지 범위 둘 다의 안쪽(가장자리에서 15m 들인 곳)으로,
    // 지도 가운데를 향해 가장 적게 옮긴다
    insidePosition(p) {
        const INSET_M = 15;
        const [[bx1, bz1], [bx2, bz2]] = this.cfg.bounds;
        const inRange = (v, a, b, d) => v >= Math.min(a, b) + d && v <= Math.max(a, b) - d;
        const wiki = this.mapInfo.wikiMap ? new WikiView(this.mapInfo.wikiMap) : null;
        // 위키 이미지 1m 의 픽셀 수
        const wikiInset = wiki ? INSET_M / Math.sqrt(Math.abs(wiki.m.det)) : 0;
        const ok = (q) => {
            if (!inRange(q.x, bx1, bx2, INSET_M) || !inRange(q.z, bz1, bz2, INSET_M)) return false;
            if (!wiki) return true;
            const [wx, wy] = wiki.toWiki(q);
            const [x1, y1, x2, y2] = wiki.rect;
            return inRange(wx, x1, x2, wikiInset) && inRange(wy, y1, y2, wikiInset);
        };
        const center = { x: (bx1 + bx2) / 2, y: p.y, z: (bz1 + bz2) / 2 };
        const at = (t) => ({ x: p.x + (center.x - p.x) * t, y: p.y, z: p.z + (center.z - p.z) * t });
        if (!ok(center)) return center;
        // 두 범위 모두 볼록한 사각형이라 가운데 쪽으로 갈수록 한 번 들어오면 계속 안쪽이다 → 이분 탐색
        let lo = 0;
        let hi = 1;
        for (let i = 0; i < 30; i++) {
            const mid = (lo + hi) / 2;
            if (ok(at(mid))) hi = mid;
            else lo = mid;
        }
        return at(hi);
    }

    // 지금 지도 범위 안의 좌표인지 (다른 맵의 스크린샷인지 확인용)
    containsPosition(p) {
        if (wikiView) return wikiView.contains(p);
        return !!this.cfg && inGameBounds(this.cfg.bounds, p);
    }

    setPlayer(p, { autoFloor, autoPan, deadZonePercent }) {
        // 지도를 불러오는 중이면 건너뛴다 (불러오기가 끝나면 마지막 위치를 다시 표시한다)
        if (!this.map || !this.playerLayer) return;
        let rotation;
        if (wikiView) {
            rotation = wikiView.screenAngle(p.rotation ?? 0);
        } else {
            let addRotation = this.cfg.coordinateRotation || 0;
            if (addRotation === 90 || addRotation === 270) addRotation += 180;
            rotation = (p.rotation ?? 0) + addRotation;
        }
        const icon = L.divIcon({
            className: 'player-marker',
            // 가운데 점이 정확한 위치이고, 부채꼴·화살촉은 바라보는 방향만 나타낸다
            // (예전 화살표는 끝이 위치보다 18px 앞에 있어 끝을 내 위치로 읽으면 수십 미터 어긋나 보였다)
            html: `<svg viewBox="0 0 48 48" width="48" height="48" style="transform: rotate(${rotation}deg)">
                     <path d="M24 24 L9 8 A22 22 0 0 1 39 8 Z" fill="#22d3ee" fill-opacity=".5" stroke="#22d3ee" stroke-width="1"/>
                     <path d="M24 3 L29.5 12 L24 10 L18.5 12 Z" fill="#22d3ee" stroke="#0b1f24" stroke-width="1.2" stroke-linejoin="round"/>
                     <circle cx="24" cy="24" r="6" fill="#22d3ee" stroke="#fff" stroke-width="2.5"/>
                   </svg>`,
            iconSize: [48, 48],
            iconAnchor: [24, 24],
        });
        const latlng = pos(p.position);
        if (this.playerMarker) {
            this.playerMarker.setLatLng(latlng);
            this.playerMarker.setIcon(icon);
        } else {
            this.playerMarker = L.marker(latlng, { icon, zIndexOffset: 2000, interactive: false }).addTo(this.playerLayer);
        }
        if (autoFloor) this.setLevel(this.detectLevel(p.position));

        const size = this.map.getSize();
        const pt = this.map.latLngToContainerPoint(latlng);
        const ratio = Math.min(Math.max(deadZonePercent, 10), 99) / 100;
        const mx = (size.x * (1 - ratio)) / 2;
        const my = (size.y * (1 - ratio)) / 2;
        const outside = pt.x < 0 || pt.y < 0 || pt.x > size.x || pt.y > size.y;
        const inDeadZone = pt.x < mx || pt.x > size.x - mx || pt.y < my || pt.y > size.y - my;
        if (outside && !this.playerShownOnce) {
            this.map.setView(latlng, Math.max(this.map.getZoom(), this.focusZoom));
        } else if (autoPan && inDeadZone) {
            this.map.panTo(latlng, { animate: true, duration: 0.4 });
        }
        this.playerShownOnce = true;
    }

    centerOnPlayer() {
        if (this.playerMarker) this.map.panTo(this.playerMarker.getLatLng());
    }

    clearPlayer() {
        this.playerLayer?.clearLayers();
        this.playerMarker = null;
        this.playerShownOnce = false;
    }

    invalidate() {
        this.map?.invalidateSize();
    }
}

window.TarkovMap = TarkovMap;
