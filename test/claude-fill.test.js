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
        [{ delay: 500 }, 'Claude fill timed out (no reply from Claude) \u2014 blanks left as-is.'],
        [{ reply: response(400, { json: { type: 'error', error: { type: 'invalid_request_error', message: 'tools.0.input_schema: example problem' } } }) },
         'Claude fill failed (400 invalid_request_error: tools.0.input_schema: example problem) \u2014 blanks left as-is.'],
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
test('timeouts: 30 s with no bytes from Claude, 120 s in all (streaming keeps a long fill alive)', () => {
    assert.strictEqual(core.FILL_IDLE_TIMEOUT_MS, 30000);
    assert.strictEqual(core.FILL_TIMEOUT_MS, 120000);
    const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'claude-fill-client.js'), 'utf8');
    assert.match(src, /timeoutMs = core\.FILL_TIMEOUT_MS/);
    assert.match(src, /idleMs = core\.FILL_IDLE_TIMEOUT_MS/);
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
    assert.match(src, /onProgress: \(p\) => showFillProgress\(p\)/, 'fill stages and errors are shown in the progress window (over any app)');
    assert.match(src, /notify: \(text\) => \{ if \(mainWindow\) mainWindow\.webContents\.send\('source-notice', text\); \}/, 'and in the main window');
    assert.match(src, /isEnabled: \(\) => !!store\.get\('libraryClaudeFill'\),/);
    assert.match(src, /model: CLAUDE_MODEL,/);
    assert.match(src, /const fillExam = source === 'freed' \? freedExam : '';/);
    assert.match(src, /fillBlanks: \(req\) => claudeFiller\.fill\(req\),/);
    assert.match(src, /webContents\.send\('library-fill-review', review \|\| null\)/);
});

// ── Streaming reply, progress, Cancel (2026-10-12) ─────────────────────────────────────────────
// Build an SSE stream of the recorded tool call, split into small chunks (lines split across chunks).
function sseChunks(message, { error } = {}) {
    const tu = message.content.find(c => c.type === 'tool_use');
    const json = JSON.stringify(tu.input);
    const ev = (o) => 'event: ' + o.type + '\ndata: ' + JSON.stringify(o) + '\n\n';
    let out = ev({ type: 'message_start', message: { id: 'msg_test', type: 'message', role: 'assistant', content: [] } });
    out += ev({ type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'toolu_test', name: tu.name, input: {} } });
    for (let i = 0; i < json.length; i += 37) out += ev({ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: json.slice(i, i + 37) } });
    if (error) return chunk(out.slice(0, out.length / 2) + ev({ type: 'error', error }));
    out += ev({ type: 'content_block_stop', index: 0 }) + ev({ type: 'message_delta', delta: { stop_reason: 'tool_use' } }) + ev({ type: 'message_stop' });
    return chunk(out);
}
function chunk(text) { const parts = []; for (let i = 0; i < text.length; i += 53) parts.push(Buffer.from(text.slice(i, i + 53))); return parts; }
function streamResponse(parts, { gate } = {}) {
    let i = 0;
    return { status: 200, ok: true, headers: { get: (k) => k.toLowerCase() === 'content-type' ? 'text/event-stream' : null },
        body: { getReader: () => ({ read: async () => { if (gate) await gate(i); return i < parts.length ? { value: parts[i++], done: false } : { done: true }; } }) } };
}

test('stream parser: counts values as they arrive and rebuilds the tool call (shared core)', () => {
    const st = core.fillStreamStart();
    const counts = [];
    for (const p of sseChunks(recorded)) { core.fillStreamFeed(st, p.toString()); counts.push(st.n); }
    assert.ok(counts.some(n => n > 0 && n < 25), 'partial counts reported');
    assert.strictEqual(st.n, 25);
    assert.strictEqual(st.stop, 'tool_use');
    assert.deepStrictEqual(core.fillStreamMessage(st).content[0].input, recorded.content.find(c => c.type === 'tool_use').input);
});

test('streaming fill: same filled text as the recorded reply; progress sending -> filling n of N -> checking -> done', async () => {
    const stages = [];
    const f = createClaudeFiller({ fetchImpl: async () => streamResponse(sseChunks(recorded)), getKey: () => 'k', isEnabled: () => true,
        model: core.FILL_MODEL, onProgress: (p) => stages.push(p) });
    const r = await f.fill({ note, results: results() });
    const filled = r.results.find(x => x.insert);
    assert.strictEqual(filled.dotphrase, read('expected_ap.txt').replace(/\n$/, ''));
    assert.strictEqual(filled.examText, read('expected_exam.txt').replace(/\n$/, ''));
    const kinds = stages.map(p => p.stage);
    assert.strictEqual(kinds[0], 'sending');
    assert.strictEqual(stages[0].text, 'Sending to Claude');
    const filling = stages.filter(p => p.stage === 'filling');
    assert.ok(filling.length > 3, 'several n-of-N updates');
    assert.match(filling[1].text, /^Claude is filling blanks \(\d+ of 25\)$/);
    assert.deepStrictEqual(kinds.slice(-2), ['checking', 'done']);
    assert.strictEqual(stages[stages.length - 1].text, 'Done: filled 19 of 25');
    assert.ok(stages.every(p => typeof p.elapsed === 'number' && typeof p.startedAt === 'number'), 'elapsed time reported');
});

test('streaming error event -> notice with the API error type and message', async () => {
    const f = createClaudeFiller({ fetchImpl: async () => streamResponse(sseChunks(recorded, { error: { type: 'overloaded_error', message: 'Overloaded' } })),
        getKey: () => 'k', isEnabled: () => true, model: core.FILL_MODEL });
    const r = await f.fill({ note, results: results() });
    assert.strictEqual(r.review.notice, 'Claude fill failed (overloaded_error: Overloaded) \u2014 blanks left as-is.');
});

test('Cancel mid-stream -> library text unfilled, "cancelled" notice, progress says so', async () => {
    let f;
    const stages = [];
    const parts = sseChunks(recorded);
    const gate = async (i) => { if (i === 10) { f.cancel(); await new Promise(r => setTimeout(r, 5)); } };
    const fetchImpl = async (url, opts) => {
        const res = streamResponse(parts, { gate });
        const read = res.body.getReader().read;
        res.body.getReader = () => ({ read: async () => { if (opts.signal.aborted) { const e = new Error('aborted'); e.name = 'AbortError'; throw e; } return read(); } });
        return res;
    };
    f = createClaudeFiller({ fetchImpl, getKey: () => 'k', isEnabled: () => true, model: core.FILL_MODEL, onProgress: (p) => stages.push(p) });
    const base = results();
    const r = await f.fill({ note, results: base });
    assert.strictEqual(r.cancelled, true);
    assert.deepStrictEqual(r.results, base, 'library text unfilled');
    assert.strictEqual(r.review.notice, 'Claude fill cancelled \u2014 blanks left as-is.');
    assert.strictEqual(stages[stages.length - 1].stage, 'cancelled');
    assert.strictEqual(f.cancel(), false, 'nothing left to cancel');
});

// ── Request body passes the API's schema checks (the cause of a 400 would show here) ───────────
test('request body (stream and non-stream) passes the Messages API checks for the fill model', () => {
    for (const stream of [false, true]) {
        const { body } = core.fillRequest(note, core.fillTemplatesFromResults(results()), core.FILL_MODEL, { stream });
        assert.deepStrictEqual(core.fillCheckRequestBody(body), [], 'stream ' + stream);
        assert.strictEqual(body.stream, stream);
        assert.strictEqual(body.model, core.FILL_MODEL);
        assert.deepStrictEqual(body.tool_choice, { type: 'tool', name: 'record_blank_values' });
        assert.ok(!('thinking' in body) && !('temperature' in body));
    }
});
test('body checks catch the mistakes that return a 400', () => {
    const good = core.fillRequest(note, core.fillTemplatesFromResults(results()), core.FILL_MODEL).body;
    const bad = (mut) => { const b = JSON.parse(JSON.stringify(good)); mut(b); return core.fillCheckRequestBody(b); };
    assert.ok(bad(b => { b.model = 'claude-sonnet-5-5'; }).some(p => /rejects forced tool_choice/.test(p)), 'forced tool on a model that rejects it');
    assert.ok(bad(b => { b.max_tokens = 0; }).some(p => /max_tokens/.test(p)));
    assert.ok(bad(b => { b.tools[0].input_schema.properties.values.items.properties.value.type = ['string', 'nil']; }).some(p => /unknown type nil/.test(p)));
    assert.ok(bad(b => { b.tools[0].input_schema.properties.values.items.oneOf = []; }).some(p => /unsupported keyword oneOf/.test(p)));
    assert.ok(bad(b => { b.tool_choice.name = 'other'; }).some(p => /not defined/.test(p)));
    assert.ok(bad(b => { b.temperature = 0; }).some(p => /unexpected top-level field temperature/.test(p)));
    assert.deepStrictEqual(bad(() => {}), [], '["string","null"] type arrays are allowed');
});
test('the fill model is shared: Electron and Swift both use core.FILL_MODEL', () => {
    assert.strictEqual(core.FILL_MODEL, 'claude-sonnet-4-6');
    assert.match(fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8'), /model: core\.FILL_MODEL,/);
    assert.match(fs.readFileSync(path.join(__dirname, '..', 'MedicalNoteAttestor', 'MedicalNoteAttestorApp.swift'), 'utf8'), /model: core\.fillModel/);
});
