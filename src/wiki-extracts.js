// 타르코프 위키(escapefromtarkov.fandom.com) 기준 탈출구·이동 지점
// 맵 문서의 Extractions / Transits 표를 탈출구 목록의 기준으로 삼는다.
// 좌표는 tarkov.dev 실측값을 우선 쓰고, tarkov.dev에 없는 탈출구는 위키 인터랙티브 지도(Map:*) 마커 위치를
// 같은 이름의 탈출구로 맞춘 변환식으로 게임 좌표로 옮긴다 (변환이 정확한 맵에서만).

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

function wikiUrl() {
    const titles = Object.values(WIKI_TITLES).flatMap((t) => [t, `Map:${t}`]).join('|');
    return `${WIKI_API}?action=query&prop=revisions&rvprop=content&rvslots=main&format=json&formatversion=2&titles=${encodeURIComponent(titles)}`;
}

const normName = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');

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
        try {
            markers = JSON.parse(pages[`Map:${title}`])
                .markers.filter((m) => /^exfil/.test(m.categoryId))
                .map((m) => ({ name: m.popup?.title || '', category: m.categoryId, position: m.position }));
        } catch { /* 지도 없음 */ }
        if (extracts.length || transits.length) result[key] = { extracts, transits, markers };
    }
    return result;
}

// 최소제곱 3x3 (가우스 소거)
function solve3(rows, values) {
    const M = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
    const v = [0, 0, 0];
    rows.forEach((r, i) => {
        for (let a = 0; a < 3; a++) {
            v[a] += r[a] * values[i];
            for (let b = 0; b < 3; b++) M[a][b] += r[a] * r[b];
        }
    });
    for (let i = 0; i < 3; i++) {
        let p = i;
        for (let r = i + 1; r < 3; r++) if (Math.abs(M[r][i]) > Math.abs(M[p][i])) p = r;
        [M[i], M[p]] = [M[p], M[i]];
        [v[i], v[p]] = [v[p], v[i]];
        if (!M[i][i]) return null;
        for (let r = 0; r < 3; r++) {
            if (r === i) continue;
            const f = M[r][i] / M[i][i];
            for (let c = 0; c < 3; c++) M[r][c] -= f * M[i][c];
            v[r] -= f * v[i];
        }
    }
    return v.map((x, i) => x / M[i][i]);
}

function fitAffine(pairs) {
    const rows = pairs.map((p) => [p.wiki[0], p.wiki[1], 1]);
    const cx = solve3(rows, pairs.map((p) => p.game.x));
    const cz = solve3(rows, pairs.map((p) => p.game.z));
    if (!cx || !cz || [...cx, ...cz].some((n) => !Number.isFinite(n))) return null;
    return (w) => ({ x: cx[0] * w[0] + cx[1] * w[1] + cx[2], z: cz[0] * w[0] + cz[1] * w[1] + cz[2] });
}

// 위키 지도 픽셀 → 게임 좌표 (RANSAC 으로 잘못 놓인 마커를 걸러낸다). 믿을 수 없으면 null
function wikiToGameTransform(pairs) {
    if (pairs.length < FIT_MIN_INLIERS) return null;
    const dist = (f, p) => {
        const g = f(p.wiki);
        return Math.hypot(g.x - p.game.x, g.z - p.game.z);
    };
    let best = [];
    for (let i = 0; i < pairs.length; i++) {
        for (let j = i + 1; j < pairs.length; j++) {
            for (let k = j + 1; k < pairs.length; k++) {
                const f = fitAffine([pairs[i], pairs[j], pairs[k]]);
                if (!f) continue;
                const inliers = pairs.filter((p) => dist(f, p) < FIT_TOLERANCE);
                if (inliers.length > best.length) best = inliers;
            }
        }
    }
    // 대부분의 기준점이 맞아야 지도가 실제 비율과 같다고 본다 (실내·다층 맵의 위키 지도는 비율이 달라 제외)
    if (best.length < FIT_MIN_INLIERS || best.length < pairs.length * 0.7) return null;
    return fitAffine(best);
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

// tarkov.dev 탈출구/이동 지점을 위키 목록 기준으로 다시 만든다
// dev: [{ name(영문), label(표시 이름), faction, position, top, bottom }]
function mergeWithWiki(wikiRows, devPoints, markers, transform, allDevPoints, inBounds) {
    const out = [];
    for (const row of wikiRows) {
        const faction = factionClass(row.faction);
        const matches = devPoints.filter((d) => normName(d.name) === normName(row.name));
        const info = {
            alwaysAvailable: row.alwaysAvailable,
            singleUse: row.singleUse,
            requirements: koRequirement(row.requirements),
            notes: row.notes,
        };
        if (matches.length) {
            // 진영이 같은 좌표를 우선, "All" 이면 대표 좌표 하나만
            const pick = matches.find((d) => d.faction === faction) || matches[0];
            out.push({ ...pick, faction, source: 'tarkov.dev', wiki: info });
            continue;
        }
        const marker = markers.find((m) => normName(m.name) === normName(row.name));
        if (!marker || !transform) {
            out.push({ name: row.name, label: row.name, faction, position: null, source: 'wiki', wiki: info });
            continue;
        }
        const g = transform(marker.position);
        // 지하 등 위키 지도의 별도 영역에 그려진 마커는 지도 밖으로 나가므로 좌표를 쓰지 않는다
        if (!inBounds(g)) {
            out.push({ name: row.name, label: row.name, faction, position: null, source: 'wiki', wiki: info });
            continue;
        }
        // 높이 정보가 없으므로 가장 가까운 기존 탈출구의 높이를 쓴다
        let nearest = null;
        for (const d of allDevPoints) {
            const dd = Math.hypot(d.position.x - g.x, d.position.z - g.z);
            if (!nearest || dd < nearest.d) nearest = { d: dd, y: d.position.y };
        }
        out.push({
            name: row.name,
            label: row.name,
            faction,
            position: { x: +g.x.toFixed(2), y: nearest ? nearest.y : 0, z: +g.z.toFixed(2) },
            source: 'wiki',
            wiki: info,
        });
    }
    return out;
}

// dev: { extracts, transits } (각각 name/label/faction/position/top/bottom), bounds: tarkov.dev 지도 범위 [[x, z], [x, z]]
function applyWikiExtracts(wiki, dev, bounds) {
    if (!wiki || !(wiki.extracts.length + wiki.transits.length)) return null;
    const allDev = [...dev.extracts, ...dev.transits].filter((d) => d.position);
    const pairs = [];
    for (const m of wiki.markers) {
        const d = allDev.find((p) => normName(p.name) === normName(m.name));
        if (d) pairs.push({ wiki: m.position, game: d.position });
    }
    const transform = wikiToGameTransform(pairs);
    const inBounds = (g) => {
        if (!bounds) return true;
        const [[x1, z1], [x2, z2]] = bounds;
        return g.x >= Math.min(x1, x2) && g.x <= Math.max(x1, x2) && g.z >= Math.min(z1, z2) && g.z <= Math.max(z1, z2);
    };
    const extracts = wiki.extracts.length
        ? mergeWithWiki(wiki.extracts, dev.extracts, wiki.markers, transform, allDev, inBounds)
        : dev.extracts;
    const transits = wiki.transits.length
        ? mergeWithWiki(wiki.transits.map((t) => ({ ...t, faction: '' })), dev.transits, wiki.markers, transform, allDev, inBounds)
        : dev.transits;
    return { extracts, transits };
}

module.exports = { WIKI_API, WIKI_TITLES, normName, cleanWikitext, wikiUrl, parseWikiResponse, applyWikiExtracts };
