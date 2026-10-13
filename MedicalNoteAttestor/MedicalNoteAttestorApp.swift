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

        // The Settings scene provides the one Settings item: app menu > Settings… (⌘,).
        // (A second, custom "Settings..." command used to sit next to it; it called
        // showSettingsWindow:, which macOS 14+ ignores, so it did nothing. Removed.)
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
    let claudeClient = ClaudeAPIClient()
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
            .pasteAp:   { Task { @MainActor in HeidiSlotManager.shared.writeToClipboard(slot: 3) } },
            .captureFreed: { Task { @MainActor in await AppDelegate.shared?.performFreedCapture() } },
            .openPicker: { Task { @MainActor in await AppDelegate.shared?.openPickerManually() } }
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

        let changeCountBefore = NSPasteboard.general.changeCount
        let fullText = await heidiCopyService.copyFullDocument(delay: delay) ?? ""
        let clipboardChanged = NSPasteboard.general.changeCount != changeCountBefore

        let hpi = heidiCopyService.parseHPI(from: fullText)
        let ap  = heidiCopyService.parseAP(from: fullText)
        let captureId = slotManager.beginCapture()   // drops the previous patient's library text
        slotManager.isCapturing = false

        // Failed capture (copy didn't land, empty, or no sections): clear everything, say so.
        if CaptureGate.isFailure(text: fullText, clipboardChanged: clipboardChanged, hpi: hpi, ap: ap) {
            slotManager.markCaptureFailed()
            return
        }
        slotManager.hpiSlot = hpi
        slotManager.apSlot  = ap

        if ActionItemsPolicy.enabled(source: .heidi, heidiSetting: SettingsManager.shared.heidiActionItems) {
            Task { await slotManager.appendActionItems() }
        }
        await libraryAfterCapture(captureId: captureId)
    }

    // F7: Freed. Sterling clicks Freed's "Copy all" first; this sends NO keystrokes and only reads
    // the general pasteboard. Invalid or duplicate notes change nothing and show a short notice
    // (never pasteboard text). Freed's profile has no action items.
    @MainActor
    func performFreedCapture() async {
        let slotManager = HeidiSlotManager.shared
        let text = NSPasteboard.general.string(forType: .string) ?? ""
        switch FreedCapture.shared.process(raw: text) {
        case .invalid:
            NSSound(named: .init("Funk"))?.play()
            FailureHUD.show(FreedCapture.noticeInvalid)
        case .duplicate:
            FailureHUD.show(FreedCapture.noticeDuplicate, style: .info)
        case .ok(let slots):
            let captureId = slotManager.adoptFreed(slots)
            if ActionItemsPolicy.enabled(source: .freed, heidiSetting: SettingsManager.shared.heidiActionItems) {
                Task { await slotManager.appendActionItems() }
            }
            await libraryAfterCapture(captureId: captureId)
        }
    }

    /// After any successful capture, Heidi or Freed (whatever key is bound): open the picker only
    /// when the A&P shows a planned procedure (shared rule, local); otherwise a brief notice.
    /// "Open payer picker" (button or optional hotkey) always opens it manually.
    @MainActor
    func libraryAfterCapture(captureId: UUID) async {
        let library = LibraryStore.shared
        let slotManager = HeidiSlotManager.shared
        // Every exit publishes this capture's slots: at once without a planned procedure, or after
        // the picker -> Claude fill flow (also when the picker is skipped, the fill fails or is cancelled).
        defer { slotManager.publish(captureId) }
        guard library.enabled, library.hasLibrary, let ap = slotManager.apSlot, !ap.isEmpty else { return }
        let decision = MNACore.shared.pickerOnCapture(ap: ap)
        if decision.open {
            await runLibraryFlow(captureId: captureId)
        } else if let notice = decision.notice {
            slotManager.publish(captureId)
            NoPlannedNotice.show(notice) { WhyNoPickerWindow.show(rows: MNACore.shared.pickerExplain(ap: ap)) }
        }
    }

    /// Manual "Open payer picker" (button or optional hotkey): opens the picker for the current
    /// capture, Heidi or Freed, exactly like the automatic open (same flow, same capture id).
    @MainActor
    func openPickerManually() async {
        let slotManager = HeidiSlotManager.shared
        guard !slotManager.captureFailed, let captureId = slotManager.captureId, slotManager.apSlot != nil else {
            FailureHUD.show("Capture a note first, then open the payer picker.", style: .info)
            return
        }
        // The picker and fill change the slots: hold pastes until they're published again.
        slotManager.holdForProcessing(captureId)
        defer { slotManager.publish(captureId) }
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
        var exams = results.map(\.examText).filter { !$0.isEmpty }
        var dots = results.map(\.dotphrase).filter { !$0.isEmpty }
        var review: FillReview?
        // Opt-in Claude fill (off by default; user key only) on EVERY library insertion, from any path
        // and either source. Claude proposes values with quotes; the shared core verifies them and does
        // the substitution. Once the setting is on it never fails silently: a HUD (visible over any app)
        // and the main window say why it couldn't run. Failure leaves every blank as-is.
        if library.claudeFill {
            let templates = exams.map { FillTemplate(slot: "exam", text: $0) } + dots.map { FillTemplate(slot: "ap", text: $0) }
            let note = ["hpi": slotManager.hpiSlot ?? "",
                        "exam": slotManager.activeSource == .freed ? slotManager.freedExam : "",   // Heidi has no captured exam
                        "ap": ap]
            let outcome = await runClaudeFill(note: note, templates: templates)
            guard slotManager.captureId == captureId else { return }  // a newer capture arrived meanwhile
            if let texts = outcome.texts {
                exams = Array(texts.prefix(exams.count))
                dots = Array(texts.suffix(dots.count))
            }
            review = outcome.review
        }
        slotManager.setLibrarySelections(captureId: captureId, exams: exams, dotphrases: dots, planLine: planLine, review: review)
    }

    /// One Claude fill attempt. Returns the filled texts (nil = leave blanks as-is) and the review,
    /// and shows a HUD for progress, the summary, or the reason it couldn't run. Logs reasons and
    /// counts only (never note text, values or the key).
    @MainActor
    func runClaudeFill(note: [String: String], templates: [FillTemplate]) async -> (texts: [String]?, review: FillReview) {
        let core = MNACore.shared
        let progress = FillProgressPanel.shared
        func failed(_ reason: String, _ detail: Int? = nil, notice: String? = nil) -> (texts: [String]?, review: FillReview) {
            let text = notice ?? core.fillNotice(reason, detail)
            logger.info("claude fill: \(reason == "cancelled" ? "cancelled" : "unavailable", privacy: .public) (\(reason, privacy: .public)\(detail.map { " \($0)" } ?? "", privacy: .public))")
            progress.finish(text, stage: reason == "cancelled" ? "cancelled" : "error")
            return (nil, FillReview(notice: text))
        }
        let apiKey: String
        switch ClaudeKey.lookup() {
        case .found(let k): apiKey = k
        case .missing: return failed("no-key")
        case .unreadable(let status): return failed("key-unreadable", Int(status))
        }
        guard templates.contains(where: { $0.text.range(of: "___") != nil }) else {
            logger.info("claude fill: no blanks")
            return (nil, FillReview(notice: nil, summary: core.fillNotice("no-blanks")))
        }
        guard let body = core.fillRequestBody(note: note, templates: templates, model: core.fillModel, stream: true) else { return failed("request") }
        let total = core.fillBlankCount(templates: templates)
        // Streaming request: "Sending to Claude" -> "Claude is filling blanks (n of N)" -> "Checking values"
        // -> "Done: filled X of N" or the error. Cancel publishes with the library text unfilled.
        core.fillStreamBegin()
        var streamError: MNACore.StreamError?
        let client = claudeClient
        let task = Task { @MainActor in
            try await client.streamMessages(body: body, apiKey: apiKey) { line in
                guard let st = core.fillStreamFeed(line + "\n") else { return true }
                if let e = st.error { streamError = e }
                if st.n > 0 { progress.update(stage: "filling", text: core.fillProgress("filling", st.n, total), n: st.n, total: total) }
                return !st.done
            }
        }
        progress.start(text: core.fillProgress("sending"), total: total) { task.cancel() }
        do { try await task.value }
        catch let f as ClaudeFillFailure {
            if case .http(let code, let errBody) = f { return failed("http", code, notice: core.fillNotice("http", code, apiErrorBody: errBody)) }
            return failed(f.reason, f.detail)
        }
        catch { return failed(task.isCancelled ? "cancelled" : "network") }
        if task.isCancelled { return failed("cancelled") }
        if let e = streamError { return failed("stream-error", notice: core.fillStreamErrorNotice(type: e.type, message: e.message)) }
        progress.update(stage: "checking", text: core.fillProgress("checking"), n: total, total: total)
        guard let reply = core.fillStreamMessage(),
              let r = core.fillApply(note: note, templates: templates, response: reply), r.ok, let texts = r.texts else {
            return failed("malformed")
        }
        let c = r.counts
        logger.info("claude fill: \(c?.filled ?? 0, privacy: .public)/\(c?.blanks ?? 0, privacy: .public) filled, \(c?.rejected ?? 0, privacy: .public) rejected (\((r.rejectionReasons ?? []).joined(separator: "; "), privacy: .public))")
        progress.finish(core.fillProgress("done", c?.filled ?? 0, c?.blanks ?? total), stage: "done")
        return (texts, FillReview(notice: nil, summary: r.summary, flags: r.flags ?? [],
                                  templates: templates.indices.map { FillReview.Template(slot: templates[$0].slot, text: texts[$0], marks: r.marks?[$0] ?? []) }))
    }
}

