const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { createLibraryClient, RELEASE_URL } = require('../lib/library-client');
const { bundleRaw, tmpDir, fakeGitHub } = require('./helpers');

function setup({ token = 'test-token-not-real', snapshot = true, gh = fakeGitHub() } = {}) {
    const dir = tmpDir();
    const snapshotPath = path.join(dir, 'library.snapshot.json');
    if (snapshot) fs.writeFileSync(snapshotPath, JSON.stringify({ ...JSON.parse(bundleRaw), release_tag: 'lib-snap' }));
    const client = createLibraryClient({ fetchImpl: gh.fetchImpl, cacheDir: path.join(dir, 'cache'), snapshotPath, getToken: () => token });
    return { client, gh, dir };
}

test('no token -> no network, bundled snapshot is used', async () => {
    const { client, gh } = setup({ token: '' });
    const s = await client.refresh();
    assert.strictEqual(gh.requests.length, 0);
    assert.strictEqual(s.source, 'snapshot');
    assert.strictEqual(s.tag, 'lib-snap');
    assert.ok(s.builtAt);
});

test('token -> fresh download, cached as UTF-8 without BOM', async () => {
    const { client, gh } = setup();
    const s = await client.refresh();
    assert.strictEqual(s.source, 'download');
    assert.strictEqual(s.tag, 'lib-20261005-892bd41');
    const buf = fs.readFileSync(client.paths.cachePath);
    assert.notDeepStrictEqual([...buf.slice(0, 3)], [0xEF, 0xBB, 0xBF], 'no BOM');
    // The storage redirect is fetched without the Authorization header.
    const storage = gh.requests.find(r => r.url.startsWith('https://objects.githubusercontent.com/'));
    assert.ok(storage && !('Authorization' in storage.headers));
});

test('ETag: second refresh sends If-None-Match and does not re-download', async () => {
    const { client, gh } = setup();
    await client.refresh();
    const n = gh.requests.length;
    const s = await client.refresh();
    const again = gh.requests.slice(n);
    assert.strictEqual(again.length, 1);
    assert.ok(again[0].headers['If-None-Match']);
    assert.strictEqual(s.source, 'cache');
});

test('network failure -> cache', async () => {
    const good = fakeGitHub();
    const { client, dir } = setup({ gh: good });
    await client.refresh();
    const offline = createLibraryClient({ fetchImpl: fakeGitHub({ failNetwork: true }).fetchImpl, cacheDir: path.join(dir, 'cache'),
        snapshotPath: path.join(dir, 'library.snapshot.json'), getToken: () => 'test-token-not-real' });
    const s = await offline.refresh();
    assert.strictEqual(s.source, 'cache');
    assert.match(s.lastError, /DISCONNECTED/);
});

test('corrupt cache -> snapshot', async () => {
    const { client, dir } = setup({ token: '' });
    fs.mkdirSync(path.join(dir, 'cache'), { recursive: true });
    fs.writeFileSync(client.paths.cachePath, '{"entries": [tru');
    assert.strictEqual(client.loadLocal().source, 'snapshot');
});

test('invalid download is rejected and the previous source is kept', async () => {
    const { client } = setup({ gh: fakeGitHub({ raw: '<html>proxy login</html>' }) });
    const s = await client.refresh();
    assert.strictEqual(s.source, 'snapshot');
    assert.match(s.lastError, /validation/);
});

test('nothing anywhere -> source none, never throws', async () => {
    const { client } = setup({ token: '', snapshot: false });
    const s = await client.refresh();
    assert.strictEqual(s.source, 'none');
    assert.strictEqual(s.hasLibrary, false);
});

test('only GitHub release GETs are made', async () => {
    const { client, gh } = setup();
    await client.refresh({ force: true });
    for (const r of gh.requests) {
        assert.strictEqual(r.method, 'GET');
        assert.strictEqual(r.body, null);
        assert.ok(r.url === RELEASE_URL || r.url.startsWith('https://api.github.com/repos/User10796/pain-criteria-library/releases/assets/') ||
                  r.url.startsWith('https://objects.githubusercontent.com/'), r.url);
    }
});
