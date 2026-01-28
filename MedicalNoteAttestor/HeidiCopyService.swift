import Foundation
import AppKit
import Carbon

enum HeidiSection {
    case hpi
    case assessmentPlan
}

class HeidiCopyService {

    // HPI headers (established vs new patient)
    private let hpiHeaders = [
        "Interval history, HPI:",
        "History of Present Illness (HPI):"
    ]

    // A&P header
    private let apHeader = "Assessment and Plan:"

    /// Extract a section from clipboard text and put it back on clipboard
    func extractAndCopySection(_ section: HeidiSection) {
        // Step 1: Simulate Ctrl+A, Ctrl+C to grab text from focused window
        simulateSelectAllAndCopy()

        // Small delay for clipboard to update
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.1) { [weak self] in
            self?.processClipboard(for: section)
        }
    }

    private func simulateSelectAllAndCopy() {
        // Create Cmd+A event
        let cmdADown = CGEvent(keyboardEventSource: nil, virtualKey: CGKeyCode(0x00), keyDown: true) // 'A' key
        cmdADown?.flags = .maskCommand
        cmdADown?.post(tap: .cghidEventTap)

        let cmdAUp = CGEvent(keyboardEventSource: nil, virtualKey: CGKeyCode(0x00), keyDown: false)
        cmdAUp?.flags = .maskCommand
        cmdAUp?.post(tap: .cghidEventTap)

        // Small delay between commands
        usleep(50000) // 50ms

        // Create Cmd+C event
        let cmdCDown = CGEvent(keyboardEventSource: nil, virtualKey: CGKeyCode(0x08), keyDown: true) // 'C' key
        cmdCDown?.flags = .maskCommand
        cmdCDown?.post(tap: .cghidEventTap)

        let cmdCUp = CGEvent(keyboardEventSource: nil, virtualKey: CGKeyCode(0x08), keyDown: false)
        cmdCUp?.flags = .maskCommand
        cmdCUp?.post(tap: .cghidEventTap)
    }

    private func processClipboard(for section: HeidiSection) {
        let pasteboard = NSPasteboard.general
        guard let text = pasteboard.string(forType: .string) else { return }

        let extracted: String?

        switch section {
        case .hpi:
            extracted = extractHPI(from: text)
        case .assessmentPlan:
            extracted = extractAssessmentPlan(from: text)
        }

        if let extracted = extracted, !extracted.isEmpty {
            // Put extracted text back on clipboard
            pasteboard.clearContents()
            pasteboard.setString(extracted, forType: .string)
        }
    }

    private func extractHPI(from text: String) -> String? {
        // Find HPI start position
        var hpiStart: String.Index?
        var usedHeader: String?

        for header in hpiHeaders {
            if let range = text.range(of: header) {
                hpiStart = range.upperBound
                usedHeader = header
                break
            }
        }

        guard let start = hpiStart else { return nil }

        // Find A&P header (marks end of HPI)
        guard let apRange = text.range(of: apHeader) else { return nil }
        let end = apRange.lowerBound

        // Make sure HPI comes before A&P
        guard start < end else { return nil }

        // Extract the text
        var extracted = String(text[start..<end])

        // Clean up: strip asterisks, trim whitespace, remove leading blank lines
        extracted = cleanUpText(extracted)

        return extracted
    }

    private func extractAssessmentPlan(from text: String) -> String? {
        // Find A&P start position
        guard let apRange = text.range(of: apHeader) else { return nil }
        let start = apRange.upperBound

        // Extract from A&P header to end
        var extracted = String(text[start...])

        // Clean up: strip asterisks, trim whitespace, remove leading blank lines
        extracted = cleanUpText(extracted)

        return extracted
    }

    private func cleanUpText(_ text: String) -> String {
        var cleaned = text

        // Strip asterisks (but NOT convert to caps - per user request)
        cleaned = cleaned.replacingOccurrences(of: "**", with: "")
        cleaned = cleaned.replacingOccurrences(of: "*", with: "")

        // Trim leading and trailing whitespace
        cleaned = cleaned.trimmingCharacters(in: .whitespacesAndNewlines)

        // Remove leading blank lines (lines that are just whitespace)
        let lines = cleaned.components(separatedBy: .newlines)
        var startIndex = 0
        for (index, line) in lines.enumerated() {
            if !line.trimmingCharacters(in: .whitespaces).isEmpty {
                startIndex = index
                break
            }
        }
        cleaned = lines[startIndex...].joined(separator: "\n")

        return cleaned
    }
}
