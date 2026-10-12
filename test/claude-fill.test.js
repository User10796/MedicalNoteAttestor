// SPEC_library_claude_fill: Claude extracts values with quotes; the app verifies and substitutes.
// CI never calls the live API: recorded / mocked responses only. Fixtures are synthetic.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const core = require('../lib/mna-core');
const freed = require('../lib/freed-parser');
const { createClaudeFiller, API_URL, STARTED } = require('../lib/claude-fill-client');
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
test('recorded response: clinician-style fills accepted; fabrications rejected; expected text exact', () => {
    const r = core.fillApply(note, templates, recorded);
    assert.ok(r.ok);
    assert.strictEqual(r.texts[0], read('expected_exam.txt').replace(/\n$/, ''));
    assert.strictEqual(r.texts[1], read('expected_ap.txt').replace(/\n$/, ''));
    assert.deepStrictEqual(r.counts, { blanks: 25, filled: 19, inferred: 5, derived: 1, rejected: 2 });
    assert.deepStrictEqual(r.rejectionReasons, ['date not supported by quote', 'percentage not in quote']);
    assert.match(r.texts[1], /symptoms for 8 weeks/, '"two months" -> 8 weeks (derived)');
    assert.match(r.texts[1], /x 6 weeks: physical therapy and home exercise program\./, 'PT / HEP read as written out');
    assert.match(r.texts[1], /imaging: MRI \(MRI\/CT date 2026-08-14\)/, '"MR" and 08/14/2026 accepted');
    assert.match(r.texts[1], /past 12 months: 0\./, '"No prior epidural steroid injections" -> 0');
    assert.match(r.texts[1], /prior ESI on ___ gave ___% relief/, 'unsupported date and percentage left blank');
    assert.strictEqual(r.summary, 'Filled 19 of 25 blanks (5 inferred, 1 derived); 1 criteria warning.');
    const derived = r.marks[1].find(m => m.kind === 'derived');
    assert.strictEqual(derived.conversion, '2 months → 8 weeks');
});

// ── validator (§3, revised 2026-10-12) ───────────────────────────────────────────────────────
const NOTE2 = {
    hpi: 'Completed PT for two months with about half the pain gone. Denies prior ESI; no prior injections. MR of lumbar spine Aug 2026 shows L4-5 disc protrusion.',
    exam: 'Strength 4/5 in left EHL.',
    ap: 'Proceed with left L4-L5 TFESI.'
};
const one = (line) => [{ slot: 'ap', text: line }];
function check(line, v, n = NOTE2) {
    const plan = core.fillPlan(one(line));
    return core.fillValidate({ values: [v], flags: [] }, plan, n);
}
const ok = (r) => Object.values(r.accepted)[0];
const why = (r) => r.rejections.map(x => x.reason);

test('"PT" -> "physical therapy" accepted (no content-word match any more)', () => {
    assert.strictEqual(ok(check('Conservative care: ___.', val(1, 'physical therapy', 'inferred', 'Completed PT for two months', 'HPI'))).value, 'physical therapy');
});
test('"MR of lumbar spine" -> MRI (option list, synonym mapped to the option)', () => {
    assert.strictEqual(ok(check('Imaging: ___ (MRI/CT).', val(1, 'MR', 'explicit', 'MR of lumbar spine', 'HPI'))).value, 'MRI');
    assert.strictEqual(ok(check('Imaging: ___ (MRI/CT).', val(1, 'MRI', 'inferred', 'MR of lumbar spine', 'HPI'))).value, 'MRI');
});
test('"no prior injections" -> 0 accepted', () => {
    assert.strictEqual(ok(check('Prior injections in 12 months: ___.', val(1, '0', 'inferred', 'no prior injections', 'HPI'))).value, '0');
});
test('"PT for two months" -> 8 weeks, derived (with the conversion)', () => {
    const a = ok(check('PT for ___ weeks.', val(1, '8', 'explicit', 'Completed PT for two months', 'HPI')));
    assert.strictEqual(a.kind, 'derived');
    assert.strictEqual(a.conversion, '2 months → 8 weeks');
});
test('"about half the pain gone" -> 50%, inferred', () => {
    const a = ok(check('Patient reports ___% relief.', val(1, '50', 'inferred', 'about half the pain gone', 'HPI')));
    assert.deepStrictEqual([a.value, a.kind], ['50', 'inferred']);
});
test('a date not in the note -> rejected; a normalized date in the quote -> accepted', () => {
    assert.deepStrictEqual(why(check('MRI date ___.', val(1, '2026-03-01', 'explicit', 'MR of lumbar spine Aug 2026', 'HPI'))), ['date not supported by quote']);
    assert.ok(ok(check('MRI date ___.', val(1, '08/2026', 'explicit', 'MR of lumbar spine Aug 2026', 'HPI'))));
});
test('a radiologist name not in the note -> rejected', () => {
    assert.deepStrictEqual(why(check('Read by ___ (radiologist).', val(1, 'Dr. Alan Chu', 'inferred', 'MR of lumbar spine Aug 2026', 'HPI'))), ['name not in quote']);
});
test('a percentage with no supporting quote -> rejected', () => {
    assert.deepStrictEqual(why(check('Patient reports ___% relief.', val(1, '60', 'inferred', 'Denies prior ESI', 'HPI'))), ['percentage not in quote']);
});
test('counts and durations stay strict', () => {
    assert.deepStrictEqual(why(check('Sessions: ___.', val(1, '3', 'inferred', 'Completed PT for two months', 'HPI'))), ['count not in quote']);
    assert.deepStrictEqual(why(check('Symptoms for ___ weeks.', val(1, '6', 'derived', 'Denies prior ESI', 'HPI'))), ['duration not in quote']);
    assert.deepStrictEqual(why(check('PT for ___ weeks.', val(1, '20', 'derived', 'Completed PT for two months', 'HPI'))), ['duration not supported by quote']);
    assert.deepStrictEqual(why(check('Score: ___.', val(1, 'ODI 40', 'inferred', 'Completed PT for two months', 'HPI'))), ['number not in quote']);
    assert.ok(ok(check('Strength ___ in left EHL.', val(1, '4/5', 'explicit', 'Strength 4/5 in left EHL', 'Exam'))));
});
test('quote must exist in the stated section', () => {
    assert.deepStrictEqual(why(check('Pain ___/10.', val(1, '9', 'explicit', 'rated 9/10', 'HPI'))), ['quote not in note section']);
    assert.deepStrictEqual(why(check('Side ___.', val(1, 'left', 'inferred', 'Proceed with left L4-L5 TFESI', 'HPI'))), ['quote not in note section'], 'wrong section');
    assert.ok(ok(check('Side ___.', val(1, 'left', 'inferred', 'PROCEED   with left L4-L5 TFESI', 'A&P'))), 'case/whitespace-insensitive');
});
test('option outside the list -> rejected', () => {
    assert.deepStrictEqual(why(check('Imaging: ___ (MRI/CT).', val(1, 'X-ray', 'explicit', 'MR of lumbar spine', 'HPI'))), ['value not in option list']);
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
    const calls = [], notices = [];
    const fetchImpl = async (url, opts) => {
        calls.push({ url, opts });
        if (delay) await new Promise((r, j) => { const t = setTimeout(r, delay); opts.signal.addEventListener('abort', () => { clearTimeout(t); const e = new Error('aborted'); e.name = 'AbortError'; j(e); }); });
        if (reply instanceof Error) throw reply;
        return reply || response(200, { json: recorded });
    };
    return { f: createClaudeFiller({ fetchImpl, getKey: () => key, isEnabled: () => enabled, model: 'claude-sonnet-4-6', timeoutMs: 50,
                                     notify: (text, kind) => notices.push({ text, kind }) }), calls, notices };
}
test('setting off (the default) -> no API call, no notice, behavior unchanged', async () => {
    const { f, calls, notices } = filler({ enabled: false });
    assert.strictEqual(await f.fill({ note, results: results() }), null);
    assert.strictEqual(calls.length, 0);
    assert.deepStrictEqual(notices, []);
});
test('setting on, no key -> no API call, visible notice saying why (never silent)', async () => {
    const { f, calls, notices } = filler({ key: '' });
    const base = results();
    const r = await f.fill({ note, results: base });
    assert.strictEqual(calls.length, 0);
    assert.deepStrictEqual(r.results, base);
    assert.strictEqual(r.review.notice, 'Claude fill: no API key saved \u2014 blanks left as-is. Add your key in Settings.');
    assert.deepStrictEqual(notices, [{ text: r.review.notice, kind: 'error' }]);
});
test('setting on, key unreadable (safeStorage decrypt failed) -> visible notice', async () => {
    const { f, calls, notices } = filler({ key: { state: 'unreadable' } });
    const r = await f.fill({ note, results: results() });
    assert.strictEqual(calls.length, 0);
    assert.match(r.review.notice, /^Claude fill: your saved API key couldn\u2019t be read/);
    assert.strictEqual(notices[0].kind, 'error');
});
test('on + key -> one POST to the Messages API with the request body; results filled; progress + summary shown', async () => {
    const { f, calls, notices } = filler();
    const r = await f.fill({ note, results: results() });
    assert.strictEqual(calls.length, 1);
    assert.strictEqual(calls[0].url, API_URL);
    assert.strictEqual(calls[0].opts.method, 'POST');
    const body = JSON.parse(calls[0].opts.body);
    assert.strictEqual(body.tool_choice.name, 'record_blank_values');
    assert.strictEqual(body.max_tokens, 4096);
    const filled = r.results.find(x => x.insert);
    assert.strictEqual(filled.dotphrase, read('expected_ap.txt').replace(/\n$/, ''));
    assert.strictEqual(filled.examText, read('expected_exam.txt').replace(/\n$/, ''));
    assert.match(r.review.summary, /^Filled 19 of 25 blanks/);
    assert.deepStrictEqual(notices.map(n => n.kind), ['info', 'info']);
    assert.strictEqual(notices[0].text, STARTED);
    assert.strictEqual(notices[1].text, r.review.summary);
});
test('API error, network error, timeout or malformed reply -> blanks left as-is, notice with the reason', async () => {
    const cases = [
        [{ reply: response(500, { json: {} }) }, 'Claude fill failed (HTTP 500: Anthropic service error) \u2014 blanks left as-is.'],
        [{ reply: response(401, { json: {} }) }, 'Claude fill failed (HTTP 401: check your API key) \u2014 blanks left as-is.'],
        [{ reply: new Error('offline') }, 'Claude fill failed (network error) \u2014 blanks left as-is.'],
        [{ delay: 500 }, 'Claude fill timed out after 60 s \u2014 blanks left as-is.'],
        [{ reply: response(200, { json: { content: [] } }) }, 'Claude fill failed (unexpected reply) \u2014 blanks left as-is.']
    ];
    for (const [opts, text] of cases) {
        const { f, notices } = filler(opts);
        const base = results();
        const r = await f.fill({ note, results: base });
        assert.deepStrictEqual(r.results, base);
        assert.strictEqual(r.review.notice, text);
        assert.deepStrictEqual(notices[notices.length - 1], { text, kind: 'error' });
    }
});
test('inserted text with no blanks -> no API call, review says so', async () => {
    const { f, calls } = filler();
    const noBlanks = results().map(x => ({ ...x, examText: 'Exam.', dotphrase: 'Plan.' }));
    const r = await f.fill({ note, results: noBlanks });
    assert.strictEqual(calls.length, 0);
    assert.strictEqual(r.review.summary, 'Claude fill: no blanks in the inserted library text.');
});
test('timeout default is 60 s (a full template takes Claude more than 20 s)', () => {
    assert.strictEqual(core.FILL_TIMEOUT_MS, 60000);
    assert.match(fs.readFileSync(path.join(__dirname, '..', 'lib', 'claude-fill-client.js'), 'utf8'), /timeoutMs = core\.FILL_TIMEOUT_MS/);
});
test('logs counts and reasons only (never note text or values)', async () => {
    const lines = [];
    const fetchImpl = async () => response(200, { json: recorded });
    const f = createClaudeFiller({ fetchImpl, getKey: () => 'k', isEnabled: () => true, model: 'm', log: (m) => lines.push(m) });
    await f.fill({ note, results: results() });
    assert.strictEqual(lines.length, 1);
    assert.match(lines[0], /^claude fill: 19\/25 filled, 2 rejected/);
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
    assert.match(r.review.summary, /Filled 19 of 25/);
});

test('main.js wiring: setting off by default, user key only, CLAUDE_MODEL, captured note only, review never pasted', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
    assert.match(src, /libraryClaudeFill: false,/);
    assert.match(src, /getKey: \(\) => secrets\.lookup\('claudeApiKey'\),/);
    assert.match(src, /notify: \(text\) => showNotice\(text\)/, 'fill notices are visible');
    assert.match(src, /isEnabled: \(\) => !!store\.get\('libraryClaudeFill'\),/);
    assert.match(src, /model: CLAUDE_MODEL,/);
    assert.match(src, /const fillExam = source === 'freed' \? freedExam : '';/);
    assert.match(src, /fillBlanks: \(req\) => claudeFiller\.fill\(req\),/);
    assert.match(src, /webContents\.send\('library-fill-review', review \|\| null\)/);
});
