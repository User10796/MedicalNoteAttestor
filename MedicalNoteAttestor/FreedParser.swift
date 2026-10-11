import Foundation

// Freed note parser — Swift port of lib/freed-parser.js (SPEC_freed_source_standalone §3–§8).
// Same rules, same order; checked against the shared fixtures in test/fixtures/freed/.
// Pure functions, no I/O, never logs text.
enum FreedLineClass: String { case blank, divider, numbered, bullet, subheader, inlineLabel, text }

struct FreedSlots: Equatable { var hpi: String; var exam: String; var ap: String }

enum FreedParser {
    static let dividers = ["Subjective", "Objective", "Assessment & Plan"]

    private static func matches(_ s: String, _ pattern: String) -> Bool {
        s.range(of: pattern, options: .regularExpression) != nil
    }
    private static func trimmed(_ s: String) -> String { s.trimmingCharacters(in: .whitespaces) }

    /// §6: CRLF -> LF, strip a leading BOM, trim trailing whitespace on each line.
    static func normalize(_ raw: String) -> String {
        var s = raw
        if s.hasPrefix("\u{FEFF}") { s.removeFirst() }
        s = s.replacingOccurrences(of: "\r\n", with: "\n").replacingOccurrences(of: "\r", with: "\n")
        return s.components(separatedBy: "\n")
            .map { $0.replacingOccurrences(of: "[ \\t\\u00A0]+$", with: "", options: .regularExpression) }
            .joined(separator: "\n")
    }

    /// §3: checked in this order.
    static func classify(_ line: String) -> FreedLineClass {
        let t = trimmed(line)
        if t.isEmpty { return .blank }
        if dividers.contains(t) { return .divider }
        if matches(line, "^\\s*\\d+\\.\\s+") { return .numbered }
        if matches(line, "^\\s*-\\s+") { return .bullet }
        if t.hasSuffix(":") { return .subheader }
        if matches(t, "^[^:\\-\\d][^:]*:\\s+\\S.*$") { return .inlineLabel }
        return .text
    }

    /// §4 + §5. nil = not a valid Freed note.
    static func sections(_ text: String) -> (subjective: [String], objective: [String], ap: [String])? {
        let lines = text.components(separatedBy: "\n")
        var at: [String: Int] = [:]
        for (i, l) in lines.enumerated() where classify(l) == .divider {
            let d = trimmed(l)
            if at[d] != nil { return nil }            // each divider exactly once
            at[d] = i
        }
        guard let s = at[dividers[0]], let o = at[dividers[1]], let a = at[dividers[2]], s < o, o < a else { return nil }
        let subj = Array(lines[(s + 1)..<o]), obj = Array(lines[(o + 1)..<a]), ap = Array(lines[(a + 1)...])
        let hasHpi = subj.contains { classify($0) == .subheader && trimmed($0).hasPrefix("History of Present Illness") }
        let hasProblem = ap.contains { classify($0) == .numbered }
        return hasHpi && hasProblem ? (subj, obj, ap) : nil
    }

    /// §8: format one slot; `drop` = lowercased subheaders removed for this slot (§7).
    static func format(_ lines: [String], drop: [String]) -> String {
        var out: [String] = []
        for line in lines {
            let emit: String
            switch classify(line) {
            case .divider: continue
            case .blank: emit = ""
            case .subheader:
                if drop.contains(trimmed(line).lowercased()) { continue }
                emit = trimmed(line)
            case .bullet:
                emit = "- " + trimmed(line.replacingOccurrences(of: "^\\s*-\\s+", with: "", options: .regularExpression))
            default: emit = trimmed(line)   // numbered keeps "N. content"; inline label; text
            }
            if emit.isEmpty && (out.isEmpty || out.last == "") { continue }   // collapse blank runs
            out.append(emit)
        }
        while out.last == "" { out.removeLast() }
        return out.joined(separator: "\n")
    }

    /// §7 F10 silent no-op: empty, or only N/A once the label is dropped and bullet markers stripped.
    static func isEmptyExam(_ exam: String) -> Bool {
        let content = exam.components(separatedBy: "\n")
            .map { trimmed($0.replacingOccurrences(of: "^-\\s+", with: "", options: .regularExpression)) }
            .filter { !$0.isEmpty }
        return content.isEmpty || content.allSatisfy { matches($0, "^(?i)n/a\\.?$") }
    }

    /// `text` must already be normalized. nil = invalid shape.
    static func parse(_ text: String) -> FreedSlots? {
        guard let s = sections(text) else { return nil }
        var exam = format(s.objective, drop: ["physical examination:"])
        if isEmptyExam(exam) { exam = "" }
        return FreedSlots(hpi: format(s.subjective, drop: []),
                          exam: exam,
                          ap: format(s.ap, drop: ["assessment and plan:"]))
    }
}
