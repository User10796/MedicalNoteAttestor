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
