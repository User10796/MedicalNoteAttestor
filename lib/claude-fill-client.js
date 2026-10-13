// Claude fill of library blanks: the API call (SPEC_library_claude_fill). Prompt, validation and
// assembly live in lib/mna-core.js (shared with macOS). Opt-in, user-entered key only. Streaming
// request so progress shows values as they arrive; gives up after 30 s with no bytes or 120 s in all.
// Any failure leaves every blank as-is and shows a visible notice saying why (with the API's own error
// type and message, which never contain patient data). Logs counts and reasons only, never note text,
// values or the key.
const core = require('./mna-core');

const API_URL = 'https://api.anthropic.com/v1/messages';
const NOTICE = 'Claude fill unavailable — blanks left as-is.';
const STARTED = 'Claude is filling library blanks…';

// getKey() returns the stored key string ('' = none) or { state: 'found'|'missing'|'unreadable', value }.
function keyState(k) {
    if (k && typeof k === 'object') return { state: k.state, value: k.value || '' };
    return k ? { state: 'found', value: String(k) } : { state: 'missing', value: '' };
}

// fetchImpl: Electron net.fetch (app) or a mock (tests).
// notify(text, kind): a visible, non-blocking notice ('info' | 'error'); never silent once the setting is on.
// onProgress({ stage, text, n, total, startedAt, elapsed }): stages sending -> filling (n of N) -> checking
//   -> done | error | cancelled, for the progress window.
// getWorkspaceId(): optional Anthropic workspace ID (sent as anthropic-workspace-id; not a secret).
function createClaudeFiller({ fetchImpl, getKey, isEnabled, model, getWorkspaceId = () => '', timeoutMs = core.FILL_TIMEOUT_MS,
                              idleMs = core.FILL_IDLE_TIMEOUT_MS, log = () => {}, notify = () => {},
                              onProgress = () => {}, now = Date.now }) {
    let current = null;   // { controller, cancelled } of the request in flight

    // Returns null only when the setting is off (behavior exactly as before, no request).
    // Otherwise { results, review, cancelled? }: review is { notice } when the fill can't run, fails or
    // is cancelled (results unchanged: library text unfilled), or { summary, flags, templates } when it ran.
    async function fill({ note, results }) {
        if (!isEnabled()) return null;
        const startedAt = now();
        let total = 0;
        const progress = (stage, n, text) => {
            try { onProgress({ stage, text, n: n || 0, total, startedAt, elapsed: Math.round((now() - startedAt) / 1000) }); }
            catch (e) { /* UI only */ }
        };
        const failed = (reason, detail, apiError) => {
            const text = core.fillNotice(reason, detail, apiError);
            log('claude fill: ' + (reason === 'cancelled' ? 'cancelled' : 'unavailable (' + reason + (detail ? ' ' + detail : '') +
                (apiError && apiError.type ? ' ' + apiError.type : '') + ')'));
            notify(text, reason === 'cancelled' ? 'info' : 'error');
            progress(reason === 'cancelled' ? 'cancelled' : 'error', 0, text);
            return { results, review: { notice: text }, cancelled: reason === 'cancelled' };
        };
        const key = keyState(getKey());
        if (key.state === 'unreadable') return failed('key-unreadable');
        if (key.state !== 'found' || !key.value) return failed('no-key');
        const templates = core.fillTemplatesFromResults(results);
        if (!templates.some(t => /_{3,}/.test(t.text))) {
            log('claude fill: no blanks');
            return { results, review: { summary: core.fillNotice('no-blanks') } };
        }
        let body, plan;
        try { ({ body, plan } = core.fillRequest(note, templates, model, { stream: true })); } catch (e) { return failed('request'); }
        total = plan.blanks.length;
        notify(STARTED, 'info');
        progress('sending', 0, core.fillProgress('sending'));

        const controller = new AbortController();
        const job = { controller, cancelled: false, timedOut: false };
        current = job;
        let idle = null;
        const armIdle = () => { clearTimeout(idle); idle = setTimeout(() => { job.timedOut = true; controller.abort(); }, idleMs); };
        const overall = setTimeout(() => { job.timedOut = true; controller.abort(); }, timeoutMs);
        armIdle();
        let message;
        try {
            let res;
            try {
                res = await fetchImpl(API_URL, {
                    method: 'POST',
                    headers: { ...core.claudeHeaders(getWorkspaceId()), 'x-api-key': key.value },
                    body: JSON.stringify(body),
                    signal: controller.signal
                });
            } catch (e) {
                return job.cancelled ? failed('cancelled') : failed(job.timedOut || (e && e.name === 'AbortError') ? 'timeout' : 'network');
            }
            if (!res.ok) {
                let text = '';
                try { text = await res.text(); } catch (e) { /* no body */ }
                return failed('http', res.status, core.fillApiError(text));
            }
            const type = String((res.headers && res.headers.get && res.headers.get('content-type')) || '');
            if (res.body && res.body.getReader && !/application\/json/.test(type)) {
                // Streaming (SSE): count values as they arrive.
                const st = core.fillStreamStart();
                const reader = res.body.getReader();
                const decoder = new TextDecoder();
                let lastN = -1;
                try {
                    for (;;) {
                        const { value, done } = await reader.read();
                        if (done) break;
                        armIdle();
                        core.fillStreamFeed(st, decoder.decode(value, { stream: true }));
                        if (st.n !== lastN) { lastN = st.n; progress('filling', st.n, core.fillProgress('filling', st.n, total)); }
                        if (st.done) break;
                    }
                } catch (e) {
                    return job.cancelled ? failed('cancelled') : failed(job.timedOut || (e && e.name === 'AbortError') ? 'timeout' : 'network');
                }
                if (job.cancelled) return failed('cancelled');
                if (st.error) return failed('stream-error', null, st.error);
                message = core.fillStreamMessage(st);
                if (!message) return failed(job.timedOut ? 'timeout' : 'malformed');
            } else {
                try { message = await res.json(); }
                catch (e) { return job.cancelled ? failed('cancelled') : failed(job.timedOut ? 'timeout' : 'malformed'); }
            }
        } finally {
            clearTimeout(idle);
            clearTimeout(overall);
            if (current === job) current = null;
        }
        progress('checking', total, core.fillProgress('checking'));
        const applied = core.fillApply(note, templates, message);
        if (!applied.ok) return failed('malformed');
        log(`claude fill: ${applied.counts.filled}/${applied.counts.blanks} filled, ${applied.counts.rejected} rejected` +
            (applied.rejectionReasons.length ? ' (' + applied.rejectionReasons.join('; ') + ')' : ''));
        notify(applied.summary, 'info');
        progress('done', applied.counts.filled, core.fillProgress('done', applied.counts.filled, applied.counts.blanks));
        return {
            results: core.applyFilledTexts(results, templates, applied.texts),
            review: {
                summary: applied.summary, flags: applied.flags,
                templates: templates.map((t, i) => ({ slot: t.slot, text: applied.texts[i], marks: applied.marks[i] }))
            }
        };
    }

    // Cancel button: stop the request; the slots are published with the library text unfilled.
    function cancel() {
        if (!current) return false;
        current.cancelled = true;
        current.controller.abort();
        return true;
    }

    return { fill, cancel, busy: () => !!current, NOTICE };
}

module.exports = { createClaudeFiller, API_URL, NOTICE, STARTED };
