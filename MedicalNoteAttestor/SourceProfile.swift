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

    static let heidi = SourceProfile(id: .heidi, captureKey: "F8", captureMethod: "selectAllCopy", parser: "heidi", actionItems: true)
    static let freed = SourceProfile(id: .freed, captureKey: "F7", captureMethod: "clipboardRead", parser: "freed", actionItems: false)
}
