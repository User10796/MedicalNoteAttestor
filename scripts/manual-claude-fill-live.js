#!/usr/bin/env node
// OPTIONAL manual live test of the Claude fill (SPEC_library_claude_fill §6). NOT run in CI.
// Uses only the synthetic note in test/fixtures/claude-fill/ and the TFESI template from the test library.
//   ANTHROPIC_API_KEY=<your key> node scripts/manual-claude-fill-live.js
// (MNA_CLAUDE_KEY also works.) MNA_WORKSPACE_ID (optional) is sent as anthropic-workspace-id, for keys
// that aren't scoped to a workspace. The key is read from the environment at run time; it is never written
// anywhere or printed. Output: HTTP status, the API's error type/message on failure (Anthropic's text,
// no patient data), and the fill summary. Step 1 sends the exact request build fd53909 sent (no
// streaming); step 2 runs the app's current streaming client.
const fs = require('fs');
const path = require('path');
const core = require('../lib/mna-core');
const freed = require('../lib/freed-parser');
const { createClaudeFiller, API_URL } = require('../lib/claude-fill-client');

const key = process.env.ANTHROPIC_API_KEY || process.env.MNA_CLAUDE_KEY || '';
if (!key) { console.error('Set ANTHROPIC_API_KEY (or MNA_CLAUDE_KEY) to run this manual test.'); process.exit(2); }
const model = process.argv[2] || core.FILL_MODEL;
const workspaceId = process.env.MNA_WORKSPACE_ID || '';
const FIX = path.join(__dirname, '..', 'test', 'fixtures');
const bundle = JSON.parse(fs.readFileSync(path.join(FIX, 'library.fixture.json'), 'utf8'));
const note = freed.parseFreed(freed.normalize(fs.readFileSync(path.join(FIX, 'claude-fill', 'freed_tfesi_note.txt'), 'utf8'))).slots;
const results = core.resolveSelections(bundle, 'medicare_ab_ga', [{ procedure_id: 'lumbar_tfesi', laterality: 'left', checked: true, line: 0 }]);
const templates = core.fillTemplatesFromResults(results);
const noteIn = { hpi: note.hpi, exam: note.exam, ap: note.ap };

async function step1() {
    const { body } = core.fillRequest(noteIn, templates, model);
    delete body.stream;
    const problems = core.fillCheckRequestBody(body);
    console.log(`step 1: model ${body.model}, max_tokens ${body.max_tokens}, tool_choice ${JSON.stringify(body.tool_choice)}, ` +
                `body checks: ${problems.length ? problems.join('; ') : 'ok'}`);
    const t0 = Date.now();
    const res = await fetch(API_URL, { method: 'POST', body: JSON.stringify(body),
        headers: { ...core.claudeHeaders(workspaceId), 'x-api-key': key } });
    const text = await res.text();
    const err = core.fillApiError(text);
    console.log(`step 1: HTTP ${res.status} in ${((Date.now() - t0) / 1000).toFixed(1)} s` +
                (err ? ` — ${err.type}: ${err.message}` : ''));
    if (res.ok) console.log('step 1: ' + (core.fillApply(noteIn, templates, text).summary || 'no summary'));
}

async function step2() {
    const filler = createClaudeFiller({ fetchImpl: fetch, getKey: () => key, isEnabled: () => true, model, getWorkspaceId: () => workspaceId,
        log: (m) => console.log('step 2: ' + m),
        onProgress: (p) => { if (p.stage !== 'filling' || p.n % 5 === 0) console.log(`step 2: ${p.text} (${p.elapsed} s)`); } });
    const r = await filler.fill({ note: noteIn, results });
    console.log('step 2: ' + (r.review.notice || r.review.summary));
    for (const f of r.review.flags || []) console.log('step 2 warning:', f.message);
}

step1().then(step2).catch((e) => { console.error('failed:', e.message); process.exit(1); });
