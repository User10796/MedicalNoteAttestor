// Claude fill of library blanks: the API call (SPEC_library_claude_fill). Prompt, validation and
// assembly live in lib/mna-core.js (shared with macOS). Opt-in, user-entered key only, 20 s timeout.
// Any failure leaves every blank as-is. Logs counts and rejection reasons only, never note text or values.
const core = require('./mna-core');

const API_URL = 'https://api.anthropic.com/v1/messages';
const NOTICE = 'Claude fill unavailable — blanks left as-is.';

// fetchImpl: Electron net.fetch (app) or a mock (tests). getKey(): the stored key or ''.
function createClaudeFiller({ fetchImpl, getKey, isEnabled, model, timeoutMs = 20000, log = () => {} }) {
    // Returns null (feature off / no key / nothing to fill: behavior exactly as today, no request),
    // or { results, review } where review is { notice } on failure or { summary, flags, templates }.
    async function fill({ note, results }) {
        if (!isEnabled()) return null;
        const key = getKey();
        if (!key) return null;
        const templates = core.fillTemplatesFromResults(results);
        if (!templates.some(t => /_{3,}/.test(t.text))) return null;
        const { body } = core.fillRequest(note, templates, model);
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        let json;
        try {
            const res = await fetchImpl(API_URL, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
                body: JSON.stringify(body),
                signal: controller.signal
            });
            if (!res.ok) throw new Error('HTTP ' + res.status);
            json = await res.json();
        } catch (e) {
            log('claude fill: unavailable (' + (e.name === 'AbortError' ? 'timeout' : 'request failed') + ')');
            return { results, review: { notice: NOTICE } };
        } finally {
            clearTimeout(timer);
        }
        const applied = core.fillApply(note, templates, json);
        if (!applied.ok) {
            log('claude fill: unavailable (malformed response)');
            return { results, review: { notice: NOTICE } };
        }
        log(`claude fill: ${applied.counts.filled}/${applied.counts.blanks} filled, ${applied.counts.rejected} rejected` +
            (applied.rejectionReasons.length ? ' (' + applied.rejectionReasons.join('; ') + ')' : ''));
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

module.exports = { createClaudeFiller, API_URL, NOTICE };
