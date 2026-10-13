// 2026-10-12 feedback on build d6545f8 (SI joint injection template): short criteria-gap lines, a
// collapsed gaps panel, and zero counts only when the note explicitly says none.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const core = require('../lib/mna-core');

const ROOT = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');

// ── Warning format ─────────────────────────────────────────────────────────────────────────────
// Messages in the style the real fill returned (verbose, blank IDs, "the treating clinician", speculation).
const VERBOSE = [
    'No formal functional scale (e.g., ODI, PROMIS) is documented in the note. Functional impact is described qualitatively without a numeric scale score. Both blanks (value and scale) are set to null.',
    'Line 13 applies to repeat injections only (blanks 18-21). The note states no prior SI joint injections, so this line is not applicable.',
    'The treating clinician should document at least 4 weeks of PT/HEP; only 2 weeks are noted.',
    'Patient may be noncompliant with home exercises, which could affect approval.',
    'Counts of 0 were inferred from the absence of prior SI injections (blank_id 12).',
    'No baseline NRS or functional score',
    'No baseline NRS or functional score.'
];
const SPECULATION = /\b(complian|adheren|motivat|behavio|unwilling|reluctan|effort)/i;

test('each warning becomes one short line: no blank/line IDs, addressed to you, no speculation', () => {
    const out = VERBOSE.map(core.fillFormatFlag);
    assert.strictEqual(out[0], 'No formal functional scale (e.g., ODI, PROMIS) is documented in the note');
    assert.strictEqual(out[1], 'Applies to repeat injections only');
    assert.strictEqual(out[2], 'You should document at least 4 weeks of PT/HEP');
    assert.strictEqual(out[3], null, 'speculation about the patient is dropped');
    assert.strictEqual(out[5], 'No baseline NRS or functional score');
    assert.strictEqual(out[6], 'No baseline NRS or functional score');
    for (const m of out.filter(Boolean)) {
        assert.ok(!/\n/.test(m), 'one line: ' + m);
        assert.ok(m.length <= 90, 'short: ' + m);
        assert.ok(!/\bblank|\bline[_ ]?ids?\b|\bline \d/i.test(m), 'no blank or line IDs: ' + m);
        assert.ok(!/treating clinician|the provider|the physician/i.test(m), 'addresses you: ' + m);
        assert.ok(!SPECULATION.test(m), 'no patient-behavior language: ' + m);
    }
});

test('fillApply returns formatted, de-duplicated gaps and counts them in the summary', () => {
    const recorded = JSON.parse(read('test/fixtures/claude-fill/recorded_response_tfesi.json'));
    const tu = recorded.content.find(c => c.type === 'tool_use');
    tu.input.criteria_flags = VERBOSE.map((message, i) => ({ line_id: 1 + (i % 3), message }));
    const freed = require('../lib/freed-parser');
    const note = freed.parseFreed(freed.normalize(read('test/fixtures/claude-fill/freed_tfesi_note.txt'))).slots;
    const bundle = JSON.parse(read('test/fixtures/library.fixture.json'));
    const results = core.resolveSelections(bundle, 'medicare_ab_ga', [{ procedure_id: 'lumbar_tfesi', laterality: 'left', checked: true, line: 0 }]);
    const r = core.fillApply({ hpi: note.hpi, exam: note.exam, ap: note.ap }, core.fillTemplatesFromResults(results), recorded);
    const msgs = r.flags.map(f => f.message);
    assert.strictEqual(msgs.length, 5, 'speculation dropped, duplicate merged');
    assert.match(r.summary, /; 5 criteria gaps\.$/);
    for (const m of msgs) assert.ok(m.length <= 90 && !/blank/i.test(m) && !SPECULATION.test(m), m);
});

test('the prompt asks for one short line per gap, grouped, no IDs, addressed to you, no speculation', () => {
    const p = core.FILL_SYSTEM_PROMPT;
    assert.match(p, /ONE short line \(under 80 characters\) naming the missing criterion/);
    assert.match(p, /Group related gaps into one line/);
    assert.match(p, /No prior diagnostic SIJI data \(date, NRS, % relief, duration\)/);
    assert.match(p, /Never mention blank IDs or line IDs/);
    assert.match(p, /never say "the treating clinician"/);
    assert.match(p, /never speculate about the patient \(compliance, behavior, motivation\)/);
    assert.match(core.FILL_INPUT_SCHEMA.properties.criteria_flags.items.properties.message.description, /One short line/);
});

// ── Collapsed gaps panel above the slots ─────────────────────────────────────────────────────
test('Windows: "⚠ N criteria gaps ▸" above the slot cards, collapsed by default, one line per gap', () => {
    const html = read('index.html');
    assert.ok(html.indexOf('id="criteria-gaps"') < html.indexOf('id="slot-hpi"'), 'above the slots');
    assert.match(html, /<details id="criteria-gaps"/);
    assert.match(html, /#criteria-gaps summary::after \{ content:' \\25B8'; \}/);
    assert.ok(!/fill-flags/.test(html), 'gaps no longer listed inside the review block');
    const r = read('renderer.js');
    const fn = r.slice(r.indexOf('function showCriteriaGaps('), r.indexOf('window.electronAPI.onLibraryFillReview'));
    assert.match(fn, /box\.open = false;/, 'a new fill starts collapsed');
    assert.match(fn, /'\\u26A0 ' \+ gaps\.length \+ ' criteria gap' \+ \(gaps\.length === 1 \? '' : 's'\)/);
    assert.match(fn, /li\.textContent = g;/);
    assert.ok(!/innerHTML/.test(fn));
});
test('Mac: CriteriaGapsView above the slot cards, collapsed by default', () => {
    const v = read('MedicalNoteAttestor/HeidiTabView.swift');
    assert.ok(v.indexOf('CriteriaGapsView(flags: flags)') < v.indexOf('SlotCard(label: "HPI"'), 'above the slots');
    assert.match(v, /@State private var expanded = false/);
    assert.match(v, /Text\("\\u\{26A0\} \\\(flags\.count\) criteria gap\\\(flags\.count == 1 \? "" : "s"\)"\)/);
    assert.ok(!/ForEach\(Array\(review\.flags/.test(v), 'not repeated in the review');
});

// ── Zero counts: only with an explicit "none" about the same thing ──────────────────────────
const NOTE = {
    hpi: 'Right low back and buttock pain for 4 months. No bowel or bladder changes. Denies numbness or tingling. ' +
         'No prior SI joint injections. Denies prior ESI. Never had a medial branch block. Completed 6 weeks of PT.',
    exam: 'Positive FABER and thigh thrust on the right.',
    ap: 'Right SI joint dysfunction. Plan right SIJI.'
};
const zero = (line, value, quote, kind = 'inferred') => {
    const plan = core.fillPlan([{ slot: 'ap', text: line }]);
    const v = core.fillValidate({ values: [{ blank_id: 1, value, kind, source_quote: quote, source_section: 'HPI' }], flags: [] }, plan, NOTE);
    return { accepted: Object.keys(v.accepted).length === 1, reasons: v.rejections.map(r => r.reason) };
};
test('0 with an unrelated negation ("No bowel or bladder changes") is rejected: absence of mention is not zero', () => {
    const line = 'Number of prior SI joint injections: ___.';
    assert.deepStrictEqual(zero(line, '0', 'No bowel or bladder changes'), { accepted: false, reasons: ['zero not stated in quote'] });
    assert.deepStrictEqual(zero(line, '0', 'Denies numbness or tingling'), { accepted: false, reasons: ['zero not stated in quote'] });
    assert.deepStrictEqual(zero(line, 'none', 'Completed 6 weeks of PT'), { accepted: false, reasons: ['zero not stated in quote'] });
    assert.deepStrictEqual(zero(line, 'N/A', 'No bowel or bladder changes'), { accepted: false, reasons: ['zero not stated in quote'] });
});
test('0 is accepted when the quote explicitly says none of that thing', () => {
    assert.strictEqual(zero('Number of prior SI joint injections: ___.', '0', 'No prior SI joint injections').accepted, true);
    assert.strictEqual(zero('Prior SIJI count: ___.', '0', 'No prior SI joint injections').accepted, true, 'SIJI = SI joint injection');
    assert.strictEqual(zero('Prior ESI in past 12 months: ___.', '0', 'Denies prior ESI').accepted, true);
    assert.strictEqual(zero('Prior medial branch blocks: ___.', 'none', 'Never had a medial branch block').accepted, true);
    assert.deepStrictEqual(zero('Prior medial branch blocks: ___.', '0', 'No prior SI joint injections').reasons, ['zero not stated in quote'],
        'a none about a different procedure does not count');
});
test('a non-zero count still needs the number in the quote', () => {
    assert.deepStrictEqual(zero('PT weeks completed: ___.', '6', 'Completed 6 weeks of PT').accepted, true);
    assert.deepStrictEqual(zero('Number of prior SI joint injections: ___.', '2', 'No prior SI joint injections').reasons, ['count not in quote']);
});
