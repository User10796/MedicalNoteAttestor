// Criteria-library client (Electron main process).
//
// Source order: fresh download -> local cache -> bundled snapshot (MNACore.chooseLibrary).
// The only network traffic is a GET of the latest pain-criteria-library release (ETag'd) and,
// when the release tag changes, a GET of its library.json asset. Nothing from the note is ever
// sent. `fetchImpl` is injected (Electron's net.fetch in the app, so the system proxy applies;
// a recorder in tests). The token comes from `getToken()` and is never logged or returned.
const fs = require('fs');
const path = require('path');
const core = require('./mna-core');

const REPO = 'User10796/pain-criteria-library';
const RELEASE_URL = `https://api.github.com/repos/${REPO}/releases/latest`;
const REFRESH_INTERVAL_MS = 6 * 60 * 60 * 1000;
const UA = 'MedicalNoteAttestor (+https://github.com/User10796/MedicalNoteAttestor)';

function readJsonFile(p) {
    try { return JSON.parse(fs.readFileSync(p, 'utf8').replace(/^﻿/, '')); } catch { return null; }
}
function readText(p) {
    try { return fs.readFileSync(p, 'utf8'); } catch { return null; }
}
// UTF-8 without BOM, written atomically (temp + rename) so a crash can't leave half a cache.
function writeUtf8NoBom(p, text) {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    const tmp = p + '.tmp';
    fs.writeFileSync(tmp, String(text).replace(/^﻿/, ''), { encoding: 'utf8' });
    fs.renameSync(tmp, p);
}

function createLibraryClient({ fetchImpl, cacheDir, snapshotPath, getToken, log = () => {} }) {
    const cachePath = path.join(cacheDir, 'library.json');
    const metaPath = path.join(cacheDir, 'library-meta.json');
    let state = { bundle: null, source: 'none', tag: null, builtAt: null, lastCheck: null, lastError: null };
    let timer = null;

    function snapshotCandidate() {
        const raw = snapshotPath && readText(snapshotPath);
        if (!raw) return null;
        const b = core.parseBundle(raw);
        return { raw, tag: (b && b.release_tag) || (b && b.commit ? 'snapshot-' + String(b.commit).slice(0, 7) : 'snapshot') };
    }
    function cacheCandidate() {
        const raw = readText(cachePath);
        if (!raw) return null;
        const meta = readJsonFile(metaPath) || {};
        return { raw, tag: meta.tag || null };
    }
    function apply(choice) {
        state.bundle = choice.bundle;
        state.source = choice.source;
        state.tag = choice.tag;
        state.builtAt = choice.bundle ? choice.bundle.built_at : null;
    }

    // Load without network (startup, or when there's no token).
    function loadLocal() {
        apply(core.chooseLibrary(null, cacheCandidate(), snapshotCandidate()));
        return status();
    }

    async function getFollowingRedirectWithoutAuth(url, headers) {
        // GitHub answers the asset URL with a 302 to a signed storage URL. That URL must be
        // fetched WITHOUT the Authorization header (storage rejects two auth mechanisms).
        let res = await fetchImpl(url, { method: 'GET', headers, redirect: 'manual' });
        if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
            res = await fetchImpl(res.headers.get('location'), { method: 'GET', headers: { 'User-Agent': UA, Accept: 'application/octet-stream' } });
        } else if (res.type === 'opaqueredirect' || res.status === 0) {
            res = await fetchImpl(url, { method: 'GET', headers, redirect: 'follow' });
        }
        return res;
    }

    // Returns status(); never throws. `force` ignores the ETag (Settings "Refresh now").
    async function refresh({ force = false } = {}) {
        state.lastCheck = new Date().toISOString();
        const token = (getToken && getToken()) || '';
        if (!token) { state.lastError = null; return loadLocal(); } // no token: silently local
        const meta = readJsonFile(metaPath) || {};
        const headers = {
            'User-Agent': UA,
            Accept: 'application/vnd.github+json',
            'X-GitHub-Api-Version': '2022-11-28',
            Authorization: 'Bearer ' + token
        };
        if (meta.etag && !force && fs.existsSync(cachePath)) headers['If-None-Match'] = meta.etag;
        try {
            const res = await fetchImpl(RELEASE_URL, { method: 'GET', headers });
            if (res.status === 304) { state.lastError = null; return loadLocal(); }
            if (!res.ok) throw new Error('release check HTTP ' + res.status);
            const rel = await res.json();
            const etag = res.headers.get('etag') || null;
            const tag = rel.tag_name;
            if (!force && tag && tag === meta.tag && fs.existsSync(cachePath)) {
                writeUtf8NoBom(metaPath, JSON.stringify({ ...meta, etag, checked_at: state.lastCheck }));
                state.lastError = null;
                return loadLocal();
            }
            const asset = (rel.assets || []).find(a => a.name === 'library.json');
            if (!asset) throw new Error('release ' + tag + ' has no library.json');
            const aRes = await getFollowingRedirectWithoutAuth(asset.url, { ...headers, Accept: 'application/octet-stream' });
            if (!aRes.ok) throw new Error('asset download HTTP ' + aRes.status);
            const raw = await aRes.text();
            const choice = core.chooseLibrary({ raw, tag }, null, null);
            if (!choice.bundle) throw new Error('downloaded library.json failed validation');
            writeUtf8NoBom(cachePath, raw);
            writeUtf8NoBom(metaPath, JSON.stringify({ tag, etag, built_at: choice.bundle.built_at, fetched_at: state.lastCheck }));
            apply(choice);
            state.lastError = null;
            log('library: downloaded release ' + tag);
            return status();
        } catch (e) {
            state.lastError = String(e.message || e);
            log('library: refresh failed (' + state.lastError + '); using local copy');
            return loadLocal();
        }
    }

    function status() {
        return { source: state.source, tag: state.tag, builtAt: state.builtAt, lastCheck: state.lastCheck,
                 lastError: state.lastError, hasLibrary: !!state.bundle };
    }

    return {
        loadLocal,
        refresh,
        status,
        bundle: () => state.bundle,
        snapshotTag: () => { const s = snapshotCandidate(); return s ? s.tag : null; },
        startAutoRefresh() { if (!timer) timer = setInterval(() => { refresh(); }, REFRESH_INTERVAL_MS); },
        stopAutoRefresh() { if (timer) { clearInterval(timer); timer = null; } },
        paths: { cachePath, metaPath }
    };
}

module.exports = { createLibraryClient, writeUtf8NoBom, RELEASE_URL, REFRESH_INTERVAL_MS };
