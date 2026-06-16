import Foundation
import AppKit

enum ClaudeAPIError: Error, LocalizedError {
    case missingAPIKey
    case invalidResponse
    case apiError(String)
    case networkError(String)

    var errorDescription: String? {
        switch self {
        case .missingAPIKey:
            return "API key not configured. Please set your Anthropic API key."
        case .invalidResponse:
            return "Invalid response from Claude API"
        case .apiError(let message):
            return "Claude API error: \(message)"
        case .networkError(let message):
            return "Network error: \(message)"
        }
    }
}

class ClaudeAPIClient {
    private let apiURL = URL(string: "https://api.anthropic.com/v1/messages")!
    private let claudeModel = "claude-sonnet-4-6"
    private let maxTokens = 4096

    // UserDefaults key for storing API key
    private let apiKeyDefaultsKey = "AnthropicAPIKey"

    private let baseSystemPrompt = """
    You are a medical note reformatter. Transform the input according to these rules:

    NAME REMOVAL:
    - Delete all instances of "Dr. Haring"

    MEDICATIONS:
    - Continued/unchanged medications → combine into single bullet: "- Continue: [med1], [med2], [med3]"
    - New medications → "- Start: [medication]"
    - Stopped medications → "- Stop: [medication]"
    - Changed medications → "- Change: [medication to new dosage/frequency]"
    - Only include Start/Stop/Change bullets when actual changes exist

    RECOMMENDATIONS:
    - Preserve "Consider" language verbatim (don't convert to directives)

    PROCEDURES:
    - Each procedure gets its own bullet point
    - Note if procedure was "performed today" vs "scheduled"

    ABBREVIATIONS (expand all):
    - BID → twice daily
    - TID → three times daily
    - QID → four times daily
    - QD → once daily
    - PRN → as needed
    - PO → by mouth
    - IM → intramuscular
    - IV → intravenous
    - ESI → epidural steroid injection
    - TFESI → transforaminal epidural steroid injection
    - ILESI → interlaminar epidural steroid injection
    - CESI → caudal epidural steroid injection
    - RFA → radiofrequency ablation
    - MBB → medial branch block
    - SI → sacroiliac
    - SIJ → sacroiliac joint
    - CRPS → complex regional pain syndrome
    - PT → physical therapy
    - OT → occupational therapy
    - MRI → magnetic resonance imaging
    - CT → computed tomography
    - EMG → electromyography
    - NCS → nerve conduction study
    - NSAID → nonsteroidal anti-inflammatory drug
    - HA → headache
    - LBP → low back pain
    - ROM → range of motion
    - WNL → within normal limits
    - F/U → follow up
    - RTC → return to clinic

    OUTPUT FORMAT:
    - Use dash-space bullets (- )
    - No blank lines between bullets
    - Single line per bullet (no wrapping)
    - No nested sub-bullets
    - Output ONLY the formatted bullets, no explanations
    - At the END, on a new line, output one of these codes based on content:
      [CODE:NO_CHANGES] - if no medication changes and no procedures
      [CODE:MED_CHANGES] - if medication changes only (Start/Stop/Change present)
      [CODE:MED_AND_SCHEDULED] - if medication changes AND a scheduled procedure
      [CODE:PROCEDURE_TODAY] - if a procedure was performed today
    """

    /// Get the full system prompt including any custom instructions
    @MainActor
    private var systemPrompt: String {
        let customInstructions = SettingsManager.shared.customClaudeInstructions.trimmingCharacters(in: .whitespacesAndNewlines)
        if customInstructions.isEmpty {
            return baseSystemPrompt
        }
        return baseSystemPrompt + "\n\nADDITIONAL INSTRUCTIONS:\n" + customInstructions
    }

    @MainActor
    func formatMedicalNote(_ text: String) async throws -> String {
        let apiKey = try await getAPIKey()
        let prompt = systemPrompt

        var request = URLRequest(url: apiURL)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue(apiKey, forHTTPHeaderField: "x-api-key")
        request.setValue("2023-06-01", forHTTPHeaderField: "anthropic-version")

        let body: [String: Any] = [
            "model": claudeModel,
            "max_tokens": maxTokens,
            "system": prompt,
            "messages": [
                ["role": "user", "content": text]
            ]
        ]

        request.httpBody = try JSONSerialization.data(withJSONObject: body)

        do {
            let (data, response) = try await URLSession.shared.data(for: request)

            guard let httpResponse = response as? HTTPURLResponse else {
                throw ClaudeAPIError.invalidResponse
            }

            if httpResponse.statusCode != 200 {
                if let errorJson = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                   let error = errorJson["error"] as? [String: Any],
                   let message = error["message"] as? String {
                    throw ClaudeAPIError.apiError(message)
                }
                throw ClaudeAPIError.apiError("HTTP \(httpResponse.statusCode)")
            }

            guard let json = try JSONSerialization.jsonObject(with: data) as? [String: Any],
                  let content = json["content"] as? [[String: Any]],
                  let firstContent = content.first,
                  let text = firstContent["text"] as? String else {
                throw ClaudeAPIError.invalidResponse
            }

            return text

        } catch let error as ClaudeAPIError {
            throw error
        } catch {
            throw ClaudeAPIError.networkError(error.localizedDescription)
        }
    }

    static let actionItemSystemPrompt = """
You are a medical note assistant. Given an Assessment and Plan section from a clinical note, extract only the concrete action items and output them as a concise bullet list.

INCLUDE these categories (when present):
- Medication changes: start, stop, or change (keep drug names and doses as written)
- Procedures ordered or scheduled
- Referrals
- Labs or imaging ordered
- Follow-up instructions (e.g. return to clinic timeframes)

DO NOT include:
- Diagnoses or problem descriptions
- Findings or exam results
- Rationale or explanations
- Anything that is not a discrete action

FORMAT:
- Use dash-space bullets (- )
- One action per bullet
- Keep abbreviations as-is (do not expand)
- No blank lines between bullets
- No preamble, headers, or explanation — output ONLY the bullet list
- If no action items are found, output nothing — return an empty string
"""

    func extractActionItems(from apText: String) async throws -> String {
        let apiKey = try await getAPIKey()

        var request = URLRequest(url: apiURL)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue(apiKey, forHTTPHeaderField: "x-api-key")
        request.setValue("2023-06-01", forHTTPHeaderField: "anthropic-version")

        let body: [String: Any] = [
            "model": claudeModel,
            "max_tokens": 512,
            "system": ClaudeAPIClient.actionItemSystemPrompt,
            "messages": [["role": "user", "content": apText]]
        ]

        request.httpBody = try JSONSerialization.data(withJSONObject: body)

        let (data, response) = try await URLSession.shared.data(for: request)

        guard let httpResponse = response as? HTTPURLResponse,
              httpResponse.statusCode == 200 else {
            if let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
               let error = json["error"] as? [String: Any],
               let message = error["message"] as? String {
                throw ClaudeAPIError.apiError(message)
            }
            throw ClaudeAPIError.invalidResponse
        }

        guard let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let content = json["content"] as? [[String: Any]],
              let text = content.first?["text"] as? String else {
            throw ClaudeAPIError.invalidResponse
        }

        return text.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    @MainActor
    private func getAPIKey() async throws -> String {
        let userKey = SettingsManager.shared.claudeAPIKey.trimmingCharacters(in: .whitespaces)
        if !userKey.isEmpty { return userKey }
        return "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"
    }
}
