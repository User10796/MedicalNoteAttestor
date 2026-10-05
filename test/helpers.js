const fs = require('fs');
const os = require('os');
const path = require('path');

const FIX = path.join(__dirname, 'fixtures');
const bundleRaw = fs.readFileSync(path.join(FIX, 'library.fixture.json'), 'utf8');
const tmpDir = (p = 'mna-') => fs.mkdtempSync(path.join(os.tmpdir(), p));

function headersObj(h) { return { get: (k) => h[k.toLowerCase()] ?? null }; }
function response(status, { json, text, headers = {} } = {}) {
    return {
        status, ok: status >= 200 && status < 300, type: 'basic', headers: headersObj(headers),
        json: async () => json, text: async () => (text != null ? text : JSON.stringify(json))
    };
}

// Fake GitHub: release endpoint (ETag) + asset that 302s to storage. Records every request.
function fakeGitHub({ tag = 'lib-20261005-892bd41', raw = bundleRaw, failNetwork = false } = {}) {
    const requests = [];
    const etag = '"etag-' + tag + '"';
    async function fetchImpl(url, opts = {}) {
        requests.push({ url, method: opts.method || 'GET', headers: { ...(opts.headers || {}) }, body: opts.body ?? null });
        if (failNetwork) throw new Error('net::ERR_INTERNET_DISCONNECTED');
        if (url.endsWith('/releases/latest')) {
            if (opts.headers && opts.headers['If-None-Match'] === etag) return response(304);
            return response(200, { json: { tag_name: tag, assets: [{ name: 'library.json', url: 'https://api.github.com/repos/User10796/pain-criteria-library/releases/assets/1' }] }, headers: { etag } });
        }
        if (url.includes('/releases/assets/')) return response(302, { headers: { location: 'https://objects.githubusercontent.com/signed/library.json?sig=x' } });
        if (url.startsWith('https://objects.githubusercontent.com/')) return response(200, { text: raw });
        return response(404, { json: {} });
    }
    return { fetchImpl, requests };
}

module.exports = { FIX, bundleRaw, tmpDir, fakeGitHub, response };
