#!/usr/bin/env node
// OPTIONAL manual live test of the Claude fill (SPEC_library_claude_fill §6). NOT run in CI.
// Uses only the synthetic note in test/fixtures/claude-fill/ and the real TFESI template.
//   MNA_CLAUDE_KEY=<your key> node scripts/manual-claude-fill-live.js
// The key is read from the environment at run time; it is never written anywhere or printed.
const fs = require('fs');
const path = require('path');
const core = require('../lib/mna-core');
const freed = require('../lib/freed-parser');
const { createClaudeFiller } = require('../lib/claude-fill-client');

const key = process.env.MNA_CLAUDE_KEY || '';
if (!key) { console.error('Set MNA_CLAUDE_KEY to run this manual test.'); process.exit(2); }
const FIX = path.join(__dirname, '..', 'test', 'fixtures');
const bundle = JSON.parse(fs.readFileSync(path.join(FIX, 'library.fixture.json'), 'utf8'));
const note = freed.parseFreed(freed.normalize(fs.readFileSync(path.join(FIX, 'claude-fill', 'freed_tfesi_note.txt'), 'utf8'))).slots;
const results = core.resolveSelections(bundle, 'medicare_ab_ga', [{ procedure_id: 'lumbar_tfesi', laterality: 'left', checked: true, line: 0 }]);
const filler = createClaudeFiller({ fetchImpl: fetch, getKey: () => key, isEnabled: () => true, model: 'claude-sonnet-4-6', log: console.log });
filler.fill({ note: { hpi: note.hpi, exam: note.exam, ap: note.ap }, results }).then((r) => {
    if (!r) { console.log('skipped'); return; }
    console.log(r.review.notice || r.review.summary);
    for (const f of r.review.flags || []) console.log('warning:', f.message);
    for (const t of r.review.templates || []) console.log('\n[' + t.slot + ']\n' + t.text);
});
