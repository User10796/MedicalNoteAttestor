import Foundation
import Security
import os.log

private let logger = Logger(subsystem: "com.user.medicalnoteattestor", category: "Library")

// Criteria-library client (macOS). Source order: fresh download -> local cache -> snapshot
// embedded in the app bundle. The only network traffic is a GET of the latest
// pain-criteria-library release (ETag'd) and, when its tag changes, its library.json asset.
// Nothing from the note is ever sent. The token lives in the Keychain and is never logged.

enum LibraryKeychain {
    static let service = "com.user.medicalnoteattestor.criteria-library"
    static let account = "github-token"

    static func read() -> String? {
        let q: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service,
                                kSecAttrAccount as String: account, kSecReturnData as String: true,
                                kSecMatchLimit as String: kSecMatchLimitOne]
        var out: CFTypeRef?
        guard SecItemCopyMatching(q as CFDictionary, &out) == errSecSuccess, let d = out as? Data else { return nil }
        let s = String(data: d, encoding: .utf8)
        return (s?.isEmpty ?? true) ? nil : s
    }
    @discardableResult
    static func save(_ token: String) -> Bool {
        delete()
        let q: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service,
                                kSecAttrAccount as String: account, kSecValueData as String: Data(token.utf8),
                                kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly]
        return SecItemAdd(q as CFDictionary, nil) == errSecSuccess
    }
    static func delete() {
        let q: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service,
                                kSecAttrAccount as String: account]
        SecItemDelete(q as CFDictionary)
    }
}

/// Drops the Authorization header when GitHub redirects the asset download to signed storage.
private final class StripAuthOnRedirect: NSObject, URLSessionTaskDelegate {
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) {
        var r = request
        if r.url?.host != "api.github.com" { r.setValue(nil, forHTTPHeaderField: "Authorization") }
        completionHandler(r)
    }
}

@MainActor
final class LibraryStore: ObservableObject {
    static let shared = LibraryStore()

    static let releaseURL = URL(string: "https://api.github.com/repos/User10796/pain-criteria-library/releases/latest")!
    static let refreshInterval: TimeInterval = 6 * 60 * 60

    @Published private(set) var source: String = "none"      // download | cache | snapshot | none
    @Published private(set) var tag: String?
    @Published private(set) var builtAt: String?
    @Published private(set) var lastCheck: Date?
    @Published private(set) var lastError: String?
    @Published private(set) var hasToken: Bool = false
    @Published var enabled: Bool { didSet { UserDefaults.standard.set(enabled, forKey: "libraryEnabled") } }
    @Published var insertion: String { didSet { UserDefaults.standard.set(insertion, forKey: "libraryInsertion") } }

    var hasLibrary: Bool { source != "none" }
    let snapshotTag: String?

    private let core = MNACore.shared
    private var timer: Timer?
    private let cacheDir: URL
    private var cacheURL: URL { cacheDir.appendingPathComponent("library.json") }
    private var metaURL: URL { cacheDir.appendingPathComponent("library-meta.json") }
    private var snapshotURL: URL? { Bundle.main.url(forResource: "library.snapshot", withExtension: "json") }

    private init() {
        let d = UserDefaults.standard
        enabled = d.object(forKey: "libraryEnabled") as? Bool ?? true
        insertion = d.string(forKey: "libraryInsertion") ?? "end"
        cacheDir = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("MedicalNoteAttestor", isDirectory: true)
        snapshotTag = Bundle.main.object(forInfoDictionaryKey: "MNALibraryTag") as? String
        hasToken = LibraryKeychain.read() != nil
    }

    // MARK: local sources

    private func readMeta() -> [String: String] {
        guard let d = try? Data(contentsOf: metaURL),
              let o = try? JSONSerialization.jsonObject(with: d) as? [String: Any] else { return [:] }
        return o.compactMapValues { $0 as? String }
    }
    private func writeNoBom(_ text: String, to url: URL) throws {
        try FileManager.default.createDirectory(at: cacheDir, withIntermediateDirectories: true)
        var s = text
        if s.hasPrefix("\u{FEFF}") { s.removeFirst() }
        try Data(s.utf8).write(to: url, options: .atomic)
    }

    /// cache -> snapshot, no network.
    @discardableResult
    func loadLocal() -> String {
        if let raw = try? String(contentsOf: cacheURL, encoding: .utf8), core.setBundle(raw: raw) {
            apply(source: "cache", tag: readMeta()["tag"])
        } else if let url = snapshotURL, let raw = try? String(contentsOf: url, encoding: .utf8), core.setBundle(raw: raw) {
            apply(source: "snapshot", tag: core.bundleInfo()?.release_tag ?? snapshotTag ?? "snapshot")
        } else if !hasLibrary {
            source = "none"; tag = nil; builtAt = nil
        }
        return source
    }
    private func apply(source: String, tag: String?) {
        self.source = source
        self.tag = tag
        self.builtAt = core.bundleInfo()?.built_at
    }

    // MARK: refresh

    func refresh(force: Bool = false) async {
        lastCheck = Date()
        guard let token = LibraryKeychain.read() else { hasToken = false; lastError = nil; loadLocal(); return }
        hasToken = true
        var meta = readMeta()
        var req = URLRequest(url: LibraryStore.releaseURL)
        req.setValue("application/vnd.github+json", forHTTPHeaderField: "Accept")
        req.setValue("2022-11-28", forHTTPHeaderField: "X-GitHub-Api-Version")
        req.setValue("Bearer " + token, forHTTPHeaderField: "Authorization")
        req.setValue("MedicalNoteAttestor-macOS", forHTTPHeaderField: "User-Agent")
        req.cachePolicy = .reloadIgnoringLocalCacheData
        if !force, let etag = meta["etag"], FileManager.default.fileExists(atPath: cacheURL.path) {
            req.setValue(etag, forHTTPHeaderField: "If-None-Match")
        }
        do {
            let (data, resp) = try await URLSession.shared.data(for: req)
            let http = resp as? HTTPURLResponse
            if http?.statusCode == 304 { lastError = nil; loadLocal(); return }
            guard http?.statusCode == 200,
                  let rel = try JSONSerialization.jsonObject(with: data) as? [String: Any],
                  let newTag = rel["tag_name"] as? String else {
                throw NSError(domain: "Library", code: http?.statusCode ?? 0,
                              userInfo: [NSLocalizedDescriptionKey: "release check HTTP \(http?.statusCode ?? 0)"])
            }
            let etag = http?.value(forHTTPHeaderField: "ETag")
            if !force, newTag == meta["tag"], FileManager.default.fileExists(atPath: cacheURL.path) {
                meta["etag"] = etag
                try? writeNoBom(String(data: try JSONSerialization.data(withJSONObject: meta), encoding: .utf8) ?? "{}", to: metaURL)
                lastError = nil; loadLocal(); return
            }
            guard let assets = rel["assets"] as? [[String: Any]],
                  let asset = assets.first(where: { $0["name"] as? String == "library.json" }),
                  let assetURLString = asset["url"] as? String, let assetURL = URL(string: assetURLString) else {
                throw NSError(domain: "Library", code: 0, userInfo: [NSLocalizedDescriptionKey: "release \(newTag) has no library.json"])
            }
            var areq = URLRequest(url: assetURL)
            areq.setValue("application/octet-stream", forHTTPHeaderField: "Accept")
            areq.setValue("Bearer " + token, forHTTPHeaderField: "Authorization")
            areq.setValue("MedicalNoteAttestor-macOS", forHTTPHeaderField: "User-Agent")
            let (adata, aresp) = try await URLSession.shared.data(for: areq, delegate: StripAuthOnRedirect())
            guard (aresp as? HTTPURLResponse)?.statusCode == 200, let raw = String(data: adata, encoding: .utf8) else {
                throw NSError(domain: "Library", code: 0, userInfo: [NSLocalizedDescriptionKey: "asset download failed"])
            }
            guard core.setBundle(raw: raw) else {
                throw NSError(domain: "Library", code: 0, userInfo: [NSLocalizedDescriptionKey: "downloaded library.json failed validation"])
            }
            try writeNoBom(raw, to: cacheURL)
            let newMeta = ["tag": newTag, "etag": etag ?? "", "built_at": core.bundleInfo()?.built_at ?? ""]
            try writeNoBom(String(data: try JSONSerialization.data(withJSONObject: newMeta), encoding: .utf8) ?? "{}", to: metaURL)
            apply(source: "download", tag: newTag)
            lastError = nil
            logger.info("library: downloaded release \(newTag, privacy: .public)")
        } catch {
            lastError = error.localizedDescription
            logger.warning("library: refresh failed; using local copy")
            loadLocal()
        }
    }

    func start() {
        loadLocal()
        Task { await refresh() }
        timer?.invalidate()
        timer = Timer.scheduledTimer(withTimeInterval: LibraryStore.refreshInterval, repeats: true) { _ in
            Task { @MainActor in await LibraryStore.shared.refresh() }
        }
    }

    // MARK: token (write-only from the UI)

    func setToken(_ token: String) async {
        let t = token.trimmingCharacters(in: .whitespacesAndNewlines)
        if t.isEmpty { LibraryKeychain.delete(); hasToken = false; loadLocal(); return }
        hasToken = LibraryKeychain.save(t)
        await refresh(force: true)
    }

    // MARK: payer recents

    var recents: [String] {
        get { UserDefaults.standard.stringArray(forKey: "payerRecents") ?? [] }
        set { UserDefaults.standard.set(newValue, forKey: "payerRecents") }
    }
}
