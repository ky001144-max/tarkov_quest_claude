// tarkov.dev 데이터 로더
// the-hideout/tarkov-data-manager 가 생성해 json.tarkov.dev 로 배포하는 원본 JSON을 받아
// 렌더러에서 쓰기 좋은 형태(한국어 번역 적용)로 가공한다. 실패 시 디스크 캐시를 사용한다.
// 원본(맵 JSON만 8MB 이상) 파싱은 별도 프로세스(data-builder.js)에서 하고, 가공 결과만 캐시해 메인 프로세스 메모리를 작게 유지한다.
const fs = require('fs');
const path = require('path');
const { wikiUrl, parseWikiResponse, applyWikiExtracts, wikiImageInfoUrl, parseWikiImageInfo } = require('./wiki-extracts');
const { fetchWikiEvents, EVENTS_VERSION } = require('./wiki-events');

const JSON_API = 'https://json.tarkov.dev';
const MAX_AGE_MS = 6 * 3600 * 1000;
// 가공 결과 형식이 바뀌면 올린다 (이전 캐시 무효화)
const BUILD_VERSION = 17;
// 위키 이벤트 퀘스트는 자주 바뀌지 않아 하루에 한 번만 새로 받는다
const EVENTS_MAX_AGE_MS = 24 * 3600 * 1000;
const HANGUL = /[가-힣]/;
// 위키 지도 이미지는 위키 페이지에서 불러온 것처럼 Referer 를 붙여야 받을 수 있다
const WIKI_IMAGE_HOST = /^https:\/\/static\.wikia\.nocookie\.net\/escapefromtarkov_gamepedia\/images\//;
const WIKI_IMAGE_MAX_AGE_MS = 7 * 24 * 3600 * 1000;
const MAPS_JSON_URL = 'https://raw.githubusercontent.com/the-hideout/tarkov-dev/main/src/data/maps.json';

// tarkov.dev maps.json 그룹 키 → 같은 지도를 쓰는 추가 API 맵
const MAP_ALIASES = {
    'ground-zero': ['ground-zero-21', 'ground-zero-tutorial'],
    'factory': ['night-factory'],
    'the-lab': ['the-lab-dark'],
};

class DataService {
    constructor(cacheDir, bundledMapsPath) {
        this.cacheDir = cacheDir;
        this.bundledMapsPath = bundledMapsPath;
        this.overridesPath = path.join(path.dirname(bundledMapsPath), 'ko_overrides.json');
        this.extraTasksPath = path.join(path.dirname(bundledMapsPath), 'extra_tasks.json');
        this.wikiExtractsPath = path.join(path.dirname(bundledMapsPath), 'wiki_extracts.json');
        this.eventTasksPath = path.join(path.dirname(bundledMapsPath), 'event_tasks.json');
        this.eventKoPath = path.join(path.dirname(bundledMapsPath), 'event_ko.json');
        this.eventLocationsPath = path.join(path.dirname(bundledMapsPath), 'event_locations.json');
        fs.mkdirSync(cacheDir, { recursive: true });
    }

    cacheFile(name) {
        return path.join(this.cacheDir, name.replace(/[^a-z0-9_.-]/gi, '_'));
    }

    async fetchWithCache(url, cacheName, { force = false, maxAgeMs = MAX_AGE_MS } = {}) {
        const file = this.cacheFile(cacheName);
        if (!force && fs.existsSync(file)) {
            const age = Date.now() - fs.statSync(file).mtimeMs;
            if (age < maxAgeMs) {
                return fs.readFileSync(file, 'utf8');
            }
        }
        try {
            const res = await fetch(url, { headers: { 'User-Agent': 'EFT-Where-Am-I-KO/1.0' } });
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const text = await res.text();
            fs.writeFileSync(file, text, 'utf8');
            return text;
        } catch (err) {
            if (fs.existsSync(file)) {
                return fs.readFileSync(file, 'utf8');
            }
            throw new Error(`${url} 다운로드 실패: ${err.message}`);
        }
    }

    async fetchJson(apiPath, opts) {
        const text = await this.fetchWithCache(`${JSON_API}/${apiPath}`, `${apiPath}.json`, opts);
        return JSON.parse(text);
    }

    async getSvg(url) {
        if (!/^https:\/\/assets\.tarkov\.dev\//.test(url)) {
            throw new Error('허용되지 않은 SVG 주소');
        }
        return this.fetchWithCache(url, `svg_${path.basename(url)}`, { maxAgeMs: 7 * 24 * 3600 * 1000 });
    }

    // 위키 지도 이미지 { data, type } (디스크 캐시, 받지 못하면 이전 캐시)
    async getWikiImage(url) {
        if (!WIKI_IMAGE_HOST.test(url)) throw new Error('허용되지 않은 지도 이미지 주소');
        const name = this.cacheFile(`wikimap_${url.split('/images/')[1]}`);
        const meta = `${name}.type`;
        const cached = () => ({ data: fs.readFileSync(name), type: fs.readFileSync(meta, 'utf8') });
        try {
            if (Date.now() - fs.statSync(name).mtimeMs < WIKI_IMAGE_MAX_AGE_MS) return cached();
        } catch { /* 새로 받기 */ }
        try {
            const res = await fetch(url, {
                headers: { 'User-Agent': 'EFT-Where-Am-I-KO/1.0', Referer: 'https://escapefromtarkov.fandom.com/' },
            });
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const data = Buffer.from(await res.arrayBuffer());
            const type = res.headers.get('content-type') || 'image/png';
            fs.writeFileSync(name, data);
            fs.writeFileSync(meta, type, 'utf8');
            return { data, type };
        } catch (err) {
            try {
                return cached();
            } catch {
                throw new Error(`위키 지도 이미지 다운로드 실패: ${err.message}`);
            }
        }
    }

    // 위키 지도 이미지 파일 이름 → 주소 (받지 못하면 빈 객체 → 위키 지도 없이 표시)
    async getWikiImageUrls(wikiExtracts, force) {
        const files = Object.values(wikiExtracts).map((w) => w.image?.file).filter(Boolean).sort();
        if (!files.length) return {};
        // 지도 목록이 바뀌면(새 맵 추가 등) 이전 캐시를 쓰지 않도록 캐시 이름에 목록을 넣는다
        const key = require('crypto').createHash('sha1').update(files.join('|')).digest('hex').slice(0, 10);
        try {
            return parseWikiImageInfo(await this.fetchWithCache(wikiImageInfoUrl(files), `wiki-images-${key}.json`, { force }));
        } catch {
            return {};
        }
    }

    loadOverrides() {
        try {
            return JSON.parse(fs.readFileSync(this.overridesPath, 'utf8'));
        } catch {
            return {};
        }
    }

    loadExtraTasks() {
        try {
            return JSON.parse(fs.readFileSync(this.extraTasksPath, 'utf8')).tasks || [];
        } catch {
            return [];
        }
    }

    // 위키 탈출구 목록 (받지 못하거나 형식이 바뀌어 비어 있으면 동봉한 스냅샷)
    async getWikiExtracts(force) {
        try {
            const parsed = parseWikiResponse(await this.fetchWithCache(wikiUrl(), 'wiki-extracts.json', { force }));
            if (Object.keys(parsed).length) return parsed;
        } catch { /* 스냅샷 사용 */ }
        try {
            return JSON.parse(fs.readFileSync(this.wikiExtractsPath, 'utf8'));
        } catch {
            return {};
        }
    }

    // 위키 이벤트 퀘스트 (가공 결과를 캐시하고, 받지 못하면 이전 캐시 → 동봉한 스냅샷 순으로 쓴다)
    async getWikiEvents(force) {
        const file = this.cacheFile('wiki-events.json');
        const readJson = (p) => {
            const data = JSON.parse(fs.readFileSync(p, 'utf8'));
            if (data.v !== EVENTS_VERSION) throw new Error('old events');
            return data;
        };
        if (!force) {
            try {
                if (Date.now() - fs.statSync(file).mtimeMs < EVENTS_MAX_AGE_MS) return readJson(file);
            } catch { /* 새로 받기 */ }
        }
        try {
            const result = await fetchWikiEvents();
            fs.writeFileSync(file, JSON.stringify(result), 'utf8');
            return result;
        } catch {
            for (const p of [file, this.eventTasksPath]) {
                try {
                    return readJson(p);
                } catch { /* 다음 후보 */ }
            }
            return { quests: [] };
        }
    }

    loadEventLocations() {
        try {
            return JSON.parse(fs.readFileSync(this.eventLocationsPath, 'utf8')).quests || {};
        } catch {
            return {};
        }
    }

    loadEventKo() {
        try {
            return JSON.parse(fs.readFileSync(this.eventKoPath, 'utf8'));
        } catch {
            return {};
        }
    }

    async getMapConfigs(force) {
        try {
            const text = await this.fetchWithCache(MAPS_JSON_URL, 'tarkov-dev-maps.json', { force, maxAgeMs: 24 * 3600 * 1000 });
            return JSON.parse(text);
        } catch {
            return JSON.parse(fs.readFileSync(this.bundledMapsPath, 'utf8'));
        }
    }

    // 가공된 데이터를 JSON 문자열로 돌려준다 (렌더러에서 파싱)
    async load(mode = 'regular', force = false) {
        const file = this.cacheFile(`built_${mode}.json`);
        const readBuilt = () => {
            const text = fs.readFileSync(file, 'utf8');
            if (!text.startsWith(`{"v":${BUILD_VERSION},`)) throw new Error('old build');
            return text;
        };
        if (!force) {
            try {
                if (Date.now() - fs.statSync(file).mtimeMs < MAX_AGE_MS) return readBuilt();
            } catch { /* 새로 가공 */ }
        }
        try {
            const text = await this.buildInProcess(mode, force);
            fs.writeFileSync(file, text, 'utf8');
            return text;
        } catch (err) {
            try {
                return readBuilt();
            } catch {
                throw err;
            }
        }
    }

    // 끝나면 종료되는 유틸리티 프로세스에서 가공해, 원본 파싱에 쓴 메모리를 모두 운영체제에 돌려준다
    buildInProcess(mode, force) {
        const { utilityProcess } = require('electron');
        return new Promise((resolve, reject) => {
            const child = utilityProcess.fork(path.join(__dirname, 'data-builder.js'), [], { serviceName: 'EFT data builder' });
            child.once('message', (msg) => {
                if (msg.ok) resolve(msg.text);
                else reject(new Error(msg.error));
                child.kill();
            });
            child.once('exit', (code) => reject(new Error(`데이터 가공 프로세스 종료 (${code})`)));
            child.postMessage({ cacheDir: this.cacheDir, bundledMapsPath: this.bundledMapsPath, mode, force });
        });
    }

    async build(mode, force) {
        const opts = { force };
        const [tasks, tasksKo, tasksEn, maps, mapsKo, mapsEn, traders, tradersKo, mapConfigs, wikiExtracts, wikiEvents] = await Promise.all([
            this.fetchJson(`${mode}/tasks`, opts),
            this.fetchJson(`${mode}/tasks_ko`, opts),
            this.fetchJson(`${mode}/tasks_en`, opts),
            this.fetchJson(`${mode}/maps`, opts),
            this.fetchJson(`${mode}/maps_ko`, opts),
            this.fetchJson(`${mode}/maps_en`, opts),
            this.fetchJson(`${mode}/traders`, opts),
            this.fetchJson(`${mode}/traders_ko`, opts),
            this.getMapConfigs(force),
            this.getWikiExtracts(force),
            this.getWikiEvents(force),
        ]);

        const makeTr = (ko, en) => (key) => {
            if (key === undefined || key === null) return '';
            return ko.data?.[key] ?? en.data?.[key] ?? key;
        };
        // tarkov.dev 한국어 데이터에 없는 퀘스트 문장은 보완 번역(영문 → 한국어)으로 채운다
        const overrides = this.loadOverrides();
        const trTaskBase = makeTr(tasksKo, tasksEn);
        const trTask = (key) => {
            const text = trTaskBase(key);
            if (HANGUL.test(text)) return text;
            const en = (tasksEn.data?.[key] ?? text).trim();
            return overrides[en] ?? text;
        };
        const trMap = makeTr(mapsKo, mapsEn);
        const wikiImageUrls = await this.getWikiImageUrls(wikiExtracts, force);
        const trTrader = makeTr(tradersKo, { data: {} });

        // 상인
        const traderList = Object.values(traders.data).map((t) => ({
            id: t.id,
            name: trTrader(t.name),
            normalizedName: t.normalizedName,
            image: t.imageLink || `https://assets.tarkov.dev/${t.id}.webp`,
        }));
        const traderById = Object.fromEntries(traderList.map((t) => [t.id, t]));

        // 맵
        const apiMaps = Object.values(maps.data.maps);
        // 위키 지도 좌표를 다듬는 기준 물체 종류 (wiki-extracts REF_TYPES 와 같은 이름)
        const containerTypes = Object.fromEntries(Object.values(maps.data.lootContainers || {}).map((c) => [c.id, c.normalizedName]));
        const refType = (name) => {
            if (/cache/.test(name)) return 'cache';
            if (/body|dead-scav/.test(name)) return 'body';
            if (/supply-crate/.test(name)) return 'supply';
            return name;
        };
        const wikiRefs = (m) => [
            ...(m.lootContainers || []).map((c) => ({ type: refType(containerTypes[c.lootContainer] || ''), position: c.position })),
            ...(m.spawns || []).flatMap((sp) => [
                ...(sp.sides.includes('pmc') || sp.sides.includes('all') ? [{ type: 'spawn-pmc', position: sp.position }] : []),
                ...(sp.sides.includes('scav') || sp.sides.includes('all') ? [{ type: 'spawn-scav', position: sp.position }] : []),
            ]),
            ...(m.locks || []).map((l) => ({ type: 'lock', position: l.position })),
            ...(m.stationaryWeapons || []).map((w) => ({ type: 'gun', position: w.position })),
            ...(m.switches || []).map((sw) => ({ type: 'switch', position: sw.position })),
        ].filter((r) => r.position);
        const mapList = [];
        for (const group of mapConfigs) {
            const config = group.maps.find((m) => m.projection === 'interactive');
            if (!config) continue;
            const primary = apiMaps.find((m) => m.normalizedName === group.normalizedName);
            if (!primary) continue;
            const aliases = MAP_ALIASES[group.normalizedName] || [];
            const members = apiMaps.filter((m) => m.normalizedName === group.normalizedName || aliases.includes(m.normalizedName));
            // 탈출구·이동 지점은 위키 목록 기준 (좌표도 두 자료가 다르면 위키 지도 우선)
            const trMapEn = (key) => mapsEn.data?.[key] ?? key;
            const devPoints = {
                extracts: (primary.extracts || []).map((e) => ({
                    name: trMapEn(e.name), label: trMap(e.name), faction: e.faction, position: e.position, top: e.top, bottom: e.bottom,
                })),
                transits: (primary.transits || []).map((t) => ({
                    name: trMapEn(t.description), label: trMap(t.description), position: t.position, top: t.top, bottom: t.bottom,
                })),
                // 위키 지도 좌표를 맞추는 기준점으로만 쓴다
                switches: (primary.switches || []).map((s) => ({ name: trMapEn(s.name), position: s.position })),
                refs: wikiRefs(primary),
            };
            const points = applyWikiExtracts(wikiExtracts[group.normalizedName], devPoints, config.bounds, group.normalizedName) || devPoints;
            const toMarker = (p) => ({
                name: p.label,
                faction: p.faction,
                position: p.position,
                top: p.top,
                bottom: p.bottom,
                source: p.source || 'tarkov.dev',
                wiki: p.wiki || null,
                // 층을 나눠 그린 위키 지도에서 이 탈출구가 그려진 층 (null = 기본 층, 없으면 높이로 판단)
                level: p.level,
            });
            mapList.push({
                key: group.normalizedName,
                name: trMap(primary.name),
                apiIds: members.map((m) => m.id),
                nameIds: members.map((m) => (m.nameId || '').toLowerCase()),
                config,
                // 위키 지도 바탕 이미지 (게임 좌표에 맞출 수 있는 맵만)
                wikiMap: points.wikiMap && wikiImageUrls[points.wikiMap.file]
                    ? { ...points.wikiMap, url: wikiImageUrls[points.wikiMap.file] }
                    : null,
                extracts: points.extracts.map(toMarker),
                transits: points.transits.map(toMarker),
            });
        }

        // 퀘스트
        const questItems = tasks.data.questItems || {};
        const taskList = Object.values(tasks.data.tasks).map((t) => {
            const objectives = (t.objectives || []).map((o) => {
                const qi = o.questItem ? questItems[o.questItem] : null;
                return {
                    id: o.id,
                    type: o.type,
                    description: trTask(o.description),
                    count: o.count || 0,
                    optional: !!o.optional,
                    maps: o.maps || [],
                    zones: (o.zones || []).map((z) => ({
                        map: z.map,
                        position: z.position,
                        outline: z.outline || [],
                        top: z.top,
                        bottom: z.bottom,
                    })),
                    locations: (o.possibleLocations || []).map((l) => ({ map: l.map, positions: l.positions || [] })),
                    questItem: qi ? { name: trTask(qi.name), icon: qi.iconLink } : null,
                };
            });
            const mapIds = new Set();
            if (t.map) mapIds.add(t.map);
            for (const o of objectives) {
                o.maps.forEach((m) => mapIds.add(m));
                o.zones.forEach((z) => z.map && mapIds.add(z.map));
                o.locations.forEach((l) => l.map && mapIds.add(l.map));
            }
            const trader = traderById[t.trader] || { id: t.trader, name: '?', image: '' };
            return {
                id: t.id,
                name: trTask(t.name),
                enName: (tasksEn.data?.[t.name] ?? t.name).trim(),
                normalizedName: t.normalizedName,
                trader: { id: trader.id, name: trader.name, image: trader.image },
                minPlayerLevel: t.minPlayerLevel || 0,
                kappaRequired: !!t.kappaRequired,
                lightkeeperRequired: !!t.lightkeeperRequired,
                requires: (t.taskRequirements || []).map((r) => r.task),
                mapIds: [...mapIds],
                objectives,
                link: `https://tarkov.dev/task/${t.normalizedName}`,
            };
        });
        const taskNameById = Object.fromEntries(taskList.map((t) => [t.id, t.name]));
        for (const t of taskList) {
            t.requires = t.requires.map((id) => taskNameById[id]).filter(Boolean);
        }

        // tarkov.dev에 아직 없는 최신 퀘스트는 위키 기반 보완 데이터로 채운다 (같은 영문 이름이 생기면 tarkov.dev 쪽을 쓴다)
        const normName = (s) => String(s).toLowerCase().replace(/[^a-z0-9]/g, '');
        const taskByEnName = new Map(Object.values(tasks.data.tasks).map((t, i) => [normName(tasksEn.data?.[t.name] ?? t.name), taskList[i]]));
        const traderByNormalized = Object.fromEntries(traderList.map((t) => [t.normalizedName, t]));
        const mapIdByNormalized = Object.fromEntries(apiMaps.map((m) => [m.normalizedName, m.id]));
        const extras = this.loadExtraTasks().filter((x) => !taskByEnName.has(normName(x.enName)));
        // 위키 기반 퀘스트 (x: { enName, name, trader(normalizedName), wiki, requires, objectives, maps? })
        const added = [];
        const addWikiTask = (x, idPrefix, extra = {}) => {
            const id = `${idPrefix}-${normName(x.enName)}`;
            const objectives = (x.objectives || []).map((o, i) => ({
                id: `${id}-${i}`,
                type: o.type || '',
                description: o.description,
                count: o.count || 0,
                optional: !!o.optional,
                maps: (o.maps || []).map((m) => mapIdByNormalized[m]).filter(Boolean),
                zones: o.zones || [],
                locations: [],
                questItem: o.questItem ? { name: o.questItem, icon: '' } : null,
            }));
            const taskMaps = (x.maps || []).map((m) => mapIdByNormalized[m]).filter(Boolean);
            const trader = traderByNormalized[x.trader] || { id: x.trader, name: x.traderName || '?', image: '' };
            const task = {
                id,
                name: x.name,
                enName: x.enName,
                normalizedName: normName(x.enName),
                trader: { id: trader.id, name: trader.name, image: trader.image },
                minPlayerLevel: x.minPlayerLevel || 0,
                kappaRequired: !!x.kappaRequired,
                lightkeeperRequired: !!x.lightkeeperRequired,
                requires: x.requires || [],
                mapIds: [...new Set([...objectives.flatMap((o) => [...o.maps, ...o.zones.map((z) => z.map)]), ...taskMaps])],
                objectives,
                link: `https://escapefromtarkov.fandom.com/wiki/${x.wiki}`,
                ...extra,
            };
            taskList.push(task);
            taskByEnName.set(normName(x.enName), task);
            added.push(task);
        };
        for (const x of extras) addWikiTask(x, 'wiki');

        // 이벤트 퀘스트 (이벤트 기간에만 받을 수 있어 event 정보로 따로 구분한다)
        const eventKo = this.loadEventKo();
        const koOf = (dict, en) => eventKo[dict]?.[en] || en;
        // 위키 가이드 지도 기준 대략 위치 (윤곽 없이 번호 마커만 표시)
        const eventLocations = this.loadEventLocations();
        const zonesOf = (enName, description) => (eventLocations[enName] || [])
            .filter((l) => mapIdByNormalized[l.map] && description.toLowerCase().includes(l.match.toLowerCase()))
            .flatMap((l) => l.positions.map((p) => ({ map: mapIdByNormalized[l.map], position: p, outline: [], approx: true })));
        const traderKeyByWikiName = (name) => traderList.find((t) => normName(t.normalizedName) === normName(name))?.normalizedName || name;
        for (const q of wikiEvents.quests || []) {
            const event = {
                name: q.event ? koOf('events', q.event.name) : '기타 이벤트',
                enName: q.event?.name || '',
                date: q.event?.date || '',
                active: !!q.active,
            };
            const existing = taskByEnName.get(normName(q.enName));
            if (existing) {
                // tarkov.dev 에도 있는 이벤트 퀘스트는 좌표가 있는 tarkov.dev 데이터를 쓰고 이벤트 정보만 붙인다
                existing.event = event;
                continue;
            }
            addWikiTask({
                enName: q.enName,
                name: koOf('names', q.enName),
                trader: traderKeyByWikiName(q.trader),
                traderName: q.trader,
                wiki: q.wiki,
                requires: q.requires,
                kappaRequired: q.kappaRequired,
                maps: q.maps,
                objectives: q.objectives.map((o) => ({
                    description: koOf('text', o.description), optional: o.optional, maps: o.maps, zones: zonesOf(q.enName, o.description),
                })),
            }, 'event', { event });
        }
        for (const t of added) {
            t.requires = t.requires.map((en) => taskByEnName.get(normName(en))?.name || en);
        }

        return {
            v: BUILD_VERSION,
            mode,
            loadedAt: new Date().toISOString(),
            maps: mapList,
            tasks: taskList,
            traders: traderList,
        };
    }
}

module.exports = { DataService };
