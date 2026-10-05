const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createMtimePoller, parseSlotsJson, POLL_INTERVAL_MS } = require('../lib/slot-poller');

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
function tmpFile() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mna-poll-'));
    return path.join(dir, 'heidi-slots.json');
}
// Wait until predicate is true or the timeout passes.
async function until(pred, timeoutMs = 3000) {
    const t0 = Date.now();
    while (!pred()) { if (Date.now() - t0 > timeoutMs) return false; await sleep(10); }
    return true;
}

test('default poll interval is 250 ms', () => {
    assert.strictEqual(POLL_INTERVAL_MS, 250);
});

test('slot file change is picked up via mtime polling (no fs.watch)', async () => {
    const f = tmpFile();
    const seen = [];
    const poller = createMtimePoller(f, () => { seen.push(parseSlotsJson(fs.readFileSync(f, 'utf8'))); return true; },
        { intervalMs: 20 }).start();
    try {
        await sleep(60); // file absent: no callback, no crash
        assert.strictEqual(seen.length, 0);
        fs.writeFileSync(f, JSON.stringify({ hpi: 'A', ap: 'B', timestamp: 1 }));
        assert.ok(await until(() => seen.length === 1), 'first write detected');
        // Same size, different content and mtime: still detected.
        await sleep(30);
        fs.writeFileSync(f, JSON.stringify({ hpi: 'C', ap: 'D', timestamp: 2 }));
        const t = new Date(Date.now() + 5000); fs.utimesSync(f, t, t);
        assert.ok(await until(() => seen.length === 2), 'second write detected');
        assert.strictEqual(seen[1].hpi, 'C');
        await sleep(80);
        assert.strictEqual(seen.length, 2, 'unchanged file is not re-read');
    } finally { poller.stop(); }
});

test('large slot content (200 KB) is picked up intact', async () => {
    const f = tmpFile();
    let got = null;
    const poller = createMtimePoller(f, () => { got = parseSlotsJson(fs.readFileSync(f, 'utf8')); return true; },
        { intervalMs: 20 }).start();
    try {
        const big = 'Lumbar spine exam line ___.\n'.repeat(7500);
        fs.writeFileSync(f, JSON.stringify({ hpi: big, ap: big, timestamp: 3 }));
        assert.ok(await until(() => got !== null));
        assert.strictEqual(got.ap.length, big.length);
    } finally { poller.stop(); }
});

test('parse failure (half-written file) is retried on the next tick', async () => {
    const f = tmpFile();
    fs.writeFileSync(f, '{"hpi":"partial');
    let calls = 0, got = null;
    const poller = createMtimePoller(f, () => {
        calls++;
        try { got = parseSlotsJson(fs.readFileSync(f, 'utf8')); return true; } catch { return false; }
    }, { intervalMs: 20 }).start();
    try {
        assert.ok(await until(() => calls >= 2), 'retried while unparseable');
        assert.strictEqual(got, null);
        fs.writeFileSync(f, '{"hpi":"done","ap":"x"}'); // same mtime possible on coarse FS; retry covers it
        assert.ok(await until(() => got !== null));
        assert.strictEqual(got.hpi, 'done');
    } finally { poller.stop(); }
});

test('BOM-strip safety net in the slot reader', () => {
    const d = parseSlotsJson('﻿{"hpi":"x","ap":"y"}');
    assert.deepStrictEqual(d, { hpi: 'x', ap: 'y' });
});

test('main.js uses the poller, not fs.watch', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
    assert.ok(!/fs\.watch\(/.test(src), 'fs.watch must not be used for the slots file');
    assert.ok(/createMtimePoller\(slotsPath, readSlotsFile\)/.test(src));
});
