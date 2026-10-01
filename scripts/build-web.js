// 웹(GitHub Pages) 버전 만들기: node scripts/build-web.js [출력 폴더, 기본 _site]
// - renderer/ 화면 코드를 그대로 복사하고, Electron preload 대신 web/web-api.js 를 붙인다
// - tarkov.dev·위키 데이터를 데스크톱과 같은 DataService 로 가공해 data/{regular,pve}.json 으로 넣는다
//   (브라우저에서 원본 JSON 10MB 이상을 받아 가공하지 않도록 GitHub Actions 에서 미리 만든다)
const fs = require('fs');
const os = require('os');
const path = require('path');
const { DataService } = require('../src/data');

const ROOT = path.join(__dirname, '..');
const OUT = path.resolve(process.argv[2] || path.join(ROOT, '_site'));
const MODES = ['regular', 'pve'];

// 웹에서 불러오는 외부 주소: 지도 SVG·타일·상인 이미지(assets.tarkov.dev)만 (위키 지도 이미지는 사이트에 함께 넣는다)
const WEB_CSP = "default-src 'self'; img-src 'self' data: blob: https://assets.tarkov.dev; style-src 'self' 'unsafe-inline'; "
    + "script-src 'self'; connect-src 'self' https://assets.tarkov.dev";

// 위키 이미지 주소 → 사이트 안 파일 이름
const wikiImageFile = (url) => `${url.split('/images/')[1].replace(/[^a-z0-9.]/gi, '_')}.img`;

function copy(from, to) {
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.copyFileSync(from, to);
}

function buildHtml() {
    let html = fs.readFileSync(path.join(ROOT, 'renderer', 'index.html'), 'utf8');
    const replace = (pattern, value) => {
        if (!pattern.test(html)) throw new Error(`index.html 에서 ${pattern} 을 찾지 못함`);
        html = html.replace(pattern, value);
    };
    replace(/(http-equiv="Content-Security-Policy"\s+content=")[^"]*"/, `$1${WEB_CSP}"`);
    replace(/\.\.\/node_modules\/leaflet\/dist\/leaflet\.css/, 'vendor/leaflet/leaflet.css');
    replace(/<script src="\.\.\/node_modules\/leaflet\/dist\/leaflet\.js"><\/script>/,
        '<script src="vendor/leaflet/leaflet.js"></script>\n<script src="game-files.js"></script>\n<script src="web-api.js"></script>');
    replace(/<body>/, '<body class="web">');
    replace(/<title>[^<]*<\/title>/, '<title>EFT Where Am I KO</title>\n    <link rel="icon" href="icon.ico">');
    return html;
}

async function main() {
    fs.rmSync(OUT, { recursive: true, force: true });
    fs.mkdirSync(path.join(OUT, 'data'), { recursive: true });

    for (const f of ['app.js', 'map.js', 'wiki-tiles.js', 'wiki-tiler.js', 'styles.css', 'game-files.js']) copy(path.join(ROOT, 'renderer', f), path.join(OUT, f));
    copy(path.join(ROOT, 'web', 'web-api.js'), path.join(OUT, 'web-api.js'));
    copy(path.join(ROOT, 'assets', 'icon.ico'), path.join(OUT, 'icon.ico'));
    const leaflet = path.dirname(require.resolve('leaflet/dist/leaflet.js', { paths: [ROOT] }));
    fs.cpSync(leaflet, path.join(OUT, 'vendor', 'leaflet'), { recursive: true });
    fs.writeFileSync(path.join(OUT, 'index.html'), buildHtml(), 'utf8');
    fs.writeFileSync(path.join(OUT, '.nojekyll'), '');

    const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'eft-web-'));
    const service = new DataService(cacheDir, path.join(ROOT, 'assets', 'maps.json'));
    for (const mode of MODES) {
        const data = await service.build(mode, true);
        const file = path.join(OUT, 'data', `${mode}.json`);
        fs.writeFileSync(file, JSON.stringify(data), 'utf8');
        console.log(`${mode}: 퀘스트 ${data.tasks.length}개, 맵 ${data.maps.length}개 (${(fs.statSync(file).size / 1e6).toFixed(1)}MB)`);
    }
    // 위키 지도 이미지: 위키 이미지 서버는 위키 밖 페이지에서 바로 불러오는 것을 막아서, 빌드할 때 받아 사이트에 넣는다
    // (wiki-maps/index.json: 위키 이미지 주소 → 파일·형식, 못 받은 지도는 웹에서 tarkov.dev 지도로 보인다)
    const urls = new Set();
    for (const mode of MODES) {
        const data = JSON.parse(fs.readFileSync(path.join(OUT, 'data', `${mode}.json`), 'utf8'));
        for (const m of data.maps) if (m.wikiMap?.url) urls.add(m.wikiMap.url);
    }
    fs.mkdirSync(path.join(OUT, 'wiki-maps'), { recursive: true });
    const index = {};
    let bytes = 0;
    for (const url of urls) {
        try {
            const { data, type } = await service.getWikiImage(url);
            const file = wikiImageFile(url);
            fs.writeFileSync(path.join(OUT, 'wiki-maps', file), data);
            index[url] = { file, type };
            bytes += data.length;
        } catch (err) {
            console.warn(`위키 지도 이미지 받기 실패: ${url} (${err.message})`);
        }
    }
    fs.writeFileSync(path.join(OUT, 'wiki-maps', 'index.json'), JSON.stringify(index), 'utf8');
    console.log(`위키 지도 이미지: ${Object.keys(index).length}/${urls.size}개 (${(bytes / 1e6).toFixed(1)}MB)`);
    fs.rmSync(cacheDir, { recursive: true, force: true });
    console.log(`완료: ${OUT}`);
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
