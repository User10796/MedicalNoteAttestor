import Foundation
import CryptoKit

// Freed F7 capture pipeline — Swift port of lib/freed-capture.js:
// pasteboard text -> normalize -> SHA-256 duplicate guard -> shape validation -> parse ->
// all three slots replaced at once. The hash lives in memory only and resets on any Heidi
// capture or Clear. Notices never contain pasteboard text. No action items (profile).
final class FreedCapture {
    static let shared = FreedCapture()

    static let noticeInvalid = "Clipboard doesn't look like a Freed note. Click Copy all in Freed, then F7."
    static let noticeDuplicate = "Already captured"

    enum Result: Equatable {
        case ok(FreedSlots)
        case duplicate
        case invalid
    }

    private var lastHash: String?
    private(set) var parses = 0
    let profile = SourceProfile.freed

    static func sha256(_ s: String) -> String {
        SHA256.hash(data: Data(s.utf8)).map { String(format: "%02x", $0) }.joined()
    }

    func process(raw: String) -> Result {
        let text = FreedParser.normalize(raw)
        let hash = FreedCapture.sha256(text)
        if let last = lastHash, last == hash { return .duplicate }
        guard let slots = FreedParser.parse(text) else { return .invalid }
        parses += 1
        lastHash = hash        // only after a successful parse; the caller writes the slots next
        return .ok(slots)
    }

    /// Another capture (Heidi) or Clear replaced the slots: the same Freed note must re-adopt.
    func resetDuplicateGuard() { lastHash = nil }
}
