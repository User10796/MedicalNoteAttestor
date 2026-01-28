import Vision
import AppKit

enum OCRError: Error, LocalizedError {
    case noTextFound
    case processingFailed(String)

    var errorDescription: String? {
        switch self {
        case .noTextFound:
            return "No text found in the selected region"
        case .processingFailed(let message):
            return "OCR processing failed: \(message)"
        }
    }
}

class OCRService {
    func extractText(from image: CGImage) async throws -> String {
        return try await withCheckedThrowingContinuation { continuation in
            let request = VNRecognizeTextRequest { request, error in
                if let error = error {
                    continuation.resume(throwing: OCRError.processingFailed(error.localizedDescription))
                    return
                }

                guard let observations = request.results as? [VNRecognizedTextObservation] else {
                    continuation.resume(throwing: OCRError.noTextFound)
                    return
                }

                // Sort observations by their position (top to bottom, left to right)
                let sortedObservations = observations.sorted { obs1, obs2 in
                    // Vision coordinates have origin at bottom-left
                    // Sort by Y descending (top first), then X ascending (left first)
                    if abs(obs1.boundingBox.midY - obs2.boundingBox.midY) > 0.01 {
                        return obs1.boundingBox.midY > obs2.boundingBox.midY
                    }
                    return obs1.boundingBox.midX < obs2.boundingBox.midX
                }

                let text = sortedObservations
                    .compactMap { observation -> String? in
                        observation.topCandidates(1).first?.string
                    }
                    .joined(separator: "\n")

                continuation.resume(returning: text)
            }

            // Configure for accurate recognition
            request.recognitionLevel = .accurate
            request.usesLanguageCorrection = true
            request.recognitionLanguages = ["en-US"]

            // Perform the request
            let handler = VNImageRequestHandler(cgImage: image, options: [:])

            do {
                try handler.perform([request])
            } catch {
                continuation.resume(throwing: OCRError.processingFailed(error.localizedDescription))
            }
        }
    }
}
