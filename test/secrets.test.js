// API-key security (2026-10-10): no built-in key, encrypted storage, migration of plain text.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { createSecretStore } = require('../lib/secrets');

const ROOT = path.join(__dirname, '..');
function fakeSafeStorage(available = true) {
    return {
        isEncryptionAvailable: () => available,
        encryptString: (s) => Buffer.from('ENC:' + Buffer.from(s).toString('hex')),
        decryptString: (b) => Buffer.from(b.toString().slice(4), 'hex').toString()
    };
}
function memStore(init = {}) {
    const d = { ...init };
    return { d, get: (k) => d[k], set: (k, v) => { if (v === undefined) delete d[k]; else d[k] = v; } };
}

test('plain-text key from an older build is encrypted, then the plain copy is deleted', () => {
    const store = memStore({ claudeApiKey: 'test-key-not-real-123' });
    const s = createSecretStore({ store, safeStorage: fakeSafeStorage() });
    assert.strictEqual(s.migrate('claudeApiKey'), 'migrated');
    assert.ok(!('claudeApiKey' in store.d), 'plain copy deleted');
    assert.ok(store.d.claudeApiKeyEnc && !store.d.claudeApiKeyEnc.includes('test-key-not-real'), 'stored encrypted');
    assert.strictEqual(s.get('claudeApiKey'), 'test-key-not-real-123');
    assert.strictEqual(s.migrate('claudeApiKey'), 'none', 'idempotent');
});

test('no secure storage: the plain key is kept (not lost), and nothing new is ever stored in plain text', () => {
    const store = memStore({ claudeApiKey: 'test-key-not-real-123' });
    const s = createSecretStore({ store, safeStorage: fakeSafeStorage(false) });
    assert.strictEqual(s.migrate('claudeApiKey'), 'kept-plain');
    assert.strictEqual(store.d.claudeApiKey, 'test-key-not-real-123');
    assert.strictEqual(s.set('other', 'x').ok, false);
    assert.ok(!('other' in store.d) && !('otherEnc' in store.d));
});

test('an already-encrypted key wins over a stale plain copy; empty plain values are removed', () => {
    const ss = fakeSafeStorage();
    const store = memStore({ claudeApiKeyEnc: ss.encryptString('newer-key').toString('base64'), claudeApiKey: 'older-key' });
    const s = createSecretStore({ store, safeStorage: ss });
    assert.strictEqual(s.migrate('claudeApiKey'), 'migrated');
    assert.strictEqual(s.get('claudeApiKey'), 'newer-key');
    const s2 = createSecretStore({ store: memStore({ claudeApiKey: '  ' }), safeStorage: ss });
    assert.strictEqual(s2.migrate('claudeApiKey'), 'removed-empty');
});

test('no key -> get() is empty (there is no built-in fallback); set("") removes the key', () => {
    const store = memStore();
    const s = createSecretStore({ store, safeStorage: fakeSafeStorage() });
    assert.strictEqual(s.get('claudeApiKey'), '');
    s.set('claudeApiKey', 'k1'); assert.ok(s.has('claudeApiKey'));
    s.set('claudeApiKey', ''); assert.ok(!s.has('claudeApiKey'));
});

// ── repo-wide guards ──────────────────────────────────────────────────────────────────────────
function sourceFiles(dir, out = []) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        if (['node_modules', '.git', 'build', 'dist', 'resources'].includes(e.name)) continue;
        const p = path.join(dir, e.name);
        if (e.isDirectory()) sourceFiles(p, out);
        else if (/\.(js|html|swift|ahk|json|plist|sh|yml|md|pbxproj)$/.test(e.name)) out.push(p);
    }
    return out;
}
test('no Anthropic API key appears anywhere in the repo source', () => {
    const KEY = /sk-ant-[A-Za-z0-9_-]{20,}/;
    const hits = sourceFiles(ROOT).filter(f => KEY.test(fs.readFileSync(f, 'utf8')));
    assert.deepStrictEqual(hits.map(f => path.relative(ROOT, f)), []);
});

test('Electron: no built-in key or build-time key injection; key is write-only from the renderer', () => {
    const main = fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8');
    assert.ok(!/BUILT_IN_API_KEY/.test(main));
    assert.ok(!/__CLAUDE_API_KEY__/.test(main));
    assert.ok(!/claudeApiKey:\s*store\.get/.test(main), 'get-settings never returns the key');
    assert.match(main, /hasClaudeApiKey:\s+secrets\.has\('claudeApiKey'\)/);
    assert.ok(!/store\.set\('claudeApiKey'/.test(main), 'never stored in plain text');
    assert.strictEqual((main.match(/const apiKey = getClaudeKey\(\);/g) || []).length, 2, 'both Claude calls use the stored key only');
    assert.match(main, /No API key set\. Go to Settings → Claude API to enter your key\./, 'Attestor Select explains a missing key');
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
    assert.ok(!pkg.scripts['inject-key'] && !pkg.scripts['build-dist']);
    assert.ok(!fs.existsSync(path.join(ROOT, 'config.json')), 'placeholder key file removed');
});
