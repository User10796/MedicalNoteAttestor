// Mtime polling for files written by AutoHotkey (heidi-slots.json, and later hotkeys.json).
// fs.watch does not fire on the workstation's UNC/network paths, so we stat the file every
// 250 ms and call onChange when its mtime or size changes. A change is only "consumed" when
// onChange returns true; a half-written file (parse failure) is retried on the next tick.
const fsp = require('fs').promises;

const POLL_INTERVAL_MS = 250;

function createMtimePoller(filePath, onChange, { intervalMs = POLL_INTERVAL_MS, stat = fsp.stat } = {}) {
    let lastSig = null;
    let inFlight = false;
    let timer = null;

    async function tick() {
        if (inFlight) return;
        inFlight = true;
        try {
            let st;
            try { st = await stat(filePath); } catch { return; } // missing file: nothing to do yet
            const sig = `${st.mtimeMs}:${st.size}`;
            if (sig === lastSig) return;
            let ok = false;
            try { ok = (await onChange()) !== false; } catch (e) { console.error('poller onChange failed:', e.message); }
            if (ok) lastSig = sig;
        } finally {
            inFlight = false;
        }
    }

    return {
        start() { if (!timer) { timer = setInterval(tick, intervalMs); tick(); } return this; },
        stop() { if (timer) { clearInterval(timer); timer = null; } },
        tick
    };
}

// Slot file reader. AHK writes UTF-8-RAW, but strip a BOM anyway (safety net for older AHK builds
// or hand edits) so JSON.parse never chokes on U+FEFF.
function parseSlotsJson(raw) {
    return JSON.parse(String(raw).replace(/^﻿/, ''));
}

module.exports = { createMtimePoller, parseSlotsJson, POLL_INTERVAL_MS };
