// Scribe source profiles: sources differ by data, not by branching code (Freed spec §1).
// Heidi's action items default to off (they send the A&P to Claude); Settings > AI Note turns them on.
const PROFILES = {
    // actionItems is the default; Heidi's is off (2026-10-12, matching the Mac): Settings turns it on.
    heidi: { id: 'heidi', captureKey: 'F8', captureMethod: 'selectAllCopy', parser: 'heidi', actionItems: false },
    freed: { id: 'freed', captureKey: 'F7', captureMethod: 'clipboardRead', parser: 'freed', actionItems: false }
};

function get(id) {
    const p = PROFILES[id];
    if (!p) throw new Error('unknown source profile: ' + id);
    return { ...p };
}

module.exports = { get, ids: () => Object.keys(PROFILES) };
