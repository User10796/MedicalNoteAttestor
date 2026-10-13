// 2026-10-12 (build fd53909 fixes): hold the slots until the picker/fill are done, fill progress +
// Cancel, "Why no picker?", and the anthropic-workspace-id header (the cause of the HTTP 400).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const core = require('../lib/mna-core');
const { afterCapture, createCaptureFlow, createComposedStore } = require('../lib/capture-flow');
const { createProcessingHold, encodeHold, decodeHold, STILL_PROCESSING } = require('../lib/processing-hold');
const { createClaudeFiller } = require('../lib/claude-fill-client');
const { tmpDir, response } = require('./helpers');

const ROOT = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const bundle = JSON.parse(read('test/fixtures/library.fixture.json'));
const PLANNED_AP = 'Lumbar radiculopathy, left L5.\nPatient is scheduled for left L5-S1 TFESI.';
const NOT_PLANNED_AP = 'Lumbar radiculopathy, left L5.\nConsider TFESI if no improvement.';

// ── processing hold (Electron side + the file AHK reads) ────────────────────────────────────
test('hold file: encode/decode; an older capture can never change the newest', () => {
    const writes = [], changes = [];
    const h = createProcessingHold({ write: (t) => writes.push(t), onChange: (x) => changes.push(x) });
    h.capture('100');
    assert.strictEqual(h.isHolding(), true, 'nothing pasteable until decided');
    h.hold('100');
    assert.deepStrictEqual(decodeHold(writes[0]), { captureTs: '100', state: 'hold' });
    h.capture('200');
    assert.strictEqual(h.ready('100'), false, 'stale ready ignored');
    assert.strictEqual(h.isHolding(), true);
    h.ready('200');
    assert.strictEqual(h.isHolding(), false);
    assert.strictEqual(writes[writes.length - 1], encodeHold('200', 'ready'));
    assert.deepStrictEqual(decodeHold('\uFEFFMNA-HOLD1 5 ready'), { captureTs: '5', state: 'ready' });
    assert.strictEqual(decodeHold('garbage'), null);
});

// End-to-end: afterCapture + the real capture flow + composed files (what AHK pastes).
function harness({ ui, fillBlanks }) {
    const dir = tmpDir();
    const store = createComposedStore(dir);
    const events = [];
    const hold = createProcessingHold({ write: (t) => events.push('hold-file:' + decodeHold(t).state) });
    const flow = createCaptureFlow({
        getBundle: () => bundle, isEnabled: () => true, getRecents: () => [], setRecents: () => {}, getInsertion: () => 'end',
        store: { clear: () => store.clear(), write: (ts, out) => { store.write(ts, out); events.push('composed'); } },
        ui: async (req) => { events.push('picker:' + (hold.isHolding() ? 'held' : 'NOT HELD')); return ui(req); },
        fillBlanks
    });
    const notices = [];
    const run = (ap, ts = '1') => {
        hold.capture(ts);
        return afterCapture({ ap, bundle, enabled: true, captureTs: ts, hold,
            runFlow: () => flow.onCapture({ source: 'freed', captureTs: ts, ap, exam: 'Freed exam', hpi: 'HPI', fillExam: 'Freed exam' }),
            notify: (n) => notices.push(n) });
    };
    return { run, hold, store, events, notices };
}
const choose = async () => ({ payerId: 'medicare_ab_ga', items: [{ procedure_id: 'lumbar_tfesi', laterality: 'left', checked: true, line: 1 }] });

test('planned: held through picker and fill; published once, with library text and fills already in', async () => {
    let releaseFill;
    const fillGate = new Promise(r => { releaseFill = r; });
    const h = harness({ ui: choose, fillBlanks: async ({ results }) => {
        h.events.push('fill:' + (h.hold.isHolding() ? 'held' : 'NOT HELD'));
        await fillGate;
        return { results: results.map(r => ({ ...r, dotphrase: r.dotphrase.replace(/_{3,}/, 'FILLED') })), review: { summary: 'x' } };
    } });
    const r = h.run(PLANNED_AP);
    assert.strictEqual(r.open, true);
    await new Promise(res => setTimeout(res, 20));
    assert.strictEqual(h.hold.isHolding(), true, 'paste keys paste nothing while the fill runs');
    assert.strictEqual(h.store.read('ap'), null, 'nothing composed yet (never partially processed)');
    releaseFill();
    await r.done;
    assert.strictEqual(h.hold.isHolding(), false);
    assert.deepStrictEqual(h.events, ['hold-file:hold', 'picker:held', 'fill:held', 'composed', 'hold-file:ready'],
        'composed (library + fills) is written before the slots are published');
    assert.ok(h.store.read('ap').text.includes('FILLED'));
});

test('not planned: published immediately (as before) with the notice', async () => {
    const h = harness({ ui: choose });
    const r = h.run(NOT_PLANNED_AP);
    assert.strictEqual(r.open, false);
    assert.strictEqual(h.hold.isHolding(), false);
    assert.deepStrictEqual(h.events, ['hold-file:ready']);
    assert.deepStrictEqual(h.notices, ['No planned procedure detected \u2014 use Open payer picker if needed.']);
});

test('picker closed without a selection: published without library text', async () => {
    const h = harness({ ui: async () => null });
    await h.run(PLANNED_AP).done;
    assert.strictEqual(h.hold.isHolding(), false);
    assert.strictEqual(h.store.read('ap'), null, 'no library text');
    assert.deepStrictEqual(h.events, ['hold-file:hold', 'picker:held', 'hold-file:ready']);
});

test('fill fails or is cancelled: published with the library text unfilled and the notice', async () => {
    const h = harness({ ui: choose, fillBlanks: async ({ results }) => ({ results, review: { notice: core.fillNotice('cancelled') } }) });
    await h.run(PLANNED_AP).done;
    assert.strictEqual(h.hold.isHolding(), false);
    assert.match(h.store.read('ap').text, /_{3,}/, 'library text present, blanks unfilled');
});

test('a flow that throws still publishes (never stuck holding)', async () => {
    const h = harness({ ui: async () => { throw new Error('picker crashed'); } });
    await h.run(PLANNED_AP).done;
    assert.strictEqual(h.hold.isHolding(), false);
});

test('a newer capture during processing: the old flow can never publish the new capture', async () => {
    let release;
    const h = harness({ ui: () => new Promise(r => { release = () => r(null); }) });
    const first = h.run(PLANNED_AP, '1');
    await new Promise(res => setTimeout(res, 5));
    h.hold.capture('2');   // new capture arrived, not decided yet
    release();
    await first.done;
    assert.strictEqual(h.hold.isHolding(), true, 'capture 2 still undecided: still held');
});

test('Windows wiring: paste keys refuse held slots with the notice; AHK uses the same text and file', () => {
    const main = read('main.js');
    assert.match(main, /function pasteSlot\(slotName\) \{\s*\n\s*if \(processing\.isHolding\(\)\) \{ showNotice\(STILL_PROCESSING\); return; \}/);
    assert.match(main, /function beginCapture\(captureTs\) \{[\s\S]{0,120}processing\.capture\(captureTs\);/);
    assert.strictEqual(STILL_PROCESSING, 'Still processing \u2014 wait for the picker/fill to finish.');
    const ahk = read('autohotkey/heidi-hotkeys.ahk');
    for (const fn of ['DoPasteHpi', 'DoPasteExam', 'DoPasteAp']) {
        const body = ahk.slice(ahk.indexOf(fn + '() {'), ahk.indexOf('\n}', ahk.indexOf(fn + '() {')));
        assert.match(body, /if PasteHeld\(\)\s*\n\s*return/, fn + ' refuses held slots');
    }
    assert.match(ahk, /MnaReadHold\(GetRuntimeDir\(\) "\\mna-hold\.txt"\)/);
    assert.match(read('autohotkey/mna-lib.ahk'), /return "Still processing " Chr\(0x2014\) " wait for the picker\/fill to finish\."/);
});

// ── "Why no picker?" ─────────────────────────────────────────────────────────────────────────
test('pickerExplain: every A&P line with whether it was evaluated and why', () => {
    const ap = '1. Lumbar radiculopathy\n- Consider TFESI if no improvement\n- Continue gabapentin\nProcedures considered: TFESI\n\nFollow-up:\n- Schedule TFESI at next visit';
    const rows = core.pickerExplain(ap, bundle);
    const by = (l) => rows.find(r => r.line === l);
    assert.match(by('- Consider TFESI if no improvement').reason, /hedged by "consider"|hedged by "if"/i);
    assert.strictEqual(by('- Continue gabapentin').reason, 'no procedure term');
    assert.match(by('Procedures considered: TFESI').reason, /never count/);
    assert.strictEqual(by('Follow-up:').evaluated, false);
    assert.strictEqual(by('- Schedule TFESI at next visit').evaluated, false);
    assert.match(by('- Schedule TFESI at next visit').reason, /Follow-up block/);
    assert.ok(rows.every(r => !r.planned));
    const yes = core.pickerExplain('Patient is scheduled for right L4-L5 TFESI', bundle)[0];
    assert.strictEqual(yes.planned, true);
    assert.match(yes.reason, /procedure "TFESI" \+ "scheduled"/);
});
test('"Why no picker?" is local only: shown with textContent, never logged or sent', () => {
    const main = read('main.js');
    const handler = main.slice(main.indexOf("ipcMain.handle('picker-explain'"), main.indexOf('});', main.indexOf("ipcMain.handle('picker-explain'")));
    assert.ok(!/console\.|log\(|fetch|net\./.test(handler));
    assert.match(handler, /e\.sender !== mainWindow\.webContents/);
    const r = read('renderer.js');
    const fn = r.slice(r.indexOf('async function showPickerExplain()'), r.indexOf('// Slots are held while'));
    assert.ok(!/innerHTML|console\./.test(fn));
    assert.match(read('index.html'), /id="why-no-picker"[^>]*>|onclick="showPickerExplain\(\)">Why no picker\?<\/button>/);
});

// ── HTTP 400: key not scoped to a workspace -> anthropic-workspace-id header ─────────────────
test('workspace ID: header added on every Claude call when set; invalid values ignored', () => {
    assert.deepStrictEqual(core.claudeHeaders(''), { 'Content-Type': 'application/json', 'anthropic-version': '2023-06-01' });
    assert.strictEqual(core.claudeHeaders(' wrkspc_01ABCdef ')['anthropic-workspace-id'], 'wrkspc_01ABCdef');
    assert.strictEqual(core.claudeHeaders('bad id; x')['anthropic-workspace-id'], undefined);
    const main = read('main.js');
    assert.strictEqual((main.match(/\.\.\.core\.claudeHeaders\(store\.get\('claudeWorkspaceId'\)\), 'x-api-key': apiKey/g) || []).length, 2, 'Attestor + action items');
    assert.match(main, /getWorkspaceId: \(\) => store\.get\('claudeWorkspaceId'\),/, 'Claude fill');
    assert.match(read('settings.html'), /id="claude-workspace-id"/);
});
test('the fill sends anthropic-workspace-id, and the 400 notice explains how to fix it', async () => {
    let headers;
    const msg = 'This API key is not scoped to a workspace, so this request must include the anthropic-workspace-id header with the ID of the workspace to use.';
    const f = createClaudeFiller({ fetchImpl: async (u, o) => { headers = o.headers; return response(400, { json: { type: 'error', error: { type: 'invalid_request_error', message: msg } } }); },
        getKey: () => 'k', isEnabled: () => true, model: core.FILL_MODEL, getWorkspaceId: () => 'wrkspc_test' });
    const results = core.resolveSelections(bundle, 'medicare_ab_ga', [{ procedure_id: 'lumbar_tfesi', laterality: 'left', checked: true, line: 0 }]);
    const r = await f.fill({ note: { hpi: 'h', exam: 'e', ap: 'a' }, results });
    assert.strictEqual(headers['anthropic-workspace-id'], 'wrkspc_test');
    assert.strictEqual(headers['anthropic-version'], '2023-06-01');
    assert.strictEqual(r.review.notice, 'Claude fill failed (400 invalid_request_error: ' + msg + ') \u2014 blanks left as-is.' +
        ' Add your workspace ID in Settings \u2192 Claude API, or use a key scoped to a workspace.');
});

// ── Progress window ────────────────────────────────────────────────────────────────────────
test('progress window: over any app, elapsed time, Cancel wired to the filler', () => {
    const main = read('main.js');
    assert.match(main, /fillProgressWindow\.setAlwaysOnTop\(true, 'screen-saver'\)/);
    assert.match(main, /w\.showInactive\(\)/, 'does not steal focus');
    assert.match(main, /ipcMain\.on\('fill-cancel', \(e\) => \{[\s\S]{0,140}claudeFiller\.cancel\(\);/);
    const js = read('fill-progress.js');
    assert.match(js, /window\.fillProgressAPI\.cancel\(\)/);
    assert.match(js, /elapsed\.textContent = Math\.round\(\(Date\.now\(\) - startedAt\) \/ 1000\) \+ ' s'/);
    assert.match(read('fill-progress.html'), /script-src 'self'/);
    assert.ok(!/innerHTML/.test(js));
    for (const f of ['fill-progress.html', 'fill-progress.js', 'fill-progress-preload.js', 'lib/processing-hold.js'])
        assert.match(read('scripts/verify-asar-contents.js'), new RegExp("'" + f.replace('.', '\\.') + "'"), f + ' checked in app.asar');
});
