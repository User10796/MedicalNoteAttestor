import SwiftUI

struct HeidiTabView: View {
    @ObservedObject var slotManager = HeidiSlotManager.shared
    @ObservedObject var settings = SettingsManager.shared

    var body: some View {
        VStack(spacing: 8) {
            // Slot order: HPI → Exam → A/P
            SlotCard(label: "HPI",
                     hotkeyLabel: settings.pasteHotkey1.rawValue,
                     content: slotManager.hpiSlot,
                     isHighlighted: slotManager.lastPastedSlot == 1,
                     isLoading: false,
                     emptyLabel: "Empty",
                     onCopy: { slotManager.writeToClipboard(slot: 1) })

            SlotCard(label: "Exam",
                     hotkeyLabel: settings.pasteHotkey2.rawValue,
                     content: slotManager.examSlot.isEmpty ? nil : slotManager.examSlot,
                     isHighlighted: slotManager.lastPastedSlot == 2,
                     isLoading: false,
                     emptyLabel: "Configure in Settings",
                     onCopy: { slotManager.writeToClipboard(slot: 2) })

            SlotCard(label: "A/P",
                     hotkeyLabel: settings.pasteHotkey3.rawValue,
                     content: slotManager.apSlot,
                     isHighlighted: slotManager.lastPastedSlot == 3,
                     isLoading: slotManager.isLoadingBullets,
                     emptyLabel: "Empty",
                     onCopy: { slotManager.writeToClipboard(slot: 3) })

            Button(action: {
                Task { await AppDelegate.shared?.performCapture() }
            }) {
                Label(slotManager.isCapturing
                        ? "Capturing…"
                        : "Capture  \(settings.captureHotkey.rawValue)",
                      systemImage: "doc.on.clipboard")
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 6)
            }
            .buttonStyle(.borderedProminent)
            .disabled(slotManager.isCapturing)

            Button("Clear") { slotManager.clearNoteSlots() }
                .buttonStyle(.bordered)
                .frame(maxWidth: .infinity)

            Text("\(settings.pasteHotkey1.rawValue) HPI  ·  "
               + "\(settings.pasteHotkey2.rawValue) Exam  ·  "
               + "\(settings.pasteHotkey3.rawValue) A/P")
                .font(.caption2)
                .foregroundColor(.secondary)
        }
        .padding(12)
    }
}

struct SlotCard: View {
    let label: String
    let hotkeyLabel: String
    let content: String?
    let isHighlighted: Bool
    let isLoading: Bool
    let emptyLabel: String
    let onCopy: () -> Void

    var body: some View {
        HStack(alignment: .top, spacing: 8) {
            Group {
                if isLoading {
                    ProgressView().scaleEffect(0.6).frame(width: 16, height: 16)
                } else {
                    Image(systemName: content != nil ? "checkmark.circle.fill" : "circle")
                        .foregroundColor(content != nil ? .green : .secondary)
                        .frame(width: 16)
                }
            }
            .padding(.top, 2)

            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: 4) {
                    Text(label)
                        .font(.caption).fontWeight(.semibold).foregroundColor(.secondary)
                    Text(hotkeyLabel)
                        .font(.caption2)
                        .padding(.horizontal, 4).padding(.vertical, 1)
                        .background(Color.secondary.opacity(0.15))
                        .cornerRadius(3)
                }
                if isLoading {
                    Text("Loading action items…")
                        .font(.caption2).foregroundColor(.secondary).italic()
                } else if let text = content {
                    Text(String(text.prefix(80)) + (text.count > 80 ? "…" : ""))
                        .font(.caption2).lineLimit(2)
                } else {
                    Text(emptyLabel)
                        .font(.caption2).foregroundColor(.secondary).italic()
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)

            Button("Copy", action: onCopy)
                .font(.caption2).buttonStyle(.bordered).controlSize(.mini)
        }
        .padding(8)
        .background(isHighlighted
            ? Color.accentColor.opacity(0.12)
            : Color(NSColor.controlBackgroundColor))
        .cornerRadius(6)
        .animation(.easeOut(duration: 0.3), value: isHighlighted)
    }
}
