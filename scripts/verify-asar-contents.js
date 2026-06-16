#!/usr/bin/env node
// Verifies required HTML/JS files are bundled at the root of app.asar.
// Calls @electron/asar directly (no shell pipe / npx) to avoid pipefail+SIGPIPE issues.
const fs = require('fs');
const path = require('path');
const asar = require('@electron/asar');

const distDir = 'dist';
const unpacked = fs.readdirSync(distDir)
  .filter(n => /^win.*-unpacked$/.test(n))
  .map(n => path.join(distDir, n))[0];

if (!unpacked) {
  console.error('FATAL: no dist/win*-unpacked directory found');
  process.exit(1);
}
const asarPath = path.join(unpacked, 'resources', 'app.asar');
if (!fs.existsSync(asarPath)) {
  console.error('FATAL: app.asar not found at ' + asarPath);
  process.exit(1);
}

const entries = asar.listPackage(asarPath);
const rootEntries = entries.filter(e => /^\/[^/]+$/.test(e));
console.log('---- asar root entries ----');
console.log(rootEntries.join('\n'));

const required = ['/index.html', '/settings.html', '/overlay.html', '/preload.js', '/overlay-preload.js'];
const missing = required.filter(r => !entries.includes(r));
if (missing.length) {
  console.error('FATAL: missing from app.asar -> ' + missing.join(', '));
  process.exit(1);
}
console.log('asar content verification PASSED');
