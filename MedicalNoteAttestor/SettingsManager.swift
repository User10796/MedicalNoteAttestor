import Foundation
import Carbon

class SettingsManager: ObservableObject {
    static let shared = SettingsManager()

    // UserDefaults keys
    private let customClaudeInstructionsKey = "customClaudeInstructions"
    private let customAttestationTemplateKey = "customAttestationTemplate"
    private let captureDelayKey   = "captureDelay"
    private let claudeAPIKeyKey   = "claudeAPIKey"

    // Active hotkey bindings for display ("F8", "Ctrl+Shift+F10"). Read-only here: Settings saves
    // through AppDelegate.hotkeys (validated), and these refresh on every UserDefaults change.
    @Published private(set) var captureHotkey: String = "F8"
    @Published private(set) var pasteHotkey1: String = "F9"
    @Published private(set) var pasteHotkey2: String = "F10"
    @Published private(set) var pasteHotkey3: String = "F11"
    @Published private(set) var freedCaptureHotkey: String = "F7"
    private var defaultsObserver: NSObjectProtocol?

    func refreshHotkeyLabels() {
        let b = HotkeyManager(registrar: NoopRegistrar()).bindings()
        if captureHotkey != b[.capture] { captureHotkey = b[.capture] ?? "F8" }
        if pasteHotkey1 != b[.pasteHpi] { pasteHotkey1 = b[.pasteHpi] ?? "F9" }
        if pasteHotkey2 != b[.pasteExam] { pasteHotkey2 = b[.pasteExam] ?? "F10" }
        if pasteHotkey3 != b[.pasteAp] { pasteHotkey3 = b[.pasteAp] ?? "F11" }
        let freed = b[.captureFreed] ?? "not set"
        if freedCaptureHotkey != freed { freedCaptureHotkey = freed }
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
        captureDelay  = UserDefaults.standard.object(forKey: captureDelayKey) as? Double ?? 0.7
        claudeAPIKey  = UserDefaults.standard.string(forKey: claudeAPIKeyKey) ?? ""

        self.customClaudeInstructions = UserDefaults.standard.string(forKey: customClaudeInstructionsKey) ?? ""
        self.customAttestationTemplate = UserDefaults.standard.string(forKey: customAttestationTemplateKey) ?? ""

        refreshHotkeyLabels()
        defaultsObserver = NotificationCenter.default.addObserver(forName: UserDefaults.didChangeNotification,
                                                                  object: nil, queue: .main) { [weak self] _ in
            self?.refreshHotkeyLabels()
        }
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
