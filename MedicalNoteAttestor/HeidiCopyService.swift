import Foundation
import AppKit
import Carbon
import os.log

private let logger = Logger(subsystem: "com.user.medicalnoteattestor", category: "HeidiCopy")

enum HeidiSection {
    case hpi
    case assessmentPlan
}

class HeidiCopyService {

    // HPI headers (established vs new patient)
    private let hpiHeaders = [
        "Interval history, HPI:",
        "History of Present Illness (HPI):",
        "History of Present Illness:"
    ]

    // A&P header
    private let apHeader = "Assessment and Plan:"

    /// Extract a section from clipboard text and put it back on clipboard
    func extractAndCopySection(_ section: HeidiSection) {
        logger.warning("Hotkey pressed for \(section == .hpi ? "HPI" : "A&P")")

        // Simulate Cmd+A, Cmd+C using CGEvent
        simulateSelectAllAndCopy()

        // Delay for clipboard to update, then process
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.4) { [weak self] in
            self?.processClipboard(for: section)
        }
    }

    private func simulateSelectAllAndCopy() {
        // Check accessibility
        let trusted = AXIsProcessTrusted()
        logger.warning("Accessibility trusted: \(trusted)")

        if !trusted {
            logger.warning("NOT TRUSTED - requesting access")
            let options = [kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true] as CFDictionary
            AXIsProcessTrustedWithOptions(options)
            return
        }

        // Create source for better event handling
        guard let source = CGEventSource(stateID: .combinedSessionState) else {
            logger.warning("Failed to create event source")
            return
        }

        // Cmd+A
        guard let aKeyDown = CGEvent(keyboardEventSource: source, virtualKey: 0x00, keyDown: true),
              let aKeyUp = CGEvent(keyboardEventSource: source, virtualKey: 0x00, keyDown: false) else {
            logger.warning("Failed to create Cmd+A events")
            return
        }
        aKeyDown.flags = .maskCommand
        aKeyUp.flags = .maskCommand
        aKeyDown.post(tap: .cgAnnotatedSessionEventTap)
        aKeyUp.post(tap: .cgAnnotatedSessionEventTap)

        usleep(150000) // 150ms

        // Cmd+C
        guard let cKeyDown = CGEvent(keyboardEventSource: source, virtualKey: 0x08, keyDown: true),
              let cKeyUp = CGEvent(keyboardEventSource: source, virtualKey: 0x08, keyDown: false) else {
            logger.warning("Failed to create Cmd+C events")
            return
        }
        cKeyDown.flags = .maskCommand
        cKeyUp.flags = .maskCommand
        cKeyDown.post(tap: .cgAnnotatedSessionEventTap)
        cKeyUp.post(tap: .cgAnnotatedSessionEventTap)

        logger.warning("Posted Cmd+A, Cmd+C events")
    }

    private func processClipboard(for section: HeidiSection) {
        let pasteboard = NSPasteboard.general
        guard let text = pasteboard.string(forType: .string) else {
            logger.error("No text on clipboard")
            return
        }

        logger.warning("Clipboard has \(text.count) characters")


        let extracted: String?

        switch section {
        case .hpi:
            extracted = extractHPI(from: text)
        case .assessmentPlan:
            extracted = extractAssessmentPlan(from: text)
        }

        if let extracted = extracted, !extracted.isEmpty {
            logger.info("Extracted \(extracted.count) characters")
            // Put extracted text back on clipboard
            pasteboard.clearContents()
            pasteboard.setString(extracted, forType: .string)
        } else {
            logger.warning("No content extracted - headers not found in text")
        }
    }

    private func extractHPI(from text: String) -> String? {
        // Find HPI start position (case-insensitive)
        var hpiStart: String.Index?
        var usedHeader: String?

        for header in hpiHeaders {
            if let range = text.range(of: header, options: .caseInsensitive) {
                hpiStart = range.upperBound
                usedHeader = header
                break
            }
        }

        guard let start = hpiStart else { return nil }

        // Find A&P header (marks end of HPI) - case-insensitive
        guard let apRange = text.range(of: apHeader, options: .caseInsensitive) else { return nil }
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
        // Find A&P start position (case-insensitive)
        guard let apRange = text.range(of: apHeader, options: .caseInsensitive) else { return nil }
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
