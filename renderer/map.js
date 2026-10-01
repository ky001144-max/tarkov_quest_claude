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

function extractInfoText(item) {
    return extractInfoRows(item).map(([k, v]) => `${k}: ${v}`).join('\n');
}

function extractPopupHtml(item, cls, label) {
    const rows = extractInfoRows(item).map(([k, v]) => `<div class="popup-extract-row"><span>${k}</span>${escapeHtml(v)}</div>`).join('');
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
    constructor(el, { onLevelChange, onMouseCoord, levelName, onLoadProgress } = {}) {
        this.el = el;
        this.map = null;
        this.levelName = levelName || ((n) => n);
        this.onLevelChange = onLevelChange || (() => {});
        this.onMouseCoord = onMouseCoord || (() => {});
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

        this.extractLayer = L.layerGroup().addTo(map);
        this.questLayer = L.layerGroup().addTo(map);
        this.playerLayer = L.layerGroup().addTo(map);

        map.on('mousemove', (e) => this.onMouseCoord(wikiView ? wikiView.toGame(e.latlng) : { x: e.latlng.lng, z: e.latlng.lat }));

        const defaultLevel = this.layers.findIndex((l) => l.show);
        this.setLevel(defaultLevel);
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
        for (let i = 0; i < this.layers.length; i++) {
            const layer = this.layers[i];
            if (i === this.levelIndex || !layer.extents) continue;
            const hasBounds = layer.extents.some((e) => e.bounds);
            if (hasBounds && onExtents(layer.extents, p, top, bottom) === 'full') return false;
        }
        const active = this.layers[this.levelIndex];
        if (active) return !!onExtents(active.extents, p, top, bottom);
        const baseExtents = [{ height: this.cfg.heightRange || [-1e9, 1e9], bounds: [this.cfg.bounds] }];
        return !!onExtents(baseExtents, p, top, bottom);
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
            const name = otherLevelName(o);
            label.textContent = name ? `${o.label} (${name})` : o.label;
        };
        this.questLayer?.eachLayer((l) => (l.eachLayer ? l.eachLayer(applyQuest) : applyQuest(l)));
        this.extractLayer?.eachLayer(applyExtract);
    }

    // filter: { pmc, scav, transit } 종류별 표시 여부
    setExtracts(filter) {
        if (!this.extractLayer) return;
        this.extractLayer.clearLayers();
        this.unplacedControl?.remove();
        this.unplacedControl = null;
        const info = this.mapInfo;
        const unplaced = [];
        const add = (item, cls, label) => {
            if (!extractVisible(item, cls, filter)) return;
            if (!item.position || !this.containsPosition(item.position)) {
                unplaced.push({ item, cls, label });
                return;
            }
            const m = L.marker(pos(item.position), {
                icon: L.divIcon({
                    className: `extract-marker ${cls}`,
                    html: `<span class="extract-dot"></span><span class="extract-label">${escapeHtml(label)}</span>`,
                    iconSize: [0, 0],
                }),
                gamePos: item.position,
                top: item.top,
                bottom: item.bottom,
                level: item.level,
                label,
                interactive: true,
            });
            m.bindPopup(extractPopupHtml(item, cls, label));
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
