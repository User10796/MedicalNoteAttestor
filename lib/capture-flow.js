// Capture -> payer picker -> detection -> composition, independent of the scribe source.
//
// A capture is { source, captureTs, ap, exam } where `exam` is the scribe-side exam text for
// F10 (for Heidi this is today's exam dot-phrase slot; a future second source supplies its own).
// The flow never touches the network. Composed outputs are written for AutoHotkey to paste as
// two small files in the runtime dir; each starts with a header naming the capture it belongs
// to, so AHK only pastes library text for the capture it currently holds (never a stale patient).
const fs = require('fs');
const path = require('path');
const core = require('./mna-core');
const { writeUtf8NoBom } = require('./library-client');

const EXAM_FILE = 'mna-exam.txt';
const AP_FILE = 'mna-ap.txt';
const HEADER = 'MNA1 ';

// CRLF for the Windows clipboard; header line + body. UTF-8, no BOM.
function encodeComposed(captureTs, text) {
    return HEADER + String(captureTs) + '\r\n' + String(text).replace(/\r?\n/g, '\r\n');
}
function decodeComposed(raw) {
    const s = String(raw || '').replace(/^﻿/, '');
    const nl = s.indexOf('\r\n');
    if (!s.startsWith(HEADER) || nl === -1) return null;
    return { captureTs: s.slice(HEADER.length, nl), text: s.slice(nl + 2) };
}

function createComposedStore(dir) {
    const files = { exam: path.join(dir, EXAM_FILE), ap: path.join(dir, AP_FILE) };
    return {
        files,
        clear() { for (const f of Object.values(files)) { try { fs.unlinkSync(f); } catch { /* absent */ } } },
        write(captureTs, { exam, ap }) {
            this.clear();
            if (exam) writeUtf8NoBom(files.exam, encodeComposed(captureTs, exam));
            if (ap) writeUtf8NoBom(files.ap, encodeComposed(captureTs, ap));
        },
        read(which) {
            try { return decodeComposed(fs.readFileSync(files[which], 'utf8')); } catch { return null; }
        }
    };
}

// deps:
//   getBundle()            -> library bundle or null
//   isEnabled()            -> library insertion toggle
//   getRecents()/setRecents(list)
//   getInsertion()         -> 'end' | 'after_plan_line'
//   ui(request)            -> Promise<{ payerId, items } | null>   (null = Skip)
//   store                  -> createComposedStore(...)
//   onComposed(result)     -> optional, for the main window preview
function createCaptureFlow(deps) {
    let sessionLastPayer = null; // shown as a hint; never pre-selected (wrong-payer risk)
    let current = null;          // in-flight capture
    let last = null;             // last composed result { captureTs, exam, ap }

    async function onCapture(capture) {
        current = capture;
        deps.store.clear();                 // new capture: previous patient's library text is gone
        last = null;
        const bundle = deps.getBundle();
        if (!deps.isEnabled() || !bundle || !capture.ap) return { skipped: true, reason: !bundle ? 'no-library' : !capture.ap ? 'no-ap' : 'disabled' };
        const detection = core.detectProcedures(capture.ap, bundle);
        const answer = await deps.ui({
            source: capture.source,
            captureTs: capture.captureTs,
            bundle,
            detection,
            recents: deps.getRecents(),
            sessionLastPayer
        });
        if (current !== capture) return { skipped: true, reason: 'superseded' }; // newer capture arrived
        if (!answer || !answer.payerId) return { skipped: true, reason: 'skip' };
        sessionLastPayer = answer.payerId;
        deps.setRecents(core.recordRecentPayer(deps.getRecents(), answer.payerId));
        const out = core.composeOutputs(bundle, answer.payerId, answer.items || [], capture.exam || '', capture.ap,
            { insertion: deps.getInsertion() });
        deps.store.write(capture.captureTs, out);
        last = { captureTs: capture.captureTs, exam: out.exam, ap: out.ap };
        if (deps.onComposed) deps.onComposed(last, out);
        return { skipped: false, payerId: answer.payerId, ...out };
    }

    return {
        onCapture,
        composed: () => last,
        reset() { current = null; last = null; deps.store.clear(); }
    };
}

module.exports = { createCaptureFlow, createComposedStore, encodeComposed, decodeComposed, EXAM_FILE, AP_FILE };
