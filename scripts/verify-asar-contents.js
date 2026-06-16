#!/usr/bin/env node
// Verifies required HTML/JS files are bundled at the root of app.asar.
// Calls @electron/asar directly; normalizes entry paths so it works on
// both Windows (backslashes) and posix runners.
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

const raw = asar.listPackage(asarPath);
console.log('---- raw asar entries (first 20) ----');
console.log(raw.slice(0, 20).join('\n'));

// normalize: backslash -> slash, strip leading slashes, lowercase for compare
const norm = new Set(
  raw.map(e => e.replace(/\\/g, '/').replace(/^\/+/, ''))
);

const required = ['index.html', 'settings.html', 'overlay.html', 'preload.js', 'overlay-preload.js'];
const missing = required.filter(r => !norm.has(r));
if (missing.length) {
  console.error('FATAL: missing from app.asar -> ' + missing.join(', '));
  process.exit(1);
}
console.log('asar content verification PASSED');
