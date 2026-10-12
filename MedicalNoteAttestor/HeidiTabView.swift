import SwiftUI

struct HeidiTabView: View {
    @ObservedObject var slotManager = HeidiSlotManager.shared
    @ObservedObject var settings = SettingsManager.shared

    var body: some View {
        VStack(spacing: 8) {
            // Slot order: HPI → Exam → A/P
            SlotCard(label: "HPI",
                     hotkeyLabel: settings.pasteHotkey1,
                     content: slotManager.hpiSlot,
                     isHighlighted: slotManager.lastPastedSlot == 1,
                     isLoading: false,
                     emptyLabel: "Empty",
                     onCopy: { slotManager.writeToClipboard(slot: 1) })

            SlotCard(label: "Exam",
                     hotkeyLabel: settings.pasteHotkey2,
                     content: slotManager.composedExam,
                     isHighlighted: slotManager.lastPastedSlot == 2,
                     isLoading: false,
                     emptyLabel: "Configure in Settings",
                     onCopy: { slotManager.writeToClipboard(slot: 2) })

            SlotCard(label: "A/P",
                     hotkeyLabel: settings.pasteHotkey3,
                     content: slotManager.composedAP,
                     isHighlighted: slotManager.lastPastedSlot == 3,
                     isLoading: slotManager.isLoadingBullets,
                     emptyLabel: "Empty",
                     onCopy: { slotManager.writeToClipboard(slot: 3) })

            Button(action: {
                Task { await AppDelegate.shared?.performCapture() }
            }) {
                Label(slotManager.isCapturing
                        ? "Capturing…"
                        : "Capture  \(settings.captureHotkey)",
                      systemImage: "doc.on.clipboard")
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 6)
            }
            .buttonStyle(.borderedProminent)
            .disabled(slotManager.isCapturing)

            HStack {
                Button("Clear") { slotManager.clearNoteSlots() }
                    .buttonStyle(.bordered)
                    .frame(maxWidth: .infinity)
                Button("Open payer picker") { Task { await AppDelegate.shared?.openPickerManually() } }
                    .buttonStyle(.bordered)
                    .frame(maxWidth: .infinity)
                    .help("Open the payer and procedure picker for the current Freed capture")
            }

            if slotManager.captureFailed {
                Text("\u{26A0}\u{FE0F} " + CaptureGate.failureMessage)
                    .font(.caption).bold().foregroundColor(.white)
                    .padding(6).frame(maxWidth: .infinity)
                    .background(Color.red.opacity(0.85)).cornerRadius(4)
            }

            if let review = slotManager.fillReview { FillReviewView(review: review) }

            if slotManager.libraryAdded {
                Text("Library text added to Exam / A&P")
                    .font(.caption2).foregroundColor(.green)
            }

            Text("\(settings.pasteHotkey1) HPI  ·  "
               + "\(settings.pasteHotkey2) Exam  ·  "
               + "\(settings.pasteHotkey3) A/P")
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

/// Claude fill review (app only; the pasted text stays plain). Explicit fills green, inferred yellow,
/// derived blue, unfilled blanks red; hover a filled value to see its source quote (and the conversion
/// for derived values); criteria warnings above.
struct FillReviewView: View {
    let review: FillReview

    private func highlighted(_ t: FillReview.Template) -> AttributedString {
        var out = AttributedString()
        let u = Array(t.text.utf16)
        var pos = 0
        func piece(_ a: Int, _ b: Int) -> AttributedString {
            AttributedString(String(utf16CodeUnits: Array(u[max(0, a)..<min(u.count, b)]), count: max(0, min(u.count, b) - max(0, a))))
        }
        for m in t.marks where m.start >= pos && m.end <= u.count {
            out += piece(pos, m.start)
            var seg = piece(m.start, m.end)
            seg.backgroundColor = m.kind == "explicit" ? .green.opacity(0.25) : m.kind == "inferred" ? .yellow.opacity(0.35)
                : m.kind == "derived" ? .blue.opacity(0.2) : .red.opacity(0.2)
            out += seg
            pos = m.end
        }
        out += piece(pos, u.count)
        return out
    }

    private func label(_ m: FillMark) -> String {
        switch m.kind {
        case "inferred": return "inferred: "
        case "derived": return "derived: "
        default: return "from note: "
        }
    }

    private func tooltip(_ m: FillMark) -> String {
        let quote = "\u{201C}" + (m.quote ?? "") + "\u{201D}"
        guard let conversion = m.conversion else { return quote }
        return quote + " (" + conversion + ")"
    }

    private func value(_ t: FillReview.Template, _ m: FillMark) -> String {
        let u = Array(t.text.utf16)
        guard m.start >= 0, m.end <= u.count, m.start < m.end else { return "" }
        return String(utf16CodeUnits: Array(u[m.start..<m.end]), count: m.end - m.start)
    }

    var body: some View {
        DisclosureGroup(review.notice ?? review.summary ?? "Claude fill") {
            VStack(alignment: .leading, spacing: 4) {
                ForEach(Array(review.flags.enumerated()), id: \.offset) { _, f in
                    Text("\u{26A0}\u{FE0F} " + f.message).font(.caption2).foregroundColor(.orange)
                }
                ForEach(Array(review.templates.enumerated()), id: \.offset) { _, t in
                    Text(highlighted(t)).font(.system(size: 10, design: .monospaced)).textSelection(.enabled)
                    ForEach(Array(t.marks.filter { $0.kind != "unfilled" }.enumerated()), id: \.offset) { _, m in
                        Text(label(m) + value(t, m))
                            .font(.caption2).foregroundColor(.secondary)
                            .help(tooltip(m))
                    }
                }
            }
        }
        .font(.caption)
    }
}
