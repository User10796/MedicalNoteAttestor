#!/usr/bin/env node
// Validates a downloaded pain-criteria-library library.json and records its release tag in it
// (field `release_tag`) so the app can show "Library snapshot: <tag>". Writes UTF-8 without BOM.
//   node scripts/stamp-library-snapshot.js <path/to/library.snapshot.json> <release-tag>
const fs = require('fs');
const core = require('../lib/mna-core');

const [file, tag] = process.argv.slice(2);
if (!file || !tag) { console.error('usage: stamp-library-snapshot.js <file> <tag>'); process.exit(2); }
const bundle = core.parseBundle(fs.readFileSync(file, 'utf8'));
if (!bundle) { console.error('FATAL: ' + file + ' is not a valid library bundle (entries[] + built_at required)'); process.exit(1); }
const procs = (bundle.registries && bundle.registries.procedures) || [];
if (!procs.length || !procs.every(p => Array.isArray(p.aliases) && p.aliases.length)) {
    console.error('FATAL: library bundle has no procedure aliases (pain-criteria-library PR #10 or later required)');
    process.exit(1);
}
bundle.release_tag = tag;
fs.writeFileSync(file, JSON.stringify(bundle), { encoding: 'utf8' });
console.log(`Stamped ${file}: release ${tag}, built_at ${bundle.built_at}, ${bundle.entries.length} entries`);
