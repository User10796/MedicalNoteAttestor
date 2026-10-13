// Hold the slots until processing is done (2026-10-12). After a capture whose A&P shows a planned
// procedure, nothing is pasteable until the picker (and the Claude fill, if on) has finished; then
// HPI, exam and A&P are published together with library text and fills already in. Captures without a
// planned procedure are published at once.
//
// Windows: Electron writes mna-hold.txt ("MNA-HOLD1 <captureTs> hold|ready", UTF-8, no BOM). AHK pastes
// a capture only after it has seen "ready" for that capture (falling back to publishing after a few
// seconds only if Electron never answers). The main window's own paste buttons use isHolding().
const { STILL_PROCESSING } = require('./mna-core');

function encodeHold(captureTs, state) { return `MNA-HOLD1 ${captureTs} ${state}`; }

function decodeHold(raw) {
    const m = /^MNA-HOLD1 (\S+) (hold|ready)\s*$/.exec(String(raw || '').replace(/^\uFEFF/, ''));
    return m ? { captureTs: m[1], state: m[2] } : null;
}

// write(text): persist for AHK (Windows). onChange(holding): main-window indicator.
function createProcessingHold({ write = () => {}, onChange = () => {} } = {}) {
    let current = null;     // the latest capture
    let holding = false;
    function set(ts, state) {
        if (ts == null || String(ts) !== current) return false;   // an older capture can never change the newest
        holding = state === 'hold';
        try { write(encodeHold(current, state)); } catch (e) { /* AHK falls back; logged by caller */ }
        onChange(holding);
        return true;
    }
    return {
        // A new capture: nothing is pasteable until hold()/ready() decides (Electron decides at once).
        capture(ts) { current = ts == null ? null : String(ts); holding = true; onChange(true); },
        hold: (ts) => set(ts, 'hold'),
        ready: (ts) => set(ts, 'ready'),
        clear() { current = null; holding = false; onChange(false); },
        isHolding: () => holding && current !== null,
        current: () => current
    };
}

module.exports = { createProcessingHold, encodeHold, decodeHold, STILL_PROCESSING };
