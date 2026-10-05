#!/usr/bin/env node
// Verifies required files are bundled in app.asar, the criteria-library snapshot parses with a
// built_at, and the build stamp commit matches HEAD. Calls @electron/asar directly; normalizes
// entry paths so it works on both Windows (backslashes) and posix runners.
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
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

// normalize: backslash -> slash, strip leading slashes
const norm = new Set(
  raw.map(e => e.replace(/\\/g, '/').replace(/^\/+/, ''))
);

const required = ['index.html', 'settings.html', 'overlay.html', 'preload.js', 'overlay-preload.js', 'build-info.json',
                  'picker.html', 'picker.js', 'picker-preload.js',
                  'lib/slot-poller.js', 'lib/mna-core.js', 'lib/library-client.js', 'lib/capture-flow.js',
                  'resources/library.snapshot.json'];
const missing = required.filter(r => !norm.has(r));
if (missing.length) {
  console.error('FATAL: missing from app.asar -> ' + missing.join(', '));
  process.exit(1);
}

// Library snapshot parses and carries built_at (+ release tag for the About panel).
let snap;
try {
  snap = JSON.parse(asar.extractFile(asarPath, 'resources/library.snapshot.json').toString('utf8'));
} catch (e) {
  console.error('FATAL: resources/library.snapshot.json does not parse: ' + e.message);
  process.exit(1);
}
if (!snap.built_at || !Array.isArray(snap.entries) || !snap.entries.length) {
  console.error('FATAL: library snapshot lacks built_at or entries');
  process.exit(1);
}
console.log(`library snapshot OK: release ${snap.release_tag || '?'}, built_at ${snap.built_at}, ${snap.entries.length} entries`);
const snapBuf = asar.extractFile(asarPath, 'resources/library.snapshot.json');
if (snapBuf[0] === 0xEF && snapBuf[1] === 0xBB && snapBuf[2] === 0xBF) {
  console.error('FATAL: library snapshot has a UTF-8 BOM');
  process.exit(1);
}

// Build stamp commit matches HEAD.
const info = JSON.parse(asar.extractFile(asarPath, 'build-info.json').toString('utf8').replace(/^﻿/, ''));
let head = process.env.GITHUB_SHA || '';
if (!head) { try { head = execSync('git rev-parse HEAD').toString().trim(); } catch { head = ''; } }
if (!head || !head.startsWith(info.commit)) {
  console.error(`FATAL: build stamp commit ${info.commit} does not match HEAD ${head}`);
  process.exit(1);
}
console.log(`build stamp OK: ${info.commit} matches HEAD`);
console.log('asar content verification PASSED');
