import Foundation
import JavaScriptCore

// Runs lib/mna-core.js — the same file the Windows (Electron) app uses — in JavaScriptCore,
// so procedure detection, resolution, composition, payer search and hotkey validation are
// identical on both platforms and share one test suite. Values cross the bridge as JSON.
// Everything here is local; JavaScriptCore has no network access from this context.

struct DetectedRow: Codable, Identifiable, Equatable {
    var uid = UUID()
    var procedure_id: String?
    var laterality: String
    var checked: Bool
    var variant: String?
    var line: Int?
    var planned: Bool

    enum CodingKeys: String, CodingKey { case procedure_id, laterality, checked, variant, line, planned }
    var id: UUID { uid }

    init(procedure_id: String?, laterality: String, checked: Bool, variant: String? = nil, line: Int? = nil, planned: Bool = true) {
        self.procedure_id = procedure_id
        self.laterality = laterality
        self.checked = checked
        self.variant = variant
        self.line = line
        self.planned = planned
    }
}

struct Detection: Codable {
    var items: [DetectedRow]
    var noneDetected: Bool
}

struct Resolution: Codable {
    var procedure_id: String
    var insert: Bool
    var examText: String
    var dotphrase: String
    var marker: String?
    var notice: String?
}

struct PayerHit: Codable, Identifiable, Equatable {
    var payer_id: String
    var name: String
    var pinned: Bool
    var id: String { payer_id }
}

struct RegistryProcedure: Codable, Identifiable {
    var procedure_id: String
    var name: String
    var laterality_options: [String]
    var variants: [String]?
    var id: String { procedure_id }
}

struct HotkeyValidation: Codable {
    struct Message: Codable { var action: String; var message: String }
    var ok: Bool
    var bindings: [String: String]
    var errors: [Message]
    var warnings: [Message]
}

final class MNACore {
    static let shared = MNACore(scriptURL: Bundle.main.url(forResource: "mna-core", withExtension: "js"))

    private let context: JSContext
    private(set) var loadError: String?
    private var lastException: String?

    init(scriptURL: URL?) {
        context = JSContext()!
        context.exceptionHandler = { [weak self] _, exc in self?.lastException = exc?.toString() }
        guard let url = scriptURL, let src = try? String(contentsOf: url, encoding: .utf8) else {
            loadError = "mna-core.js not found in the app bundle"
            return
        }
        // No `module` in JavaScriptCore, so the file defines globalThis.MNACore.
        context.evaluateScript(src, withSourceURL: url)
        context.evaluateScript("""
            var __bundle = null;
            var __S = {
              setBundle: function (raw) { var b = MNACore.parseBundle(raw); if (b) __bundle = b; return !!b; },
              info: function () { return __bundle ? { built_at: __bundle.built_at, release_tag: __bundle.release_tag || null,
                                                      commit: __bundle.commit || null } : null; },
              detect: function (ap) { return MNACore.detectProcedures(ap, __bundle); },
              freedPlanned: function (ap) { return MNACore.freedProcedurePlanned(ap, __bundle); },
              linePlanned: function (line) { return MNACore.procedureLineIsPlanned(line, __bundle); },
              resolve: function (payer, items) { return MNACore.resolveSelections(__bundle, payer, items); },
              search: function (q, recents) { return MNACore.searchPayers(__bundle, q, recents); },
              procedures: function () { return ((__bundle && __bundle.registries && __bundle.registries.procedures) || [])
                  .map(function (p) { return { procedure_id: p.procedure_id, name: p.name,
                                               laterality_options: p.laterality_options, variants: p.variants || [] }; }); }
            };
            """)
        if context.objectForKeyedSubscript("MNACore").isUndefined { loadError = lastException ?? "MNACore failed to load" }
    }

    var isLoaded: Bool { loadError == nil }

    // Call `fn` (a JS expression naming a function) with JSON-encodable args; returns the JSON result.
    private func callJSON(_ fn: String, _ args: [Any]) -> Data? {
        guard isLoaded,
              let argData = try? JSONSerialization.data(withJSONObject: args, options: [.fragmentsAllowed]),
              let argJSON = String(data: argData, encoding: .utf8) else { return nil }
        context.setObject(argJSON, forKeyedSubscript: "__args" as NSString)
        lastException = nil
        let r = context.evaluateScript("JSON.stringify(\(fn).apply(null, JSON.parse(__args)))")
        if lastException != nil { return nil }
        guard let s = r?.toString(), s != "undefined" else { return nil }
        return s.data(using: .utf8)
    }
    private func call<T: Decodable>(_ fn: String, _ args: [Any], as: T.Type) -> T? {
        guard let d = callJSON(fn, args) else { return nil }
        return try? JSONDecoder().decode(T.self, from: d)
    }
    private func encodeRows(_ rows: [DetectedRow]) -> [Any] {
        guard let d = try? JSONEncoder().encode(rows),
              let o = try? JSONSerialization.jsonObject(with: d) as? [Any] else { return [] }
        return o
    }

    // MARK: library bundle

    /// Validates and installs a bundle. Returns false (and keeps the previous bundle) if invalid.
    @discardableResult
    func setBundle(raw: String) -> Bool { call("__S.setBundle", [raw], as: Bool.self) ?? false }

    struct BundleInfo: Codable { var built_at: String; var release_tag: String?; var commit: String? }
    func bundleInfo() -> BundleInfo? { call("__S.info", [], as: BundleInfo?.self) ?? nil }

    // MARK: detection / resolution / composition

    /// Freed: does the A&P show a planned procedure? (rule-based, local; same rule as Windows)
    func freedProcedurePlanned(ap: String) -> Bool { call("__S.freedPlanned", [ap], as: Bool.self) ?? false }
    func procedureLineIsPlanned(_ line: String) -> Bool { call("__S.linePlanned", [line], as: Bool.self) ?? false }

    func detect(ap: String) -> Detection { call("__S.detect", [ap], as: Detection.self) ?? Detection(items: [], noneDetected: true) }
    func resolve(payerId: String, rows: [DetectedRow]) -> [Resolution] {
        call("__S.resolve", [payerId, encodeRows(rows)], as: [Resolution].self) ?? []
    }
    func composeExam(scribeExam: String, libraryTexts: [String]) -> String {
        call("MNACore.composeExam", [scribeExam, libraryTexts], as: String.self) ?? scribeExam
    }
    func composeAP(ap: String, dotphrases: [String], insertion: String, planLine: Int?) -> String {
        var opts: [String: Any] = ["insertion": insertion]
        if let l = planLine { opts["planLine"] = l }
        return call("MNACore.composeAP", [ap, dotphrases, opts], as: String.self) ?? ap
    }
    func cernerSafe(_ s: String) -> String { call("MNACore.cernerSafe", [s], as: String.self) ?? s }

    // MARK: picker

    func searchPayers(query: String, recents: [String]) -> [PayerHit] {
        call("__S.search", [query, recents], as: [PayerHit].self) ?? []
    }
    func recordRecentPayer(recents: [String], payerId: String) -> [String] {
        call("MNACore.recordRecentPayer", [recents, payerId], as: [String].self) ?? recents
    }
    func procedures() -> [RegistryProcedure] { call("__S.procedures", [], as: [RegistryProcedure].self) ?? [] }

    // MARK: hotkeys

    func validateHotkeys(_ bindings: [String: String]) -> HotkeyValidation? {
        call("MNACore.validateHotkeys", [bindings, "darwin"], as: HotkeyValidation.self)
    }
    func normalizeHotkey(_ s: String) -> String? { call("MNACore.normalizeHotkey", [s], as: String?.self) ?? nil }
    func defaultHotkeys() -> [String: String] {
        call("MNACore.defaultHotkeys", [], as: [String: String].self) ?? ["capture": "F8", "pasteHpi": "F9", "pasteExam": "F10", "pasteAp": "F11"]
    }
}
