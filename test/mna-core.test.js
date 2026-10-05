const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const core = require('../lib/mna-core');

const FIX = path.join(__dirname, 'fixtures');
const bundle = JSON.parse(fs.readFileSync(path.join(FIX, 'library.fixture.json'), 'utf8'));
const entry = (k) => bundle.entries.find(e => e.key === k);
const clone = (o) => JSON.parse(JSON.stringify(o));

// ── sanitizer ────────────────────────────────────────────────────────────────────────────────
test('Cerner sanitizer: shared vectors (pain-pa.com cernerSafe)', () => {
    const { vectors } = JSON.parse(fs.readFileSync(path.join(FIX, 'cerner-sanitizer-vectors.json'), 'utf8'));
    for (const v of vectors) assert.strictEqual(core.cernerSafe(v.in), v.out, JSON.stringify(v.in));
});

// ── detection fixtures ───────────────────────────────────────────────────────────────────────
const { cases } = JSON.parse(fs.readFileSync(path.join(FIX, 'detection-fixtures.json'), 'utf8'));
test('detection fixture set has at least 25 snippets', () => assert.ok(cases.length >= 25, String(cases.length)));
for (const [i, c] of cases.entries()) {
    test(`detection #${i + 1}: ${c.ap.split('\n').pop().slice(0, 60)}`, () => {
        const r = core.detectProcedures(c.ap, bundle);
        const planned = r.items.filter(x => x.checked);
        assert.deepStrictEqual(planned.map(x => x.procedure_id), c.expect.map(x => x.id), 'planned procedures');
        c.expect.forEach((e, k) => {
            if (e.lat) assert.strictEqual(planned[k].laterality, e.lat, `${e.id} laterality`);
            if (e.region) assert.strictEqual(planned[k].region, e.region, `${e.id} region`);
            if (e.needsVariant) { assert.strictEqual(planned[k].needsVariant, true); assert.strictEqual(planned[k].variant, null); }
        });
        const suggestions = r.items.filter(x => !x.checked).map(x => x.procedure_id);
        assert.deepStrictEqual(suggestions, c.suggest || [], 'unchecked suggestions');
        assert.strictEqual(r.noneDetected, r.items.length === 0);
    });
}

test('planning language: primary signals detected, history not', () => {
    const det = (t) => core.detectProcedures(t, bundle).items.filter(x => x.checked).map(x => x.procedure_id);
    assert.deepStrictEqual(det('proceed with bilateral L4-5 MBB'), ['lumbar_mbb']);
    assert.deepStrictEqual(det('schedule right SIJ injection'), ['sij_injection']);
    assert.deepStrictEqual(det('submit for SCS trial'), ['scs_trial']);
    assert.deepStrictEqual(core.detectProcedures('s/p RFA 2024', bundle).items, []);
    assert.deepStrictEqual(core.detectProcedures('previously had ESI', bundle).items, []);
});

test('"L4-5" is not laterality; "L " and "R " are', () => {
    assert.strictEqual(core._lateralityIn('at L4-5 and L5-S1'), null);
    assert.strictEqual(core._lateralityIn('L L4-5'), 'left');
    assert.strictEqual(core._lateralityIn('R L5-S1'), 'right');
    assert.strictEqual(core._lateralityIn('b/l'), 'bilateral');
});

test('no procedure in the note -> noneDetected', () => {
    const r = core.detectProcedures('Continue gabapentin. Return in 3 months.', bundle);
    assert.strictEqual(r.noneDetected, true);
});

// ── resolution ───────────────────────────────────────────────────────────────────────────────
const row = (id, lat, extra) => Object.assign({ procedure_id: id, laterality: lat, checked: true, variant: null, line: 0 }, extra || {});

test('missing entry (draft excluded from bundle) inserts nothing and gives a dialog notice', () => {
    assert.ok(!entry('uhc_commercial/sij_injection'), 'fixture: draft entry excluded');
    const [r] = core.resolveSelections(bundle, 'uhc_commercial', [row('sij_injection', 'right')]);
    assert.strictEqual(r.insert, false);
    assert.match(r.notice, /^No library criteria for UHC Commercial \u2014 Sacroiliac joint injection$/);
});

test('routing_only and draft entries insert nothing', () => {
    for (const mut of [(e) => { e.routing_only = true; }, (e) => { e.meta.status = 'draft'; }]) {
        const b = clone(bundle);
        mut(b.entries.find(e => e.key === 'medicare_ab_ga/lumbar_mbb'));
        const out = core.composeOutputs(b, 'medicare_ab_ga', [row('lumbar_mbb', 'bilateral')], 'Exam', 'A&P');
        assert.strictEqual(out.exam, null);
        assert.strictEqual(out.ap, null);
        assert.match(out.notices[0].text, /^No library criteria for /);
    }
});

test('needs_review -> amber, stale -> red marker (dialog only, never in the text)', () => {
    const b = clone(bundle);
    const e = b.entries.find(x => x.key === 'medicare_ab_ga/lumbar_mbb');
    e.meta.status = 'needs_review';
    let [r] = core.resolveSelections(b, 'medicare_ab_ga', [row('lumbar_mbb', 'bilateral')]);
    assert.strictEqual(r.insert, true); assert.strictEqual(r.marker, 'amber');
    e.meta.status = 'stale';
    [r] = core.resolveSelections(b, 'medicare_ab_ga', [row('lumbar_mbb', 'bilateral')]);
    assert.strictEqual(r.insert, true); assert.strictEqual(r.marker, 'red');
    const out = core.composeOutputs(b, 'medicare_ab_ga', [row('lumbar_mbb', 'bilateral')], '', 'A&P');
    assert.ok(!/stale|review|library|criteria for/i.test(out.exam + out.ap), 'no markers/badges in pasted text');
});

test('SCS requires a variant; not_covered variant inserts nothing', () => {
    let [r] = core.resolveSelections(bundle, 'medicare_ab_ga', [row('scs_trial', 'midline')]);
    assert.strictEqual(r.insert, false);
    assert.match(r.notice, /Choose an SCS indication/);
    [r] = core.resolveSelections(bundle, 'medicare_ab_ga', [row('scs_trial', 'midline', { variant: 'pdn' })]);
    assert.strictEqual(r.insert, true);
    const nc = bundle.entries.find(e => e.variants && Object.values(e.variants).some(v => v.coverage === 'not_covered'));
    const vid = Object.keys(nc.variants).find(k => nc.variants[k].coverage === 'not_covered');
    [r] = core.resolveSelections(bundle, nc.payer_id, [row(nc.procedure_id, 'midline', { variant: vid })]);
    assert.strictEqual(r.insert, false);
    assert.match(r.notice, /not covered/);
});

// ── composition ──────────────────────────────────────────────────────────────────────────────
test('acceptance: Medicare + "proceed with bilateral L4-5, L5-S1 medial branch blocks"', () => {
    const ap = 'Lumbar spondylosis.\nProceed with bilateral L4-5, L5-S1 medial branch blocks.';
    const det = core.detectProcedures(ap, bundle);
    assert.deepStrictEqual(det.items.map(i => [i.procedure_id, i.laterality, i.checked]), [['lumbar_mbb', 'bilateral', true]]);
    const scribeExam = 'Gen: NAD\nTender to palpation over lumbar paraspinal musculature bilaterally.\nPain elicited with extension of the lumbar spine. Positive facet loading bilaterally.';
    const out = core.composeOutputs(bundle, 'medicare_ab_ga', det.items, scribeExam, ap);
    const e = entry('medicare_ab_ga/lumbar_mbb');
    // Exam: scribe first, blank line, library text; no duplicated scribe lines.
    assert.ok(out.exam.startsWith(scribeExam + '\n\n'));
    const count = (s, l) => s.split('\n').filter(x => x.trim() === l).length;
    assert.strictEqual(count(out.exam, 'Tender to palpation over lumbar paraspinal musculature bilaterally.'), 1);
    assert.strictEqual(count(out.exam, 'Pain elicited with extension of the lumbar spine. Positive facet loading bilaterally.'), 1);
    assert.ok(out.exam.includes('Hip flexion: 5/5 5/5'));
    // A&P: original + blank line + the Medicare lumbar MBB dot-phrase. No header.
    assert.strictEqual(out.ap, ap + '\n\n' + core.cernerSafe(e.documentation_dotphrase).replace(/\s+$/, ''));
});

test('acceptance: right SIJ renders unilateral exam lines', () => {
    const det = core.detectProcedures('Schedule right SIJ injection.', bundle);
    const out = core.composeOutputs(bundle, 'medicare_ab_ga', det.items, '', 'Schedule right SIJ injection.');
    assert.match(out.exam, /Positive Patrick test on the right\./);
    assert.ok(!/Positive Patrick test bilaterally/.test(out.exam));
});

test('composition: dedupe against scribe exam and across procedures; order preserved; ___ kept', () => {
    const a = 'Header A:\nLine one.\nShared line ___.\n\nLine two.';
    const b = 'Shared line ___.\nLine three.';
    const out = core.composeExam('line one', [a, b]);
    assert.strictEqual(out, 'line one\n\nHeader A:\nShared line ___.\n\nLine two.\n\nLine three.');
});

test('composition: header whose content was all deduped is dropped', () => {
    const out = core.composeExam('Pain with extension.', ['Range of motion:\nPain with extension.\n\nOther:\nNew finding.']);
    assert.strictEqual(out, 'Pain with extension.\n\nOther:\nNew finding.');
});

test('composition: conflicts_with replacements in the library text are carried through', () => {
    const e = entry('aetna_commercial/lumbar_mbb');
    const req = e.exam_requirements.find(r => r.conflicts_with);
    assert.ok(req, 'fixture: entry has a conflicts_with requirement');
    assert.match(bundle.boilerplate.lumbar_spine, new RegExp(req.conflicts_with, 'm'), 'boilerplate has the conflicted line');
    const out = core.composeOutputs(bundle, 'aetna_commercial', [row('lumbar_mbb', 'right')], 'Gen: NAD', 'Plan').exam;
    assert.ok(!new RegExp(req.conflicts_with, 'm').test(out), 'conflicted boilerplate line stays replaced');
    assert.ok(out.includes(req.exam_text.replace('{{SIDE_ADVERB}}', 'on the right')), 'replacement line present');
});

test('composition: multiple procedures (lumbar MBB + right SIJ) both appear, shared lines once', () => {
    const items = [row('lumbar_mbb', 'bilateral'), row('sij_injection', 'right')];
    const out = core.composeOutputs(bundle, 'medicare_ab_ga', items, '', 'Plan');
    assert.match(out.exam, /Positive facet loading bilaterally/);
    assert.match(out.exam, /Positive Patrick test on the right/);
    const lines = out.exam.split('\n').filter(l => l.trim()).map(l => l.trim().toLowerCase());
    assert.strictEqual(new Set(lines).size, lines.length, 'no duplicate lines');
    const dots = out.ap.split('\n\n');
    assert.ok(out.ap.indexOf(entry('medicare_ab_ga/lumbar_mbb').documentation_dotphrase.split('\n')[0]) <
              out.ap.indexOf(entry('medicare_ab_ga/sij_injection').documentation_dotphrase.split('\n')[0]), 'procedure order');
    assert.ok(dots.length >= 3);
});

test('A&P insertion after the procedure plan line', () => {
    const ap = 'Dx: spondylosis\nProceed with bilateral L4-5 MBB.\nRTC 4 weeks';
    const out = core.composeAP(ap, ['DOT'], { insertion: 'after_plan_line', planLine: 1 });
    assert.strictEqual(out, 'Dx: spondylosis\nProceed with bilateral L4-5 MBB.\n\nDOT\n\nRTC 4 weeks');
    assert.strictEqual(core.composeAP(ap, ['DOT']), ap + '\n\nDOT');
});

test('Skip / nothing to insert -> null outputs (paste exactly as today)', () => {
    const out = core.composeOutputs(bundle, 'medicare_ab_ga', [], 'Exam text', 'AP text');
    assert.strictEqual(out.exam, null);
    assert.strictEqual(out.ap, null);
    assert.strictEqual(core.composeExam('Exam text', []), 'Exam text');
});

test('empty scribe exam + library text -> library text alone; both empty -> empty (no-op)', () => {
    assert.strictEqual(core.composeExam('', ['Lib line.']), 'Lib line.');
    assert.strictEqual(core.composeExam('   \n', ['Lib line.']), 'Lib line.');
    assert.strictEqual(core.composeExam('', []), '');
});

test('Freed: empty Freed exam + library text pastes library text; both empty no-op', { skip: 'TODO: Freed source not implemented (spec to be rewritten); the source-agnostic composeExam rule is covered above' }, () => {});

// ── payer picker ─────────────────────────────────────────────────────────────────────────────
test('payer typeahead covers names and aliases', () => {
    const top = (q) => core.searchPayers(bundle, q, [])[0].payer_id;
    assert.strictEqual(top('PSHP'), 'peach_state');
    assert.strictEqual(top('blue cross'), 'bcbs_ga');
    assert.strictEqual(top('medicare a/b'), 'medicare_ab_ga');
    assert.strictEqual(top('humana'), 'humana_ma');
});

test('10 most recent payers pinned at top, most recent first', () => {
    let rec = [];
    const ids = bundle.registries.payers.map(p => p.payer_id);
    for (const id of ids.slice(0, 12)) rec = core.recordRecentPayer(rec, id);
    assert.strictEqual(rec.length, 10);
    assert.strictEqual(rec[0], ids[11]);
    rec = core.recordRecentPayer(rec, ids[5]);
    assert.strictEqual(rec[0], ids[5]);
    assert.strictEqual(rec.filter(x => x === ids[5]).length, 1);
    const list = core.searchPayers(bundle, '', rec);
    assert.deepStrictEqual(list.slice(0, 10).map(x => x.payer_id), rec);
    assert.ok(list.slice(0, 10).every(x => x.pinned));
    assert.ok(list.slice(10).every(x => !x.pinned));
    // One keystroke + Enter for a repeat payer: the pinned match comes first.
    const first = core.searchPayers(bundle, bundle.registries.payers.find(p => p.payer_id === rec[3]).name[0], rec)[0];
    assert.ok(first.pinned);
});

// ── library source selection ─────────────────────────────────────────────────────────────────
test('fallback: fresh > cache > snapshot; corrupt cache -> snapshot; none -> none', () => {
    const raw = JSON.stringify(bundle);
    assert.strictEqual(core.chooseLibrary({ raw, tag: 'new' }, { raw, tag: 'old' }, { raw, tag: 'snap' }).source, 'download');
    assert.strictEqual(core.chooseLibrary(null, { raw, tag: 'old' }, { raw, tag: 'snap' }).source, 'cache');
    assert.strictEqual(core.chooseLibrary(null, { raw: '{"broken', tag: 'old' }, { raw, tag: 'snap' }).source, 'snapshot');
    assert.strictEqual(core.chooseLibrary(null, null, { raw: '\uFEFF' + raw, tag: 'snap' }).source, 'snapshot');
    assert.strictEqual(core.chooseLibrary(null, null, null).source, 'none');
});

// ── hotkeys ──────────────────────────────────────────────────────────────────────────────────
test('hotkey defaults are unchanged (F8, F9, F10, F11)', () => {
    assert.deepStrictEqual(core.defaultHotkeys(), { capture: 'F8', pasteHpi: 'F9', pasteExam: 'F10', pasteAp: 'F11' });
});

test('rebinding F10 to Ctrl+Shift+F10 validates and maps to AHK ^+F10', () => {
    const v = core.validateHotkeys({ pasteExam: 'shift+ctrl+f10' }, 'win32');
    assert.ok(v.ok);
    assert.strictEqual(v.bindings.pasteExam, 'Ctrl+Shift+F10');
    assert.strictEqual(core.toAhkHotkey(v.bindings.pasteExam), '^+F10');
    assert.strictEqual(core.toAhkHotkey('PageUp'), 'PgUp');
});

test('duplicate binding rejected; invalid falls back; OS conflicts warned', () => {
    let v = core.validateHotkeys({ pasteExam: 'F9' }, 'win32');
    assert.strictEqual(v.ok, false);
    assert.match(v.errors[0].message, /already used by Paste HPI/);
    v = core.validateHotkeys({ pasteAp: 'Ctrl+Banana' }, 'win32');
    assert.strictEqual(v.ok, false);
    assert.strictEqual(v.bindings.pasteAp, 'F11');
    v = core.validateHotkeys({ pasteAp: 'Ctrl+V' }, 'win32');
    assert.ok(v.ok); assert.strictEqual(v.warnings.length, 1);
    v = core.validateHotkeys({ capture: 'Cmd+Q' }, 'darwin');
    assert.strictEqual(v.warnings.length, 1);
    assert.strictEqual(core.normalizeHotkey('A'), null, 'bare letters would hijack typing');
});

test('bare non-F keys are rejected (would hijack typing); F-keys and PageUp/PageDown allowed', () => {
    for (const k of ['Space', 'Delete', 'Up', 'Home', 'End', 'Tab', 'Enter']) assert.strictEqual(core.normalizeHotkey(k), null, k);
    for (const k of ['F7', 'F12', 'PageUp', 'PageDown', 'Ctrl+Space', 'Alt+Delete']) assert.ok(core.normalizeHotkey(k), k);
});

test('Windows: PageUp/PageDown are the legacy AHK copy keys and cannot be rebound to', () => {
    const v = core.validateHotkeys({ pasteHpi: 'PageUp' }, 'win32');
    assert.strictEqual(v.ok, false);
    assert.match(v.errors[0].message, /legacy HPI copy key/);
    assert.ok(core.validateHotkeys({ pasteHpi: 'PageUp' }, 'darwin').ok);
});

test('no wrong-side exam text when the chosen side is missing', () => {
    const b = clone(bundle);
    const e = b.entries.find(x => x.key === 'medicare_ab_ga/sij_injection');
    delete e.exam_text.left;
    const [r] = core.resolveSelections(b, 'medicare_ab_ga', [row('sij_injection', 'left')]);
    assert.strictEqual(r.examText, '');
    assert.ok(!/on the right/.test(r.examText));
});
