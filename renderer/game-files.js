// 게임 스크린샷 파일 이름·로그 줄 해석 (데스크톱 watchers.js 와 웹 버전 web-api.js 가 같이 쓴다)
(function (root) {
    // 스크린샷 파일명 예: 2026-01-10[03-59]_-318.44, 24.84, -107.49_0.00000, 0.82497, 0.00000, 0.56518_3.98 (0).png
    const POSITION_REGEX = /_(-?\d+(?:\.\d+)?), (-?\d+(?:\.\d+)?), (-?\d+(?:\.\d+)?)_(-?\d+(?:\.\d+)?), (-?\d+(?:\.\d+)?), (-?\d+(?:\.\d+)?), (-?\d+(?:\.\d+)?)/;
    const MAP_REGEX = /scene preset path:maps\/([^.]+)\.bundle/;
    const TRANSIT_END_REGEX = /\[Transit\] `([a-f0-9]+)` Count:(\d+), EventPlayer:(True|False)/;

    function parseScreenshotName(fileName) {
        const m = POSITION_REGEX.exec(fileName);
        if (!m) return null;
        const [x, y, z, rx, ry, rz, rw] = m.slice(1).map(Number);
        // TarkovMonitor 와 동일한 방식으로 쿼터니언 → 방향(도)
        const sinyCosp = 2 * (rw * ry + rx * rz);
        const cosyCosp = 1 - 2 * (rz * rz + ry * ry);
        const yaw = (Math.atan2(sinyCosp, cosyCosp) * 180) / Math.PI;
        return { position: { x, y, z }, rotation: yaw, file: fileName };
    }

    const api = { parseScreenshotName, MAP_REGEX, TRANSIT_END_REGEX };
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    else root.GameFiles = api;
}(this));
