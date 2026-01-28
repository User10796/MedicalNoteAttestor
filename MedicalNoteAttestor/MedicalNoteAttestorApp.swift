import SwiftUI
import Carbon
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
    private var eventHandler: EventHandlerRef?
    private var hpiHotKeyRef: EventHotKeyRef?
    private var apHotKeyRef: EventHotKeyRef?
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
        guard SettingsManager.shared.heidiCopyEnabled else { return }

        let hpiKeyCode = SettingsManager.shared.hpiHotkey.keyCode
        let apKeyCode = SettingsManager.shared.apHotkey.keyCode

        // Register HPI hotkey (id: 1)
        var hpiHotKeyID = EventHotKeyID()
        hpiHotKeyID.signature = OSType(0x4D4E4131) // 'MNA1' in hex
        hpiHotKeyID.id = 1

        let hpiStatus = RegisterEventHotKey(
            hpiKeyCode,
            0, // No modifiers
            hpiHotKeyID,
            GetEventDispatcherTarget(),
            0,
            &hpiHotKeyRef
        )

        if hpiStatus == noErr {
            HotkeyActions.shared.actions[1] = { [weak self] in
                logger.info("HPI hotkey pressed!")
                self?.heidiCopyService.extractAndCopySection(.hpi)
            }
            logger.info("HPI hotkey registered successfully")
        } else {
            logger.error("Failed to register HPI hotkey: \(hpiStatus)")
        }

        // Register A&P hotkey (id: 2)
        var apHotKeyID = EventHotKeyID()
        apHotKeyID.signature = OSType(0x4D4E4132) // 'MNA2' in hex
        apHotKeyID.id = 2

        let apStatus = RegisterEventHotKey(
            apKeyCode,
            0, // No modifiers
            apHotKeyID,
            GetEventDispatcherTarget(),
            0,
            &apHotKeyRef
        )

        if apStatus == noErr {
            HotkeyActions.shared.actions[2] = { [weak self] in
                logger.info("A&P hotkey pressed!")
                self?.heidiCopyService.extractAndCopySection(.assessmentPlan)
            }
            logger.info("A&P hotkey registered successfully")
        } else {
            logger.error("Failed to register A&P hotkey: \(apStatus)")
        }
    }

    private func unregisterGlobalHotkeys() {
        if let ref = hpiHotKeyRef {
            UnregisterEventHotKey(ref)
            hpiHotKeyRef = nil
        }
        if let ref = apHotKeyRef {
            UnregisterEventHotKey(ref)
            apHotKeyRef = nil
        }
        HotkeyActions.shared.actions.removeAll()
    }
}

// Helper class to store hotkey actions (needed for C callback)
class HotkeyActions {
    static let shared = HotkeyActions()
    var actions: [UInt32: () -> Void] = [:]
}
