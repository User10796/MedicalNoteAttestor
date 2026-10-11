import Foundation
import Security

// Secrets live in the macOS Keychain, never in UserDefaults or source.
protocol SecretStore: AnyObject {
    func read(_ account: String) -> String?
    @discardableResult func save(_ value: String, account: String) -> Bool
    func delete(_ account: String)
}

final class KeychainSecretStore: SecretStore {
    let service: String
    init(service: String) { self.service = service }

    private func query(_ account: String) -> [String: Any] {
        [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service, kSecAttrAccount as String: account]
    }
    func read(_ account: String) -> String? {
        var q = query(account)
        q[kSecReturnData as String] = true
        q[kSecMatchLimit as String] = kSecMatchLimitOne
        var out: CFTypeRef?
        guard SecItemCopyMatching(q as CFDictionary, &out) == errSecSuccess, let d = out as? Data,
              let s = String(data: d, encoding: .utf8), !s.isEmpty else { return nil }
        return s
    }
    @discardableResult
    func save(_ value: String, account: String) -> Bool {
        delete(account)
        var q = query(account)
        q[kSecValueData as String] = Data(value.utf8)
        q[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        return SecItemAdd(q as CFDictionary, nil) == errSecSuccess
    }
    func delete(_ account: String) { SecItemDelete(query(account) as CFDictionary) }
}

/// In-memory store (tests).
final class MemorySecretStore: SecretStore {
    var values: [String: String] = [:]
    var failSaves = false
    func read(_ account: String) -> String? { values[account] }
    @discardableResult func save(_ value: String, account: String) -> Bool {
        if failSaves { return false }
        values[account] = value; return true
    }
    func delete(_ account: String) { values[account] = nil }
}

/// The user's Claude API key. There is no built-in key and no fallback: without a key the user
/// entered, Claude features (Attestor "Select", Heidi action items) are unavailable.
enum ClaudeKey {
    static let account = "claude-api-key"
    static var store: SecretStore = KeychainSecretStore(service: "com.user.medicalnoteattestor.claude")
    /// UserDefaults keys that older builds used for the key in plain text.
    static let legacyDefaultsKeys = ["claudeAPIKey", "AnthropicAPIKey"]

    static func current(in store: SecretStore = ClaudeKey.store) -> String? {
        let k = store.read(account)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return k.isEmpty ? nil : k
    }

    static func set(_ value: String, in store: SecretStore = ClaudeKey.store) -> Bool {
        let v = value.trimmingCharacters(in: .whitespacesAndNewlines)
        if v.isEmpty { store.delete(account); return true }
        return store.save(v, account: account)
    }

    /// Move a plain-text key from UserDefaults into the store, then delete the plain copies.
    /// A plain value is deleted only once the store holds a key (never lose the user's key).
    @discardableResult
    static func migrate(defaults: UserDefaults, store: SecretStore = ClaudeKey.store) -> Bool {
        var migrated = false
        for k in legacyDefaultsKeys {
            guard let raw = defaults.object(forKey: k) else { continue }
            let v = (raw as? String ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
            if !v.isEmpty && current(in: store) == nil {
                guard store.save(v, account: account) else { continue }   // keep the plain copy; retry next launch
                migrated = true
            }
            defaults.removeObject(forKey: k)
        }
        return migrated
    }
}
