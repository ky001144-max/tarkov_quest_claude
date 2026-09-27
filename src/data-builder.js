// 데이터 가공 전용 유틸리티 프로세스 (DataService.buildInProcess 가 실행하고, 결과를 넘기면 종료된다)
const { DataService } = require('./data');

process.parentPort.once('message', async ({ data }) => {
    const { cacheDir, bundledMapsPath, mode, force } = data;
    try {
        const result = await new DataService(cacheDir, bundledMapsPath).build(mode, force);
        process.parentPort.postMessage({ ok: true, text: JSON.stringify(result) });
    } catch (err) {
        process.parentPort.postMessage({ ok: false, error: err.message });
    }
});
