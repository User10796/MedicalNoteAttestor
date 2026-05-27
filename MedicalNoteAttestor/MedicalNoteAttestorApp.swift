import SwiftUI
import Carbon
import AppKit
import os.log

private let logger = Logger(subsystem: "com.user.medicalnoteattestor", category: "App")

@main
struct MedicalNoteAttestorApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) var appDelegate

    var body: some Scene {
        WindowGroup {
            ContentView()
        }
        .windowStyle(.hiddenTitleBar)
        .windowResizability(.contentMinSize)
        .defaultPosition(.topTrailing)
        .commands {
            CommandGroup(after: .appSettings) {
                Button("Settings...") {
                    appDelegate.openSettings()
                }
                .keyboardShortcut(",", modifiers: .command)
            }
        }

        Settings {
            SettingsView()
        }
    }
}

class AppDelegate: NSObject, NSApplicationDelegate {
    static weak var shared: AppDelegate?

    private var eventHandler: EventHandlerRef?
    private var captureHotKeyRef: EventHotKeyRef?
    private var paste1HotKeyRef: EventHotKeyRef?
    private var paste2HotKeyRef: EventHotKeyRef?
    private var paste3HotKeyRef: EventHotKeyRef?
    let heidiCopyService = HeidiCopyService()
    private var settingsWindow: NSWindow?

    func applicationDidFinishLaunching(_ notification: Notification) {
        AppDelegate.shared = self

        // Set window to floating level (always on top) and make resizable
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.1) {
            if let window = NSApplication.shared.windows.first {
                window.level = .floating
                window.title = "Medical Note Attestor"
                window.styleMask.insert(.titled)
                window.styleMask.insert(.closable)
                window.styleMask.insert(.miniaturizable)
                window.styleMask.insert(.resizable)
                window.titlebarAppearsTransparent = true
                window.isMovableByWindowBackground = true
                window.minSize = NSSize(width: 180, height: 120)
            }
        }

        // Check and request accessibility permissions
        checkAccessibilityPermissions()

        // Install the event handler once
        installEventHandler()

        // Register global hotkeys
        registerGlobalHotkeys()

        // Listen for settings changes to re-register hotkeys
        NotificationCenter.default.addObserver(
            self,
            selector: #selector(settingsChanged),
            name: UserDefaults.didChangeNotification,
            object: nil
        )
    }

    private func checkAccessibilityPermissions() {
        let options = [kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true] as CFDictionary
        let trusted = AXIsProcessTrustedWithOptions(options)
        if trusted {
            logger.info("Accessibility permissions granted")
        } else {
            logger.warning("Accessibility permissions not granted. Hotkeys may not work.")
        }
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
        return true
    }

    func applicationWillTerminate(_ notification: Notification) {
        unregisterGlobalHotkeys()
    }

    func openSettings() {
        NSApp.sendAction(Selector(("showSettingsWindow:")), to: nil, from: nil)
    }

    @objc private func settingsChanged() {
        // Re-register hotkeys when settings change
        unregisterGlobalHotkeys()
        registerGlobalHotkeys()
    }

    // MARK: - Global Hotkey Registration

    private func installEventHandler() {
        var eventType = EventTypeSpec(
            eventClass: OSType(kEventClassKeyboard),
            eventKind: UInt32(kEventHotKeyPressed)
        )

        let status = InstallEventHandler(
            GetEventDispatcherTarget(),
            { (_, event, _) -> OSStatus in
                var hotKeyID = EventHotKeyID()
                GetEventParameter(
                    event,
                    EventParamName(kEventParamDirectObject),
                    EventParamType(typeEventHotKeyID),
                    nil,
                    MemoryLayout<EventHotKeyID>.size,
                    nil,
                    &hotKeyID
                )
                HotkeyActions.shared.actions[hotKeyID.id]?()
                return noErr
            },
            1,
            &eventType,
            nil,
            &eventHandler
        )

        if status == noErr {
            logger.info("Event handler installed successfully")
        } else {
            logger.error("Failed to install event handler: \(status)")
        }
    }

    private func registerGlobalHotkeys() {
        let settings = SettingsManager.shared

        @discardableResult
        func reg(_ id: UInt32, _ sig: OSType, _ key: UInt32, _ action: @escaping () -> Void) -> EventHotKeyRef? {
            var hkID = EventHotKeyID()
            hkID.signature = sig
            hkID.id = id
            var ref: EventHotKeyRef?
            RegisterEventHotKey(key, 0, hkID, GetEventDispatcherTarget(), 0, &ref)
            HotkeyActions.shared.actions[id] = action
            return ref
        }

        captureHotKeyRef = reg(1, OSType(0x4D4E4131), settings.captureHotkey.keyCode) {
            Task { @MainActor in await AppDelegate.shared?.performCapture() }
        }
        paste1HotKeyRef = reg(2, OSType(0x4D4E4132), settings.pasteHotkey1.keyCode) {
            Task { @MainActor in HeidiSlotManager.shared.writeToClipboard(slot: 1) }
        }
        paste2HotKeyRef = reg(3, OSType(0x4D4E4133), settings.pasteHotkey2.keyCode) {
            Task { @MainActor in HeidiSlotManager.shared.writeToClipboard(slot: 2) }
        }
        paste3HotKeyRef = reg(4, OSType(0x4D4E4134), settings.pasteHotkey3.keyCode) {
            Task { @MainActor in HeidiSlotManager.shared.writeToClipboard(slot: 3) }
        }
    }

    private func unregisterGlobalHotkeys() {
        for ref in [captureHotKeyRef, paste1HotKeyRef, paste2HotKeyRef, paste3HotKeyRef] {
            if let r = ref { UnregisterEventHotKey(r) }
        }
        captureHotKeyRef = nil
        paste1HotKeyRef  = nil
        paste2HotKeyRef  = nil
        paste3HotKeyRef  = nil
        HotkeyActions.shared.actions.removeAll()
    }

    // MARK: - Capture

    @MainActor
    func performCapture() async {
        let slotManager = HeidiSlotManager.shared
        let delay = 0.1

        slotManager.isCapturing = true

        let fullText = await heidiCopyService.copyFullDocument(delay: delay) ?? ""

        slotManager.hpiSlot = heidiCopyService.parseHPI(from: fullText)
        slotManager.apSlot  = heidiCopyService.parseAP(from: fullText)

        slotManager.isCapturing = false

        Task { await slotManager.appendActionItems() }
    }
}

// Helper class to store hotkey actions (needed for C callback)
class HotkeyActions {
    static let shared = HotkeyActions()
    var actions: [UInt32: () -> Void] = [:]
}
