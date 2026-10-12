// SPEC_library_claude_fill: Claude extracts values with quotes; the app verifies and substitutes.
// CI never calls the live API: recorded / mocked responses only. Fixtures are synthetic.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const core = require('../lib/mna-core');
const freed = require('../lib/freed-parser');
const { createClaudeFiller, API_URL } = require('../lib/claude-fill-client');
const { createCaptureFlow, createComposedStore } = require('../lib/capture-flow');
const { tmpDir, response } = require('./helpers');

const FIX = path.join(__dirname, 'fixtures');
const bundle = JSON.parse(fs.readFileSync(path.join(FIX, 'library.fixture.json'), 'utf8'));
const read = (f) => fs.readFileSync(path.join(FIX, 'claude-fill', f), 'utf8').replace(/\r\n/g, '\n');
const note = freed.parseFreed(freed.normalize(read('freed_tfesi_note.txt'))).slots;
const tfesi = bundle.entries.find(e => e.key === 'medicare_ab_ga/lumbar_tfesi');   // the real template, read in place
const templates = [{ slot: 'exam', text: tfesi.exam_text.left }, { slot: 'ap', text: tfesi.documentation_dotphrase }];
const recorded = JSON.parse(read('recorded_response_tfesi.json'));
const tool = (input) => ({ content: [{ type: 'tool_use', name: 'record_blank_values', input }] });
const val = (blank_id, value, kind, source_quote, source_section) => ({ blank_id, value, kind, source_quote, source_section });

// ── recorded-response fixture ────────────────────────────────────────────────────────────────
test('recorded response: verified values assembled; hallucinations rejected; expected text exact', () => {
    const r = core.fillApply(note, templates, recorded);
    assert.ok(r.ok);
    assert.strictEqual(r.texts[0], read('expected_exam.txt').replace(/\n$/, ''));
    assert.strictEqual(r.texts[1], read('expected_ap.txt').replace(/\n$/, ''));
    assert.deepStrictEqual(r.counts, { blanks: 25, filled: 18, inferred: 1, rejected: 3 });
    assert.deepStrictEqual(r.rejectionReasons, ['quote not in note section', 'quote not in note section', 'number not in quote']);
    assert.match(r.texts[1], /prior ESI on ___ gave ___% relief/, 'hallucinated date and percent left as blanks');
    assert.match(r.texts[1], /past 12 months: ___\./, 'number not in its quote -> rejected');
    assert.match(r.texts[1], /Patient has diagnosis: radiculopathy\./, 'option list dropped');
    assert.strictEqual(r.summary, 'Filled 18 of 25 blanks (1 inferred); 1 criteria warning.');
    assert.deepStrictEqual(r.flags.map(f => f.line), ['Patient has baseline function: ___ (scale: ___).']);
});

// ── validator (§3) ───────────────────────────────────────────────────────────────────────────
const one = (line) => [{ slot: 'ap', text: line }];
function check(line, v) {
    const plan = core.fillPlan(one(line));
    return core.fillValidate({ values: [v], flags: [] }, plan, note);
}
test('validator: quote not in the note -> rejected', () => {
    const r = check('Pain ___/10.', val(1, '9', 'explicit', 'rated 9/10', 'HPI'));
    assert.deepStrictEqual(r.rejections.map(x => x.reason), ['quote not in note section']);
});
test('validator: quote in the wrong section -> rejected', () => {
    assert.strictEqual(check('Pain ___/10.', val(1, '7', 'explicit', 'rated 7/10', 'Exam')).rejections.length, 1);
});
test('validator: number in value but not in quote -> rejected', () => {
    const r = check('Weeks: ___.', val(1, '12', 'explicit', 'Completed 6 weeks of physical therapy', 'HPI'));
    assert.deepStrictEqual(r.rejections.map(x => x.reason), ['number not in quote']);
});
test('validator: option outside the list -> rejected; option inside -> accepted', () => {
    assert.strictEqual(check('Imaging ___ (MRI/CT).', val(1, 'X-ray', 'explicit', 'MRI lumbar spine 2026-08-14', 'A&P')).rejections[0].reason, 'value not in option list');
    assert.ok(check('Imaging ___ (MRI/CT).', val(1, 'mri', 'explicit', 'MRI lumbar spine 2026-08-14', 'A&P')).accepted[1]);
});
test('validator: inferred date (or anything but side/level) -> rejected; inferred side/level -> accepted', () => {
    assert.strictEqual(check('On ___.', val(1, '2026-08-14', 'inferred', 'MRI lumbar spine 2026-08-14', 'A&P')).rejections[0].reason,
        'inferred value is not a side or level');
    assert.strictEqual(check('For ___ weeks.', val(1, '10', 'inferred', 'for 10 weeks', 'HPI')).rejections.length, 1);
    assert.ok(check('___ side', val(1, 'left', 'inferred', 'left lower extremity radicular pain', 'HPI')).accepted[1]);
    assert.ok(check('at ___', val(1, 'L4-L5', 'inferred', 'disc protrusion at L4-L5', 'A&P')).accepted[1]);
    assert.ok(check('the ___', val(1, 'L5 distribution', 'inferred', 'in the L5 distribution', 'HPI')).accepted[1]);
});
test('validator: a provider/facility name must be in the quote', () => {
    assert.strictEqual(check('Referred by ___.', val(1, 'Dr. Patel', 'explicit', 'Completed 6 weeks of physical therapy', 'HPI')).rejections.length, 1);
});
test('validator: whitespace/punctuation/case-insensitive quote match', () => {
    assert.ok(check('Pain ___/10.', val(1, '7', 'explicit', 'RATED   7/10', 'HPI')).accepted[1]);
});
test('malformed response -> nothing filled, notice', () => {
    for (const bad of ['not json', {}, { content: [] }, tool({ values: 'x' }), tool({ values: [{ blank_id: '1', value: 2 }] })]) {
        const r = core.fillApply(note, templates, bad);
        assert.strictEqual(r.ok, false);
        assert.strictEqual(r.notice, 'Claude fill unavailable — blanks left as-is.');
    }
});

// ── assembly (§4) ────────────────────────────────────────────────────────────────────────────
test('assembly: option list dropped; hint dropped only when filled; nested-blank parenthetical kept; wording untouched', () => {
    const t = [{ slot: 'ap', text: 'Imaging: ___ (MRI/CT).\nPT x ___ (>=4 weeks) weeks.\nRelief ___ (max 4).\nFunction: ___ (scale: ___).\nUnchanged line.' }];
    const plan = core.fillPlan(t);
    assert.deepStrictEqual(plan.blanks.map(b => b.paren && b.paren.type), ['options', 'hint', 'hint', 'contains_blank', null]);
    const accepted = { 1: { value: 'MRI', kind: 'explicit', quote: 'q' }, 2: { value: '6', kind: 'explicit', quote: 'q' },
                       4: { value: 'ODI 40', kind: 'explicit', quote: 'q' } };
    const [a] = core.fillAssemble(t, plan, accepted);
    assert.strictEqual(a.text, 'Imaging: MRI.\nPT x 6 weeks.\nRelief ___ (max 4).\nFunction: ODI 40 (scale: ___).\nUnchanged line.');
    assert.deepStrictEqual(a.marks.map(m => m.kind), ['explicit', 'explicit', 'unfilled', 'explicit', 'unfilled']);
    assert.strictEqual(a.text.slice(a.marks[0].start, a.marks[0].end), 'MRI');
});
test('assembly: nothing accepted -> text identical', () => {
    const plan = core.fillPlan(templates);
    assert.deepStrictEqual(core.fillAssemble(templates, plan, {}).map(a => a.text), templates.map(t => t.text));
});

// ── request (§0.5, §2) ───────────────────────────────────────────────────────────────────────
test('request: fixed tool schema, forced tool use, model from CLAUDE_MODEL, minimal payload', () => {
    const { body, plan } = core.fillRequest(note, templates, 'claude-sonnet-4-6');
    assert.strictEqual(body.model, 'claude-sonnet-4-6');
    assert.deepStrictEqual(body.tool_choice, { type: 'tool', name: 'record_blank_values' });
    assert.deepStrictEqual(body.tools[0].input_schema, core.FILL_INPUT_SCHEMA);
    assert.strictEqual(body.messages.length, 1);
    const user = body.messages[0].content;
    assert.ok(user.includes(note.hpi) && user.includes(note.exam) && user.includes(note.ap));
    assert.strictEqual(plan.blanks.length, 25);
    assert.ok(!/payerRecents|libraryToken|AppData|\/Users\/|\\\\/.test(JSON.stringify(body)), 'no settings or paths');
    const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
    assert.match(main, /model: CLAUDE_MODEL/, 'model comes from CLAUDE_MODEL');
});

// ── client: opt-in, key, errors (no live API) ────────────────────────────────────────────────
const results = () => core.resolveSelections(bundle, 'medicare_ab_ga', [{ procedure_id: 'lumbar_tfesi', laterality: 'left', checked: true, line: 0 }]);
function filler({ enabled = true, key = 'test-key-not-real', reply, delay = 0 } = {}) {
    const calls = [];
    const fetchImpl = async (url, opts) => {
        calls.push({ url, opts });
        if (delay) await new Promise((r, j) => { const t = setTimeout(r, delay); opts.signal.addEventListener('abort', () => { clearTimeout(t); const e = new Error('aborted'); e.name = 'AbortError'; j(e); }); });
        if (reply instanceof Error) throw reply;
        return reply || response(200, { json: recorded });
    };
    return { f: createClaudeFiller({ fetchImpl, getKey: () => key, isEnabled: () => enabled, model: 'claude-sonnet-4-6', timeoutMs: 50 }), calls };
}
test('setting off (the default) -> no API call, behavior unchanged', async () => {
    const { f, calls } = filler({ enabled: false });
    assert.strictEqual(await f.fill({ note, results: results() }), null);
    assert.strictEqual(calls.length, 0);
});
test('no key -> no API call', async () => {
    const { f, calls } = filler({ key: '' });
    assert.strictEqual(await f.fill({ note, results: results() }), null);
    assert.strictEqual(calls.length, 0);
});
test('on + key -> one POST to the Messages API with the request body; results filled', async () => {
    const { f, calls } = filler();
    const r = await f.fill({ note, results: results() });
    assert.strictEqual(calls.length, 1);
    assert.strictEqual(calls[0].url, API_URL);
    assert.strictEqual(calls[0].opts.method, 'POST');
    assert.strictEqual(JSON.parse(calls[0].opts.body).tool_choice.name, 'record_blank_values');
    const filled = r.results.find(x => x.insert);
    assert.strictEqual(filled.dotphrase, read('expected_ap.txt').replace(/\n$/, ''));
    assert.strictEqual(filled.examText, read('expected_exam.txt').replace(/\n$/, ''));
    assert.match(r.review.summary, /^Filled 18 of 25 blanks/);
});
test('API error, timeout or malformed reply -> blanks left as-is, notice', async () => {
    for (const opts of [{ reply: response(500, { json: {} }) }, { reply: new Error('offline') }, { delay: 500 }, { reply: response(200, { json: { content: [] } }) }]) {
        const { f } = filler(opts);
        const base = results();
        const r = await f.fill({ note, results: base });
        assert.deepStrictEqual(r.results, base);
        assert.strictEqual(r.review.notice, 'Claude fill unavailable — blanks left as-is.');
    }
});
test('logs counts and reasons only (never note text or values)', async () => {
    const lines = [];
    const fetchImpl = async () => response(200, { json: recorded });
    const f = createClaudeFiller({ fetchImpl, getKey: () => 'k', isEnabled: () => true, model: 'm', log: (m) => lines.push(m) });
    await f.fill({ note, results: results() });
    assert.strictEqual(lines.length, 1);
    assert.match(lines[0], /^claude fill: 18\/25 filled, 3 rejected/);
    for (const s of ['radiculopathy', 'L4-L5', '2026', 'paracentral', 'left']) assert.ok(!lines[0].includes(s), s);
});

// ── capture flow + PHI: off = unchanged; on = one extra request with only note + template ───
test('capture flow: Claude fill feeds the composed F10/F11 text; off leaves it exactly as before', async () => {
    const mk = (fillBlanks) => {
        const store = createComposedStore(tmpDir());
        const flow = createCaptureFlow({ getBundle: () => bundle, isEnabled: () => true, getRecents: () => [], setRecents: () => {},
            getInsertion: () => 'end', store, fillBlanks,
            ui: async () => ({ payerId: 'medicare_ab_ga', items: [{ procedure_id: 'lumbar_tfesi', laterality: 'left', checked: true, line: 0 }] }) });
        return { flow, store };
    };
    const cap = { source: 'freed', captureTs: '5', hpi: note.hpi, ap: note.ap, exam: note.exam, fillExam: note.exam };
    const off = mk(undefined); await off.flow.onCapture(cap);
    const offAp = off.store.read('ap').text;
    assert.ok(offAp.includes('Patient has diagnosis: ___ (radiculopathy'), 'off: template blanks untouched');
    const { f } = filler();
    const on = mk(f.fill); const r = await on.flow.onCapture(cap);
    assert.ok(on.store.read('ap').text.includes('Patient has diagnosis: radiculopathy.'));
    assert.match(r.review.summary, /Filled 18 of 25/);
});

test('main.js wiring: setting off by default, user key only, CLAUDE_MODEL, captured note only, review never pasted', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
    assert.match(src, /libraryClaudeFill: false,/);
    assert.match(src, /getKey: \(\) => getClaudeKey\(\),/);
    assert.match(src, /isEnabled: \(\) => !!store\.get\('libraryClaudeFill'\),/);
    assert.match(src, /model: CLAUDE_MODEL,/);
    assert.match(src, /const fillExam = source === 'freed' \? freedExam : '';/);
    assert.match(src, /fillBlanks: \(req\) => claudeFiller\.fill\(req\),/);
    assert.match(src, /webContents\.send\('library-fill-review', review \|\| null\)/);
});
