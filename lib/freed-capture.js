// Freed F7 capture pipeline (SPEC_freed_source_standalone §2, §5–§7, §9):
// read clipboard (done by AHK, no synthetic keystrokes) -> normalize -> duplicate guard ->
// shape validation -> parse -> replace all three slots atomically.
// The duplicate-guard hash is kept in memory only. Notices never contain clipboard text.
const crypto = require('crypto');
const { normalize, parseFreed } = require('./freed-parser');
const profiles = require('./source-profiles');

const NOTICE_INVALID = "Clipboard doesn't look like a Freed note. Click Copy all in Freed, then F7.";
const NOTICE_DUPLICATE = 'Already captured';

// deps: writeResult({kind,...}) persists the result for AHK (throws on failure),
//       notify(message) shows a short visible notice,
//       extractActionItems(ap) is only ever called if the profile allows it (Freed: never).
function createFreedCapture({ writeResult, notify = () => {}, extractActionItems = null, profile = profiles.get('freed') }) {
    let lastHash = null;
    let slots = { hpi: '', exam: '', ap: '' };
    let parses = 0;

    function process({ captureTs, raw }) {
        const ts = String(captureTs);
        const text = normalize(raw);
        const hash = crypto.createHash('sha256').update(text, 'utf8').digest('hex');
        if (lastHash !== null && hash === lastHash) {
            notify(NOTICE_DUPLICATE);
            writeResult({ kind: 'notice', captureTs: ts, message: NOTICE_DUPLICATE });
            return { status: 'duplicate' };
        }
        const parsed = parseFreed(text);
        if (!parsed.valid) {
            notify(NOTICE_INVALID);
            writeResult({ kind: 'notice', captureTs: ts, message: NOTICE_INVALID });
            return { status: 'invalid' };
        }
        parses++;
        const next = { hpi: parsed.slots.hpi, exam: parsed.slots.exam, ap: parsed.slots.ap };
        writeResult({ kind: 'ok', captureTs: ts, ...next });   // all three at once, empty slots explicit
        slots = next;
        lastHash = hash;                                        // only after slots are written
        if (profile.actionItems && extractActionItems) extractActionItems(next.ap);
        return { status: 'ok', slots: { ...next } };
    }

    return {
        process,
        slots: () => ({ ...slots }),
        stats: () => ({ parses }),
        // Another capture (Heidi F8) or Clear replaced the slots: the same Freed note must re-adopt.
        resetDuplicateGuard() { lastHash = null; }
    };
}

// ── Result file read by AHK: mna-freed-result.txt (UTF-8, no BOM, CRLF) ──────────────────────
// Line 1: "MNA-FREED1 <captureTs> ok|notice". ok: three sections; notice: the message.
const SEC = ['<<MNA:HPI>>', '<<MNA:EXAM>>', '<<MNA:AP>>'];
const crlf = (s) => String(s || '').replace(/\r?\n/g, '\r\n');

function encodeFreedResult(r) {
    if (r.kind === 'notice') return `MNA-FREED1 ${r.captureTs} notice\r\n${crlf(r.message)}`;
    return `MNA-FREED1 ${r.captureTs} ok\r\n${SEC[0]}\r\n${crlf(r.hpi)}\r\n${SEC[1]}\r\n${crlf(r.exam)}\r\n${SEC[2]}\r\n${crlf(r.ap)}`;
}

function decodeFreedResult(raw) {
    const s = String(raw || '').replace(/^﻿/, '');
    const m = /^MNA-FREED1 (\S+) (ok|notice)\r\n/.exec(s);
    if (!m) return null;
    const body = s.slice(m[0].length);
    const lf = (x) => x.replace(/\r\n/g, '\n');
    if (m[2] === 'notice') return { kind: 'notice', captureTs: m[1], message: lf(body) };
    const i0 = body.indexOf(SEC[0] + '\r\n'), i1 = body.indexOf('\r\n' + SEC[1] + '\r\n'), i2 = body.indexOf('\r\n' + SEC[2] + '\r\n');
    if (i0 !== 0 || i1 < 0 || i2 < i1) return null;
    return {
        kind: 'ok', captureTs: m[1],
        hpi: lf(body.slice(SEC[0].length + 2, i1)),
        exam: lf(body.slice(i1 + SEC[1].length + 4, i2)),
        ap: lf(body.slice(i2 + SEC[2].length + 4))
    };
}

module.exports = { createFreedCapture, encodeFreedResult, decodeFreedResult, NOTICE_INVALID, NOTICE_DUPLICATE };
