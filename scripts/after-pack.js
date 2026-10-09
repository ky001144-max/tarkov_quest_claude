// electron-builder afterPack: 이 앱이 쓰지 않는 Chromium 파일을 빼서 용량을 줄인다
// (dxcompiler/dxil: WebGPU 셰이더 컴파일러. 지도는 2D 캔버스·SVG 로만 그린다)
const fs = require('fs');
const path = require('path');

const UNUSED = ['dxcompiler.dll', 'dxil.dll'];

exports.default = async function afterPack({ appOutDir }) {
    for (const f of UNUSED) fs.rmSync(path.join(appOutDir, f), { force: true });
};
