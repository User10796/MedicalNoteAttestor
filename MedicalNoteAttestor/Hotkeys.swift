import Foundation
import Carbon

// Configurable global hotkeys. Bindings are canonical strings ("F10", "Ctrl+Shift+F10") stored in
// UserDefaults under the existing keys; HotkeyManager re-registers them whenever UserDefaults
// change, so a rebinding applies immediately without restarting. Defaults (F8/F9/F10/F11) are
// unchanged and come from lib/mna-core.js.

enum HotkeyAction: String, CaseIterable, Identifiable {
    case capture, pasteHpi, pasteExam, pasteAp, captureFreed, openPicker
    var id: String { rawValue }

    var defaultsKey: String {
        switch self {
        case .capture:   return "captureHotkey"
        case .pasteHpi:  return "pasteHotkey1"
        case .pasteExam: return "pasteHotkey2"
        case .pasteAp:   return "pasteHotkey3"
        case .captureFreed: return "freedCaptureHotkey"
        case .openPicker: return "openPickerHotkey"
        }
    }
    var label: String {
        switch self {
        case .capture:   return "Heidi capture"
        case .pasteHpi:  return "Paste HPI"
        case .pasteExam: return "Paste Exam"
        case .pasteAp:   return "Paste A&P"
        case .captureFreed: return "Freed capture"
        case .openPicker: return "Open payer picker"
        }
    }
    var defaultBinding: String {
        switch self {
        case .capture: return "F8"
        case .pasteHpi: return "F9"
        case .pasteExam: return "F10"
        case .pasteAp: return "F11"
        case .captureFreed: return "F7"
        case .openPicker: return ""     // optional: unbound by default
        }
    }
}

struct HotkeyBinding: Equatable {
    let keyCode: UInt32
    let modifiers: UInt32   // Carbon modifier mask (cmdKey, shiftKey, optionKey, controlKey)
    let canonical: String

    private static let keys: [String: Int] = {
        var m: [String: Int] = [
            "F1": kVK_F1, "F2": kVK_F2, "F3": kVK_F3, "F4": kVK_F4, "F5": kVK_F5, "F6": kVK_F6,
            "F7": kVK_F7, "F8": kVK_F8, "F9": kVK_F9, "F10": kVK_F10, "F11": kVK_F11, "F12": kVK_F12,
            "F13": kVK_F13, "F14": kVK_F14, "F15": kVK_F15, "F16": kVK_F16, "F17": kVK_F17,
            "F18": kVK_F18, "F19": kVK_F19, "F20": kVK_F20,
            "PageUp": kVK_PageUp, "PageDown": kVK_PageDown, "Home": kVK_Home, "End": kVK_End,
            "Delete": kVK_ForwardDelete, "Insert": kVK_Help,
            "Up": kVK_UpArrow, "Down": kVK_DownArrow, "Left": kVK_LeftArrow, "Right": kVK_RightArrow,
            "Space": kVK_Space, "Tab": kVK_Tab, "Enter": kVK_Return, "Esc": kVK_Escape,
            "0": kVK_ANSI_0, "1": kVK_ANSI_1, "2": kVK_ANSI_2, "3": kVK_ANSI_3, "4": kVK_ANSI_4,
            "5": kVK_ANSI_5, "6": kVK_ANSI_6, "7": kVK_ANSI_7, "8": kVK_ANSI_8, "9": kVK_ANSI_9
        ]
        let letters: [(String, Int)] = [("A", kVK_ANSI_A), ("B", kVK_ANSI_B), ("C", kVK_ANSI_C), ("D", kVK_ANSI_D),
            ("E", kVK_ANSI_E), ("F", kVK_ANSI_F), ("G", kVK_ANSI_G), ("H", kVK_ANSI_H), ("I", kVK_ANSI_I),
            ("J", kVK_ANSI_J), ("K", kVK_ANSI_K), ("L", kVK_ANSI_L), ("M", kVK_ANSI_M), ("N", kVK_ANSI_N),
            ("O", kVK_ANSI_O), ("P", kVK_ANSI_P), ("Q", kVK_ANSI_Q), ("R", kVK_ANSI_R), ("S", kVK_ANSI_S),
            ("T", kVK_ANSI_T), ("U", kVK_ANSI_U), ("V", kVK_ANSI_V), ("W", kVK_ANSI_W), ("X", kVK_ANSI_X),
            ("Y", kVK_ANSI_Y), ("Z", kVK_ANSI_Z)]
        for (k, v) in letters { m[k] = v }
        return m
    }()
    private static let codeToName: [Int: String] = {
        var r: [Int: String] = [:]
        for (k, v) in keys where r[v] == nil || k == "Insert" { r[v] = k }
        return r
    }()

    /// Parse a canonical binding ("Ctrl+Shift+F10"). Legacy picker values ("Page Up") are accepted.
    static func parse(_ raw: String) -> HotkeyBinding? {
        let s = raw.replacingOccurrences(of: "Page Up", with: "PageUp").replacingOccurrences(of: "Page Down", with: "PageDown")
        let parts = s.split(separator: "+").map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }
        guard !parts.isEmpty else { return nil }
        var mods: UInt32 = 0
        var key: String?
        var modNames: [String] = []
        for p in parts {
            switch p.lowercased() {
            case "ctrl", "control": mods |= UInt32(controlKey); modNames.append("Ctrl")
            case "alt", "option", "opt": mods |= UInt32(optionKey); modNames.append("Alt")
            case "shift": mods |= UInt32(shiftKey); modNames.append("Shift")
            case "cmd", "command", "meta": mods |= UInt32(cmdKey); modNames.append("Cmd")
            default:
                if key != nil { return nil }
                key = keys.keys.first { $0.caseInsensitiveCompare(p) == .orderedSame }
                if key == nil { return nil }
            }
        }
        guard let k = key, let code = keys[k] else { return nil }
        // Without a modifier only F-keys and PageUp/PageDown (same rule as lib/mna-core.js):
        // letters, Space, Delete, arrows... would hijack ordinary typing.
        if mods == 0 && !(k.hasPrefix("F") && k.count > 1) && k != "PageUp" && k != "PageDown" { return nil }
        let order = ["Ctrl", "Alt", "Shift", "Cmd"].filter { modNames.contains($0) }
        return HotkeyBinding(keyCode: UInt32(code), modifiers: mods, canonical: (order + [k]).joined(separator: "+"))
    }

    /// Canonical string for a recorded key press (NSEvent keyCode + modifier flags), or nil.
    static func canonical(keyCode: Int, control: Bool, option: Bool, shift: Bool, command: Bool) -> String? {
        guard let name = codeToName[keyCode] else { return nil }
        var parts: [String] = []
        if control { parts.append("Ctrl") }
        if option { parts.append("Alt") }
        if shift { parts.append("Shift") }
        if command { parts.append("Cmd") }
        return parse((parts + [name]).joined(separator: "+"))?.canonical
    }
}

protocol HotkeyRegistrar: AnyObject {
    func register(id: UInt32, binding: HotkeyBinding) -> Bool
    func unregisterAll()
}

/// Real registrar: Carbon RegisterEventHotKey. Callbacks are dispatched by HotkeyActions.
final class CarbonHotkeyRegistrar: HotkeyRegistrar {
    private var refs: [EventHotKeyRef] = []
    func register(id: UInt32, binding: HotkeyBinding) -> Bool {
        var hkID = EventHotKeyID()
        hkID.signature = OSType(0x4D4E4130 + id) // 'MNA0'+id
        hkID.id = id
        var ref: EventHotKeyRef?
        let status = RegisterEventHotKey(binding.keyCode, binding.modifiers, hkID, GetEventDispatcherTarget(), 0, &ref)
        if status == noErr, let r = ref { refs.append(r); return true }
        return false
    }
    func unregisterAll() {
        for r in refs { UnregisterEventHotKey(r) }
        refs.removeAll()
    }
}

/// Registrar that registers nothing (used to read/validate bindings without touching Carbon).
final class NoopRegistrar: HotkeyRegistrar {
    func register(id: UInt32, binding: HotkeyBinding) -> Bool { true }
    func unregisterAll() {}
}

final class HotkeyManager {
    private let registrar: HotkeyRegistrar
    private let defaults: UserDefaults
    private let validate: ([String: String]) -> HotkeyValidation?
    private var handlers: [HotkeyAction: () -> Void] = [:]
    private(set) var active: [HotkeyAction: String] = [:]
    private(set) var failed: [HotkeyAction] = []
    private var suspended = false
    private var observer: NSObjectProtocol?

    init(registrar: HotkeyRegistrar, defaults: UserDefaults = .standard,
         validate: @escaping ([String: String]) -> HotkeyValidation? = { MNACore.shared.validateHotkeys($0) }) {
        self.registrar = registrar
        self.defaults = defaults
        self.validate = validate
    }

    static func id(for action: HotkeyAction) -> UInt32 { UInt32(HotkeyAction.allCases.firstIndex(of: action)! + 1) }

    /// Current bindings from UserDefaults; invalid, duplicate or missing values fall back to defaults.
    /// Actions the shared core validates on macOS (F8-F11). Freed capture is checked here: the
    /// shared core treats it as Windows-only, and changing that would touch the Windows app.
    static let coreActions: [HotkeyAction] = [.capture, .pasteHpi, .pasteExam, .pasteAp]

    /// Current bindings from UserDefaults; invalid, duplicate or missing values fall back to defaults.
    /// Freed capture: the saved binding if valid and free, else F7 if free, else unbound (an older
    /// setting already uses F7; nothing is taken away from another action).
    func bindings() -> [HotkeyAction: String] {
        var raw: [String: String] = [:]
        for a in HotkeyManager.coreActions {
            if let v = defaults.string(forKey: a.defaultsKey), let b = HotkeyBinding.parse(v) { raw[a.rawValue] = b.canonical }
        }
        var out: [HotkeyAction: String] = [:]
        if let v = validate(raw), v.ok {
            for a in HotkeyManager.coreActions { out[a] = v.bindings[a.rawValue] ?? a.defaultBinding }
        } else {
            for a in HotkeyManager.coreActions { out[a] = a.defaultBinding }   // corrupt/duplicate -> defaults
        }
        let used = Set(out.values)
        let stored = defaults.string(forKey: HotkeyAction.captureFreed.defaultsKey).flatMap(HotkeyBinding.parse)?.canonical
        if let f = stored, !used.contains(f) { out[.captureFreed] = f }
        else if !used.contains(HotkeyAction.captureFreed.defaultBinding) { out[.captureFreed] = HotkeyAction.captureFreed.defaultBinding }
        // Optional "Open payer picker": bound only if saved, valid, and not taken.
        if let o = defaults.string(forKey: HotkeyAction.openPicker.defaultsKey).flatMap(HotkeyBinding.parse)?.canonical,
           !Set(out.values).contains(o) { out[.openPicker] = o }
        return out
    }

    /// Keys web browsers use; warned (not rejected) for the optional picker hotkey.
    static let browserKeys: Set<String> = ["F1", "F3", "F5", "F6", "F7", "F11", "F12"]

    func start(handlers: [HotkeyAction: () -> Void]) {
        self.handlers = handlers
        reload(force: true)
        observer = NotificationCenter.default.addObserver(forName: UserDefaults.didChangeNotification, object: defaults, queue: .main) { [weak self] _ in
            self?.reload()
        }
    }

    /// Re-register if the bindings changed (or `force`). Called on every UserDefaults change.
    func reload(force: Bool = false) {
        guard !suspended else { return }
        let b = bindings()
        if !force && b == active { return }
        registrar.unregisterAll()
        failed = []
        for a in HotkeyAction.allCases {
            guard let s = b[a], let binding = HotkeyBinding.parse(s) else { continue }
            let id = HotkeyManager.id(for: a)
            if registrar.register(id: id, binding: binding) {
                HotkeyActions.shared.actions[id] = handlers[a]
            } else {
                failed.append(a)
            }
        }
        active = b
    }

    /// While Settings records a new key, global hotkeys must not swallow the key press.
    func suspend() { suspended = true; registrar.unregisterAll(); active = [:] }
    func resume() { suspended = false; reload(force: true) }

    func save(_ bindings: [HotkeyAction: String]) -> HotkeyValidation? {
        var raw: [String: String] = [:]
        for a in HotkeyManager.coreActions { if let s = bindings[a] { raw[a.rawValue] = s } }
        guard var v = validate(raw) else { return nil }
        // Freed capture: valid, and not one of the other four keys.
        let freed = bindings[.captureFreed] ?? self.bindings()[.captureFreed]
        var freedCanonical: String?
        if let f = freed {
            if let b = HotkeyBinding.parse(f) {
                freedCanonical = b.canonical
                if let clash = HotkeyManager.coreActions.first(where: { v.bindings[$0.rawValue] == b.canonical }) {
                    v.errors.append(.init(action: HotkeyAction.captureFreed.rawValue,
                                          message: "Freed capture: \(b.canonical) is already used by \(clash.label)"))
                }
            } else {
                v.errors.append(.init(action: HotkeyAction.captureFreed.rawValue,
                                      message: "Freed capture: \"\(f)\" is not a valid key combination"))
            }
        }
        // Optional "Open payer picker": "" or missing = unbound; otherwise valid and unique.
        var pickerCanonical: String?
        if let o = bindings[.openPicker], !o.isEmpty {
            if let b = HotkeyBinding.parse(o) {
                pickerCanonical = b.canonical
                let taken = HotkeyManager.coreActions.first(where: { v.bindings[$0.rawValue] == b.canonical })
                    ?? (freedCanonical == b.canonical ? HotkeyAction.captureFreed : nil)
                if let clash = taken {
                    v.errors.append(.init(action: HotkeyAction.openPicker.rawValue,
                                          message: "Open payer picker: \(b.canonical) is already used by \(clash.label)"))
                } else if HotkeyManager.browserKeys.contains(b.canonical) {
                    v.warnings.append(.init(action: HotkeyAction.openPicker.rawValue,
                                            message: "Open payer picker: \(b.canonical) is used by web browsers; pick a key with a modifier"))
                }
            } else {
                v.errors.append(.init(action: HotkeyAction.openPicker.rawValue,
                                      message: "Open payer picker: \"\(o)\" is not a valid key combination"))
            }
        }
        v.ok = v.errors.isEmpty
        if v.ok {
            for a in HotkeyManager.coreActions { defaults.set(v.bindings[a.rawValue], forKey: a.defaultsKey) }
            if let f = freedCanonical { defaults.set(f, forKey: HotkeyAction.captureFreed.defaultsKey); v.bindings[HotkeyAction.captureFreed.rawValue] = f }
            if let o = pickerCanonical { defaults.set(o, forKey: HotkeyAction.openPicker.defaultsKey); v.bindings[HotkeyAction.openPicker.rawValue] = o }
            else if bindings.keys.contains(.openPicker) { defaults.removeObject(forKey: HotkeyAction.openPicker.defaultsKey) }
        }
        return v
    }
}

// Helper class to store hotkey actions (needed for the C callback)
class HotkeyActions {
    static let shared = HotkeyActions()
    var actions: [UInt32: () -> Void] = [:]
}
