import Foundation

enum PlanType {
    case noChanges
    case medChangesOnly
    case scheduledOnly
    case medAndScheduled
    case procedureToday

    var dynamicText: String {
        switch self {
        case .noChanges:
            return "ongoing plan of care as previously established by me"
        case .medChangesOnly:
            return "new plan of care including changes to prescription medication"
        case .scheduledOnly:
            return "new plan of care including the scheduled procedure"
        case .medAndScheduled:
            return "new plan of care including changes to prescription medication and the scheduled procedure"
        case .procedureToday:
            return "new plan of care including the procedure performed today"
        }
    }
}

class TextFormatter {
    /// Get the attestation template from settings (custom or default)
    private var attestationTemplate: String {
        return SettingsManager.shared.getAttestationTemplate()
    }

    /// Process Claude API response and build full attestation document
    func buildAttestation(from claudeResponse: String) -> String {
        // Extract the plan type code from the response
        let planType = extractPlanType(from: claudeResponse)

        // Clean up the bullets (remove the code line)
        let cleanedBullets = cleanUpBullets(claudeResponse)

        // Build the dynamic plan text
        let dynamicText = planType.dynamicText

        // Construct the full document
        let attestation = attestationTemplate.replacingOccurrences(
            of: "[DYNAMIC_PLAN_TEXT]",
            with: dynamicText
        )

        return attestation + cleanedBullets
    }

    private func extractPlanType(from text: String) -> PlanType {
        let lowercased = text.lowercased()

        // Check for procedure performed today
        if text.contains("[CODE:PROCEDURE_TODAY]") ||
           lowercased.contains("performed today") ||
           lowercased.contains("procedure today") {
            return .procedureToday
        }

        // Check for scheduled procedure - look for "Schedule" patterns in the text
        let hasScheduledProcedure = text.contains("[CODE:MED_AND_SCHEDULED]") ||
            lowercased.contains("schedule ") ||
            lowercased.contains("scheduled ") ||
            lowercased.contains("scheduling ") ||
            lowercased.range(of: #"schedule[d]?\s+(a|an|the|for)?\s*\w*(injection|procedure|surgery|block|ablation|mbb|esi|rfa)"#, options: .regularExpression) != nil

        // Check for medication changes
        let hasMedChanges = text.contains("[CODE:MED_CHANGES]") ||
            text.contains("[CODE:MED_AND_SCHEDULED]") ||
            lowercased.contains("- start:") ||
            lowercased.contains("- stop:") ||
            lowercased.contains("- change:")

        if hasScheduledProcedure && hasMedChanges {
            return .medAndScheduled
        } else if hasScheduledProcedure {
            return .scheduledOnly
        } else if hasMedChanges {
            return .medChangesOnly
        } else {
            return .noChanges
        }
    }

    private func cleanUpBullets(_ text: String) -> String {
        var lines = text.components(separatedBy: .newlines)

        // Remove code lines and empty lines
        lines = lines.filter { line in
            let trimmed = line.trimmingCharacters(in: .whitespaces)
            return !trimmed.isEmpty && !trimmed.hasPrefix("[CODE:")
        }

        // Ensure each line starts with "- " if it contains content
        lines = lines.map { line in
            let trimmed = line.trimmingCharacters(in: .whitespaces)

            // Skip if already properly formatted
            if trimmed.hasPrefix("- ") {
                return trimmed
            }

            // Remove other bullet styles and normalize
            var cleaned = trimmed

            // Remove common bullet prefixes
            let bulletPrefixes = ["• ", "* ", "– ", "— ", "· ", "- "]
            for prefix in bulletPrefixes {
                if cleaned.hasPrefix(prefix) {
                    cleaned = String(cleaned.dropFirst(prefix.count))
                    break
                }
            }

            // Remove numbered prefixes (e.g., "1. ", "2) ")
            if let range = cleaned.range(of: #"^\d+[\.\)]\s*"#, options: .regularExpression) {
                cleaned = String(cleaned[range.upperBound...])
            }

            // Add proper bullet prefix
            return "- \(cleaned)"
        }

        return lines.joined(separator: "\n")
    }

    /// Legacy cleanup method for backward compatibility
    func cleanUp(_ text: String) -> String {
        return buildAttestation(from: text)
    }
}
