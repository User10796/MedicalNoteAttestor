// 2026-10-12 fixes: Claude fill on every library insertion (never silent), picker gating for every
// capture source, procedure abbreviations, and rebinding changes only the key (never the source).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const core = require('../lib/mna-core');
const { createCaptureFlow, createComposedStore } = require('../lib/capture-flow');
const { tmpDir } = require('./helpers');

const ROOT = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const bundle = JSON.parse(read('test/fixtures/library.fixture.json'));

// ── Procedure terms ───────────────────────────────────────────────────────────────────────────
const ABBREVIATIONS = ['TFESI', 'ILESI', 'LESI', 'CESI', 'TESI', 'TF ESI', 'IL ESI', 'SIJI', 'SIJ', 'TPI', 'GTB', 'GNB',
                       'RFA', 'RFTC', 'MBB', 'LMBB', 'CMBB', 'SCS'];
test('every requested abbreviation is a procedure term, with or without a library', () => {
    for (const b of [null, bundle]) {
        const terms = core.procedureTerms(b);
        for (const a of ABBREVIATIONS) {
            assert.ok(terms.includes(a), `${a} in terms (${b ? 'library' : 'base'})`);
            assert.strictEqual(core.procedureLineIsPlanned(`Schedule right ${a}`, b), true, `Schedule right ${a}`);
            assert.strictEqual(core.procedureLineIsPlanned(`Consider ${a} if no improvement`, b), false, `Consider ${a}`);
        }
    }
});
test('terms include every procedure name and alias in the library, plus names without the region prefix', () => {
    const terms = core.procedureTerms(bundle);
    const procs = (bundle.registries && bundle.registries.procedures) || bundle.procedures || [];
    assert.ok(procs.length > 0);
    for (const p of procs) for (const n of [p.name].concat(p.aliases || [])) assert.ok(terms.includes(n), n);
    assert.ok(terms.includes('transforaminal ESI') || !procs.some(p => /^Lumbar\/sacral transforaminal ESI$/.test(p.name)));
});

// ── Picker gating: every source, same rule ──────────────────────────────────────────────────
const HEIDI_AP_PLANNED = 'Lumbar radiculopathy, left L5.\nPatient is scheduled for right L4-L5 TFESI.\nContinue gabapentin 300 mg nightly.';
const HEIDI_AP_CONSIDER = 'Lumbar radiculopathy, left L5.\nConsider TFESI if no improvement with physical therapy.\nFollow up in 6 weeks.';
test('Heidi free-text A&P: planned TFESI opens the picker; consider-only shows the notice instead', () => {
    assert.deepStrictEqual(core.pickerOnCapture(HEIDI_AP_PLANNED, bundle), { open: true, notice: null });
    assert.deepStrictEqual(core.pickerOnCapture(HEIDI_AP_CONSIDER, bundle),
        { open: false, notice: 'No planned procedure detected — use Open payer picker if needed.' });
    assert.strictEqual(core.NO_PLANNED_NOTICE, 'No planned procedure detected — use Open payer picker if needed.');
});
test('plain sentence and labeled lines count for Freed too; summary-line rules unchanged', () => {
    const ap = (line) => `1. Lumbar radiculopathy\n${line}`;
    assert.strictEqual(core.procedurePlanned(ap('Patient is scheduled for right L4-L5 TFESI'), bundle), true, 'plain sentence line');
    assert.strictEqual(core.procedurePlanned(ap('Plan: Schedule right L4-L5 TFESI'), bundle), true, 'labeled line');
    assert.strictEqual(core.procedurePlanned(ap('Plan: Consider TFESI'), bundle), false);
    assert.strictEqual(core.procedurePlanned(ap('Procedures considered: right L4-L5 TFESI'), bundle), false);
    assert.strictEqual(core.procedurePlanned(ap('Procedures scheduled: None'), bundle), false);
    assert.strictEqual(core.freedProcedurePlanned, core.procedurePlanned, 'one rule for every source');
});
test('empty A&P: no picker, no notice', () => {
    assert.deepStrictEqual(core.pickerOnCapture('', bundle), { open: false, notice: null });
});

// ── Claude fill on every library insertion ──────────────────────────────────────────────────
// Every path in main.js (automatic after a Heidi or Freed capture, the "Open payer picker" button,
// the picker hotkey) goes through startLibraryFlow -> captureFlow.onCapture, which calls fillBlanks
// with the captured HPI, exam and A&P and the inserted exam AND A&P library text.
for (const source of ['heidi', 'freed']) {
    test(`fill runs for a ${source} capture with the captured note and both exam and A&P templates`, async () => {
        const calls = [];
        const flow = createCaptureFlow({
            getBundle: () => bundle, isEnabled: () => true, getRecents: () => [], setRecents: () => {},
            getInsertion: () => 'end', store: createComposedStore(tmpDir()),
            ui: async () => ({ payerId: 'medicare_ab_ga', items: [{ procedure_id: 'lumbar_tfesi', laterality: 'left', checked: true, line: 0 }] }),
            fillBlanks: async (req) => { calls.push(req); return null; }
        });
        const fillExam = source === 'freed' ? 'Freed exam text' : '';
        await flow.onCapture({ source, captureTs: '9', hpi: 'HPI text', ap: HEIDI_AP_PLANNED, exam: 'x', fillExam });
        assert.strictEqual(calls.length, 1);
        assert.deepStrictEqual(calls[0].note, { hpi: 'HPI text', exam: fillExam, ap: HEIDI_AP_PLANNED });
        const slots = core.fillTemplatesFromResults(calls[0].results).map(t => t.slot);
        assert.ok(slots.includes('exam') && slots.includes('ap'), 'exam and A&P library text both offered');
    });
}
test('main.js: every insertion path reaches the same flow, which always has the Claude filler', () => {
    const src = read('main.js');
    assert.match(src, /fillBlanks: \(req\) => claudeFiller\.fill\(req\),/);
    assert.match(src, /function startLibraryFlow\(source, captureTs\) \{[\s\S]{0,400}captureFlow\.onCapture\(/);
    assert.match(src, /hold: processing, runFlow: \(\) => startLibraryFlow\(source, captureTs\),/, 'automatic (Heidi and Freed)');
    assert.match(src, /startLibraryFlow\(currentSource, ts\)\.finally\(\(\) => processing\.ready\(ts\)\);/, 'manual open, either source');
    assert.match(src, /ipcMain\.handle\('open-picker-manually', \(\) => openPickerManually\(\)\);/, 'button');
    assert.match(src, /tryRegister\(hk\.openPicker, \(\) => \{ const r = openPickerManually\(\);/, 'picker hotkey');
    const manual = src.slice(src.indexOf('function openPickerManually()'), src.indexOf('ipcMain.handle(\'open-picker-manually\''));
    assert.ok(!/currentSource !== 'freed'/.test(manual), 'manual open is not Freed-only');
});

// ── Rebinding changes only the key ──────────────────────────────────────────────────────────
test('Freed capture on F8 (Heidi moved): valid; the action, not the key, picks the source', () => {
    const v = core.validateHotkeys({ capture: 'Ctrl+Shift+F8', captureFreed: 'F8' }, 'win32');
    assert.ok(v.ok, JSON.stringify(v.errors));
    assert.strictEqual(v.bindings.captureFreed, 'F8');
    assert.strictEqual(core.toAhkHotkey(v.bindings.captureFreed), 'F8');
    assert.strictEqual(core.captureSourceForAction('captureFreed'), 'freed');
    assert.strictEqual(core.captureSourceForAction('capture'), 'heidi');
});
test('AHK and Electron dispatch by action name; no source/parser/gating/fill decision reads a key name', () => {
    const ahk = read('autohotkey/heidi-hotkeys.ahk');
    assert.match(ahk, /case "capture":\s+DoCapture\(\)/);
    assert.match(ahk, /case "captureFreed": DoCaptureFreed\(\)/);
    assert.match(ahk, /Hotkey\(key, MakeHandler\(action\), "On"\)/);
    const main = read('main.js');
    assert.match(main, /captureFreed: 'freedCaptureHotkey'/);
    // Electron learns the source from which bridge file changed (slot file = Heidi, freed-clip = Freed).
    assert.match(main, /if \(isNewCapture\) \{\s*\n\s*currentSource = 'heidi';/);
    assert.match(main, /freedExam = r\.slots\.exam;\s*\n\s*currentSource = 'freed';/);
    for (const f of ['main.js', 'lib/capture-flow.js', 'lib/claude-fill-client.js', 'lib/freed-capture.js', 'lib/mna-core.js']) {
        const code = read(f).replace(/^\s*\/\/.*$/gm, '');
        assert.ok(!/(===|!==|==|!=)\s*'F[0-9]{1,2}'|'F[0-9]{1,2}'\s*(===|!==|==|!=)/.test(code), `${f}: no comparison with a key name`);
    }
});

// ── Windows notices reach the user outside the main window ──────────────────────────────────
test('notices: main window + AHK tooltip file; AHK polls it and skips one left from before launch', () => {
    const main = read('main.js');
    assert.match(main, /function showNotice\(text, \{ tooltipSuffix = '' \} = \{\}\) \{[\s\S]{0,300}webContents\.send\('source-notice', text\)[\s\S]{0,300}mna-notice\.txt/);
    assert.match(main, /notify: \(notice\) => showNotice\(notice, \{ tooltipSuffix: ' \(Why\? See the MNA window\.\)' \}\)/);
    const ahk = read('autohotkey/heidi-hotkeys.ahk');
    assert.match(ahk, /SetTimer\(CheckNoticeFile, 250\)/);
    assert.match(ahk, /ShowNotice\(n\["message"\]\)/);
    assert.match(read('autohotkey/mna-lib.ahk'), /MnaParseNotice\(raw, lastId\)/);
});
