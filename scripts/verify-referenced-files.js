#!/usr/bin/env node
// Fails if any path main.js loads via path.join(__dirname, '<x>') is missing
// from the build root. Catches dropped files (the "blank window" bug class).
const fs = require('fs');
const path = require('path');

const mainPath = process.argv[2] || 'main.js';
if (!fs.existsSync(mainPath)) {
  console.error(`FATAL: ${mainPath} not found (run from the Electron app root)`);
  process.exit(2);
}
const baseDir = path.dirname(path.resolve(mainPath));
const src = fs.readFileSync(mainPath, 'utf8');

const re = /__dirname,\s*['"]([^'"]+)['"]/g;
const refs = new Set();
let m;
while ((m = re.exec(src)) !== null) refs.add(m[1]);

const missing = [...refs].filter(r => !fs.existsSync(path.join(baseDir, r)));
if (missing.length) {
  console.error('FATAL: main.js references paths missing from the build root:');
  missing.forEach(f => console.error('  - ' + f));
  process.exit(1);
}
console.log('OK: all __dirname-referenced paths exist -> ' + [...refs].sort().join(', '));
