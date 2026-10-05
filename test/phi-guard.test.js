// PHI guard (spec §0.5 / §7): capture every outbound request during a full capture-and-paste
// cycle. Only the GitHub release GETs are allowed, and none may contain note text.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { createLibraryClient } = require('../lib/library-client');
const { createCaptureFlow, createComposedStore } = require('../lib/capture-flow');
const { createMtimePoller, parseSlotsJson } = require('../lib/slot-poller');
const { bundleRaw, tmpDir, fakeGitHub } = require('./helpers');

const NOTE = {
    hpi: 'Ms. Testpatient Zyxwv is a 63 yo F with chronic axial LBP x 9 months, MRN 99887766.',
    ap: 'Lumbar spondylosis, Zyxwv family history noted.\nProceed with bilateral L4-5, L5-S1 medial branch blocks.\nSchedule right SIJ injection.'
};
const EXAM = 'Gen: NAD. Patient Zyxwv ambulatory.';

test('full capture-and-paste cycle sends only the GitHub release GET and no note text', async () => {
    const dir = tmpDir();
    const gh = fakeGitHub();
    // Intercept global fetch too, in case any module reached for it directly.
    const origFetch = global.fetch;
    const stray = [];
    global.fetch = async (...a) => { stray.push(a); throw new Error('unexpected global fetch'); };
    try {
        const snapshotPath = path.join(dir, 'library.snapshot.json');
        fs.writeFileSync(snapshotPath, bundleRaw);
        const client = createLibraryClient({ fetchImpl: gh.fetchImpl, cacheDir: path.join(dir, 'cache'), snapshotPath, getToken: () => 'test-token-not-real' });
        await client.refresh();

        // AHK writes the slot file; Electron picks it up by polling.
        const slotsPath = path.join(dir, 'heidi-slots.json');
        const store = createComposedStore(dir);
        let recents = [];
        const flow = createCaptureFlow({
            getBundle: client.bundle, isEnabled: () => true, getRecents: () => recents, setRecents: (r) => { recents = r; },
            getInsertion: () => 'end', store,
            ui: async (req) => ({ payerId: 'medicare_ab_ga', items: req.detection.items })
        });
        let result = null;
        const poller = createMtimePoller(slotsPath, async () => {
            const d = parseSlotsJson(fs.readFileSync(slotsPath, 'utf8'));
            result = await flow.onCapture({ source: 'heidi', captureTs: String(d.timestamp), ap: d.ap, exam: EXAM });
            return true;
        }, { intervalMs: 20 }).start();
        fs.writeFileSync(slotsPath, JSON.stringify({ hpi: NOTE.hpi, ap: NOTE.ap, timestamp: 4242 }));
        const t0 = Date.now();
        while (!result && Date.now() - t0 < 3000) await new Promise(r => setTimeout(r, 10));
        poller.stop();
        assert.ok(result && !result.skipped, 'cycle completed');
        // "Paste": what AHK would read for F10/F11.
        assert.match(store.read('ap').text, /Proceed with bilateral/);
        assert.match(store.read('exam').text, /Positive Patrick test on the right/);
        await client.refresh(); // a periodic refresh after the capture, too

        assert.strictEqual(stray.length, 0, 'no global fetch');
        assert.ok(gh.requests.length >= 2);
        const needles = ['Zyxwv', 'Testpatient', '99887766', 'spondylosis', 'medial branch', 'SIJ', 'Gen: NAD'];
        for (const r of gh.requests) {
            assert.strictEqual(r.method, 'GET');
            assert.strictEqual(r.body, null);
            const host = new URL(r.url).host;
            assert.ok(['api.github.com', 'objects.githubusercontent.com'].includes(host), host);
            const wire = r.url + JSON.stringify(r.headers);
            for (const n of needles) assert.ok(!wire.includes(n), `request contains note text "${n}"`);
        }
    } finally { global.fetch = origFetch; }
});

test('static guard: new library/detection modules make no other network calls', () => {
    const lib = path.join(__dirname, '..', 'lib');
    const NET = /\bfetch\s*\(|require\(['"](https?|net|dgram|tls|electron)['"]\)|XMLHttpRequest|WebSocket/;
    for (const f of fs.readdirSync(lib)) {
        const src = fs.readFileSync(path.join(lib, f), 'utf8');
        if (f === 'library-client.js') {
            // Only the injected fetchImpl, only GET.
            assert.ok(!/require\(['"](https?|net)['"]\)/.test(src));
            assert.ok(!/method:\s*'(POST|PUT|PATCH|DELETE)'/.test(src));
            continue;
        }
        assert.ok(!NET.test(src), `${f} must not touch the network`);
    }
});

test('static guard: main.js outbound calls are the pre-existing Claude API calls plus the library client', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
    const calls = src.match(/net\.fetch\(\s*'[^']+'/g) || [];
    assert.deepStrictEqual(calls, ["net.fetch('https://api.anthropic.com/v1/messages'", "net.fetch('https://api.anthropic.com/v1/messages'"]);
    assert.ok(/fetchImpl:\s*\(url, opts\) => net\.fetch\(url, opts\)/.test(src), 'library client gets net.fetch');
    for (const f of ['picker.html', 'picker.js', 'picker-preload.js']) {
        const src2 = fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
        assert.ok(!/fetch\(|XMLHttpRequest|WebSocket|https?:\/\//.test(src2), `${f} makes no requests`);
    }
    assert.match(fs.readFileSync(path.join(__dirname, '..', 'picker.html'), 'utf8'), /default-src 'none'/, 'picker CSP blocks network');
});
