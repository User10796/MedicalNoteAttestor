// Claude fill of library blanks: the API call (SPEC_library_claude_fill). Prompt, validation and
// assembly live in lib/mna-core.js (shared with macOS). Opt-in, user-entered key only, 60 s timeout.
// Any failure leaves every blank as-is and shows a visible notice saying why. Logs counts and rejection
// reasons only, never note text or values.
const core = require('./mna-core');

const API_URL = 'https://api.anthropic.com/v1/messages';
const NOTICE = 'Claude fill unavailable — blanks left as-is.';
const STARTED = 'Claude is filling library blanks…';

// getKey() returns the stored key string ('' = none) or { state: 'found'|'missing'|'unreadable', value }.
function keyState(k) {
    if (k && typeof k === 'object') return { state: k.state, value: k.value || '' };
    return k ? { state: 'found', value: String(k) } : { state: 'missing', value: '' };
}

// fetchImpl: Electron net.fetch (app) or a mock (tests). notify(text, kind): a visible, non-blocking
// notice ('info' | 'error'); the fill never fails silently once the setting is on.
function createClaudeFiller({ fetchImpl, getKey, isEnabled, model, timeoutMs = core.FILL_TIMEOUT_MS, log = () => {}, notify = () => {} }) {
    // Returns null only when the setting is off (behavior exactly as before, no request).
    // Otherwise { results, review }: review is { notice } when the fill can't run or fails, or
    // { summary, flags, templates } when it ran.
    async function fill({ note, results }) {
        if (!isEnabled()) return null;
        const failed = (reason, detail) => {
            const text = core.fillNotice(reason, detail);
            log('claude fill: unavailable (' + reason + (detail ? ' ' + detail : '') + ')');
            notify(text, 'error');
            return { results, review: { notice: text } };
        };
        const key = keyState(getKey());
        if (key.state === 'unreadable') return failed('key-unreadable');
        if (key.state !== 'found' || !key.value) return failed('no-key');
        const templates = core.fillTemplatesFromResults(results);
        if (!templates.some(t => /_{3,}/.test(t.text))) {
            log('claude fill: no blanks');
            return { results, review: { summary: core.fillNotice('no-blanks') } };
        }
        let body;
        try { body = core.fillRequest(note, templates, model).body; } catch (e) { return failed('request'); }
        notify(STARTED, 'info');
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        let json;
        try {
            let res;
            try {
                res = await fetchImpl(API_URL, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', 'x-api-key': key.value, 'anthropic-version': '2023-06-01' },
                    body: JSON.stringify(body),
                    signal: controller.signal
                });
            } catch (e) {
                return failed(e && e.name === 'AbortError' ? 'timeout' : 'network');
            }
            if (!res.ok) return failed('http', res.status);
            try { json = await res.json(); }
            catch (e) { return failed(e && e.name === 'AbortError' ? 'timeout' : 'malformed'); }
        } finally {
            clearTimeout(timer);
        }
        const applied = core.fillApply(note, templates, json);
        if (!applied.ok) return failed('malformed');
        log(`claude fill: ${applied.counts.filled}/${applied.counts.blanks} filled, ${applied.counts.rejected} rejected` +
            (applied.rejectionReasons.length ? ' (' + applied.rejectionReasons.join('; ') + ')' : ''));
        notify(applied.summary, 'info');
        return {
            results: core.applyFilledTexts(results, templates, applied.texts),
            review: {
                summary: applied.summary, flags: applied.flags,
                templates: templates.map((t, i) => ({ slot: t.slot, text: applied.texts[i], marks: applied.marks[i] }))
            }
        };
    }
    return { fill, NOTICE };
}

module.exports = { createClaudeFiller, API_URL, NOTICE, STARTED };
