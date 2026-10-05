const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const { createCaptureFlow, createComposedStore, decodeComposed, createCaptureTracker } = require('../lib/capture-flow');
const { bundleRaw, tmpDir } = require('./helpers');

const bundle = JSON.parse(bundleRaw);
function makeFlow(ui, { enabled = true, withBundle = true } = {}) {
    const store = createComposedStore(tmpDir());
    let recents = [];
    const flow = createCaptureFlow({
        getBundle: () => (withBundle ? bundle : null), isEnabled: () => enabled,
        getRecents: () => recents, setRecents: (r) => { recents = r; },
        getInsertion: () => 'end', ui, store
    });
    return { flow, store, recents: () => recents };
}
const AP = 'Lumbar spondylosis.\nProceed with bilateral L4-5, L5-S1 medial branch blocks.';
const confirmAll = (payerId) => async (req) => ({ payerId, items: req.detection.items });

test('Skip -> no composed files (AHK pastes exactly as today)', async () => {
    const { flow, store } = makeFlow(async () => null);
    const r = await flow.onCapture({ source: 'heidi', captureTs: '111', ap: AP, exam: 'Exam' });
    assert.strictEqual(r.skipped, true);
    assert.ok(!fs.existsSync(store.files.exam) && !fs.existsSync(store.files.ap));
});

test('confirm -> composed files carry the capture timestamp, CRLF, no BOM; recents updated', async () => {
    const { flow, store, recents } = makeFlow(confirmAll('medicare_ab_ga'));
    const r = await flow.onCapture({ source: 'heidi', captureTs: '222', ap: AP, exam: 'Gen: NAD' });
    assert.strictEqual(r.skipped, false);
    const raw = fs.readFileSync(store.files.ap);
    assert.notDeepStrictEqual([...raw.slice(0, 3)], [0xEF, 0xBB, 0xBF]);
    const ap = decodeComposed(raw.toString('utf8'));
    assert.strictEqual(ap.captureTs, '222');
    assert.ok(ap.text.startsWith(AP.replace(/\n/g, '\r\n') + '\r\n\r\n'));
    assert.ok(!/(^|[^\r])\n/.test(ap.text), 'CRLF only');
    assert.ok(store.read('exam').text.startsWith('Gen: NAD\r\n\r\n'));
    assert.deepStrictEqual(recents(), ['medicare_ab_ga']);
});

test('new capture clears the previous patient\'s composed text before the picker opens', async () => {
    let answer;
    const { flow, store } = makeFlow((req) => answer(req));
    answer = confirmAll('medicare_ab_ga');
    await flow.onCapture({ source: 'heidi', captureTs: '1', ap: AP, exam: '' });
    assert.ok(fs.existsSync(store.files.ap));
    let release;
    answer = () => new Promise(r => { release = () => r(null); });
    const p = flow.onCapture({ source: 'heidi', captureTs: '2', ap: AP, exam: '' });
    assert.ok(!fs.existsSync(store.files.ap), 'cleared at capture time, while the picker is still open');
    release();
    await p;
    assert.ok(!fs.existsSync(store.files.ap), 'skip leaves nothing behind');
});

test('a superseded capture never writes', async () => {
    const pending = [];
    const { flow, store } = makeFlow((req) => new Promise(r => pending.push(() => r({ payerId: 'medicare_ab_ga', items: req.detection.items }))));
    const first = flow.onCapture({ source: 'heidi', captureTs: 'A', ap: AP, exam: '' });
    const second = flow.onCapture({ source: 'heidi', captureTs: 'B', ap: AP, exam: '' });
    pending[0]();
    assert.strictEqual((await first).reason, 'superseded');
    pending[1]();
    await second;
    assert.strictEqual(store.read('ap').captureTs, 'B');
});

test('library disabled or unavailable -> no picker, no files', async () => {
    let asked = 0;
    for (const opts of [{ enabled: false }, { withBundle: false }]) {
        const { flow, store } = makeFlow(async () => { asked++; return null; }, opts);
        const r = await flow.onCapture({ source: 'heidi', captureTs: '3', ap: AP, exam: '' });
        assert.strictEqual(r.skipped, true);
        assert.ok(!fs.existsSync(store.files.ap));
    }
    assert.strictEqual(asked, 0);
});

test('source-agnostic: a non-Heidi source with its own exam composes the same way', async () => {
    const { flow, store } = makeFlow(confirmAll('medicare_ab_ga'));
    await flow.onCapture({ source: 'second-scribe', captureTs: '9', ap: AP, exam: '' });
    assert.ok(store.read('exam').text.startsWith('Lumbar spine and lower extremities:'), 'empty scribe exam -> library exam alone');
});

test('capture tracker: leftover slot file at launch is not a new capture', () => {
    const t = createCaptureTracker();
    t.init(true);
    assert.strictEqual(t.observe('100'), false, 'first read records state only');
    assert.strictEqual(t.observe('100'), false, 'same capture');
    assert.strictEqual(t.observe('200'), true, 'next F8');
});

test('capture tracker: no slot file at launch -> the first file is a new capture', () => {
    const t = createCaptureTracker();
    t.init(false);
    assert.strictEqual(t.observe('300'), true);
    assert.strictEqual(t.observe('300'), false);
});
