import AppKit

/// A small floating message near the mouse pointer (the macOS twin of the AHK tooltip), so a
/// failed capture is seen even when MNA is behind Heidi/Cerner or on another tab.
@MainActor
enum FailureHUD {
    private static var panel: NSPanel?

    enum Style { case error, info }

    static func show(_ text: String, seconds: Double = 4, style: Style = .error) {
        panel?.close()
        let label = NSTextField(labelWithString: text)
        label.font = .systemFont(ofSize: 13, weight: .semibold)
        label.textColor = .white
        label.sizeToFit()
        let size = NSSize(width: label.frame.width + 24, height: label.frame.height + 14)
        let mouse = NSEvent.mouseLocation
        let p = NSPanel(contentRect: NSRect(x: mouse.x + 12, y: mouse.y - size.height - 12, width: size.width, height: size.height),
                        styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
        p.level = .statusBar
        p.isOpaque = false
        p.backgroundColor = .clear
        p.ignoresMouseEvents = true
        p.hasShadow = true
        let bg = NSView(frame: NSRect(origin: .zero, size: size))
        bg.wantsLayer = true
        bg.layer?.backgroundColor = (style == .error ? NSColor.systemRed : NSColor.darkGray).withAlphaComponent(0.92).cgColor
        bg.layer?.cornerRadius = 6
        label.frame.origin = NSPoint(x: 12, y: 7)
        bg.addSubview(label)
        p.contentView = bg
        p.orderFrontRegardless()
        panel = p
        DispatchQueue.main.asyncAfter(deadline: .now() + seconds) {
            if panel === p { p.close(); panel = nil }
        }
    }
}

import SwiftUI

/// A borderless floating panel that can take clicks (Cancel, Why no picker?) without activating MNA,
/// so the user stays in Freed, Heidi or Cerner.
private final class ClickablePanel: NSPanel {
    override var canBecomeKey: Bool { true }
}

private func makeFloatingPanel<V: View>(size: NSSize, origin: NSPoint, root: V) -> NSPanel {
    let p = ClickablePanel(contentRect: NSRect(origin: origin, size: size),
                           styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
    p.level = .statusBar
    p.isOpaque = false
    p.backgroundColor = .clear
    p.hasShadow = true
    p.hidesOnDeactivate = false
    p.becomesKeyOnlyIfNeeded = true
    p.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
    let host = NSHostingView(rootView: root)
    host.frame = NSRect(origin: .zero, size: size)
    p.contentView = host
    return p
}

// MARK: - Claude fill progress (over any app)

@MainActor
final class FillProgressModel: ObservableObject {
    @Published var text = ""
    @Published var stage = "sending"
    @Published var n = 0
    @Published var total = 0
    @Published var startedAt = Date()
    @Published var endedAt: Date?
    @Published var cancelling = false
}

private struct FillProgressView: View {
    @ObservedObject var model: FillProgressModel
    let cancel: () -> Void
    let close: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("Claude fill").font(.caption2).foregroundColor(.white.opacity(0.7))
            Text(model.text)
                .font(.system(size: 13, weight: .semibold))
                .foregroundColor(model.stage == "error" || model.stage == "cancelled" ? Color(red: 1, green: 0.55, blue: 0.5)
                                 : model.stage == "done" ? Color(red: 0.65, green: 0.85, blue: 0.65) : .white)
                .lineLimit(4).fixedSize(horizontal: false, vertical: true)
            if model.total > 0 && model.endedAt == nil {
                ProgressView(value: Double(min(model.n, model.total)), total: Double(model.total)).tint(.blue)
            }
            HStack {
                TimelineView(.periodic(from: .now, by: 0.5)) { ctx in
                    Text("\(Int((model.endedAt ?? ctx.date).timeIntervalSince(model.startedAt))) s")
                        .font(.caption.monospacedDigit()).foregroundColor(.white.opacity(0.7))
                }
                Spacer()
                if model.endedAt == nil {
                    Button(model.cancelling ? "Cancelling\u{2026}" : "Cancel", action: cancel)
                        .disabled(model.cancelling)
                        .help("Stop; paste the library text with its blanks unfilled")
                } else {
                    Button("Close", action: close)
                }
            }
        }
        .padding(12)
        .frame(width: 340, alignment: .leading)
        .background(RoundedRectangle(cornerRadius: 8).fill(Color(white: 0.17).opacity(0.96)))
    }
}

/// Stages: "Sending to Claude" -> "Claude is filling blanks (n of N)" -> "Checking values" ->
/// "Done: filled X of N" or the error. Elapsed time; Cancel publishes with library text unfilled.
@MainActor
final class FillProgressPanel {
    static let shared = FillProgressPanel()
    private var panel: NSPanel?
    private let model = FillProgressModel()
    private var onCancel: (() -> Void)?
    private var hideWork: DispatchWorkItem?

    func start(text: String, total: Int, onCancel: @escaping () -> Void) {
        hideWork?.cancel()
        model.text = text; model.stage = "sending"; model.n = 0; model.total = total
        model.startedAt = Date(); model.endedAt = nil; model.cancelling = false
        self.onCancel = onCancel
        show()
    }
    func update(stage: String, text: String, n: Int, total: Int) {
        guard model.endedAt == nil else { return }
        model.stage = stage; model.text = text; model.n = n; model.total = total
        show()
    }
    /// Done, error or cancelled. Also shown when the fill couldn't start (no key): never silent.
    func finish(_ text: String, stage: String) {
        if model.endedAt != nil || panel == nil { model.startedAt = Date() }
        model.text = text; model.stage = stage; model.endedAt = Date(); model.cancelling = false
        onCancel = nil
        show()
        hideWork?.cancel()
        let w = DispatchWorkItem { [weak self] in self?.close() }
        hideWork = w
        DispatchQueue.main.asyncAfter(deadline: .now() + (stage == "done" ? 2.5 : 8), execute: w)
    }
    private func cancel() {
        model.cancelling = true
        onCancel?()
        onCancel = nil
    }
    private func close() { panel?.close(); panel = nil }
    private func show() {
        if panel == nil {
            let size = NSSize(width: 340, height: 120)
            let vf = (NSScreen.main ?? NSScreen.screens.first)?.visibleFrame ?? NSRect(x: 0, y: 0, width: 800, height: 600)
            panel = makeFloatingPanel(size: size, origin: NSPoint(x: vf.maxX - size.width - 16, y: vf.minY + 16),
                                      root: FillProgressView(model: model, cancel: { [weak self] in self?.cancel() },
                                                             close: { [weak self] in self?.close() }))
        }
        panel?.orderFrontRegardless()
    }
}

// MARK: - "No planned procedure detected" + Why no picker?

private struct NoPlannedNoticeView: View {
    let text: String
    let why: () -> Void
    var body: some View {
        HStack(spacing: 10) {
            Text(text).font(.system(size: 13, weight: .semibold)).foregroundColor(.white)
                .lineLimit(3).fixedSize(horizontal: false, vertical: true)
            Button("Why no picker?", action: why)
        }
        .padding(10)
        .frame(width: 420, alignment: .leading)
        .background(RoundedRectangle(cornerRadius: 6).fill(Color(white: 0.25).opacity(0.95)))
    }
}

/// A brief, non-blocking notice near the pointer with a "Why no picker?" button.
@MainActor
enum NoPlannedNotice {
    private static var panel: NSPanel?
    static func show(_ text: String, why: @escaping () -> Void) {
        panel?.close()
        let size = NSSize(width: 420, height: 56)
        let mouse = NSEvent.mouseLocation
        let p = makeFloatingPanel(size: size, origin: NSPoint(x: mouse.x + 12, y: mouse.y - size.height - 12),
                                  root: NoPlannedNoticeView(text: text, why: { panel?.close(); panel = nil; why() }))
        p.orderFrontRegardless()
        panel = p
        DispatchQueue.main.asyncAfter(deadline: .now() + 8) { if panel === p { p.close(); panel = nil } }
    }
}

private struct WhyNoPickerView: View {
    let rows: [MNACore.ExplainRow]
    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("A&P lines checked for a planned procedure").font(.headline)
            Text("Shown here only; never saved or sent.").font(.caption).foregroundColor(.secondary)
            ScrollView {
                VStack(alignment: .leading, spacing: 6) {
                    if rows.isEmpty { Text("No A&P text in the current capture.").foregroundColor(.secondary) }
                    ForEach(rows) { r in
                        HStack(alignment: .top, spacing: 6) {
                            Rectangle().fill(r.planned ? Color.green : r.evaluated ? Color.orange : Color.gray.opacity(0.4)).frame(width: 3)
                            VStack(alignment: .leading, spacing: 2) {
                                Text(r.line).font(.system(size: 11, design: .monospaced)).textSelection(.enabled)
                                Text((r.planned ? "\u{2713} counts: " : r.evaluated ? "\u{2717} " : "skipped: ") + r.reason)
                                    .font(.caption).foregroundColor(.secondary)
                            }
                        }
                    }
                }.frame(maxWidth: .infinity, alignment: .leading)
            }
        }
        .padding(14)
        .frame(minWidth: 460, minHeight: 260)
    }
}

/// "Why no picker?": which A&P lines were evaluated and why each did or didn't qualify. Local only.
@MainActor
enum WhyNoPickerWindow {
    private static var window: NSPanel?
    static func show(rows: [MNACore.ExplainRow]) {
        window?.close()
        let w = NSPanel(contentRect: NSRect(x: 0, y: 0, width: 520, height: 360),
                        styleMask: [.titled, .closable, .resizable, .utilityWindow], backing: .buffered, defer: false)
        w.title = "Why no picker?"
        w.level = .floating
        w.isReleasedWhenClosed = false
        w.contentView = NSHostingView(rootView: WhyNoPickerView(rows: rows))
        w.center()
        w.orderFrontRegardless()
        window = w
    }
}
