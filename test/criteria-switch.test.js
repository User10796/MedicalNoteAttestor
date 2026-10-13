// "Include procedure criteria" switch (2026-10-12): A&P paste with or without the library criteria
// text, read at paste time; reset to On for each new capture unless Settings says otherwise.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const core = require('../lib/mna-core');
const { slotContent, createCaptureFlow, createComposedStore } = require('../lib/capture-flow');
const { tmpDir } = require('./helpers');

const ROOT = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const bundle = JSON.parse(read('test/fixtures/library.fixture.json'));
const AP = 'Lumbar radiculopathy, left L5.\nPatient is scheduled for left L5-S1 TFESI.';

// One real capture -> picker -> composed A&P (with criteria text) and exam, as the app builds them.
async function composed() {
    const store = createComposedStore(tmpDir());
    const flow = createCaptureFlow({ getBundle: () => bundle, isEnabled: () => true, getRecents: () => [], setRecents: () => {},
        getInsertion: () => 'end', store,
        ui: async () => ({ payerId: 'medicare_ab_ga', items: [{ procedure_id: 'lumbar_tfesi', laterality: 'left', checked: true, line: 1 }] }) });
    const out = await flow.onCapture({ source: 'freed', captureTs: '1', ap: AP, exam: 'Freed exam', hpi: 'HPI' });
    return { failed: false, hpi: 'HPI', ap: AP, examDotPhrase: 'Default exam', composedExam: out.exam, composedAp: out.ap };
}

test('switch on: A&P paste includes the library criteria text; off: only the captured A&P', async () => {
    const s = await composed();
    assert.ok(s.composedAp.length > AP.length, 'criteria text composed');
    assert.strictEqual(slotContent('ap', { ...s, includeCriteria: true }), s.composedAp);
    assert.strictEqual(slotContent('ap', { ...s, includeCriteria: false }), AP);
    assert.strictEqual(slotContent('ap', { ...s }), s.composedAp, 'default (unset) is On');
});

test('flipping after capture changes the next A&P paste without re-capturing', async () => {
    const s = await composed();
    let on = true;
    const paste = () => slotContent('ap', { ...s, includeCriteria: on });   // main.js reads the switch at paste time
    assert.strictEqual(paste(), s.composedAp);
    on = false;
    assert.strictEqual(paste(), AP);
    on = true;
    assert.strictEqual(paste(), s.composedAp);
});

test('the exam slot is unaffected by the switch', async () => {
    const s = await composed();
    assert.ok(s.composedExam.includes('Freed exam') && s.composedExam.length > 'Freed exam'.length, 'library exam text composed');
    assert.strictEqual(slotContent('exam', { ...s, includeCriteria: false }), s.composedExam);
    assert.strictEqual(slotContent('exam', { ...s, includeCriteria: true }), s.composedExam);
});

test('new capture: reset to On when the setting is on (default); keeps its position when off', () => {
    assert.strictEqual(core.criteriaSwitchAfterCapture(false, true), true, 'setting on: Off -> On');
    assert.strictEqual(core.criteriaSwitchAfterCapture(true, true), true);
    assert.strictEqual(core.criteriaSwitchAfterCapture(false, false), false, 'setting off: stays Off');
    assert.strictEqual(core.criteriaSwitchAfterCapture(true, false), true, 'setting off: stays On');
    assert.strictEqual(core.criteriaSwitchAfterCapture(undefined, false), true, 'never set: On');
});

test('Windows wiring: persisted (survives restarts), reset on capture, preview follows, AHK reads it at A&P paste time', () => {
    const main = read('main.js');
    assert.match(main, /includeCriteria: true, {9}\/\/ main-screen switch/);
    assert.match(main, /criteriaResetOnCapture: true, {2}\/\/ every new capture/);
    assert.match(main, /function includeCriteria\(\) \{ return store\.get\('includeCriteria'\) !== false; \}/, 'persisted in the config store');
    assert.match(main, /function beginCapture\(captureTs\) \{[\s\S]{0,300}core\.criteriaSwitchAfterCapture\(includeCriteria\(\), store\.get\('criteriaResetOnCapture'\) !== false\)/);
    assert.match(main, /composedExam: c && c\.exam, composedAp: c && c\.ap, includeCriteria: includeCriteria\(\) \};/);
    assert.match(main, /function setIncludeCriteria\(on\) \{[\s\S]{0,300}writeCriteriaFile\(\);[\s\S]{0,200}sendSlotState\(\);/, 'A&P preview reflects the switch');
    assert.match(main, /writeCriteriaFile\(\);\s*\n\s*launchAHK\(\);/, 'written at startup for AHK');
    const ahk = read('autohotkey/heidi-hotkeys.ahk');
    const ap = ahk.slice(ahk.indexOf('DoPasteAp() {'), ahk.indexOf('\n}', ahk.indexOf('DoPasteAp() {')));
    assert.match(ap, /composed := MnaCriteriaOn\(GetRuntimeDir\(\) "\\mna-criteria\.txt"\) \? MnaReadComposed\(GetRuntimeDir\(\) "\\mna-ap\.txt", lastCaptureTs\) : ""/);
    const exam = ahk.slice(ahk.indexOf('DoPasteExam() {'), ahk.indexOf('\n}', ahk.indexOf('DoPasteExam() {')));
    assert.ok(!/Criteria/.test(exam), 'exam paste ignores the switch');
});

test('UI: a toggle switch near the A&P slot (both platforms) and the reset setting', () => {
    const html = read('index.html');
    const i = html.indexOf('id="slot-ap"'), sw = html.indexOf('id="criteria-switch"');
    assert.ok(sw > i && sw < html.indexOf('id="capture-btn"'), 'right under the A&P slot');
    assert.match(html, /<input type="checkbox" role="switch" id="criteria-switch"/);
    assert.match(html, /\.criteria-switch \.track/, 'styled as a switch');
    assert.match(read('settings.html'), /Reset criteria switch to On for each new capture/);
    const tab = read('MedicalNoteAttestor/HeidiTabView.swift');
    const a = tab.indexOf('SlotCard(label: "A/P"'), t = tab.indexOf('Toggle("Include procedure criteria", isOn: $slotManager.includeCriteria)');
    assert.ok(t > a, 'Mac: right under the A&P slot');
    assert.match(tab.slice(t, t + 200), /\.toggleStyle\(\.switch\)/);
    assert.match(read('MedicalNoteAttestor/SettingsView.swift'), /Toggle\("Reset criteria switch to On for each new capture", isOn: \$criteriaReset\)/);
    const sm = read('MedicalNoteAttestor/HeidiSlotManager.swift');
    assert.match(sm, /if libraryDots\.isEmpty \|\| !includeCriteria \{ return ap \}/, 'Mac A&P paste and preview follow the switch');
    assert.match(sm, /includeCriteria = UserDefaults\.standard\.object\(forKey: Self\.includeCriteriaKey\) as\? Bool \?\? true/, 'Mac: persisted, default On');
    assert.strictEqual((sm.match(/resetCriteriaForNewCapture\(\)/g) || []).length, 3, 'Mac: reset on Heidi and Freed captures');
});
