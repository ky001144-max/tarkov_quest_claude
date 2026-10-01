/* eslint-env worker */
// 위키 지도 이미지 → 배율별 타일 (Web Worker)
// 큰 위키 이미지를 통째로 화면에 두면 원본 전체가 메모리에 디코딩되므로, 처음 한 번 타일로 잘라 두고 보이는 타일만 쓴다.
// 좌표: Leaflet CRS.Simple 에서 위키 좌표(왼쪽 아래 원점, lat = 위키 y) 를 배율 z 로 그린 픽셀 = (x·2^z, -y·2^z).
// 받는 값: { blob, rect: [x1, y1, x2, y2] (이미지가 놓이는 위키 좌표 범위, 이미지는 이 범위에 맞춰 그린다), tileSize }
// 보내는 값: { start: { zMin } } → { tile: { z, x, y, blob } } … { progress } … { level: z } (그 배율 완료) … { done: { zMin } }
// 작은 배율부터 만들어, 첫 배율이 끝나면 바로 지도를 보여 줄 수 있다

self.onmessage = async ({ data }) => {
    const { blob, rect: [X1, Y1, X2, Y2], tileSize: T } = data;
    const W = X2 - X1;
    const H = Y2 - Y1;
    try {
        const image = await createImageBitmap(blob);
        // 위키 이미지 전체가 타일 한 장에 들어가는 배율까지
        const zMin = -Math.max(0, Math.ceil(Math.log2(Math.max(W, H) / T)));
        const levels = [];
        let total = 0;
        for (let z = zMin; z <= 0; z++) {
            const s = 2 ** z;
            // 이 배율에서 이미지가 걸치는 타일 번호 범위 (y 는 위쪽이 음수)
            const x0 = Math.floor((X1 * s) / T);
            const x1 = Math.ceil((X2 * s) / T);
            const y0 = Math.floor((-Y2 * s) / T);
            const y1 = Math.ceil((-Y1 * s) / T);
            levels.push({ z, s, x0, x1, y0, y1 });
            total += (x1 - x0) * (y1 - y0);
        }
        self.postMessage({ start: { zMin } });
        let done = 0;
        // 작은 배율부터 (원본에서 바로 줄이면 품질이 떨어지므로 그 배율 크기로 한 번 줄인 이미지에서 자른다)
        for (const { z, s, x0, x1, y0, y1 } of levels) {
            const level = z === 0 ? image : await createImageBitmap(image, {
                resizeWidth: Math.max(1, Math.round(image.width * s)),
                resizeHeight: Math.max(1, Math.round(image.height * s)),
                resizeQuality: 'high',
            });
            // 이 배율 이미지 픽셀 / 타일 픽셀
            const bx = level.width / (W * s);
            const by = level.height / (H * s);
            const canvas = new OffscreenCanvas(T, T);
            const ctx = canvas.getContext('2d');
            for (let y = y0; y < y1; y++) {
                for (let x = x0; x < x1; x++) {
                    ctx.clearRect(0, 0, T, T);
                    ctx.drawImage(level, (x * T - X1 * s) * bx, (Y2 * s + y * T) * by, T * bx, T * by, 0, 0, T, T);
                    const tile = await canvas.convertToBlob({ type: 'image/webp', quality: 0.9 });
                    self.postMessage({ tile: { z, x, y, blob: tile } });
                    done++;
                    if (done % 20 === 0) self.postMessage({ progress: done / total });
                }
            }
            if (level !== image) level.close();
            self.postMessage({ level: z });
        }
        image.close();
        self.postMessage({ done: { zMin } });
    } catch (err) {
        self.postMessage({ error: String(err && err.message ? err.message : err) });
    }
};
