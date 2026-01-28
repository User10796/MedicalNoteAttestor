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
    private let hpiHotkeyKey = "hpiHotkey"
    private let apHotkeyKey = "apHotkey"
    private let customClaudeInstructionsKey = "customClaudeInstructions"
    private let customAttestationTemplateKey = "customAttestationTemplate"
    private let heidiCopyEnabledKey = "heidiCopyEnabled"

    // Published properties for SwiftUI binding
    @Published var hpiHotkey: HotkeyOption {
        didSet { UserDefaults.standard.set(hpiHotkey.rawValue, forKey: hpiHotkeyKey) }
    }

    @Published var apHotkey: HotkeyOption {
        didSet { UserDefaults.standard.set(apHotkey.rawValue, forKey: apHotkeyKey) }
    }

    @Published var customClaudeInstructions: String {
        didSet { UserDefaults.standard.set(customClaudeInstructions, forKey: customClaudeInstructionsKey) }
    }

    @Published var customAttestationTemplate: String {
        didSet { UserDefaults.standard.set(customAttestationTemplate, forKey: customAttestationTemplateKey) }
    }

    @Published var heidiCopyEnabled: Bool {
        didSet { UserDefaults.standard.set(heidiCopyEnabled, forKey: heidiCopyEnabledKey) }
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
        // Load saved values or use defaults
        if let savedHPI = UserDefaults.standard.string(forKey: hpiHotkeyKey),
           let hotkey = HotkeyOption(rawValue: savedHPI) {
            self.hpiHotkey = hotkey
        } else {
            self.hpiHotkey = .pageUp
        }

        if let savedAP = UserDefaults.standard.string(forKey: apHotkeyKey),
           let hotkey = HotkeyOption(rawValue: savedAP) {
            self.apHotkey = hotkey
        } else {
            self.apHotkey = .pageDown
        }

        self.customClaudeInstructions = UserDefaults.standard.string(forKey: customClaudeInstructionsKey) ?? ""
        self.customAttestationTemplate = UserDefaults.standard.string(forKey: customAttestationTemplateKey) ?? ""
        self.heidiCopyEnabled = UserDefaults.standard.object(forKey: heidiCopyEnabledKey) as? Bool ?? true
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
