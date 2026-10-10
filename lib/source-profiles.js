// Scribe source profiles: sources differ by data, not by branching code (Freed spec §1).
// Heidi's profile describes today's behavior and must not change.
const PROFILES = {
    heidi: { id: 'heidi', captureKey: 'F8', captureMethod: 'selectAllCopy', parser: 'heidi', actionItems: true },
    freed: { id: 'freed', captureKey: 'F7', captureMethod: 'clipboardRead', parser: 'freed', actionItems: false }
};

function get(id) {
    const p = PROFILES[id];
    if (!p) throw new Error('unknown source profile: ' + id);
    return { ...p };
}

module.exports = { get, ids: () => Object.keys(PROFILES) };
