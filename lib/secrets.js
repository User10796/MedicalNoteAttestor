// Secrets in the Electron config are stored only encrypted with safeStorage (DPAPI on Windows,
// Keychain-backed on macOS). The plain value never touches disk and is never sent to a renderer.
// `store` is the app config ({ get, set }); `safeStorage` is Electron's (injected for tests).

function createSecretStore({ store, safeStorage, log = () => {} }) {
    const encKey = (name) => name + 'Enc';
    const available = () => { try { return !!safeStorage.isEncryptionAvailable(); } catch { return false; } };

    function get(name) {
        const enc = store.get(encKey(name));
        if (!enc || !available()) return '';
        try { return safeStorage.decryptString(Buffer.from(enc, 'base64')).trim(); }
        catch { log(`secrets: stored ${name} could not be decrypted`); return ''; }
    }
    function has(name) { return !!get(name); }

    // Save (or with '' remove). Never falls back to plain text.
    function set(name, value) {
        const v = String(value == null ? '' : value).trim();
        if (!v) { store.set(encKey(name), ''); return { ok: true }; }
        if (!available()) return { ok: false, error: 'Secure storage unavailable; key not saved' };
        store.set(encKey(name), safeStorage.encryptString(v).toString('base64'));
        return { ok: true };
    }

    // Move a plain-text value (older builds) into encrypted storage, then delete the plain copy.
    // If encryption isn't available the plain value is kept, so the user's key isn't lost.
    function migrate(name) {
        const plain = store.get(name);
        if (plain === undefined || plain === null) return 'none';
        const v = String(plain).trim();
        if (!v) { store.set(name, undefined); return 'removed-empty'; }
        if (!has(name)) {
            const r = set(name, v);
            if (!r.ok) { log(`secrets: ${name} left in plain text (${r.error})`); return 'kept-plain'; }
        }
        store.set(name, undefined);
        return 'migrated';
    }

    return { get, has, set, migrate, available };
}

module.exports = { createSecretStore };
