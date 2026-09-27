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

// 게임 좌표 → Leaflet 좌표 (lat = z, lng = x)
function pos(p) {
    return [p.z, p.x];
}

function getBounds(b) {
    return L.latLngBounds([b[0][1], b[0][0]], [b[1][1], b[1][0]]);
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
                if (getBounds(bounds).contains(pos(p))) return type;
            }
        }
    }
    return false;
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
    const source = item.source === 'wiki' ? '<div class="popup-elev">위치: 위키 지도에서 계산 (대략적)</div>' : '';
    return `<div class="popup-task extract-${cls}">${escapeHtml(label)}</div><div class="popup-item">${FACTION_KO[cls] || ''}</div>${rows}${source}`;
}

// 퀘스트 제목: 한국어 (영문 원문)
function taskTitle(task) {
    const en = task.enName || '';
    return en && en !== task.name ? `${task.name} (${en})` : task.name;
}

const escapeHtml = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

class TarkovMap {
    constructor(el, { onLevelChange, onMouseCoord, levelName } = {}) {
        this.el = el;
        this.map = null;
        this.levelName = levelName || ((n) => n);
        this.onLevelChange = onLevelChange || (() => {});
        this.onMouseCoord = onMouseCoord || (() => {});
        this.levelIndex = -1;
        this.objectiveTargets = {};
        this.playerMarker = null;
        this.loadToken = 0;
    }

    get layers() {
        return this.cfg?.layers || [];
    }

    availableStyles(cfg = this.cfg) {
        const s = [];
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

        const styles = this.availableStyles(cfg);
        this.style = styles.includes(preferredStyle) ? preferredStyle : styles[0];
        const maxZoom = Math.max(cfg.maxZoom + 2, 7);
        const bounds = getBounds(cfg.bounds);
        this.bounds = bounds;

        const map = L.map(this.el, {
            crs: getCRS(cfg),
            zoomSnap: 0.1,
            zoomDelta: 0.5,
            wheelPxPerZoomLevel: 120,
            attributionControl: false,
            minZoom: cfg.minZoom,
            maxZoom,
            maxBounds: bounds.pad(0.6),
        });
        this.map = map;
        map.createPane('levelPane').style.zIndex = 420;
        map.createPane('zonePane').style.zIndex = 440;
        map.fitBounds(bounds);

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
        } else {
            this.baseLayer = L.tileLayer(cfg.tilePath, this.tileOptions).addTo(map);
        }
        if (token !== this.loadToken) return;

        this.extractLayer = L.layerGroup().addTo(map);
        this.questLayer = L.layerGroup().addTo(map);
        this.playerLayer = L.layerGroup().addTo(map);

        map.on('mousemove', (e) => this.onMouseCoord({ x: e.latlng.lng, z: e.latlng.lat }));

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
        if (layer) {
            const svgGroup = this.style === 'svg' && layer.svgLayer
                ? this.svgGroups.find((g) => g.id === layer.svgLayer)
                : null;
            if (svgGroup) {
                svgGroup.classList.remove('hidden-layer');
            } else if (layer.tilePath) {
                this.levelTile = L.tileLayer(layer.tilePath, { ...this.tileOptions, pane: 'levelPane' }).addTo(this.map);
            }
        }
        const base = this.baseElement();
        if (base) base.classList.toggle('off-level', !!layer && !layer.show);
        this.refreshMarkerLevels();
        this.onLevelChange(index);
    }

    // 해당 위치가 현재 보이는 층에 있는지 (tarkov-dev markerIsOnActiveLayer 와 동일한 규칙)
    isOnActiveLevel(p, top, bottom) {
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
            if (this.isOnActiveLevel(o.gamePos, o.top, o.bottom)) return null;
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

    setExtracts(show) {
        if (!this.extractLayer) return;
        this.extractLayer.clearLayers();
        this.unplacedControl?.remove();
        this.unplacedControl = null;
        if (!show) return;
        const info = this.mapInfo;
        const unplaced = [];
        const add = (item, cls, label) => {
            if (!item.position || !this.bounds.contains(pos(item.position))) {
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
    setQuestMarkers(entries) {
        if (!this.questLayer) return;
        this.questLayer.clearLayers();
        this.objectiveTargets = {};
        const apiIds = this.mapInfo.apiIds;
        for (const { task, color, number, completed } of entries) {
            for (const obj of task.objectives) {
                const done = completed.has(obj.id);
                const popupHtml = (p) => `<div class="popup-task" style="border-color:${color}">${escapeHtml(taskTitle(task))}</div>`
                    + `<div class="popup-obj">${escapeHtml(obj.description)}</div>`
                    + (obj.questItem ? `<div class="popup-item">퀘스트 아이템: ${escapeHtml(obj.questItem.name)}</div>` : '')
                    + `<div class="popup-elev">높이: ${p.y.toFixed(1)}</div>`;
                const targets = [];
                for (const zone of obj.zones) {
                    if (!apiIds.includes(zone.map)) continue;
                    if (!this.bounds.contains(pos(zone.position))) continue;
                    const levelOpts = { gamePos: zone.position, top: zone.top, bottom: zone.bottom };
                    const group = L.layerGroup();
                    if (zone.outline.length >= 3) {
                        L.polygon(zone.outline.map(pos), {
                            color, weight: 2, fillOpacity: 0.15, pane: 'zonePane', interactive: false, ...levelOpts,
                            className: done ? 'done-zone' : '',
                        }).addTo(group);
                    }
                    const marker = L.marker(pos(zone.position), {
                        icon: L.divIcon({
                            className: `quest-marker${done ? ' done' : ''}`,
                            html: `<span style="background:${color}">${number}</span>`,
                            iconSize: [22, 22],
                            iconAnchor: [11, 11],
                        }),
                        riseOnHover: true,
                        ...levelOpts,
                    }).bindPopup(popupHtml(zone.position));
                    marker.addTo(group);
                    group.addTo(this.questLayer);
                    targets.push({ marker, position: zone.position });
                }
                for (const loc of obj.locations) {
                    if (!apiIds.includes(loc.map)) continue;
                    for (const p of loc.positions) {
                        if (!this.bounds.contains(pos(p))) continue;
                        const marker = L.marker(pos(p), {
                            icon: L.divIcon({
                                className: `quest-item-marker${done ? ' done' : ''}`,
                                html: `<span style="border-color:${color}">${number}</span>`,
                                iconSize: [22, 22],
                                iconAnchor: [11, 11],
                            }),
                            riseOnHover: true,
                            gamePos: p,
                        }).bindPopup(popupHtml(p));
                        marker.addTo(this.questLayer);
                        targets.push({ marker, position: p });
                    }
                }
                if (targets.length) this.objectiveTargets[obj.id] = targets;
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

    setPlayer(p, { autoFloor, autoPan, deadZonePercent }) {
        if (!this.map) return;
        let addRotation = this.cfg.coordinateRotation || 0;
        if (addRotation === 90 || addRotation === 270) addRotation += 180;
        const rotation = (p.rotation ?? 0) + addRotation;
        const icon = L.divIcon({
            className: 'player-marker',
            html: `<svg viewBox="0 0 40 40" width="40" height="40" style="transform: rotate(${rotation}deg)">
                     <path d="M20 2 L31 30 L20 23 L9 30 Z" fill="#22d3ee" stroke="#0b1f24" stroke-width="2" stroke-linejoin="round"/>
                   </svg>`,
            iconSize: [40, 40],
            iconAnchor: [20, 20],
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
            this.map.setView(latlng, Math.max(this.map.getZoom(), this.cfg.minZoom + 2));
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
