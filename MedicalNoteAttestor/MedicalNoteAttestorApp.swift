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
    let hotkeys = HotkeyManager(registrar: CarbonHotkeyRegistrar())
    let heidiCopyService = HeidiCopyService()
    private var sessionLastPayer: String?   // hint only; never pre-selected
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

        // Register global hotkeys; HotkeyManager re-registers on every UserDefaults change
        // (Settings > Hotkeys), so rebinding applies without a restart.
        hotkeys.start(handlers: [
            .capture:   { Task { @MainActor in await AppDelegate.shared?.performCapture() } },
            .pasteHpi:  { Task { @MainActor in HeidiSlotManager.shared.writeToClipboard(slot: 1) } },
            .pasteExam: { Task { @MainActor in HeidiSlotManager.shared.writeToClipboard(slot: 2) } },
            .pasteAp:   { Task { @MainActor in HeidiSlotManager.shared.writeToClipboard(slot: 3) } }
        ])

        // Criteria library: local cache/snapshot now, live refresh at launch and every 6 h.
        Task { @MainActor in LibraryStore.shared.start() }
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
        hotkeys.suspend()
    }

    func openSettings() {
        NSApp.sendAction(Selector(("showSettingsWindow:")), to: nil, from: nil)
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

    // MARK: - Capture

    @MainActor
    func performCapture() async {
        let slotManager = HeidiSlotManager.shared
        let delay = 0.1

        slotManager.isCapturing = true

        let fullText = await heidiCopyService.copyFullDocument(delay: delay) ?? ""

        slotManager.hpiSlot = heidiCopyService.parseHPI(from: fullText)
        slotManager.apSlot  = heidiCopyService.parseAP(from: fullText)
        let captureId = slotManager.beginCapture()   // drops the previous patient's library text

        slotManager.isCapturing = false

        Task { await slotManager.appendActionItems() }
        await runLibraryFlow(captureId: captureId)
    }

    // Capture -> payer picker -> detection -> library selections (source-agnostic: takes the
    // A&P text from whichever scribe filled the slots). Composition happens at paste time so the
    // A&P includes the action-item bullets that arrive asynchronously. No network, no LLM.
    @MainActor
    func runLibraryFlow(captureId: UUID) async {
        let slotManager = HeidiSlotManager.shared
        let library = LibraryStore.shared
        guard library.enabled, library.hasLibrary, let ap = slotManager.apSlot, !ap.isEmpty else { return }
        let core = MNACore.shared
        let detection = core.detect(ap: ap)
        guard let answer = await PayerPickerController.shared.present(
            detection: detection, recents: library.recents, sessionLastPayer: sessionLastPayer) else { return } // Skip
        guard slotManager.captureId == captureId else { return }  // a newer capture arrived meanwhile
        sessionLastPayer = answer.payerId
        library.recents = core.recordRecentPayer(recents: library.recents, payerId: answer.payerId)
        let results = core.resolve(payerId: answer.payerId, rows: answer.rows).filter { $0.insert }
        let planLine = answer.rows.first(where: { $0.checked && $0.line != nil })?.line
        slotManager.setLibrarySelections(captureId: captureId,
                                         exams: results.map(\.examText).filter { !$0.isEmpty },
                                         dotphrases: results.map(\.dotphrase).filter { !$0.isEmpty },
                                         planLine: planLine)
    }
}
