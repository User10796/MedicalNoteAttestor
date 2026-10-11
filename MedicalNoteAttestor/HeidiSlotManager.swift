import Foundation
import AppKit

@MainActor
class HeidiSlotManager: ObservableObject {
    static let shared = HeidiSlotManager()

    @Published var hpiSlot: String? = nil
    @Published var examSlot: String = ""
    @Published var apSlot: String? = nil
    @Published var isCapturing: Bool = false
    @Published var isLoadingBullets: Bool = false
    @Published var lastPastedSlot: Int? = nil
    /// Last capture failed: every paste yields nothing until a good capture or Clear.
    @Published private(set) var captureFailed: Bool = false

    /// Which scribe filled the slots. Heidi (F8) uses the exam dot-phrase for F10; Freed (F7)
    /// uses Freed's own exam, which may be empty (then F10 is a silent no-op).
    @Published private(set) var activeSource: ScribeSource = .heidi
    @Published private(set) var freedExam: String = ""

    // Criteria-library selections for the current capture only. Composition happens at paste
    // time (MNACore.composeExam / composeAP) so the A&P includes late-arriving action items.
    @Published private(set) var captureId: UUID? = nil
    @Published private(set) var libraryExams: [String] = []
    @Published private(set) var libraryDots: [String] = []
    private var libraryPlanLine: Int? = nil
    var libraryAdded: Bool { !libraryExams.isEmpty || !libraryDots.isEmpty }

    private let examDotPhraseKey = "examDotPhrase"
    // Non-isolated so URLSession can run off main thread
    private let claudeClient = ClaudeAPIClient()

    init() {
        examSlot = UserDefaults.standard.string(forKey: examDotPhraseKey) ?? ""
    }

    func saveExamDotPhrase(_ text: String) {
        examSlot = text
        UserDefaults.standard.set(text, forKey: examDotPhraseKey)
    }

    func clearNoteSlots() {
        hpiSlot = nil
        apSlot = nil
        clearLibrary()
        captureId = nil
        captureFailed = false
        activeSource = .heidi
        freedExam = ""
        FreedCapture.shared.resetDuplicateGuard()   // Clear: the same Freed note must re-adopt
        // examSlot intentionally NOT cleared — persists always
    }

    /// New capture: a fresh id, and the previous patient's library text is dropped.
    func beginCapture() -> UUID {
        clearLibrary()
        captureFailed = false
        activeSource = .heidi
        freedExam = ""
        FreedCapture.shared.resetDuplicateGuard()   // a Heidi capture replaced the slots
        let id = UUID()
        captureId = id
        return id
    }

    /// Successful Freed capture: replace all three slots at once. An empty section empties its
    /// slot (never the previous patient's text). Returns the new capture id for the library flow.
    func adoptFreed(_ slots: FreedSlots) -> UUID {
        clearLibrary()
        captureFailed = false
        activeSource = .freed
        hpiSlot = slots.hpi.isEmpty ? nil : slots.hpi
        apSlot = slots.ap.isEmpty ? nil : slots.ap
        freedExam = slots.exam
        let id = UUID()
        captureId = id
        return id
    }

    /// Failed capture: clear every slot so nothing (not even the exam dot-phrase) can be pasted.
    func markCaptureFailed() {
        hpiSlot = nil
        apSlot = nil
        clearLibrary()
        captureFailed = true
        NSSound(named: .init("Funk"))?.play()
        FailureHUD.show(CaptureGate.failureMessage)
    }

    func setLibrarySelections(captureId id: UUID, exams: [String], dotphrases: [String], planLine: Int?) {
        guard id == captureId else { return }   // stale picker answer: ignore
        libraryExams = exams
        libraryDots = dotphrases
        libraryPlanLine = planLine
    }

    private func clearLibrary() {
        libraryExams = []
        libraryDots = []
        libraryPlanLine = nil
    }

    /// Exam paste: scribe exam (+ library exam text, deduped). Empty scribe exam + library -> library alone.
    var composedExam: String? {
        if captureFailed { return nil }
        let scribeExam = activeSource == .freed ? freedExam : examSlot
        if libraryExams.isEmpty { return scribeExam.isEmpty ? nil : scribeExam }
        let out = MNACore.shared.composeExam(scribeExam: scribeExam, libraryTexts: libraryExams)
        return out.isEmpty ? nil : out
    }

    /// A&P paste: A&P (+ library dot-phrases at the end or after the plan line).
    var composedAP: String? {
        if captureFailed { return nil }
        guard let ap = apSlot else { return nil }
        if libraryDots.isEmpty { return ap }
        return MNACore.shared.composeAP(ap: ap, dotphrases: libraryDots,
                                        insertion: LibraryStore.shared.insertion, planLine: libraryPlanLine)
    }

    func writeToClipboard(slot: Int) {
        let decision = CaptureGate.decide(slot: slot, failed: captureFailed, source: activeSource,
                                          hpi: hpiSlot, exam: composedExam, ap: composedAP)
        switch decision {
        case .failedNotice:
            NSSound(named: .init("Funk"))?.play()
            FailureHUD.show(CaptureGate.failureMessage)
            return
        case .silent:
            return   // Freed exam empty/N/A and no library text: paste nothing, show nothing
        case .beep, .paste:
            break
        }

        if case .paste(let text) = decision {
            NSPasteboard.general.clearContents()
            NSPasteboard.general.setString(text, forType: .string)
            lastPastedSlot = slot
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.35) {
                self.lastPastedSlot = nil
            }
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.05) {
                self.simulatePaste()
            }
        } else {
            NSSound(named: .init("Funk"))?.play()
        }
    }

    private func simulatePaste() {
        guard let source = CGEventSource(stateID: .combinedSessionState) else { return }
        guard let vKeyDown = CGEvent(keyboardEventSource: source,
                                     virtualKey: 0x09, keyDown: true),
              let vKeyUp   = CGEvent(keyboardEventSource: source,
                                     virtualKey: 0x09, keyDown: false)
        else { return }
        vKeyDown.flags = .maskCommand
        vKeyUp.flags   = .maskCommand
        vKeyDown.post(tap: .cgAnnotatedSessionEventTap)
        vKeyUp.post(tap: .cgAnnotatedSessionEventTap)

        // Send Escape after short delay to release any toolbar focus (Citrix zoom fix)
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.15) {
            guard let src = CGEventSource(stateID: .combinedSessionState),
                  let escDown = CGEvent(keyboardEventSource: src,
                                        virtualKey: 0x35, keyDown: true),
                  let escUp   = CGEvent(keyboardEventSource: src,
                                        virtualKey: 0x35, keyDown: false)
            else { return }
            escDown.post(tap: .cgAnnotatedSessionEventTap)
            escUp.post(tap: .cgAnnotatedSessionEventTap)
        }
    }

    func appendActionItems() async {
        guard let apText = apSlot, !apText.isEmpty else { return }
        isLoadingBullets = true
        defer { Task { @MainActor in self.isLoadingBullets = false } }

        // Task.detached fully escapes MainActor so URLSession can suspend freely
        let result = await Task.detached(priority: .userInitiated) { [claudeClient] in
            try? await claudeClient.extractActionItems(from: apText)
        }.value

        if let bullets = result, !bullets.isEmpty, apSlot == apText {
            apSlot = apText + "\n\n" + bullets
        }
        isLoadingBullets = false
    }
}
