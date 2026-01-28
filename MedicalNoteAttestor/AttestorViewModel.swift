import SwiftUI
import AppKit

@MainActor
class AttestorViewModel: ObservableObject {
    @Published var outputText: String = "Click 'Select' to capture screen text..."
    @Published var autoCopy: Bool = false
    @Published var isProcessing: Bool = false
    @Published var errorMessage: String?
    @Published var statusMessage: String = ""

    private let screenCaptureManager = ScreenCaptureManager()
    private let ocrService = OCRService()
    private let claudeAPIClient = ClaudeAPIClient()
    private let textFormatter = TextFormatter()

    func startScreenSelection() {
        guard !isProcessing else { return }

        isProcessing = true
        outputText = "Select a region on screen..."
        statusMessage = "Drag to select text area"
        errorMessage = nil

        Task {
            do {
                let image = try await screenCaptureManager.captureSelection()
                await processImage(image)
            } catch let error as ScreenCaptureError {
                if case .selectionCancelled = error {
                    outputText = "Selection cancelled."
                    statusMessage = ""
                } else {
                    outputText = "Error: \(error.localizedDescription)"
                    errorMessage = error.localizedDescription
                }
                isProcessing = false
            } catch {
                outputText = "Error: \(error.localizedDescription)"
                errorMessage = error.localizedDescription
                isProcessing = false
            }
        }
    }

    private func processImage(_ image: CGImage) async {
        statusMessage = "Extracting text..."

        do {
            // Step 1: OCR
            let extractedText = try await ocrService.extractText(from: image)

            guard !extractedText.isEmpty else {
                outputText = "No text found in selection."
                statusMessage = ""
                isProcessing = false
                return
            }

            statusMessage = "Processing with Claude API..."

            // Step 2: Claude API formatting
            let formattedText = try await claudeAPIClient.formatMedicalNote(extractedText)

            // Step 3: Build full attestation with dynamic plan text
            let finalText = textFormatter.buildAttestation(from: formattedText)

            outputText = finalText
            statusMessage = "Complete"

            // Auto-copy if enabled
            if autoCopy {
                copyToClipboard()
                statusMessage = "Complete - Copied to clipboard"
            }

        } catch {
            outputText = "Error: \(error.localizedDescription)"
            errorMessage = error.localizedDescription
            statusMessage = ""
        }

        isProcessing = false
    }

    func copyToClipboard() {
        let pasteboard = NSPasteboard.general
        pasteboard.clearContents()
        pasteboard.setString(outputText, forType: .string)
        statusMessage = "Copied to clipboard"
    }

    func clearOutput() {
        outputText = "Click 'Select' to capture screen text..."
        statusMessage = ""
        errorMessage = nil
    }
}
