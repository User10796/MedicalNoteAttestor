// Freed: open the payer picker only for a planned procedure
// (SPEC_freed_picker_on_planned_procedure). The shared cases file is also run by the Swift tests.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const core = require('../lib/mna-core');
const freed = require('../lib/freed-parser');
const { createCaptureFlow, createComposedStore } = require('../lib/capture-flow');
const { createFreedCapture } = require('../lib/freed-capture');
const { tmpDir } = require('./helpers');

const FIX = path.join(__dirname, 'fixtures');
const bundle = JSON.parse(fs.readFileSync(path.join(FIX, 'library.fixture.json'), 'utf8'));
const cases = JSON.parse(fs.readFileSync(path.join(FIX, 'freed', 'procedure_intent_cases.json'), 'utf8'));
const apOf = (f) => freed.parseFreed(freed.normalize(fs.readFileSync(path.join(FIX, 'freed', f), 'utf8'))).slots.ap;

test('shared intent cases file has the spec minimum (18) and more', () => assert.ok(cases.length >= 18));
for (const c of cases) {
    test(`intent: ${c.planned ? 'planned' : 'not planned'} — ${c.text}`, () => {
        assert.strictEqual(core.procedureLineIsPlanned(c.text, bundle), c.planned);
        assert.strictEqual(core.procedureLineIsPlanned('- ' + c.text, bundle), c.planned, 'as a bullet');
    });
}
test('intent cases also hold without a library bundle (base term list only)', () => {
    for (const c of cases) assert.strictEqual(core.procedureLineIsPlanned(c.text, null), c.planned, c.text);
});

test('whole notes: samples 01 and 02 open the picker; sample 03 (consider-only) does not', () => {
    assert.strictEqual(core.freedProcedurePlanned(apOf('freed_sample_01.txt'), bundle), true);
    assert.strictEqual(core.freedProcedurePlanned(apOf('freed_sample_02_no_exam.txt'), bundle), true);
    assert.strictEqual(core.freedProcedurePlanned(apOf('freed_sample_03_consider_only.txt'), bundle), false);
});

test('sample 03 parses: F9 / F10 / F11 match the new expected files', () => {
    const n = (s) => freed.normalize(s).replace(/\n+$/, '');
    const r = freed.parseFreed(freed.normalize(fs.readFileSync(path.join(FIX, 'freed', 'freed_sample_03_consider_only.txt'), 'utf8')));
    assert.ok(r.valid);
    for (const [k, e] of [['hpi', 'F9'], ['exam', 'F10'], ['ap', 'F11']]) {
        assert.strictEqual(n(r.slots[k]), n(fs.readFileSync(path.join(FIX, 'freed', `freed_sample_03_consider_only.${e}.expected.txt`), 'utf8')), e);
    }
});

test('the Follow-up: block is ignored; the summary lines after it are not', () => {
    const ap = '1. Knee pain\n- Continue PT\n\nFollow-up:\n- Schedule repeat genicular nerve block at next visit\n\nProcedures scheduled: None';
    assert.strictEqual(core.freedProcedurePlanned(ap, bundle), false, 'follow-up bullet ignored');
    const ap2 = ap.replace('Procedures scheduled: None', 'Procedures scheduled: left genicular nerve block');
    assert.strictEqual(core.freedProcedurePlanned(ap2, bundle), true, 'summary line after Follow-up still counts');
});

test('Heidi detection (library picker rows) is unchanged by the Freed rule', () => {
    const d = core.detectProcedures('Consider TFESI in the future if radicular symptoms persist.', bundle);
    assert.deepStrictEqual(d.items.map(i => [i.procedure_id, i.checked]), [['lumbar_tfesi', false]]);
});

// ── Fallback: manual open after a capture that didn't auto-open ───────────────────────────────
test('manual "Open payer picker" after a non-planned Freed capture inserts library exam text for F10', async () => {
    const dir = tmpDir();
    const store = createComposedStore(dir);
    let asked = 0;
    const flow = createCaptureFlow({
        getBundle: () => bundle, isEnabled: () => true, getRecents: () => [], setRecents: () => {},
        getInsertion: () => 'end', store,
        ui: async (req) => { asked++; return { payerId: 'medicare_ab_ga', items: [{ procedure_id: 'lumbar_mbb', laterality: 'bilateral', checked: true, line: 0 }] }; }
    });
    const cap = createFreedCapture({ writeResult: () => {} });
    const r = cap.process({ captureTs: '77', raw: fs.readFileSync(path.join(FIX, 'freed', 'freed_sample_03_consider_only.txt'), 'utf8') });
    assert.strictEqual(r.status, 'ok');
    // Automatic path: the rule says not planned -> main.js does not call the flow.
    assert.strictEqual(core.freedProcedurePlanned(r.slots.ap, bundle), false);
    assert.strictEqual(asked, 0);
    // Manual path: same flow, same capture.
    await flow.onCapture({ source: 'freed', captureTs: '77', ap: r.slots.ap, exam: r.slots.exam });
    assert.strictEqual(asked, 1);
    const exam = store.read('exam');
    assert.strictEqual(exam.captureTs, '77', 'composed for the current capture (AHK pastes it on F10)');
    assert.ok(exam.text.startsWith(r.slots.exam.replace(/\n/g, '\r\n') + '\r\n\r\n'), 'Freed exam then library exam');
    assert.ok(exam.text.includes('Lumbar spine and lower extremities:'), 'library exam text inserted');
});

test('main.js wiring: Freed auto-open is gated by the rule; manual open + hotkey reuse the same flow; Heidi untouched', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
    assert.match(src, /if \(slots\.ap && core\.freedProcedurePlanned\(slots\.ap, getLibraryClient\(\)\.bundle\(\)\)\) startLibraryFlow\('freed', ts\);/);
    assert.match(src, /if \(isNewCapture && !captureFailed && slots\.ap\) startLibraryFlow\('heidi', ts\);/, 'Heidi auto-open unchanged');
    assert.match(src, /function openPickerManually\(\)/);
    assert.match(src, /ipcMain\.handle\('open-picker-manually'/);
    assert.ok(!/api\.anthropic\.com[\s\S]{0,400}freedProcedurePlanned|freedProcedurePlanned[\s\S]{0,400}api\.anthropic/.test(src), 'no network for detection');
});

test('optional "Open picker" hotkey: unbound by default, rebindable, not a browser key by default', () => {
    assert.deepStrictEqual(core.defaultHotkeys(), { capture: 'F8', pasteHpi: 'F9', pasteExam: 'F10', pasteAp: 'F11' }, 'defaults unchanged');
    assert.ok(!('openPicker' in core.validateHotkeys({}, 'win32').bindings), 'unbound by default');
    const v = core.validateHotkeys({ openPicker: 'Ctrl+Shift+P' }, 'win32');
    assert.ok(v.ok); assert.strictEqual(v.bindings.openPicker, 'Ctrl+Shift+P');
    assert.strictEqual(core.validateHotkeys({ openPicker: 'F9' }, 'win32').ok, false, 'duplicate rejected');
    assert.ok(core.validateHotkeys({ openPicker: 'F6' }, 'win32').warnings.some(w => /browser/i.test(w.message)), 'browser key warned');
    assert.deepStrictEqual(core.optionalHotkeyActions('darwin').map(a => a.id), ['openPicker']);
});
