/* global L */
// 위키 지도 타일: 처음 한 번 위키 이미지를 배율별 타일로 잘라 IndexedDB 에 두고(wiki-tiler.js), 보이는 타일만 그린다.
// 원본 이미지를 통째로 두면 Factory(13440×6656) 같은 지도는 디코딩만 수백 MB 를 쓰기 때문이다.
(function () {
    const TILE = 512;
    const DB_NAME = 'eft-wiki-tiles';
    // 위키 지도 이미지 타일 규칙이 바뀌면 올린다 (이전 타일 무시)
    const TILE_VERSION = 1;
    // 디코딩해 둔 타일 (최근 것만). 밀려난 타일은 그리던 중일 수 있어 조금 뒤에 닫는다
    const BITMAP_CACHE = 40;
    const CLOSE_DELAY_MS = 5000;

    let dbPromise = null;
    function db() {
        if (!dbPromise) {
            dbPromise = new Promise((resolve, reject) => {
                const req = indexedDB.open(DB_NAME, 1);
                req.onupgradeneeded = () => {
                    req.result.createObjectStore('tiles');
                    req.result.createObjectStore('meta');
                };
                req.onsuccess = () => resolve(req.result);
                req.onerror = () => reject(req.error);
            });
        }
        return dbPromise;
    }

    function request(store, mode, fn) {
        return db().then((d) => new Promise((resolve, reject) => {
            const tx = d.transaction(store, mode);
            const r = fn(tx.objectStore(store));
            tx.oncomplete = () => resolve(r?.result);
            tx.onerror = () => reject(tx.error);
        }));
    }

    const tileKey = (id, z, x, y) => `${id}|${z}|${x}|${y}`;

    // 같은 위키 파일의 이전 판(주소가 바뀐 경우) 타일을 지운다
    async function removeOld(file, keepId) {
        const metas = await request('meta', 'readonly', (s) => s.getAll());
        const keys = await request('meta', 'readonly', (s) => s.getAllKeys());
        const old = keys.filter((k, i) => metas[i].file === file && k !== keepId);
        for (const id of old) {
            await request('tiles', 'readwrite', (s) => s.delete(IDBKeyRange.bound(`${id}|`, `${id}|￿`)));
            await request('meta', 'readwrite', (s) => s.delete(id));
        }
    }

    // 만드는 중인 타일 작업 (같은 지도를 다시 열면 이어서 쓴다)
    const jobs = new Map();

    // 위키 이미지를 타일로 자르기 시작한다 (작은 배율부터). 반환: 작업
    //   firstLevel: 가장 작은 배율이 끝나면 (지도를 이때부터 보여 준다), done: 모두 끝나면 (zMin)
    //   wait(key): 아직 안 만든 타일을 만들어지면 받는다 (끝날 때까지 없으면 null)
    function startBuild(id, blob, rect) {
        const job = { id, zMin: null, finished: false, blobs: new Map(), made: new Set(), waiters: new Map(), progress: 0, onProgress: null };
        const worker = new Worker('wiki-tiler.js');
        let batch = [];
        let writing = Promise.resolve();
        // 저장한 타일은 메모리에서 뺀다 (저장 전까지는 blobs 에서 바로 준다)
        const flush = () => {
            if (!batch.length) return Promise.resolve();
            const items = batch;
            batch = [];
            return request('tiles', 'readwrite', (st) => {
                for (const t of items) st.put(t.blob, tileKey(id, t.z, t.x, t.y));
            }).then(() => items.forEach((t) => job.blobs.delete(tileKey(id, t.z, t.x, t.y))));
        };
        const finish = () => {
            job.finished = true;
            for (const list of job.waiters.values()) list.forEach((r) => r(null));
            job.waiters.clear();
        };
        let firstResolve;
        let firstReject;
        job.firstLevel = new Promise((res, rej) => { firstResolve = res; firstReject = rej; });
        job.done = new Promise((resolve, reject) => {
            const fail = (err) => {
                worker.terminate();
                finish();
                firstReject(err);
                reject(err);
            };
            worker.onmessage = ({ data }) => {
                if (data.start) {
                    job.zMin = data.start.zMin;
                } else if (data.tile) {
                    const t = data.tile;
                    const key = tileKey(id, t.z, t.x, t.y);
                    job.blobs.set(key, t.blob);
                    job.made.add(key);
                    job.waiters.get(key)?.forEach((r) => r(t.blob));
                    job.waiters.delete(key);
                    batch.push(t);
                    if (batch.length >= 40) writing = writing.then(flush);
                } else if (data.progress !== undefined) {
                    job.progress = data.progress;
                    job.onProgress?.(data.progress);
                } else if (data.level !== undefined) {
                    if (data.level === job.zMin) firstResolve();
                } else if (data.done) {
                    worker.terminate();
                    writing = writing.then(flush);
                    writing.then(() => {
                        finish();
                        job.progress = 1;
                        job.onProgress?.(1);
                        resolve(data.done.zMin);
                    }, fail);
                } else if (data.error) {
                    fail(new Error(data.error));
                }
            };
            worker.onerror = (e) => fail(new Error(e.message || '타일 만들기 실패'));
        });
        job.wait = (key) => {
            if (job.blobs.has(key)) return Promise.resolve(job.blobs.get(key));
            if (job.made.has(key)) return request('tiles', 'readonly', (st) => st.get(key));
            if (job.finished) return Promise.resolve(null);
            return new Promise((r) => {
                if (!job.waiters.has(key)) job.waiters.set(key, []);
                job.waiters.get(key).push(r);
            });
        };
        worker.postMessage({ blob, rect, tileSize: TILE });
        return job;
    }

    // 위키 지도 타일 원본. url 이 같으면 저장해 둔 타일을 쓰고, 없으면 loadImage() 로 받아 새로 자른다.
    // 새로 자를 때는 가장 작은 배율이 끝나면 바로 돌려주고, 나머지 타일은 만들어지는 대로 그린다.
    // rect: 이미지가 놓이는 위키 좌표 범위 [x1, y1, x2, y2], onProgress(0~1): 타일 만드는 진행률
    // onStored: 타일을 모두 저장한 뒤 (원본 이미지는 더 필요 없다)
    async function open({ file, url, rect, loadImage, onProgress, onStored }) {
        const id = `v${TILE_VERSION}|${rect.join(',')}|${url}`;
        let meta = await request('meta', 'readonly', (s) => s.get(id));
        let job = null;
        if (!meta) {
            job = jobs.get(id);
            if (!job) {
                const { data, type } = await loadImage();
                job = jobs.get(id) || startBuild(id, new Blob([data], { type }), rect);
                if (!jobs.has(id)) {
                    jobs.set(id, job);
                    job.done.then(async (zMin) => {
                        await request('meta', 'readwrite', (s) => s.put({ file, rect, zMin, tileSize: TILE }, id));
                        jobs.delete(id);
                        onStored?.();
                        removeOld(file, id).catch(() => {});
                    }, () => jobs.delete(id));
                }
            }
            job.onProgress = onProgress;
            onProgress?.(job.progress);
            await job.firstLevel;
            meta = { zMin: job.zMin };
        }
        const cache = new Map();
        return {
            zMin: meta.zMin,
            tileSize: TILE,
            // 아직 타일을 만드는 중이면 끝날 때 (아니면 바로)
            ready: job ? job.done.then(() => {}, () => {}) : Promise.resolve(),
            // 타일 한 장 (ImageBitmap, 없으면 null). 만드는 중이면 그 타일이 만들어질 때까지 기다린다
            async get(z, x, y) {
                const key = tileKey(id, z, x, y);
                if (cache.has(key)) {
                    const hit = cache.get(key);
                    cache.delete(key);
                    cache.set(key, hit);
                    return hit;
                }
                const load = async () => {
                    const active = jobs.get(id);
                    let blob = active?.blobs.get(key) || await request('tiles', 'readonly', (s) => s.get(key));
                    if (!blob && active && !active.finished) blob = await active.wait(key);
                    return blob ? createImageBitmap(blob) : null;
                };
                const promise = load().catch(() => null);
                cache.set(key, promise);
                while (cache.size > BITMAP_CACHE) {
                    const [k, v] = cache.entries().next().value;
                    cache.delete(k);
                    setTimeout(() => v.then((b) => b?.close()), CLOSE_DELAY_MS);
                }
                return promise;
            },
            close() {
                if (job && job.onProgress === onProgress) job.onProgress = null;
                for (const v of cache.values()) v.then((b) => b?.close());
                cache.clear();
            },
        };
    }

    // 위키 타일을 그리는 레이어
    // clip: 보여 줄 영역 (위키 좌표 다각형, 화면 좌표계 기준), shift: 이 레이어가 그리는 그림을 위키 좌표로 이만큼 옮긴다
    const WikiTileLayer = L.GridLayer.extend({
        initialize(source, options) {
            this._source = source;
            L.setOptions(this, {
                tileSize: source.tileSize,
                minNativeZoom: source.zMin,
                maxNativeZoom: 0,
                // 위키 지도는 이미지 1px = 1 좌표라 음수 배율로 본다 (기본값 0 이면 축소했을 때 타일을 안 그린다)
                minZoom: -20,
                noWrap: true,
                // 화면 밖에 남겨 두는 타일 캔버스(장당 1MB)를 줄인다
                keepBuffer: 1,
                ...options,
            });
        },

        // 소수 배율에서 타일 사이에 1px 틈이 보이지 않게 타일을 1px 겹쳐 그린다
        onAdd(map) {
            L.GridLayer.prototype.onAdd.call(this, map);
            this.on('tileload', this._overlapTile, this);
        },

        onRemove(map) {
            this.off('tileload', this._overlapTile, this);
            L.GridLayer.prototype.onRemove.call(this, map);
        },

        _overlapTile({ tile }) {
            const T = this._source.tileSize;
            tile.style.width = `${T + 1}px`;
            tile.style.height = `${T + 1}px`;
        },

        createTile(coords, done) {
            const T = this._source.tileSize;
            const canvas = L.DomUtil.create('canvas', 'leaflet-tile');
            canvas.width = T;
            canvas.height = T;
            const z = coords.z;
            const s = 2 ** z;
            const [dx, dy] = this.options.shift || [0, 0];
            // 이 타일 자리에 그릴 원본 타일 픽셀 범위 (옮긴 그림이면 옮기기 전 위치)
            const ox = coords.x * T - dx * s;
            const oy = coords.y * T + dy * s;
            const tiles = [];
            for (let ty = Math.floor(oy / T); ty <= Math.floor((oy + T - 1) / T); ty++) {
                for (let tx = Math.floor(ox / T); tx <= Math.floor((ox + T - 1) / T); tx++) tiles.push([tx, ty]);
            }
            Promise.all(tiles.map(([tx, ty]) => this._source.get(z, tx, ty))).then((bitmaps) => {
                try {
                    this._draw(canvas, coords, bitmaps, tiles, ox, oy);
                    done(null, canvas);
                } catch (err) {
                    done(err, canvas);
                }
            }, (err) => done(err, canvas));
            return canvas;
        },

        _draw(canvas, coords, bitmaps, tiles, ox, oy) {
            const T = this._source.tileSize;
            const s = 2 ** coords.z;
            const ctx = canvas.getContext('2d');
            const clip = this.options.clip;
            if (clip) {
                ctx.beginPath();
                clip.forEach(([x, y], i) => {
                    const px = x * s - coords.x * T;
                    const py = -y * s - coords.y * T;
                    if (i) ctx.lineTo(px, py);
                    else ctx.moveTo(px, py);
                });
                ctx.closePath();
                ctx.clip();
            }
            bitmaps.forEach((b, i) => {
                if (b) ctx.drawImage(b, tiles[i][0] * T - ox, tiles[i][1] * T - oy);
            });
        },
    });

    window.WikiTiles = { open, WikiTileLayer };
}());
