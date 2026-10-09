// tarkov.dev 데이터 로더
// the-hideout/tarkov-data-manager 가 생성해 json.tarkov.dev 로 배포하는 원본 JSON을 받아
// 렌더러에서 쓰기 좋은 형태(한국어 번역 적용)로 가공한다. 실패 시 디스크 캐시를 사용한다.
// 원본(맵 JSON만 8MB 이상) 파싱은 별도 프로세스(data-builder.js)에서 하고, 가공 결과만 캐시해 메인 프로세스 메모리를 작게 유지한다.
const fs = require('fs');
const path = require('path');
const { WIKI_API, wikiUrl, parseWikiResponse, applyWikiExtracts, wikiImageInfoUrl, parseWikiImageInfo } = require('./wiki-extracts');
const { fetchWikiEvents, EVENTS_VERSION } = require('./wiki-events');
const { fetchQuestPhotos } = require('./wiki-quest-photos');

const JSON_API = 'https://json.tarkov.dev';
const MAX_AGE_MS = 6 * 3600 * 1000;
// 가공 결과 형식이 바뀌면 올린다 (이전 캐시 무효화)
const BUILD_VERSION = 25;
// 위키 이벤트 퀘스트는 자주 바뀌지 않아 하루에 한 번만 새로 받는다
const EVENTS_MAX_AGE_MS = 24 * 3600 * 1000;
const HANGUL = /[가-힣]/;
// 위키 지도 이미지는 위키 페이지에서 불러온 것처럼 Referer 를 붙여야 받을 수 있다
const WIKI_IMAGE_HOST = /^https:\/\/static\.wikia\.nocookie\.net\/escapefromtarkov_gamepedia\/images\//;
const WIKI_IMAGE_MAX_AGE_MS = 7 * 24 * 3600 * 1000;
const QUEST_PHOTOS_MAX_AGE_MS = 3 * 24 * 3600 * 1000;
// 퀘스트 사진 목록 형식이 바뀌면 올린다 (2: 사진마다 맵, 3: 지도 그림 빼기)
const QUEST_PHOTOS_VERSION = 3;
// 위키 주소(https://…/wiki/First_in_Line) → 문서 제목
const wikiTitle = (link) => {
    const m = String(link || '').match(/\/wiki\/([^?#]+)/);
    return m ? decodeURIComponent(m[1]).replace(/_/g, ' ') : null;
};
const MAPS_JSON_URL = 'https://raw.githubusercontent.com/the-hideout/tarkov-dev/main/src/data/maps.json';

// tarkov.dev maps.json 그룹 키 → 같은 지도를 쓰는 추가 API 맵
const MAP_ALIASES = {
    'ground-zero': ['ground-zero-21', 'ground-zero-tutorial'],
    'factory': ['night-factory'],
    'the-lab': ['the-lab-dark'],
};

// tarkov.dev 한국어 데이터에 없는 보스 이름
const BOSS_NAME_KO = {
    Knight: '나이트', Partisan: '파르티잔', Kaban: '카반', Kollontay: '콜론타이',
    'Shadow of Tagilla': '타길라의 그림자', 'The Wedge': '웨지', 'The Wedge (Labs)': '웨지 (연구소)',
};

// 사전에 없는 아이템 이름을 옮기는 규칙 (영문 → 한국어)
const ITEM_NAME_RULES = [
    [/^(.+) ammo pack \((\d+) pcs\)$/, '$1 탄약 팩 ($2발)'],
    [/^(\d+(?:\.\d+)?x\d+mm .+) \((\d+) pcs\)$/, '$1 ($2발)'],
    [/^26x75mm flare cartridge \(Red\)$/, '26x75mm 신호탄 (빨강)'],
    [/^26x75mm flare cartridge \(Yellow\)$/, '26x75mm 신호탄 (노랑)'],
    [/^26x75mm flare cartridge \(Green\)$/, '26x75mm 신호탄 (초록)'],
    [/^Health Resort (west|east) wing (office )?room (\d+) key$/, (m, wing, office, n) => `요양소 ${wing === 'west' ? '서관' : '동관'} ${n}호 ${office ? '사무실 ' : ''}열쇠`],
    [/^Dorm room (\d+) key$/, '기숙사 $1호 열쇠'],
    [/^((?:RB|ZB)-[\w-]+) key$/, '$1 열쇠'],
];

function itemDisplayName(ko, en, dict) {
    if (!en) return ko;
    let kr = HANGUL.test(ko) ? ko : dict[en];
    if (!kr) {
        const rule = ITEM_NAME_RULES.find(([re]) => re.test(en));
        if (rule) kr = en.replace(rule[0], rule[1]);
    }
    if (!kr) return en;
    // tarkov.dev 한국어 이름에 영문이 이미 들어 있으면 그대로
    // (예: "벨루가 식당 지배인 열쇠 (Beluga restaurant director key)", "Propane tank 프로판 탱크 (5L)")
    if (kr.toLowerCase().includes(en.toLowerCase())) return kr;
    const latin = kr.match(/[A-Za-z][\w.-]*(?:\s+[A-Za-z][\w.-]*)+/);
    if (latin && en.toLowerCase().includes(latin[0].toLowerCase())) return kr;
    return `${kr} (${en})`;
}

// 화면에서 쓰는 지도 설정만 남긴다 (위성 타일 주소·지도 라벨·작성자 등은 빼서 가공 데이터를 줄인다)
const MAP_CONFIG_KEYS = ['minZoom', 'maxZoom', 'transform', 'coordinateRotation', 'bounds', 'svgBounds', 'svgPath', 'svgLayer', 'heightRange'];
const LAYER_KEYS = ['name', 'svgLayer', 'show', 'extents'];
const pick = (obj, keys) => Object.fromEntries(keys.filter((k) => obj[k] !== undefined).map((k) => [k, obj[k]]));
function pickMapConfig(config) {
    const out = pick(config, MAP_CONFIG_KEYS);
    if (config.layers) out.layers = config.layers.map((l) => pick(l, LAYER_KEYS));
    return out;
}

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
        this.itemNamesKoPath = path.join(path.dirname(bundledMapsPath), 'item_names_ko.json');
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

    // 위키 퀘스트 문서의 위치 사진 [{ url, caption, map }] (문서 제목별로 며칠 동안 저장)
    async getQuestPhotos(title) {
        if (!title) return [];
        const file = this.cacheFile('wiki-quest-photos.json');
        let cache = {};
        try {
            cache = JSON.parse(fs.readFileSync(file, 'utf8'));
        } catch { /* 처음 */ }
        const hit = cache[title];
        const fresh = hit?.v === QUEST_PHOTOS_VERSION;
        if (fresh && Date.now() - hit.at < QUEST_PHOTOS_MAX_AGE_MS) return hit.photos;
        const fetchJson = async (url) => {
            const res = await fetch(url, { headers: { 'User-Agent': 'EFT-Where-Am-I-KO/1.0' } });
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            return res.json();
        };
        try {
            const photos = await fetchQuestPhotos(WIKI_API, title, fetchJson);
            cache[title] = { v: QUEST_PHOTOS_VERSION, at: Date.now(), photos };
            fs.writeFileSync(file, JSON.stringify(cache), 'utf8');
            return photos;
        } catch (err) {
            if (fresh) return hit.photos;
            throw new Error(`위키 퀘스트 사진을 받지 못했습니다: ${err.message}`);
        }
    }

    // 위키 사진 한 장 { data, type } (위키 이미지 서버가 Referer 를 요구해 메인 프로세스에서 받는다. 디스크에는 두지 않는다)
    async getWikiPhoto(url) {
        if (!WIKI_IMAGE_HOST.test(url)) throw new Error('허용되지 않은 사진 주소');
        const res = await fetch(url, {
            headers: { 'User-Agent': 'EFT-Where-Am-I-KO/1.0', Referer: 'https://escapefromtarkov.fandom.com/' },
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return { data: Buffer.from(await res.arrayBuffer()), type: res.headers.get('content-type') || 'image/png' };
    }

    // 타일로 잘라 저장한 위키 지도 원본 이미지는 지운다 (url 없으면 남은 원본 전부)
    dropWikiImage(url) {
        if (url && !WIKI_IMAGE_HOST.test(url)) return;
        const prefix = url ? path.basename(this.cacheFile(`wikimap_${url.split('/images/')[1]}`)) : 'wikimap_';
        try {
            for (const f of fs.readdirSync(this.cacheDir)) {
                if (f === prefix || f === `${prefix}.type` || (!url && f.startsWith(prefix))) fs.rmSync(path.join(this.cacheDir, f), { force: true });
            }
        } catch { /* 없으면 그만 */ }
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

    loadItemNamesKo() {
        try {
            return JSON.parse(fs.readFileSync(this.itemNamesKoPath, 'utf8'));
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
        const [tasks, tasksKo, tasksEn, maps, mapsKo, mapsEn, traders, tradersKo, mapConfigs, wikiExtracts, wikiEvents, items, itemsKo, itemsEn] = await Promise.all([
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
            // 아이템 이름(퀘스트에 필요한 열쇠·아이템 표시용)은 받지 못해도 나머지는 쓸 수 있게 한다
            this.fetchJson(`${mode}/items`, opts).catch(() => ({ data: {} })),
            this.fetchJson(`${mode}/items_ko`, opts).catch(() => ({ data: {} })),
            this.fetchJson(`${mode}/items_en`, opts).catch(() => ({ data: {} })),
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
        const roundPos = (p) => ({ x: +p.x.toFixed(1), y: +p.y.toFixed(1), z: +p.z.toFixed(1) });
        // 보스: 이름 · 출현 확률 · 출현 구역(구역별 확률과 위치) · 호위 수.
        // 한 맵에 같은 보스가 여러 번 등록되어 등록마다 확률이 다르면(등대 로그 등) 확률은 비우고(null) 하나로 합친다.
        // 몹 종류가 달라도 이름이 같으면(쇄빙선 블랙 디비전 3종 등) 같은 보스로 본다. PvE 의 AI PMC(pmcUSEC·pmcBEAR)는 보스가 아니라 뺀다
        const mobs = maps.data.mobs || {};
        const mobEnName = (mob) => mapsEn.data?.[mobs[mob]?.name] || mob;
        // tarkov.dev 보스 이름 → 위키 지도 출현 마커 이름 (같은 이름이면 생략).
        // 레이더·로그·블랙 디비전 같은 무리는 위키에 구역 표시만 한두 개 있어서 tarkov.dev 의 실제 출현 지점을 그대로 쓴다
        const WIKI_BOSS_NAMES = {
            Knight: ['The Goons', 'Knight'], 'Big Pipe': ['The Goons'], 'Bird Eye': ['The Goons'], 'Cultist Priest': ['Cultists'],
            Raider: [], Rogue: [], 'Black Div.': [], AF: [],
        };
        const wikiNorm = (s) => s.trim().toLowerCase();
        // 위키 지도에 그 보스의 출현 마커가 있으면 그 위치를 쓴다 (tarkov.dev 구역 좌표는 Woods 처럼 맵 곳곳에 흩어진 경우가 있다).
        // 높이·구역 이름은 같은 보스의 가장 가까운 tarkov.dev 위치에서 가져온다. 위키에 없으면 tarkov.dev 위치 그대로
        const placeOnWiki = (enName, locations, wikiBosses) => {
            const names = (WIKI_BOSS_NAMES[enName] || [enName]).map(wikiNorm);
            const marks = (wikiBosses || []).filter((w) => names.includes(wikiNorm(w.name)));
            const devPts = locations.flatMap((loc) => loc.positions.map((p) => ({ p, loc })));
            if (!marks.length || !devPts.length) return locations;
            const out = new Map();
            for (const w of marks) {
                let near = devPts[0];
                for (const d of devPts) {
                    if (Math.hypot(d.p.x - w.position.x, d.p.z - w.position.z) < Math.hypot(near.p.x - w.position.x, near.p.z - w.position.z)) near = d;
                }
                const p = { x: w.position.x, y: w.position.y ?? near.p.y, z: w.position.z };
                const loc = out.get(near.loc) || { ...near.loc, positions: [] };
                if (!loc.positions.some((q) => Math.hypot(q.x - p.x, q.z - p.z) < 1)) loc.positions.push(p);
                out.set(near.loc, loc);
            }
            return [...out.values()];
        };
        const bossesOf = (m, wikiBosses) => {
            const byName = new Map();
            for (const b of m.bosses || []) {
                if (/^pmc(USEC|BEAR)$/i.test(b.mob)) continue;
                const list = byName.get(mobEnName(b.mob)) || [];
                list.push(b);
                byName.set(mobEnName(b.mob), list);
            }
            return [...byName].map(([enName, entries]) => {
                const mob = entries[0].mob;
                const chances = new Set(entries.map((b) => b.spawnChance));
                const counts = entries.flatMap((b) => (b.escorts || []).flatMap((e) => (e.amount || []).map((a) => a.count)));
                const locations = new Map();
                for (const b of entries) {
                    for (const l of b.spawnLocations || []) {
                        if (!l.positions?.length) continue;
                        const name = trMap(l.name);
                        const loc = locations.get(name) || { name, chances: new Set(), positions: [] };
                        loc.chances.add(l.chance);
                        for (const p of l.positions.map(roundPos)) {
                            if (!loc.positions.some((q) => q.x === p.x && q.z === p.z)) loc.positions.push(p);
                        }
                        locations.set(name, loc);
                    }
                }
                return {
                    id: mob,
                    name: BOSS_NAME_KO[enName] || trMap(mobs[mob]?.name || mob),
                    enName,
                    chance: chances.size === 1 ? [...chances][0] : null,
                    escorts: counts.length ? [Math.min(...counts), Math.max(...counts)] : null,
                    locations: placeOnWiki(enName, [...locations.values()].map((l) => ({
                        name: l.name,
                        chance: l.chances.size === 1 ? [...l.chances][0] : null,
                        positions: l.positions,
                    })), wikiBosses),
                };
            }).filter((b) => b.locations.length);
        };
        const NO_BOSS_MAPS = ['terminal', 'the-lab'];
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
                    outline: e.outline,
                })),
                transits: (primary.transits || []).map((t) => ({
                    name: trMapEn(t.description), label: trMap(t.description), position: t.position, top: t.top, bottom: t.bottom,
                    outline: t.outline,
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
                config: pickMapConfig(config),
                // 위키 지도 바탕 이미지 (게임 좌표에 맞출 수 있는 맵만)
                wikiMap: points.wikiMap && wikiImageUrls[points.wikiMap.file]
                    ? { ...points.wikiMap, url: wikiImageUrls[points.wikiMap.file] }
                    : null,
                extracts: points.extracts.map(toMarker),
                transits: points.transits.map(toMarker),
                // 터미널·연구소는 보스·무리가 맵 전체에 나와서 보스 표시를 하지 않는다
                bosses: NO_BOSS_MAPS.includes(group.normalizedName) ? [] : bossesOf(primary, points.bosses),
            });
        }

        // 퀘스트
        const questItems = tasks.data.questItems || {};
        const itemById = items.data?.items || {};
        const itemNamesKo = this.loadItemNamesKo();
        // 아이템 이름: "한국어 (영문 원문)" (tarkov.dev 에 한국어가 없으면 보완 사전·규칙으로 옮긴다)
        const itemRef = (id) => {
            const it = itemById[id];
            if (!it) return { name: id, icon: '' };
            const en = (itemsEn.data?.[it.name] || '').trim();
            const ko = (itemsKo.data?.[it.name] || '').trim();
            return { name: itemDisplayName(ko, en, itemNamesKo), icon: it.iconLink || '' };
        };
        // 목표를 하려고 레이드에 가져가야 하는 아이템 (설치할 아이템·표식기·사용할 아이템, 여러 개면 그중 하나)
        const bringOf = (o) => {
            if (o.type === 'plantItem') return o.items || [];
            if (o.type === 'mark') return o.markerItem ? [o.markerItem] : [];
            if (o.type === 'useItem') return o.useAny || [];
            return [];
        };
        const taskList = Object.values(tasks.data.tasks).map((t) => {
            const objectives = (t.objectives || []).map((o) => {
                const qi = o.questItem ? questItems[o.questItem] : null;
                return {
                    // 필요한 열쇠: [[열쇠, 대체 열쇠...], ...] 묶음마다 그중 하나만 있으면 된다
                    keys: (o.requiredKeys || []).map((group) => group.map(itemRef)).filter((g) => g.length),
                    bring: bringOf(o).map(itemRef),
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
                wiki: wikiTitle(t.wikiLink) || (tasksEn.data?.[t.name] ?? t.name).trim(),
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
                keys: [],
                bring: [],
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
                wiki: String(x.wiki).replace(/_/g, ' '),
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
