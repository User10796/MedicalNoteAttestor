// Freed as a second scribe source (SPEC_freed_source_standalone, 2026-10-10).
// Fixtures are synthetic (spec §0.2). Every test feeds text through the same path the F7
// clipboard capture uses: normalize -> duplicate guard -> shape validation -> parse -> slots.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const freed = require('../lib/freed-parser');
const { createFreedCapture, encodeFreedResult, decodeFreedResult } = require('../lib/freed-capture');
const profiles = require('../lib/source-profiles');

const DIR = path.join(__dirname, 'fixtures', 'freed');
const read = (f) => fs.readFileSync(path.join(DIR, f), 'utf8');
// §10.1: compare after the §6 normalization (CRLF -> LF, BOM, trailing whitespace) and EOF trim.
const norm = (s) => freed.normalize(s).replace(/\n+$/, '');

function harness() {
    const writes = [];
    const notices = [];
    let actionItemCalls = 0;
    const cap = createFreedCapture({
        writeResult: (r) => writes.push(r),
        notify: (msg) => notices.push(msg),
        extractActionItems: () => { actionItemCalls++; return Promise.resolve(''); }
    });
    return { cap, writes, notices, actionItems: () => actionItemCalls };
}

// ── §10.1 / §10.2: fixtures ──────────────────────────────────────────────────────────────────
for (const [sample, hasExam] of [['freed_sample_01', true], ['freed_sample_02_no_exam', false]]) {
    test(`${sample}: F9 / F10 / F11 match the expected fixtures`, () => {
        const { cap } = harness();
        const r = cap.process({ captureTs: '1', raw: read(sample + '.txt') });
        assert.strictEqual(r.status, 'ok');
        assert.strictEqual(norm(r.slots.hpi), norm(read(sample + '.F9.expected.txt')), 'F9');
        assert.strictEqual(norm(r.slots.ap), norm(read(sample + '.F11.expected.txt')), 'F11');
        if (hasExam) assert.strictEqual(norm(r.slots.exam), norm(read(sample + '.F10.expected.txt')), 'F10');
        else assert.strictEqual(r.slots.exam, '', 'F10 slot is empty (N/A exam) -> silent no-op');
    });
}

test('CRLF and BOM clipboard text parses identically (Windows clipboard)', () => {
    const { cap } = harness();
    const raw = '﻿' + read('freed_sample_01.txt').replace(/\n/g, '\r\n').replace(/\r\n/g, '  \r\n');
    const r = cap.process({ captureTs: '1', raw });
    assert.strictEqual(r.status, 'ok');
    assert.strictEqual(norm(r.slots.ap), norm(read('freed_sample_01.F11.expected.txt')));
});

test('slots have no trailing whitespace and no leading/trailing blank lines', () => {
    const { cap } = harness();
    const r = cap.process({ captureTs: '1', raw: read('freed_sample_01.txt') });
    for (const k of ['hpi', 'exam', 'ap']) {
        const s = r.slots[k];
        assert.ok(!/[ \t]+$/m.test(s), k + ' trailing whitespace');
        assert.ok(!/^\s*\n/.test(s) && !/\n\s*$/.test(s), k + ' leading/trailing blank lines');
        assert.ok(!/\n\n\n/.test(s), k + ' blank runs collapsed');
    }
});

// ── §10.3: stale-slot clearing ───────────────────────────────────────────────────────────────
test('capture 01 then 02: all three slots replaced; F10 is empty, not sample 01\'s exam', () => {
    const { cap, writes } = harness();
    cap.process({ captureTs: '1', raw: read('freed_sample_01.txt') });
    assert.ok(cap.slots().exam.includes('Tenderness over bilateral L4-L5'));
    const r = cap.process({ captureTs: '2', raw: read('freed_sample_02_no_exam.txt') });
    assert.strictEqual(r.status, 'ok');
    assert.strictEqual(cap.slots().exam, '');
    assert.ok(cap.slots().hpi.includes('61-year-old male'));
    assert.ok(!cap.slots().ap.includes('Lumbar spondylosis'));
    // What AHK adopts: one atomic result carrying all three slots, the exam explicitly empty.
    const last = decodeFreedResult(encodeFreedResult(writes[writes.length - 1]));
    assert.deepStrictEqual([last.kind, last.captureTs, last.exam], ['ok', '2', '']);
});

// ── §10.4: duplicate guard ───────────────────────────────────────────────────────────────────
test('capturing sample 01 twice: second is "Already captured", no re-parse, slots unchanged', () => {
    const { cap, writes, notices } = harness();
    cap.process({ captureTs: '1', raw: read('freed_sample_01.txt') });
    const before = JSON.stringify(cap.slots());
    const parses = cap.stats().parses;
    const r = cap.process({ captureTs: '2', raw: read('freed_sample_01.txt').replace(/\n/g, '\r\n') });
    assert.strictEqual(r.status, 'duplicate');
    assert.strictEqual(cap.stats().parses, parses, 'not re-parsed');
    assert.strictEqual(JSON.stringify(cap.slots()), before, 'slots unchanged');
    assert.ok(writes.every(w => w.kind !== 'ok' || w.captureTs === '1'), 'no slot write for the duplicate');
    assert.match(notices[notices.length - 1], /^Already captured/);
});

test('capturing 01, then 02, then 01 again re-parses all three times', () => {
    const { cap } = harness();
    for (const [ts, f] of [['1', 'freed_sample_01.txt'], ['2', 'freed_sample_02_no_exam.txt'], ['3', 'freed_sample_01.txt']]) {
        assert.strictEqual(cap.process({ captureTs: ts, raw: read(f) }).status, 'ok', ts);
    }
    assert.strictEqual(cap.stats().parses, 3);
    assert.ok(cap.slots().exam.includes('Tenderness'));
});

test('duplicate hash is in memory only and updates only after a successful capture', () => {
    const { cap } = harness();
    assert.strictEqual(cap.process({ captureTs: '1', raw: 'not a note' }).status, 'invalid');
    assert.strictEqual(cap.process({ captureTs: '2', raw: 'not a note' }).status, 'invalid', 'failed captures never become "duplicates"');
    const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'freed-capture.js'), 'utf8');
    assert.ok(!/writeFile|appendFile|localStorage/.test(src.replace(/writeResult/g, '')), 'hash never persisted');
});

test('a Heidi capture in between resets the duplicate guard (so the same Freed note re-adopts)', () => {
    const { cap } = harness();
    cap.process({ captureTs: '1', raw: read('freed_sample_01.txt') });
    cap.resetDuplicateGuard();   // main.js calls this on every other capture (F8) and on Clear
    assert.strictEqual(cap.process({ captureTs: '2', raw: read('freed_sample_01.txt') }).status, 'ok');
});

// ── §10.5: shape validation failures leave slots unchanged ───────────────────────────────────
const HEIDI_NOTE = [
    'Interval history, HPI:',
    'Patient returns for follow-up of low back pain. Pain is axial, worse with extension.',
    '',
    'Assessment and Plan:',
    'Lumbar spondylosis. Proceed with bilateral L4-5, L5-S1 medial branch blocks.',
    'Return in 4 weeks.'
].join('\n');
const s01 = () => read('freed_sample_01.txt');
const INVALID = {
    'missing Objective divider': () => s01().replace(/^Objective\n/m, ''),
    'dividers out of order': () => {
        const t = s01();
        return t.replace(/^Subjective$/m, '@@S').replace(/^Objective$/m, 'Subjective').replace(/^@@S$/m, 'Objective');
    },
    'A&P with no numbered problem': () => s01().replace(/^(\d+)\. /gm, ''),
    'arbitrary non-note text': () => 'Grocery list:\n- eggs\n- milk\nCall the pharmacy at 3pm.',
    'Heidi note fed to the Freed parser': () => HEIDI_NOTE,
    'duplicated divider': () => s01() + '\nObjective\n',
    'no HPI subheader': () => s01().replace('History of Present Illness (HPI):', 'Chief complaint:'),
    'empty clipboard': () => ''
};
for (const [name, make] of Object.entries(INVALID)) {
    test(`shape validation rejects: ${name} (slots unchanged, visible notice, no clipboard echo)`, () => {
        const { cap, writes, notices } = harness();
        cap.process({ captureTs: '1', raw: read('freed_sample_02_no_exam.txt') });
        const before = JSON.stringify(cap.slots());
        const raw = make();
        const r = cap.process({ captureTs: '2', raw });
        assert.strictEqual(r.status, 'invalid');
        assert.strictEqual(JSON.stringify(cap.slots()), before);
        assert.strictEqual(writes.filter(w => w.kind === 'ok').length, 1, 'no slot write');
        const msg = notices[notices.length - 1];
        assert.strictEqual(msg, "Clipboard doesn't look like a Freed note. Click Copy all in Freed, then F7.");
        for (const line of raw.split('\n').filter(l => l.trim().length > 12)) assert.ok(!msg.includes(line.trim()), 'notice echoes clipboard');
    });
}

// ── §10.6: classification ────────────────────────────────────────────────────────────────────
test('line classification', () => {
    const c = freed.classifyLine;
    assert.strictEqual(c('Medications started: x'), 'INLINE_LABEL');
    assert.strictEqual(c('Follow-up:'), 'SUBHEADER');
    assert.strictEqual(c('- General: Ambulatory.'), 'BULLET');
    assert.strictEqual(c('Assessment & Plan'), 'DIVIDER');
    assert.strictEqual(c('Assessment and Plan:'), 'SUBHEADER');
    assert.strictEqual(c('  Subjective  '), 'DIVIDER');
    assert.strictEqual(c('Objective:'), 'SUBHEADER', 'a colon means not a divider');
    assert.strictEqual(c('1. Right hip pain'), 'NUMBERED');
    assert.strictEqual(c('   - Continue baclofen'), 'BULLET');
    assert.strictEqual(c('   '), 'BLANK');
    assert.strictEqual(c('Imaging ordered: None'), 'INLINE_LABEL');
    assert.strictEqual(c('Free text line without a colon'), 'TEXT');
});

// ── §10.7: action items ──────────────────────────────────────────────────────────────────────
test('Freed captures never produce MNA-generated action items', () => {
    const { cap, actionItems } = harness();
    for (const f of ['freed_sample_01.txt', 'freed_sample_02_no_exam.txt']) {
        const r = cap.process({ captureTs: f, raw: read(f) });
        assert.strictEqual(r.status, 'ok');
        assert.strictEqual(norm(r.slots.ap), norm(read(f.replace('.txt', '.F11.expected.txt'))), 'F11 is exactly Freed text');
    }
    assert.strictEqual(actionItems(), 0, 'extractActionItems never called for Freed');
});

test('source profiles: data, not branching (Heidi unchanged, Freed F7 clipboardRead, no action items)', () => {
    assert.deepStrictEqual(profiles.get('heidi'),
        { id: 'heidi', captureKey: 'F8', captureMethod: 'selectAllCopy', parser: 'heidi', actionItems: true });
    assert.deepStrictEqual(profiles.get('freed'),
        { id: 'freed', captureKey: 'F7', captureMethod: 'clipboardRead', parser: 'freed', actionItems: false });
});

test('main.js gates action items on the source profile', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
    assert.match(src, /profiles\.get\('heidi'\)\.actionItems/);
    assert.ok(!/extractActionItems/.test(src.slice(src.indexOf('// ── Freed source'), src.indexOf('// ── end Freed source'))),
        'the Freed path never references extractActionItems');
});

// ── result file (Electron -> AHK) ────────────────────────────────────────────────────────────
test('result file round-trips; AHK adopts all three slots or nothing', () => {
    const r = { kind: 'ok', captureTs: '42', hpi: 'H1\nH2', exam: '', ap: 'A\n\nB' };
    const enc = encodeFreedResult(r);
    assert.ok(!enc.startsWith('﻿'));
    assert.ok(!/(^|[^\r])\n/.test(enc), 'CRLF only');
    assert.deepStrictEqual(decodeFreedResult(enc), r);
    const n = decodeFreedResult(encodeFreedResult({ kind: 'notice', captureTs: '43', message: 'Already captured' }));
    assert.deepStrictEqual([n.kind, n.captureTs, n.message], ['notice', '43', 'Already captured']);
    assert.strictEqual(decodeFreedResult('garbage'), null);
});

// ── F7 hotkey (Windows only; defaults F8-F11 unchanged) ──────────────────────────────────────
test('F7 Freed capture is a Windows hotkey; macOS and the F8-F11 defaults are unchanged', () => {
    const core = require('../lib/mna-core');
    assert.deepStrictEqual(core.defaultHotkeys(), { capture: 'F8', pasteHpi: 'F9', pasteExam: 'F10', pasteAp: 'F11' });
    assert.deepStrictEqual(core.defaultHotkeys('win32'), { capture: 'F8', pasteHpi: 'F9', pasteExam: 'F10', pasteAp: 'F11', captureFreed: 'F7' });
    assert.deepStrictEqual(core.defaultHotkeys('darwin'), core.defaultHotkeys());
    const win = core.validateHotkeys({}, 'win32');
    assert.ok(win.ok); assert.strictEqual(win.bindings.captureFreed, 'F7');
    assert.strictEqual(core.toAhkHotkey(win.bindings.captureFreed), 'F7');
    assert.strictEqual(core.validateHotkeys({ pasteHpi: 'F7' }, 'win32').ok, false, 'F7 taken by Freed capture on Windows');
    assert.ok(core.validateHotkeys({ pasteHpi: 'F7' }, 'darwin').ok, 'no Freed hotkey on macOS');
    assert.ok(!('captureFreed' in core.validateHotkeys({}, 'darwin').bindings));
});

// ── cross-language contract: AHK parses exactly what Electron writes ─────────────────────────
test('result file sample (shared with the AHK test) matches the encoder byte for byte', () => {
    const sample = fs.readFileSync(path.join(DIR, 'freed_result_sample.txt'), 'utf8');
    assert.strictEqual(encodeFreedResult({ kind: 'ok', captureTs: '12345', hpi: 'HPI line 1\nHPI line 2', exam: '', ap: '1. Problem\n- Bullet\n\nFollow-up:\n- RTC' }), sample);
});

test('AHK F7 reads the clipboard only (no synthetic keystrokes) and writes UTF-8-RAW', () => {
    const ahk = fs.readFileSync(path.join(__dirname, '..', 'autohotkey', 'heidi-hotkeys.ahk'), 'utf8');
    const start = ahk.indexOf('DoCaptureFreed() {');
    const body = ahk.slice(start, ahk.indexOf('\n}', start));
    assert.ok(start > 0);
    assert.ok(!/\bSend\b/.test(body), 'no Send in the Freed capture');
    assert.match(body, /text := A_Clipboard/);
    assert.match(body, /"UTF-8-RAW"/);
    assert.match(ahk, /case "captureFreed": DoCaptureFreed\(\)/);
    // Heidi F8 is still select-all + copy.
    const heidi = ahk.slice(ahk.indexOf('DoCapture() {'), ahk.indexOf('\n}', ahk.indexOf('DoCapture() {')));
    assert.match(heidi, /Send "\^a\^c"/);
});
