import AppKit

/// A small floating message near the mouse pointer (the macOS twin of the AHK tooltip), so a
/// failed capture is seen even when MNA is behind Heidi/Cerner or on another tab.
@MainActor
enum FailureHUD {
    private static var panel: NSPanel?

    static func show(_ text: String, seconds: Double = 4) {
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
        bg.layer?.backgroundColor = NSColor.systemRed.withAlphaComponent(0.92).cgColor
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
