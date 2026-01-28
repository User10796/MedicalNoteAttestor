import SwiftUI
import Carbon

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
    private var hpiEventHandler: EventHandlerRef?
    private var apEventHandler: EventHandlerRef?
    private let heidiCopyService = HeidiCopyService()
    private var settingsWindow: NSWindow?

    func applicationDidFinishLaunching(_ notification: Notification) {
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

    private func registerGlobalHotkeys() {
        guard SettingsManager.shared.heidiCopyEnabled else { return }

        let hpiKeyCode = SettingsManager.shared.hpiHotkey.keyCode
        let apKeyCode = SettingsManager.shared.apHotkey.keyCode

        // Register HPI hotkey
        registerHotkey(
            keyCode: hpiKeyCode,
            id: 1,
            handler: &hpiEventHandler
        ) { [weak self] in
            self?.heidiCopyService.extractAndCopySection(.hpi)
        }

        // Register A&P hotkey
        registerHotkey(
            keyCode: apKeyCode,
            id: 2,
            handler: &apEventHandler
        ) { [weak self] in
            self?.heidiCopyService.extractAndCopySection(.assessmentPlan)
        }
    }

    private func registerHotkey(keyCode: UInt32, id: UInt32, handler: inout EventHandlerRef?, action: @escaping () -> Void) {
        var hotKeyID = EventHotKeyID()
        hotKeyID.signature = OSType(id)
        hotKeyID.id = id

        var hotKeyRef: EventHotKeyRef?
        let status = RegisterEventHotKey(
            keyCode,
            0, // No modifiers
            hotKeyID,
            GetApplicationEventTarget(),
            0,
            &hotKeyRef
        )

        if status == noErr {
            // Store the action in a static dictionary keyed by id
            HotkeyActions.shared.actions[id] = action

            // Install event handler
            var eventType = EventTypeSpec(eventClass: OSType(kEventClassKeyboard), eventKind: UInt32(kEventHotKeyPressed))
            InstallEventHandler(
                GetApplicationEventTarget(),
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
                &handler
            )
        }
    }

    private func unregisterGlobalHotkeys() {
        if let handler = hpiEventHandler {
            RemoveEventHandler(handler)
            hpiEventHandler = nil
        }
        if let handler = apEventHandler {
            RemoveEventHandler(handler)
            apEventHandler = nil
        }
        HotkeyActions.shared.actions.removeAll()
    }
}

// Helper class to store hotkey actions (needed for C callback)
class HotkeyActions {
    static let shared = HotkeyActions()
    var actions: [UInt32: () -> Void] = [:]
}
