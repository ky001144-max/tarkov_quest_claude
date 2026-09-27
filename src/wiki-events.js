// 타르코프 위키 "Event content" 분류의 이벤트 퀘스트
// 이벤트 기간에만 받을 수 있는 퀘스트라 일반 퀘스트와 따로 관리한다.
// 위키 문서에서 상인·목표·선행 퀘스트를 읽고, Events 문서에서 어느 이벤트의 퀘스트인지 찾는다.
// 아레나(Escape from Tarkov: Arena) 퀘스트는 제외한다.
const { WIKI_API, WIKI_TITLES, normName, cleanWikitext } = require('./wiki-extracts');

const PAGE_BATCH = 50;

// 위키 맵 문서 제목 → tarkov.dev 맵 normalizedName
const MAP_BY_WIKI_TITLE = {
    ...Object.fromEntries(Object.entries(WIKI_TITLES).map(([key, title]) => [normName(title), key])),
    nightfactory: 'factory',
    lab: 'the-lab',
    labs: 'the-lab',
    streets: 'streets-of-tarkov',
};

async function fetchJson(url) {
    const res = await fetch(url, { headers: { 'User-Agent': 'EFT-Where-Am-I-KO/1.0' } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
}

async function fetchPages(titles) {
    const pages = {};
    for (let i = 0; i < titles.length; i += PAGE_BATCH) {
        const batch = titles.slice(i, i + PAGE_BATCH).join('|');
        const r = await fetchJson(`${WIKI_API}?action=query&prop=revisions&rvprop=content&rvslots=main&format=json&formatversion=2&titles=${encodeURIComponent(batch)}`);
        for (const p of r.query?.pages || []) pages[p.title] = p.revisions?.[0]?.slots?.main?.content || '';
    }
    return pages;
}

function section(text, name) {
    const start = text.search(new RegExp(`^==\\s*${name}\\s*==\\s*$`, 'm'));
    if (start < 0) return '';
    const lines = [];
    for (const line of text.slice(start).split('\n').slice(1)) {
        if (/^==[^=]/.test(line) || line.startsWith('{{Navbox')) break;
        lines.push(line);
    }
    return lines.join('\n');
}

function infobox(text) {
    const body = (text.match(/\{\{Infobox quest([\s\S]*?)\n\}\}/i) || [])[1] || '';
    const fields = {};
    for (const m of body.matchAll(/^\|\s*([^=\n]+?)\s*=(.*)$/gm)) fields[m[1].trim().toLowerCase()] = m[2].trim();
    return fields;
}

const links = (s) => [...String(s || '').matchAll(/\[\[([^\]|#]+)(?:[#|][^\]]*)?\]\]/g)].map((m) => m[1].trim());
const mapKeysIn = (s) => [...new Set(links(s).map((l) => MAP_BY_WIKI_TITLE[normName(l)]).filter(Boolean))];

// Events 문서의 "== 이벤트 이름 (날짜) ==" 섹션마다 링크된 퀘스트 → 가장 최근 이벤트
function parseEvents(text) {
    const byQuest = {};
    for (const part of String(text || '').split(/\n(?===[^=])/)) {
        const head = part.match(/^==\s*(.+?)\s*==/);
        if (!head) continue;
        const m = head[1].match(/^(.*?)\s*\(([^)]*\d{4})\)\s*$/);
        const event = { name: (m ? m[1] : head[1]).trim(), date: m ? m[2].trim() : '' };
        for (const l of links(part)) {
            const key = normName(l);
            if (!byQuest[key]) byQuest[key] = event;
        }
    }
    return byQuest;
}

function parseQuest(title, text, events) {
    if (!/\{\{Infobox quest/i.test(text)) return null;
    // 아레나 퀘스트 제외
    if (/Escape from Tarkov:? Arena/i.test(text)) return null;
    const box = infobox(text);
    if (/\[\[Arena\]\]/.test(box.location || '')) return null;

    const objectives = [];
    for (const line of section(text, 'Objectives').split('\n')) {
        const m = line.match(/^(\*+)\s*(.*)$/);
        if (!m) continue;
        const raw = m[2];
        const cleaned = cleanWikitext(raw).replace(/''/g, '').trim();
        // "(Optional)" 표기는 위키마다 ''(Optional)'' / (''Optional'') 등으로 달라서 정리한 뒤 판별한다
        const optional = /^\(\s*optional\s*\)/i.test(cleaned);
        const description = cleaned.replace(/^\(\s*optional\s*\)\s*/i, '').trim();
        if (!description) continue;
        objectives.push({ description, optional, sub: m[1].length > 1, maps: mapKeysIn(raw) });
    }
    const traderName = links(box['given by'])[0] || cleanWikitext(box['given by']) || '';
    return {
        // "(quest)" 는 문서 구분용이라 빼고, "Hustle (2023)" 처럼 연도로 구분한 이름은 그대로 둔다
        enName: title.replace(/\s*\(quest\)$/i, ''),
        wiki: encodeURIComponent(title.replace(/ /g, '_')).replace(/%2F/g, '/'),
        trader: traderName,
        maps: mapKeysIn(box.location),
        requires: links(box.previous),
        kappaRequired: /yes/i.test(cleanWikitext(box.reqkappa)),
        active: !/\{\{Historical content/i.test(text),
        event: events[normName(title)] || null,
        objectives,
    };
}

// 위키에서 이벤트 퀘스트 전체를 받아 가공한다
async function fetchWikiEvents() {
    const cat = await fetchJson(`${WIKI_API}?action=query&list=categorymembers&cmtitle=${encodeURIComponent('Category:Event content')}&cmlimit=500&cmnamespace=0&format=json&formatversion=2`);
    const titles = (cat.query?.categorymembers || []).map((m) => m.title);
    if (!titles.length) throw new Error('이벤트 분류가 비어 있음');
    const [pages, eventsPage] = await Promise.all([fetchPages(titles), fetchPages(['Events'])]);
    const events = parseEvents(eventsPage.Events);
    const quests = titles.map((t) => parseQuest(t, pages[t] || '', events)).filter(Boolean);
    if (!quests.length) throw new Error('이벤트 퀘스트를 찾지 못함');
    return { fetchedAt: new Date().toISOString(), quests };
}

module.exports = { fetchWikiEvents };
