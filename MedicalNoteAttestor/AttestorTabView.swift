import SwiftUI

struct AttestorTabView: View {
    @StateObject private var viewModel = AttestorViewModel()

    var body: some View {
        VStack(spacing: 12) {
            // Header with status
            HStack {
                Text("Medical Note Attestor")
                    .font(.headline)
                Spacer()
                if viewModel.isProcessing {
                    ProgressView()
                        .scaleEffect(0.7)
                }
            }

            // Status message
            if !viewModel.statusMessage.isEmpty {
                Text(viewModel.statusMessage)
                    .font(.caption)
                    .foregroundColor(.secondary)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }

            // Select button (primary action) - clears output when clicked
            Button(action: {
                viewModel.clearOutput()  // Clear textbox on Select
                viewModel.startScreenSelection()
            }) {
                HStack {
                    Image(systemName: "rectangle.dashed")
                    Text("Select")
                }
                .frame(maxWidth: .infinity)
                .padding(.vertical, 8)
            }
            .buttonStyle(.borderedProminent)
            .disabled(viewModel.isProcessing)
            .keyboardShortcut("s", modifiers: [.command])

            // Scrollable text display
            ScrollView {
                Text(viewModel.outputText)
                    .font(.system(size: 11, design: .monospaced))
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .textSelection(.enabled)
                    .padding(8)
            }
            .frame(maxHeight: .infinity)
            .background(Color(NSColor.textBackgroundColor))
            .cornerRadius(6)
            .overlay(
                RoundedRectangle(cornerRadius: 6)
                    .stroke(Color.gray.opacity(0.3), lineWidth: 1)
            )

            // Error display
            if let error = viewModel.errorMessage {
                Text(error)
                    .font(.caption)
                    .foregroundColor(.red)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }

            // Bottom controls
            HStack {
                Toggle("Auto-copy", isOn: $viewModel.autoCopy)
                    .toggleStyle(.checkbox)
                    .font(.caption)

                Spacer()

                Button(action: { viewModel.copyToClipboard() }) {
                    HStack(spacing: 4) {
                        Image(systemName: "doc.on.doc")
                        Text("Copy")
                    }
                    .font(.caption)
                }
                .keyboardShortcut("c", modifiers: [.command, .shift])

                Button(action: { viewModel.clearOutput() }) {
                    HStack(spacing: 4) {
                        Image(systemName: "trash")
                        Text("Clear")
                    }
                    .font(.caption)
                }
            }
        }
        .padding(12)
    }
}
