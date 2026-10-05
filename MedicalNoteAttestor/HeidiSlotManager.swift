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
        // examSlot intentionally NOT cleared — persists always
    }

    /// New capture: a fresh id, and the previous patient's library text is dropped.
    func beginCapture() -> UUID {
        clearLibrary()
        let id = UUID()
        captureId = id
        return id
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
        if libraryExams.isEmpty { return examSlot.isEmpty ? nil : examSlot }
        let out = MNACore.shared.composeExam(scribeExam: examSlot, libraryTexts: libraryExams)
        return out.isEmpty ? nil : out
    }

    /// A&P paste: A&P (+ library dot-phrases at the end or after the plan line).
    var composedAP: String? {
        guard let ap = apSlot else { return nil }
        if libraryDots.isEmpty { return ap }
        return MNACore.shared.composeAP(ap: ap, dotphrases: libraryDots,
                                        insertion: LibraryStore.shared.insertion, planLine: libraryPlanLine)
    }

    func writeToClipboard(slot: Int) {
        let content: String?
        switch slot {
        case 1: content = hpiSlot
        case 2: content = composedExam
        case 3: content = composedAP
        default: content = nil
        }

        if let text = content, !text.isEmpty {
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
