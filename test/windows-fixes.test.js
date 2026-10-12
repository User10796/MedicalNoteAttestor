// Windows fixes (2026-10-12): Freed exam fallback, remaining "Heidi" branding, action items off by default.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { examFallback, slotContent } = require('../lib/capture-flow');
const profiles = require('../lib/source-profiles');
const ROOT = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');

// ── F10 after a Freed capture: Freed exam -> library exam (if inserted) -> default exam ──────────
const f10 = (s) => slotContent('exam', { failed: false, hpi: 'h', ap: 'a', composedAp: null, ...s });
test('Freed exam present -> Freed exam (library text, if inserted, is composed on top)', () => {
    assert.strictEqual(f10({ examDotPhrase: examFallback('freed', 'Freed exam', 'Default'), composedExam: null }), 'Freed exam');
    assert.strictEqual(f10({ examDotPhrase: examFallback('freed', 'Freed exam', 'Default'), composedExam: 'Freed exam\n\nLib' }), 'Freed exam\n\nLib');
});
test('Freed exam empty/N/A + library inserted -> library exam text (before the default)', () => {
    assert.strictEqual(f10({ examDotPhrase: examFallback('freed', '', 'Default'), composedExam: 'Lib exam' }), 'Lib exam');
});
test('Freed exam empty/N/A, no library -> default exam from Settings', () => {
    assert.strictEqual(f10({ examDotPhrase: examFallback('freed', '', 'Default exam'), composedExam: null }), 'Default exam');
});
test('nothing anywhere -> empty (silent no-op); failed capture -> nothing', () => {
    assert.strictEqual(f10({ examDotPhrase: examFallback('freed', '', ''), composedExam: null }), '');
    assert.strictEqual(slotContent('exam', { failed: true, examDotPhrase: examFallback('freed', '', 'Default') }), '');
});
test('Heidi exam path unchanged: default exam, library composed on top', () => {
    assert.strictEqual(examFallback('heidi', 'ignored', 'Default'), 'Default');
    assert.strictEqual(f10({ examDotPhrase: examFallback('heidi', '', 'Default'), composedExam: 'Default\n\nLib' }), 'Default\n\nLib');
});
test('a new Freed capture never carries over the previous capture\'s exam', () => {
    // examFallback is stateless; main.js replaces freedExam on every Freed capture and clears it on F8/Clear.
    const main = read('main.js');
    assert.match(main, /examDotPhrase: examFallback\(currentSource, freedExam, getExamSlot\(\)\)/);
    assert.match(main, /freedExam = r\.slots\.exam;/);
    assert.match(main, /currentSource = 'heidi'; freedExam = '';/);
});
test('AHK F10 for Freed uses the same order (Freed exam, library text, default exam)', () => {
    const ahk = read('autohotkey/heidi-hotkeys.ahk');
    const body = ahk.slice(ahk.indexOf('DoPasteExam() {'), ahk.indexOf('\n}', ahk.indexOf('DoPasteExam() {')));
    assert.match(body, /MnaContentToPaste\(captureFailed, composed, MnaFreedExamFallback\(slotFreedExam, examDotPhrase\)\)/);
    assert.match(body, /LoadConfig\(\)/, 'reads the current default exam');
});

// ── "Heidi" branding on Windows ─────────────────────────────────────────────────────────────────
test('no user-visible "Heidi" on Windows except hotkey labels naming the source', () => {
    const visible = (txt) => txt.split('\n').filter(l => /Heidi/.test(l) && !/^\s*(\/\/|;|<!--|\/\*|\*)/.test(l));
    // HTML/JS UI files: no visible Heidi text at all (identifiers like setHeidiStatus are code, not text).
    for (const f of ['index.html', 'settings.html', 'picker.html', 'picker.js', 'overlay.html']) {
        // Allowed: the per-source capture instructions ("Heidi: click into the note…").
        const hits = visible(read(f)).filter(l => /[>'"`][^<'"`]*\bHeidi\b/.test(l) && !/Heidi: click into the note/.test(l));
        assert.deepStrictEqual(hits, [], f);
    }
    // Strings in main.js / renderer.js / AHK: only internal identifiers remain ([Heidi] ini section).
    assert.deepStrictEqual(visible(read('renderer.js')).filter(l => /['"`][^'"`]*\bHeidi\b[^'"`]*['"`]/.test(l)), []);
    assert.deepStrictEqual(visible(read('main.js')).filter(l => /['"`][^'"`]*\bHeidi\b/.test(l) && !/\[Heidi\]/.test(l)), []);
    const ahk = read('autohotkey/heidi-hotkeys.ahk');
    assert.deepStrictEqual(visible(ahk).filter(l => /"[^"]*\bHeidi\b[^"]*"/.test(l) && !/IniRead\(configPath, "Heidi"/.test(l)), []);
    assert.match(ahk, /A_IconTip := "Medical Note Attestor " Chr\(0x2014\) " AI Note hotkeys"/, 'tray tooltip');
    assert.strictEqual(JSON.parse(read('package.json')).description, 'Medical Note Attestor with AI Note capture', 'exe File description');
    // The hotkey labels that name a source stay.
    assert.match(read('lib/mna-core.js'), /label: 'Heidi capture', default: 'F8'/);
    assert.match(read('lib/mna-core.js'), /label: 'Freed capture', default: 'F7'/);
});

// ── Capture instructions name each source (both platforms) ──────────────────────────────────────
test('capture help text names each source on Windows and Mac', () => {
    const flat = (t) => t.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ');
    const main = flat(read('index.html'));
    assert.match(main, /Heidi: click into the note, then press F8 \(it selects and copies for you\)\. Freed: click Copy all, then press F7\./);
    assert.match(read('index.html'), /<kbd id="freed-key-label">F7<\/kbd>/);
    assert.match(read('renderer.js'), /set\('freed-key-label', +settings\.freedCaptureHotkey \|\| 'F7'\)/);
    assert.match(flat(read('settings.html')), /1\. Heidi: click into the note, then press F8 \(it selects and copies for you\)\. Freed: click Copy all, then press F7\./);
    const mac = read('MedicalNoteAttestor/SettingsView.swift');
    assert.ok(mac.includes('Text("1. Heidi: click into the note, then press \\(settings.captureHotkey) (it selects and copies for you). Freed: click Copy all, then press \\(settings.freedCaptureHotkey).")'));
    for (const old of ['In the AI Note, Ctrl+A', 'Click into your AI Note', 'Ctrl+A and Ctrl+C fire automatically', 'Open patient note in Heidi'])
        for (const f of ['index.html', 'settings.html', 'MedicalNoteAttestor/SettingsView.swift']) assert.ok(!read(f).includes(old), `${f}: ${old}`);
});

// ── Windows Heidi action items: off by default, Settings toggle ────────────────────────────────
test('action items off by default on Windows, with a Settings toggle (matching the Mac)', () => {
    assert.strictEqual(profiles.get('heidi').actionItems, false);
    assert.strictEqual(profiles.get('freed').actionItems, false);
    const main = read('main.js');
    assert.match(main, /heidiActionItems: false,/);
    assert.match(main, /if \(slots\.ap && \(store\.get\('heidiActionItems'\) \?\? profiles\.get\('heidi'\)\.actionItems\)\) \{/);
    const settings = read('settings.html');
    assert.match(settings, /id="heidi-action-items"/);
    assert.match(settings, /heidiActionItems: document\.getElementById\('heidi-action-items'\)\.checked/);
});
