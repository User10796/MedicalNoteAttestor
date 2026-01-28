import AppKit

enum ScreenCaptureError: Error, LocalizedError {
    case selectionCancelled
    case captureFailure(String)

    var errorDescription: String? {
        switch self {
        case .selectionCancelled:
            return "Selection was cancelled"
        case .captureFailure(let msg):
            return "Capture failed: \(msg)"
        }
    }
}

class ScreenCaptureManager {

    func captureSelection() async throws -> CGImage {
        let tempFile = FileManager.default.temporaryDirectory
            .appendingPathComponent("capture_\(UUID().uuidString).png")
        let filePath = tempFile.path

        // Run screencapture synchronously on background thread
        let success = await withCheckedContinuation { continuation in
            DispatchQueue.global(qos: .userInteractive).async {
                let task = Process()
                task.launchPath = "/usr/sbin/screencapture"
                task.arguments = ["-i", "-x", filePath]

                do {
                    try task.run()
                    task.waitUntilExit()
                    continuation.resume(returning: true)
                } catch {
                    continuation.resume(returning: false)
                }
            }
        }

        guard success else {
            throw ScreenCaptureError.captureFailure("Failed to run screencapture")
        }

        // Check if file exists (user didn't cancel with ESC)
        guard FileManager.default.fileExists(atPath: filePath) else {
            throw ScreenCaptureError.selectionCancelled
        }

        // Load image
        guard let nsImage = NSImage(contentsOfFile: filePath),
              let cgImage = nsImage.cgImage(forProposedRect: nil, context: nil, hints: nil) else {
            try? FileManager.default.removeItem(atPath: filePath)
            throw ScreenCaptureError.captureFailure("Failed to load captured image")
        }

        try? FileManager.default.removeItem(atPath: filePath)
        return cgImage
    }
}
