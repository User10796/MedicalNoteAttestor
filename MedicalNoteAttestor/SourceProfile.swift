import Foundation

// Scribe source profiles — same data as lib/source-profiles.js on Windows.
// Sources differ by data, not by branching code. Heidi's profile is today's behavior.
enum ScribeSource: String { case heidi, freed }

struct SourceProfile: Equatable {
    let id: ScribeSource
    let captureKey: String
    let captureMethod: String   // "selectAllCopy" (synthetic Cmd+A/Cmd+C) | "clipboardRead" (no keystrokes)
    let parser: String
    let actionItems: Bool

    // actionItems is the DEFAULT. Heidi's is off (2026-10-10): action items send the A&P to Claude, so
    // they run only when Sterling turns them on in Settings (AI Note tab) and has entered his own key.
    static let heidi = SourceProfile(id: .heidi, captureKey: "F8", captureMethod: "selectAllCopy", parser: "heidi", actionItems: false)
    static let freed = SourceProfile(id: .freed, captureKey: "F7", captureMethod: "clipboardRead", parser: "freed", actionItems: false)
}

/// Whether to generate action items after a capture. Heidi: the user's setting (default off).
/// Freed: never (its summary lines replace action items).
enum ActionItemsPolicy {
    static func enabled(source: ScribeSource, heidiSetting: Bool) -> Bool {
        switch source {
        case .heidi: return heidiSetting
        case .freed: return SourceProfile.freed.actionItems
        }
    }
}
