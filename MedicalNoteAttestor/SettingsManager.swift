import Foundation
import Carbon

/// Hotkey options for the Heidi copy feature
enum HotkeyOption: String, CaseIterable, Identifiable {
    case pageUp = "Page Up"
    case pageDown = "Page Down"
    case f5 = "F5"
    case f6 = "F6"
    case f7 = "F7"
    case f8 = "F8"
    case f9 = "F9"
    case f10 = "F10"
    case f11 = "F11"
    case f12 = "F12"

    var id: String { rawValue }

    var keyCode: UInt32 {
        switch self {
        case .pageUp: return UInt32(kVK_PageUp)
        case .pageDown: return UInt32(kVK_PageDown)
        case .f5: return UInt32(kVK_F5)
        case .f6: return UInt32(kVK_F6)
        case .f7: return UInt32(kVK_F7)
        case .f8: return UInt32(kVK_F8)
        case .f9: return UInt32(kVK_F9)
        case .f10: return UInt32(kVK_F10)
        case .f11: return UInt32(kVK_F11)
        case .f12: return UInt32(kVK_F12)
        }
    }
}

class SettingsManager: ObservableObject {
    static let shared = SettingsManager()

    // UserDefaults keys
    private let customClaudeInstructionsKey = "customClaudeInstructions"
    private let customAttestationTemplateKey = "customAttestationTemplate"
    private let captureHotkeyKey  = "captureHotkey"
    private let pasteHotkey1Key   = "pasteHotkey1"
    private let pasteHotkey2Key   = "pasteHotkey2"
    private let pasteHotkey3Key   = "pasteHotkey3"
    private let captureDelayKey   = "captureDelay"
    private let claudeAPIKeyKey   = "claudeAPIKey"

    // Published properties for SwiftUI binding
    @Published var captureHotkey: HotkeyOption {
        didSet { UserDefaults.standard.set(captureHotkey.rawValue, forKey: captureHotkeyKey) }
    }

    @Published var pasteHotkey1: HotkeyOption {
        didSet { UserDefaults.standard.set(pasteHotkey1.rawValue, forKey: pasteHotkey1Key) }
    }

    @Published var pasteHotkey2: HotkeyOption {
        didSet { UserDefaults.standard.set(pasteHotkey2.rawValue, forKey: pasteHotkey2Key) }
    }

    @Published var pasteHotkey3: HotkeyOption {
        didSet { UserDefaults.standard.set(pasteHotkey3.rawValue, forKey: pasteHotkey3Key) }
    }

    @Published var captureDelay: Double {
        didSet { UserDefaults.standard.set(captureDelay, forKey: captureDelayKey) }
    }

    @Published var claudeAPIKey: String {
        didSet { UserDefaults.standard.set(claudeAPIKey, forKey: claudeAPIKeyKey) }
    }

    @Published var customClaudeInstructions: String {
        didSet { UserDefaults.standard.set(customClaudeInstructions, forKey: customClaudeInstructionsKey) }
    }

    @Published var customAttestationTemplate: String {
        didSet { UserDefaults.standard.set(customAttestationTemplate, forKey: customAttestationTemplateKey) }
    }

    // Default attestation template
    static let defaultAttestationTemplate = """
For this patient encounter, I personally saw this patient and formulated the plan together with the APP at the time of this visit. I agree with the [DYNAMIC_PLAN_TEXT]. I reviewed the APP's documentation, medical decision making and treatment plan, and agree with the documentation above. By my electronic signature I authenticate all APP orders and attest that all pages have been reviewed and completed.

Physical exam: Gen: No acute distress
HEENT: EOMI, NC/AT
CV: Extremities warm and perfused.
Pulm: No increased work of breathing.
Neuro: Moves extremities spontaneously. Alert and oriented.
Psych: Answered all questions appropriately.

Assessment: As above

Plan:

"""

    private init() {
        // Migration: clear any stale Option-key values from earlier builds
        ["captureHotkey", "pasteHotkey1", "pasteHotkey2", "pasteHotkey3"].forEach { key in
            if let val = UserDefaults.standard.string(forKey: key),
               val.contains("\u{2325}") || val.contains("\u{2303}") {
                UserDefaults.standard.removeObject(forKey: key)
            }
        }

        // Load saved values or use defaults
        captureHotkey = UserDefaults.standard.string(forKey: captureHotkeyKey)
            .flatMap(HotkeyOption.init(rawValue:)) ?? .f8
        pasteHotkey1  = UserDefaults.standard.string(forKey: pasteHotkey1Key)
            .flatMap(HotkeyOption.init(rawValue:)) ?? .f9
        pasteHotkey2  = UserDefaults.standard.string(forKey: pasteHotkey2Key)
            .flatMap(HotkeyOption.init(rawValue:)) ?? .f10
        pasteHotkey3  = UserDefaults.standard.string(forKey: pasteHotkey3Key)
            .flatMap(HotkeyOption.init(rawValue:)) ?? .f11
        captureDelay  = UserDefaults.standard.object(forKey: captureDelayKey) as? Double ?? 0.7
        claudeAPIKey  = UserDefaults.standard.string(forKey: claudeAPIKeyKey) ?? ""

        self.customClaudeInstructions = UserDefaults.standard.string(forKey: customClaudeInstructionsKey) ?? ""
        self.customAttestationTemplate = UserDefaults.standard.string(forKey: customAttestationTemplateKey) ?? ""
    }

    /// Get the effective attestation template (custom or default)
    func getAttestationTemplate() -> String {
        if customAttestationTemplate.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            return SettingsManager.defaultAttestationTemplate
        }
        return customAttestationTemplate
    }

    /// Reset attestation template to default
    func resetAttestationTemplate() {
        customAttestationTemplate = ""
    }

    /// Reset Claude instructions to default (empty)
    func resetClaudeInstructions() {
        customClaudeInstructions = ""
    }
}
