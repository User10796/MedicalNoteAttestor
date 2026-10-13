import Foundation
import AppKit

/// Why a Claude fill request failed; the reason names map to MNACore.fillNotice (shared text).
/// `http` carries the API's error body (Anthropic's error type and message; no patient data).
enum ClaudeFillFailure: Error, Equatable {
    case timeout, network, malformed, cancelled
    case http(Int, String?)
    case streamError(type: String, message: String)
    var reason: String {
        switch self {
        case .timeout: return "timeout"; case .network: return "network"; case .malformed: return "malformed"
        case .cancelled: return "cancelled"; case .http: return "http"; case .streamError: return "stream-error"
        }
    }
    var detail: Int? { if case .http(let c, _) = self { return c }; return nil }
}

enum ClaudeAPIError: Error, LocalizedError {
    case missingAPIKey
    case invalidResponse
    case apiError(String)
    case networkError(String)

    var errorDescription: String? {
        switch self {
        case .missingAPIKey:
            return "No Claude API key. Add your key in Settings \u{2192} Claude API to use this feature."
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
    static let model = "claude-sonnet-4-6"   // same as MNACore.FILL_MODEL (tests check)

    /// Optional Anthropic workspace ID (Settings > Claude API) for keys not scoped to a workspace:
    /// without it such keys get HTTP 400 "must include the anthropic-workspace-id header". Not a secret.
    static func addWorkspaceHeader(_ request: inout URLRequest) {
        let w = MNACore.shared.normalizeWorkspaceId(UserDefaults.standard.string(forKey: "claudeWorkspaceId") ?? "")
        if !w.isEmpty { request.setValue(w, forHTTPHeaderField: "anthropic-workspace-id") }
    }
    private let claudeModel = ClaudeAPIClient.model
    private let maxTokens = 4096

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

    /// POST a prepared, streaming Messages API body (Claude fill). User key only. Gives up after
    /// `idleTimeout` with no bytes or `totalTimeout` in all. Each SSE line is handed to `onLine` (the
    /// shared core parses it and counts values). Throws a ClaudeFillFailure naming the reason; Task
    /// cancellation (the Cancel button) throws .cancelled. Never logs the key or note text.
    static let fillIdleTimeout: TimeInterval = 30
    static let fillTotalTimeout: TimeInterval = 120
    func streamMessages(body: Data, apiKey: String, idleTimeout: TimeInterval = ClaudeAPIClient.fillIdleTimeout,
                        totalTimeout: TimeInterval = ClaudeAPIClient.fillTotalTimeout,
                        onLine: @escaping @MainActor (String) -> Bool) async throws {
        var request = URLRequest(url: apiURL)
        request.httpMethod = "POST"
        request.timeoutInterval = idleTimeout
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue(apiKey, forHTTPHeaderField: "x-api-key")
        request.setValue("2023-06-01", forHTTPHeaderField: "anthropic-version")
        ClaudeAPIClient.addWorkspaceHeader(&request)
        request.httpBody = body
        let config = URLSessionConfiguration.ephemeral
        config.timeoutIntervalForRequest = idleTimeout       // idle: no bytes for this long
        config.timeoutIntervalForResource = totalTimeout     // whole request
        let session = URLSession(configuration: config)
        defer { session.invalidateAndCancel() }
        func mapped(_ error: Error) -> ClaudeFillFailure {
            if error is CancellationError || Task.isCancelled { return .cancelled }
            if let e = error as? URLError { return e.code == .cancelled ? .cancelled : e.code == .timedOut ? .timeout : .network }
            return (error as? ClaudeFillFailure) ?? .network
        }
        do {
            let (bytes, response) = try await session.bytes(for: request)
            let status = (response as? HTTPURLResponse)?.statusCode ?? 0
            if status != 200 {
                var errBody = Data()
                for try await b in bytes { errBody.append(b); if errBody.count > 16_384 { break } }
                throw ClaudeFillFailure.http(status, String(data: errBody, encoding: .utf8))
            }
            for try await line in bytes.lines {
                try Task.checkCancellation()
                if !(await onLine(line)) { break }   // the core saw message_stop or an error event (parsed on the main actor)
            }
            try Task.checkCancellation()
        } catch {
            throw mapped(error)
        }
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
        ClaudeAPIClient.addWorkspaceHeader(&request)

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
        ClaudeAPIClient.addWorkspaceHeader(&request)

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

    /// The key the user entered (Keychain). No built-in key, no fallback.
    @MainActor
    private func getAPIKey() async throws -> String {
        guard let key = ClaudeKey.current() else { throw ClaudeAPIError.missingAPIKey }
        return key
    }
}
