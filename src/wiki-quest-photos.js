// 타르코프 위키 퀘스트 문서의 위치 사진 (Guide 섹션의 갤러리·썸네일 그림)
// 문서 위키텍스트에서 그림 파일과 설명을 뽑고, 위키 API 로 썸네일 주소를 받는다.
const { cleanWikitext } = require('./wiki-extracts');

const IMAGE_EXT = /\.(png|jpe?g|webp|gif)$/i;
// 그림 설명이 아닌 [[File:...]] 옵션
const FILE_OPTION = /^(thumb|thumbnail|frame|frameless|border|left|right|center|centre|none|upright(=.*)?|\d*x?\d+px|link=.*|alt=.*|class=.*|page=.*|lang=.*)$/i;
const MAX_PHOTOS = 100;

const fileTitle = (name) => {
    const n = name.replace(/_/g, ' ').replace(/\s+/g, ' ').trim();
    return `File:${n.charAt(0).toUpperCase()}${n.slice(1)}`;
};

// "== Guide ==" 섹션 (없으면 문서 전체)
function guideSection(text) {
    const start = text.search(/^==\s*Guide\s*==\s*$/m);
    if (start === -1) return text;
    const rest = text.slice(start).replace(/^==\s*Guide\s*==\s*$/m, '');
    const end = rest.search(/^==[^=]/m);
    return end === -1 ? rest : rest.slice(0, end);
}

// [[ ... ]] 를 안쪽 링크까지 짝을 맞춰 하나씩 꺼낸다
function* bracketLinks(text, prefix) {
    let i = 0;
    while ((i = text.indexOf('[[', i)) !== -1) {
        let depth = 0;
        let j = i;
        for (; j < text.length - 1; j++) {
            if (text.startsWith('[[', j)) { depth++; j++; } else if (text.startsWith(']]', j)) { depth--; j++; if (!depth) break; }
        }
        const inner = text.slice(i + 2, j - 1);
        if (prefix.test(inner)) yield { inner, index: i, end: j + 1 };
        i = j + 1;
    }
}

// 위 단계에서만 | 로 나눈다 (설명 안의 [[링크|글]] 은 나누지 않는다)
function splitTop(s) {
    const parts = [];
    let depth = 0;
    let cur = '';
    for (let k = 0; k < s.length; k++) {
        if (s.startsWith('[[', k) || s.startsWith('{{', k)) depth++;
        if (s.startsWith(']]', k) || s.startsWith('}}', k)) depth--;
        if (s[k] === '|' && depth === 0) { parts.push(cur); cur = ''; } else cur += s[k];
    }
    parts.push(cur);
    return parts;
}

// 위키 맵 문서 이름 → 앱 맵 키 (링크 [[Customs]] 나 제목 ===Customs=== 로 쓰인 이름)
const MAP_NAMES = [
    [/^streets( of tarkov)?$/i, 'streets-of-tarkov'], [/^ground ?zero$/i, 'ground-zero'], [/^customs$/i, 'customs'],
    [/^factory$/i, 'factory'], [/^woods$/i, 'woods'], [/^shoreline$/i, 'shoreline'], [/^interchange$/i, 'interchange'],
    [/^reserve$/i, 'reserve'], [/^lighthouse$/i, 'lighthouse'], [/^(the )?lab(oratory)?$/i, 'the-lab'],
    [/^(the )?labyrinth$/i, 'the-labyrinth'], [/^terminal$/i, 'terminal'], [/^icebreaker$/i, 'icebreaker'],
];
const mapOf = (name) => MAP_NAMES.find(([re]) => re.test(String(name).trim()))?.[1] || null;
// 글에 링크로 나온 맵들 (나온 순서대로)
const linkedMaps = (text) => [...text.matchAll(/\[\[([^\]|#]+)(?:[|#][^\]]*)?\]\]/g)].map((m) => mapOf(m[1])).filter(Boolean);
const HEADING = /^(=+)\s*(.*?)\s*\1\s*$/;

// 위키텍스트 → [{ file: 'File:이름.png', caption, map }] (아이템 아이콘 같은 작은 그림은 뺀다)
// map: 그 사진이 어느 맵 설명 아래 있는지. 맵 이름 제목(====[[Customs]]====) 아래면 그 맵,
//   아니면 사진 바로 앞 글에 가장 많이 링크된 맵, 그것도 없으면 앞 사진과 같은 맵 (null 이면 모든 맵)
function parseQuestPhotos(text) {
    const section = guideSection(String(text || ''));
    // 그림이 나오는 자리를 차례대로: 갤러리, [[File:...]]
    const events = [];
    for (const m of section.matchAll(/<gallery[^>]*>([\s\S]*?)<\/gallery>/gi)) {
        const items = [];
        for (const line of m[1].split('\n')) {
            const g = line.trim().match(/^(?:File|Image):([^|]+)(?:\|(.*))?$/i);
            if (g) items.push({ name: g[1], caption: splitTop(g[2] || '').filter((o) => !FILE_OPTION.test(o.trim())).pop() });
        }
        events.push({ start: m.index, end: m.index + m[0].length, items });
    }
    const inGallery = (i) => events.some((e) => i >= e.start && i < e.end);
    for (const { inner, index, end } of bracketLinks(section, /^(File|Image):/i)) {
        if (inGallery(index)) continue;
        const [name, ...opts] = splitTop(inner.replace(/^(File|Image):/i, ''));
        const px = opts.map((o) => o.trim().match(/^(\d+)px$/i)).find(Boolean);
        if (px && Number(px[1]) < 150) continue;
        if (opts.some((o) => /^frameless$/i.test(o.trim())) && !opts.some((o) => /^thumb/i.test(o.trim()))) continue;
        events.push({ start: index, end, items: [{ name, caption: opts.filter((o) => !FILE_OPTION.test(o.trim())).pop() }] });
    }
    events.sort((a, b) => a.start - b.start);

    const out = [];
    let titled = null; // { map, level } 지금 들어와 있는 맵 이름 제목
    let current = null;
    let last = 0;
    for (const e of events) {
        const lines = section.slice(last, e.start).split('\n');
        last = e.end;
        // 사이에 나온 제목: 맵 이름이면 그 맵으로 들어가고, 같거나 높은 단계의 다른 제목이 나오면 맵 제목에서 나온다
        let bodyFrom = 0;
        lines.forEach((line, k) => {
            const h = line.trim().match(HEADING);
            if (!h) return;
            bodyFrom = k + 1;
            const level = h[1].length;
            const map = mapOf(h[2].replace(/\[\[(?:[^\]|]*\|)?([^\]]*)\]\]/g, '$1'));
            if (map) titled = { map, level };
            else if (titled && level <= titled.level) titled = null;
        });
        if (titled) {
            current = titled.map;
        } else {
            // 맵 제목 아래가 아니면 사진 바로 앞 글에 가장 많이 링크된 맵 (같으면 나중에 나온 맵)
            const maps = linkedMaps(lines.slice(bodyFrom).join('\n'));
            if (maps.length) {
                const count = {};
                for (const m of maps) count[m] = (count[m] || 0) + 1;
                current = maps.reduce((best, m) => (count[m] >= count[best] ? m : best), maps[0]);
            }
        }
        for (const it of e.items) {
            const file = fileTitle(it.name);
            const caption = cleanWikitext(it.caption || '');
            if (!IMAGE_EXT.test(file) || /icon/i.test(file) || out.some((p) => p.file === file && p.map === current)) continue;
            // 게임 화면 사진만: 지도에 위치를 표시한 그림("… marked on map", ITARBurnedGirlMap.png 등)은 뺀다
            if (/\bmaps?\b/i.test(caption) || /map/i.test(file)) continue;
            out.push({ file, caption, map: current });
        }
    }
    return out.slice(0, MAX_PHOTOS);
}

// 위키 문서 제목 → 썸네일까지 붙인 사진 목록 [{ url, caption, map }]
// fetchJson(url) 로 위키 API 를 부른다
async function fetchQuestPhotos(api, title, fetchJson, width = 640) {
    const page = await fetchJson(`${api}?action=query&prop=revisions&rvprop=content&rvslots=main&format=json&formatversion=2&redirects=1&titles=${encodeURIComponent(title)}`);
    const content = page.query?.pages?.[0]?.revisions?.[0]?.slots?.main?.content;
    if (!content) return [];
    const photos = parseQuestPhotos(content);
    if (!photos.length) return [];
    // 한 번에 50장까지 물을 수 있다
    const renamed = {};
    const urls = {};
    for (let i = 0; i < photos.length; i += 50) {
        const files = photos.slice(i, i + 50).map((p) => p.file).join('|');
        const info = await fetchJson(`${api}?action=query&prop=imageinfo&iiprop=url&iiurlwidth=${width}&format=json&formatversion=2&titles=${encodeURIComponent(files)}`);
        for (const n of info.query?.normalized || []) renamed[n.from] = n.to;
        for (const pg of info.query?.pages || []) urls[pg.title] = pg.imageinfo?.[0]?.thumburl || pg.imageinfo?.[0]?.url;
    }
    return photos.map((p) => ({ url: urls[renamed[p.file] || p.file], caption: p.caption, map: p.map })).filter((p) => p.url);
}

module.exports = { parseQuestPhotos, fetchQuestPhotos };
