import Foundation
import Security

// Secrets live in the macOS Keychain, never in UserDefaults or source.
/// A lookup that says why there is no value (so Claude features can tell the user, never fail silently).
enum SecretLookup: Equatable {
    case found(String)
    case missing
    case unreadable(Int32)   // OSStatus from the Keychain (e.g. access denied); never the value
}

protocol SecretStore: AnyObject {
    func lookup(_ account: String) -> SecretLookup
    @discardableResult func save(_ value: String, account: String) -> Bool
    func delete(_ account: String)
}

extension SecretStore {
    func read(_ account: String) -> String? {
        if case .found(let s) = lookup(account) { return s }
        return nil
    }
}

final class KeychainSecretStore: SecretStore {
    let service: String
    init(service: String) { self.service = service }

    private func query(_ account: String) -> [String: Any] {
        [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service, kSecAttrAccount as String: account]
    }
    func lookup(_ account: String) -> SecretLookup {
        var q = query(account)
        q[kSecReturnData as String] = true
        q[kSecMatchLimit as String] = kSecMatchLimitOne
        var out: CFTypeRef?
        let status = SecItemCopyMatching(q as CFDictionary, &out)
        if status == errSecItemNotFound { return .missing }
        guard status == errSecSuccess, let d = out as? Data, let s = String(data: d, encoding: .utf8) else { return .unreadable(status) }
        return s.isEmpty ? .missing : .found(s)
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
    var unreadableStatus: Int32? = nil   // simulate a Keychain read error
    func lookup(_ account: String) -> SecretLookup {
        if let st = unreadableStatus { return .unreadable(st) }
        guard let v = values[account], !v.isEmpty else { return .missing }
        return .found(v)
    }
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
        if case .found(let k) = lookup(in: store) { return k }
        return nil
    }

    /// The key, or why there isn't one: .missing (none saved) or .unreadable (Keychain error).
    static func lookup(in store: SecretStore = ClaudeKey.store) -> SecretLookup {
        switch store.lookup(account) {
        case .found(let raw):
            let k = raw.trimmingCharacters(in: .whitespacesAndNewlines)
            return k.isEmpty ? .missing : .found(k)
        case let other: return other
        }
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
