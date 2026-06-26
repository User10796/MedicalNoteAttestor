#!/usr/bin/env node
// Writes build-info.json at repo root so the packaged app can display its exact
// provenance (version + commit + build time + CI run) in Settings > About.
// Commit comes from $GIT_COMMIT (CI passes github.sha); falls back to
// `git rev-parse --short HEAD` for local dev builds.
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const pkg = require('../package.json');

function shortCommit() {
  if (process.env.GIT_COMMIT) return process.env.GIT_COMMIT.slice(0, 7);
  try {
    return execSync('git rev-parse --short HEAD', { stdio: ['ignore', 'pipe', 'ignore'] })
      .toString().trim();
  } catch {
    return 'unknown';
  }
}

const info = {
  version:   pkg.version,
  commit:    shortCommit(),
  builtAt:   new Date().toISOString(),
  runNumber: process.env.BUILD_RUN_NUMBER || null
};

const out = path.join(__dirname, '..', 'build-info.json');
fs.writeFileSync(out, JSON.stringify(info, null, 2));
console.log('Wrote ' + out + ': ' + JSON.stringify(info));
