import Foundation

// Failed-capture rules (approved 2026-10-08), same as Windows (lib/capture-flow.js, mna-lib.ahk):
// a capture fails when the copy didn't change the clipboard, the text is empty, or neither HPI
// nor A&P was found. After a failed capture every paste yields nothing — not the exam
// dot-phrase, never a previous patient's slot or library text — until a good capture or Clear.
enum CaptureGate {
    static let failureMessage = "Capture failed \u{2014} nothing to paste"

    static func isFailure(text: String?, clipboardChanged: Bool, hpi: String?, ap: String?) -> Bool {
        guard clipboardChanged else { return true }   // Cmd+C didn't land: clipboard holds stale text
        guard let t = text, !t.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return true }
        return (hpi ?? "").isEmpty && (ap ?? "").isEmpty
    }

    enum PasteDecision: Equatable {
        case paste(String)
        case failedNotice   // last capture failed: say so, paste nothing
        case beep           // nothing to paste (Heidi: unchanged behavior)
        case silent         // Freed exam empty/N/A with no library text: no paste, no sound
    }

    /// What pressing F9 (1), F10 (2) or F11 (3) does. Heidi behavior is exactly as before;
    /// the only Freed difference is the silent no-op for an empty exam (SPEC_freed §7).
    static func decide(slot: Int, failed: Bool, source: ScribeSource, hpi: String?, exam: String?, ap: String?) -> PasteDecision {
        if failed { return .failedNotice }
        if let text = content(slot: slot, failed: false, hpi: hpi, exam: exam, ap: ap) { return .paste(text) }
        return source == .freed && slot == 2 ? .silent : .beep
    }

    /// What paste slot 1 (HPI), 2 (Exam) or 3 (A&P) yields; nil = nothing to paste.
    static func content(slot: Int, failed: Bool, hpi: String?, exam: String?, ap: String?) -> String? {
        if failed { return nil }
        let v: String?
        switch slot {
        case 1: v = hpi
        case 2: v = exam
        case 3: v = ap
        default: v = nil
        }
        return (v?.isEmpty ?? true) ? nil : v
    }
}
