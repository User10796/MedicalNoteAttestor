// Swift tests for the macOS library integration. Run: scripts/test-swift.sh
// Compiled together with MedicalNoteAttestor/MNACore.swift and Hotkeys.swift (no Xcode test target).
import Foundation
import Carbon

let root = URL(fileURLWithPath: CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : FileManager.default.currentDirectoryPath)
var passed = 0, failed = 0
func check(_ cond: Bool, _ name: String) {
    if cond { passed += 1; print("ok - \(name)") } else { failed += 1; print("not ok - \(name)") }
}
func json(_ rel: String) -> Any { try! JSONSerialization.jsonObject(with: Data(contentsOf: root.appendingPathComponent(rel))) }

// ── JavaScriptCore bridge runs the shared core ─────────────────────────────────────────────
let core = MNACore(scriptURL: root.appendingPathComponent("lib/mna-core.js"))
check(core.isLoaded, "mna-core.js loads in JavaScriptCore (\(core.loadError ?? "ok"))")
let raw = try! String(contentsOf: root.appendingPathComponent("test/fixtures/library.fixture.json"), encoding: .utf8)
check(core.setBundle(raw: raw), "fixture bundle accepted")
check(!core.setBundle(raw: "{\"broken"), "corrupt bundle rejected (previous bundle kept)")
check(core.bundleInfo()?.built_at.isEmpty == false, "bundle info has built_at")

// Same detection fixtures as the Node suite: identical results on macOS.
let cases = (json("test/fixtures/detection-fixtures.json") as! [String: Any])["cases"] as! [[String: Any]]
var detOK = 0
for c in cases {
    let d = core.detect(ap: c["ap"] as! String)
    let planned = d.items.filter { $0.checked }
    let expect = c["expect"] as! [[String: Any]]
    var ok = planned.map { $0.procedure_id ?? "" } == expect.map { $0["id"] as! String }
    if ok { for (i, e) in expect.enumerated() { if let lat = e["lat"] as? String, planned[i].laterality != lat { ok = false } } }
    let sugg = (c["suggest"] as? [String]) ?? []
    if d.items.filter({ !$0.checked }).map({ $0.procedure_id ?? "" }) != sugg { ok = false }
    if ok { detOK += 1 } else { print("  detection mismatch: \(c["ap"]!) -> \(planned.map { "\($0.procedure_id ?? "?")/\($0.laterality)" })") }
}
check(detOK == cases.count, "all \(cases.count) detection fixtures match on macOS")

// Sanitizer shared vectors.
let vectors = (json("test/fixtures/cerner-sanitizer-vectors.json") as! [String: Any])["vectors"] as! [[String: String]]
check(vectors.allSatisfy { core.cernerSafe($0["in"]!) == $0["out"]! }, "Cerner sanitizer vectors (\(vectors.count))")

// Acceptance: Medicare + bilateral lumbar MBB.
let ap = "Lumbar spondylosis.\nProceed with bilateral L4-5, L5-S1 medial branch blocks."
let det = core.detect(ap: ap)
check(det.items.map { $0.procedure_id ?? "" } == ["lumbar_mbb"] && det.items[0].laterality == "bilateral", "acceptance: detects lumbar_mbb bilateral")
let res = core.resolve(payerId: "medicare_ab_ga", rows: det.items).filter { $0.insert }
let scribe = "Gen: NAD\nTender to palpation over lumbar paraspinal musculature bilaterally."
let exam = core.composeExam(scribeExam: scribe, libraryTexts: res.map(\.examText))
check(exam.hasPrefix(scribe + "\n\n") && exam.components(separatedBy: "Tender to palpation over lumbar paraspinal musculature bilaterally.").count == 2,
      "F10: scribe exam + library exam, no duplicated scribe line")
let apOut = core.composeAP(ap: ap, dotphrases: res.map(\.dotphrase), insertion: "end", planLine: nil)
check(apOut.hasPrefix(ap + "\n\n") && apOut.contains("Patient reports moderate-to-severe"), "F11: A&P + Medicare MBB dot-phrase")
let sij = core.resolve(payerId: "medicare_ab_ga", rows: core.detect(ap: "Schedule right SIJ injection.").items)
check(sij.first?.examText.contains("Positive Patrick test on the right.") == true, "right SIJ renders unilateral exam lines")
check(core.composeExam(scribeExam: "", libraryTexts: []) == "", "both empty -> empty (F10 no-op)")
check(core.composeExam(scribeExam: "", libraryTexts: ["Lib."]) == "Lib.", "empty scribe exam + library -> library alone")

// Payer picker: recents pinned, aliases.
let recents = ["bcbs_ga", "medicare_ab_ga"]
let hits = core.searchPayers(query: "", recents: recents)
check(hits.prefix(2).map(\.payer_id) == recents && hits[0].pinned, "recents pinned first, most recent first")
check(core.searchPayers(query: "PSHP", recents: []).first?.payer_id == "peach_state", "alias typeahead (PSHP)")
var rec: [String] = []
for p in ["a","b","c","d","e","f","g","h","i","j","k"] { rec = core.recordRecentPayer(recents: rec, payerId: p) }
check(rec.count == 10 && rec.first == "k", "recents capped at 10, newest first")

// ── Hotkeys ────────────────────────────────────────────────────────────────────────────────
let b = HotkeyBinding.parse("Ctrl+Shift+F10")
check(b?.keyCode == UInt32(kVK_F10) && b?.modifiers == UInt32(controlKey | shiftKey) && b?.canonical == "Ctrl+Shift+F10", "parse Ctrl+Shift+F10")
check(HotkeyBinding.parse("Page Up")?.canonical == "PageUp", "legacy 'Page Up' value migrates")
check(HotkeyBinding.parse("Space") == nil && HotkeyBinding.parse("A") == nil, "bare non-F keys rejected")
check(HotkeyBinding.canonical(keyCode: kVK_F10, control: true, option: false, shift: true, command: false) == "Ctrl+Shift+F10", "recorded key press -> canonical")

final class FakeRegistrar: HotkeyRegistrar {
    var registered: [UInt32: String] = [:]
    var registerCalls = 0
    func register(id: UInt32, binding: HotkeyBinding) -> Bool { registerCalls += 1; registered[id] = binding.canonical; return true }
    func unregisterAll() { registered = [:] }
}
let suite = "mna-tests-\(UUID().uuidString)"
let defaults = UserDefaults(suiteName: suite)!
let fake = FakeRegistrar()
let mgr = HotkeyManager(registrar: fake, defaults: defaults, validate: { core.validateHotkeys($0) })
mgr.start(handlers: [:])
func reg(_ a: HotkeyAction) -> String? { fake.registered[HotkeyManager.id(for: a)] }
check(reg(.capture) == "F8" && reg(.pasteHpi) == "F9" && reg(.pasteExam) == "F10" && reg(.pasteAp) == "F11", "defaults F8/F9/F10/F11 registered")

// Rebind F10 -> Ctrl+Shift+F10 through Settings' save path; the UserDefaults change re-registers live.
let v = mgr.save([.capture: "F8", .pasteHpi: "F9", .pasteExam: "Ctrl+Shift+F10", .pasteAp: "F11"])
check(v?.ok == true, "rebinding validates")
RunLoop.main.run(until: Date().addingTimeInterval(0.3))   // deliver UserDefaults.didChangeNotification
check(reg(.pasteExam) == "Ctrl+Shift+F10", "Ctrl+Shift+F10 active without restart")

let dup = mgr.save([.capture: "F8", .pasteHpi: "F9", .pasteExam: "F9", .pasteAp: "F11"])
check(dup?.ok == false && reg(.pasteExam) == "Ctrl+Shift+F10", "duplicate binding rejected, previous kept")

defaults.set("garbage!!", forKey: "pasteHotkey2")
RunLoop.main.run(until: Date().addingTimeInterval(0.3))
check(reg(.pasteExam) == "F10", "corrupt stored binding -> default")

let calls = fake.registerCalls
defaults.set(["x"], forKey: "payerRecents")   // unrelated default change
RunLoop.main.run(until: Date().addingTimeInterval(0.3))
check(fake.registerCalls == calls, "unrelated UserDefaults changes don't re-register")
UserDefaults().removePersistentDomain(forName: suite)

// ── Failed captures (approved 2026-10-08) ─────────────────────────────────────────────────
check(CaptureGate.isFailure(text: "old patient note", clipboardChanged: false, hpi: "x", ap: "y"),
      "copy that didn't change the clipboard is a failure (stale text never captured)")
check(CaptureGate.isFailure(text: "", clipboardChanged: true, hpi: nil, ap: nil), "empty clipboard is a failure")
check(CaptureGate.isFailure(text: "  \n", clipboardChanged: true, hpi: nil, ap: nil), "whitespace is a failure")
check(CaptureGate.isFailure(text: "no headers", clipboardChanged: true, hpi: nil, ap: nil), "no sections is a failure")
check(!CaptureGate.isFailure(text: "note", clipboardChanged: true, hpi: "h", ap: nil), "HPI only is a capture")
check(!CaptureGate.isFailure(text: "note", clipboardChanged: true, hpi: nil, ap: "a"), "A&P only is a capture")
check((1...3).allSatisfy { CaptureGate.content(slot: $0, failed: true, hpi: "old", exam: "Gen: NAD", ap: "old") == nil },
      "after a failed capture F9/F10/F11 paste nothing (not even the exam dot-phrase)")
check(CaptureGate.content(slot: 2, failed: false, hpi: "h", exam: "Gen: NAD", ap: "a") == "Gen: NAD"
      && CaptureGate.content(slot: 3, failed: false, hpi: "h", exam: "e", ap: "a") == "a", "good capture pastes unchanged")
check(CaptureGate.failureMessage == "Capture failed \u{2014} nothing to paste", "failure message text")

// ── Freed capture hotkey (F7) ──────────────────────────────────────────────────────────────
do {
    let suite2 = "mna-tests-freed-\(UUID().uuidString)"
    let d2 = UserDefaults(suiteName: suite2)!
    let f2 = FakeRegistrar()
    let m2 = HotkeyManager(registrar: f2, defaults: d2, validate: { core.validateHotkeys($0) })
    m2.start(handlers: [:])
    func r2(_ a: HotkeyAction) -> String? { f2.registered[HotkeyManager.id(for: a)] }
    check(r2(.captureFreed) == "F7", "older settings without an F7 entry load; Freed capture defaults to F7")
    check(r2(.capture) == "F8" && r2(.pasteExam) == "F10", "Heidi keys unchanged alongside F7")
    let ok = m2.save([.capture: "F8", .pasteHpi: "F9", .pasteExam: "F10", .pasteAp: "F11", .captureFreed: "Ctrl+Shift+F7"])
    check(ok?.ok == true, "Freed capture rebinding validates")
    RunLoop.main.run(until: Date().addingTimeInterval(0.3))
    check(r2(.captureFreed) == "Ctrl+Shift+F7", "Freed rebinding active without restart")
    let dup = m2.save([.capture: "F8", .pasteHpi: "F9", .pasteExam: "F10", .pasteAp: "F11", .captureFreed: "F9"])
    check(dup?.ok == false && dup?.errors.first?.message.contains("already used by Paste HPI") == true
          && r2(.captureFreed) == "Ctrl+Shift+F7", "Freed capture duplicate rejected, previous kept")
    UserDefaults().removePersistentDomain(forName: suite2)

    let suite3 = "mna-tests-freed-old-\(UUID().uuidString)"
    let d3 = UserDefaults(suiteName: suite3)!
    d3.set("F7", forKey: "pasteHotkey1")   // an older setup that already used F7 for Paste HPI
    let f3 = FakeRegistrar()
    let m3 = HotkeyManager(registrar: f3, defaults: d3, validate: { core.validateHotkeys($0) })
    m3.start(handlers: [:])
    check(f3.registered[HotkeyManager.id(for: .pasteHpi)] == "F7" && f3.registered[HotkeyManager.id(for: .captureFreed)] == nil,
          "existing F7 binding kept; Freed capture left unbound until rebound")
    UserDefaults().removePersistentDomain(forName: suite3)
}

// ── Freed source on Mac (SPEC_mac_freed_and_build_stamp Part C) ─────────────────────────
// Reads the SHARED fixtures in test/fixtures/freed/ (same expected outputs as Windows).
let freedDir = root.appendingPathComponent("test/fixtures/freed")
func freedFixture(_ f: String) -> String { try! String(contentsOf: freedDir.appendingPathComponent(f), encoding: .utf8) }
func nf(_ s: String) -> String {   // §6 normalization + EOF trim, as the Node harness does
    var t = FreedParser.normalize(s)
    while t.hasSuffix("\n") { t.removeLast() }
    return t
}
func okSlots(_ r: FreedCapture.Result) -> FreedSlots? { if case .ok(let s) = r { return s } else { return nil } }

for (sample, hasExam) in [("freed_sample_01", true), ("freed_sample_02_no_exam", false)] {
    let s = okSlots(FreedCapture().process(raw: freedFixture(sample + ".txt")))
    check(s.map { nf($0.hpi) } == nf(freedFixture(sample + ".F9.expected.txt")), "\(sample): F9 matches the shared fixture")
    check(s.map { nf($0.ap) } == nf(freedFixture(sample + ".F11.expected.txt")), "\(sample): F11 matches the shared fixture")
    if hasExam { check(s.map { nf($0.exam) } == nf(freedFixture(sample + ".F10.expected.txt")), "\(sample): F10 matches the shared fixture") }
    else { check(s?.exam == "", "\(sample): F10 slot is empty (N/A exam)") }
}
let crlf = "\u{FEFF}" + freedFixture("freed_sample_01.txt").replacingOccurrences(of: "\r\n", with: "\n")
    .replacingOccurrences(of: "\n", with: "  \r\n")
check(okSlots(FreedCapture().process(raw: crlf)).map { nf($0.ap) } == nf(freedFixture("freed_sample_01.F11.expected.txt")),
      "CRLF + BOM + trailing spaces parse identically")

// Stale-slot clearing: 01 then 02 -> F10 empty, all three replaced.
do {
    let cap = FreedCapture()
    let a = okSlots(cap.process(raw: freedFixture("freed_sample_01.txt")))
    let b = okSlots(cap.process(raw: freedFixture("freed_sample_02_no_exam.txt")))
    check(a?.exam.contains("Tenderness over bilateral L4-L5") == true && b?.exam == "" && b?.hpi.contains("61-year-old male") == true,
          "01 then 02: F10 empty, slots replaced (no stale exam)")
}
// Duplicate guard.
do {
    let cap = FreedCapture()
    _ = cap.process(raw: freedFixture("freed_sample_01.txt"))
    let p = cap.parses
    check(cap.process(raw: freedFixture("freed_sample_01.txt").replacingOccurrences(of: "\n", with: "\r\n")) == .duplicate && cap.parses == p,
          "same note twice -> duplicate, no re-parse")
    let c2 = FreedCapture()
    let seq = ["freed_sample_01.txt", "freed_sample_02_no_exam.txt", "freed_sample_01.txt"].map { okSlots(c2.process(raw: freedFixture($0))) != nil }
    check(seq == [true, true, true] && c2.parses == 3, "01 -> 02 -> 01 re-parses each time")
    cap.resetDuplicateGuard()
    check(okSlots(cap.process(raw: freedFixture("freed_sample_01.txt"))) != nil, "reset (Heidi capture / Clear) lets the same note re-adopt")
    let c3 = FreedCapture()
    check(c3.process(raw: "not a note") == .invalid && c3.process(raw: "not a note") == .invalid, "failed captures never become duplicates")
}
// Shape validation failures (slots unchanged = no .ok result; nothing adopted).
let s01 = freedFixture("freed_sample_01.txt").replacingOccurrences(of: "\r\n", with: "\n")
let heidiNote = "Interval history, HPI:\nPatient returns for follow-up of low back pain.\n\nAssessment and Plan:\nLumbar spondylosis. Proceed with bilateral L4-5, L5-S1 medial branch blocks.\n"
let invalid: [(String, String)] = [
    ("missing Objective divider", s01.replacingOccurrences(of: "\nObjective\n", with: "\n")),
    ("dividers out of order", s01.replacingOccurrences(of: "Subjective\n", with: "@@S\n").replacingOccurrences(of: "\nObjective\n", with: "\nSubjective\n").replacingOccurrences(of: "@@S\n", with: "Objective\n")),
    ("no numbered problem", s01.replacingOccurrences(of: "\\d+\\. ", with: "", options: .regularExpression)),
    ("arbitrary text", "Grocery list:\n- eggs\n- milk\nCall the pharmacy at 3pm."),
    ("Heidi-format note", heidiNote),
    ("empty pasteboard", "")
]
for (name, text) in invalid {
    let cap = FreedCapture()
    let before = okSlots(cap.process(raw: freedFixture("freed_sample_02_no_exam.txt")))
    check(cap.process(raw: text) == .invalid && before != nil, "shape validation rejects: \(name)")
}
check(!FreedCapture.noticeInvalid.contains("Subjective") && FreedCapture.noticeInvalid == "Clipboard doesn't look like a Freed note. Click Copy all in Freed, then F7.",
      "invalid notice is fixed text (never echoes the pasteboard)")
// Classification.
check(FreedParser.classify("Medications started: x") == .inlineLabel, "classify INLINE_LABEL")
check(FreedParser.classify("Follow-up:") == .subheader, "classify Follow-up: SUBHEADER")
check(FreedParser.classify("- General: Ambulatory.") == .bullet, "classify bullet with colon BULLET")
check(FreedParser.classify("Assessment & Plan") == .divider, "classify DIVIDER")
check(FreedParser.classify("Assessment and Plan:") == .subheader, "classify Assessment and Plan: SUBHEADER")
// Action items: none for Freed (profile), Heidi unchanged.
check(SourceProfile.freed.actionItems == false && SourceProfile.freed.captureMethod == "clipboardRead" && SourceProfile.freed.captureKey == "F7",
      "Freed profile: F7, clipboard read, no action items")
check(SourceProfile.heidi == SourceProfile(id: .heidi, captureKey: "F8", captureMethod: "selectAllCopy", parser: "heidi", actionItems: true),
      "Heidi profile unchanged")
// Paste decisions: Heidi exactly as before; Freed empty exam is a silent no-op.
check(CaptureGate.decide(slot: 2, failed: false, source: .heidi, hpi: "h", exam: nil, ap: "a") == .beep, "Heidi empty exam still beeps")
check(CaptureGate.decide(slot: 2, failed: false, source: .freed, hpi: "h", exam: nil, ap: "a") == .silent, "Freed empty exam: silent no-op")
check(CaptureGate.decide(slot: 2, failed: false, source: .freed, hpi: "h", exam: "Lib exam", ap: "a") == .paste("Lib exam"), "Freed F10 pastes library exam text")
check(CaptureGate.decide(slot: 1, failed: true, source: .freed, hpi: "h", exam: "e", ap: "a") == .failedNotice, "failed capture still gates every paste")
check(CaptureGate.decide(slot: 3, failed: false, source: .heidi, hpi: nil, exam: nil, ap: nil) == .beep, "Heidi empty A&P still beeps")
// App wiring (source checks): F7 reads the pasteboard only; Heidi capture / Clear reset the guard.
func src(_ f: String) -> String { try! String(contentsOf: root.appendingPathComponent("MedicalNoteAttestor/" + f), encoding: .utf8) }
func body(_ text: String, from start: String) -> String {
    guard let r = text.range(of: start) else { return "" }
    let rest = text[r.lowerBound...]
    return String(rest.prefix(upTo: rest.range(of: "\n    }\n")?.upperBound ?? rest.endIndex))
}
let appSrc = src("MedicalNoteAttestorApp.swift"), slotSrc = src("HeidiSlotManager.swift")
let f7 = body(appSrc, from: "func performFreedCapture()")
check(f7.contains("NSPasteboard.general.string(forType: .string)") && !f7.contains("copyFullDocument") && !f7.contains("CGEvent"),
      "F7 reads the pasteboard only (no synthetic keystrokes)")
check(f7.contains("if SourceProfile.freed.actionItems {") && !SourceProfile.freed.actionItems
      && f7.components(separatedBy: "appendActionItems").count == 2,
      "F7: the only action-item call is behind the Freed profile, which is off")
check(appSrc.contains(".captureFreed: { Task { @MainActor in await AppDelegate.shared?.performFreedCapture() } }"),
      "F7 registered through the same hotkey mechanism as F8")
check(body(slotSrc, from: "func beginCapture()").contains("FreedCapture.shared.resetDuplicateGuard()"), "Heidi capture resets the Freed duplicate guard")
check(body(slotSrc, from: "func clearNoteSlots()").contains("FreedCapture.shared.resetDuplicateGuard()"), "Clear resets the Freed duplicate guard")
let adopt = body(slotSrc, from: "func adoptFreed(")
check(["hpiSlot = ", "apSlot = ", "freedExam = slots.exam", "clearLibrary()", "captureFailed = false"].allSatisfy { adopt.contains($0) },
      "Freed adoption replaces all three slots and drops library text from the previous capture")

// Library picker parity: empty Freed exam + library exam -> library text alone (shared core).
check(core.composeExam(scribeExam: "", libraryTexts: ["Lumbar spine exam."]) == "Lumbar spine exam.", "Freed N/A exam + library exam -> library exam")

// ── Freed: picker only for a planned procedure (SPEC_freed_picker_on_planned_procedure) ────
// Same shared cases file as the Node tests, through the same rule (lib/mna-core.js via JavaScriptCore).
let intentCases = json("test/fixtures/freed/procedure_intent_cases.json") as! [[String: Any]]
var intentOK = 0
for c in intentCases {
    let text = c["text"] as! String, want = c["planned"] as! Bool
    if core.procedureLineIsPlanned(text) == want && core.procedureLineIsPlanned("- " + text) == want { intentOK += 1 }
    else { print("  intent mismatch: \(text) (want \(want))") }
}
check(intentCases.count >= 18 && intentOK == intentCases.count, "all \(intentCases.count) shared intent cases match on macOS")
func freedAP(_ f: String) -> String { okSlots(FreedCapture().process(raw: freedFixture(f)))?.ap ?? "" }
check(core.freedProcedurePlanned(ap: freedAP("freed_sample_01.txt")), "sample 01 -> picker opens")
check(core.freedProcedurePlanned(ap: freedAP("freed_sample_02_no_exam.txt")), "sample 02 -> picker opens")
check(!core.freedProcedurePlanned(ap: freedAP("freed_sample_03_consider_only.txt")), "sample 03 (consider only) -> picker does not open")
do {
    let s3 = okSlots(FreedCapture().process(raw: freedFixture("freed_sample_03_consider_only.txt")))
    check(s3.map { nf($0.hpi) } == nf(freedFixture("freed_sample_03_consider_only.F9.expected.txt"))
          && s3.map { nf($0.exam) } == nf(freedFixture("freed_sample_03_consider_only.F10.expected.txt"))
          && s3.map { nf($0.ap) } == nf(freedFixture("freed_sample_03_consider_only.F11.expected.txt")),
          "sample 03 parses: F9 / F10 / F11 match the new expected files")
}
// Manual fallback: after a capture that didn't auto-open, the picker's library exam text is what F10 pastes.
do {
    let s3exam = okSlots(FreedCapture().process(raw: freedFixture("freed_sample_03_consider_only.txt")))?.exam ?? ""
    let f10 = core.composeExam(scribeExam: s3exam, libraryTexts: ["Lib exam line."])
    check(f10.hasPrefix(s3exam + "\n\n") && f10.hasSuffix("Lib exam line."), "manual open: F10 = Freed exam + inserted library exam")
}
let appSrc2 = src("MedicalNoteAttestorApp.swift")
let f7b = body(appSrc2, from: "func performFreedCapture()")
check(f7b.contains("MNACore.shared.freedProcedurePlanned(ap: ap)") && f7b.contains("await runLibraryFlow(captureId: captureId)"),
      "Freed auto-open gated by the planned-procedure rule")
let manual = body(appSrc2, from: "func openPickerManually()")
check(manual.contains("slotManager.activeSource == .freed") && manual.contains("await runLibraryFlow(captureId: captureId)"),
      "manual open reuses the same library flow for the current Freed capture")
check(appSrc2.contains(".openPicker: { Task { @MainActor in await AppDelegate.shared?.openPickerManually() } }"), "optional hotkey wired to manual open")
check(body(appSrc2, from: "func performCapture()").contains("await runLibraryFlow(captureId: captureId)")
      && !body(appSrc2, from: "func performCapture()").contains("freedProcedurePlanned"), "Heidi auto-open unchanged")
check(src("HeidiTabView.swift").contains("Button(\"Open payer picker\")"), "main window has an Open payer picker button")
// Optional hotkey: unbound by default, rebindable, duplicate rejected, browser key warned, clearable.
do {
    let suite4 = "mna-tests-picker-\(UUID().uuidString)"
    let d4 = UserDefaults(suiteName: suite4)!
    let f4 = FakeRegistrar()
    let m4 = HotkeyManager(registrar: f4, defaults: d4, validate: { core.validateHotkeys($0) })
    m4.start(handlers: [:])
    let pid = HotkeyManager.id(for: .openPicker)
    check(f4.registered[pid] == nil && m4.bindings()[.openPicker] == nil, "Open picker hotkey unbound by default")
    var b = m4.bindings(); b[.openPicker] = "Ctrl+Shift+P"
    check(m4.save(b)?.ok == true, "Open picker hotkey binds")
    RunLoop.main.run(until: Date().addingTimeInterval(0.3))
    check(f4.registered[pid] == "Ctrl+Shift+P", "Open picker hotkey active without restart")
    var dupB = m4.bindings(); dupB[.openPicker] = "F9"
    check(m4.save(dupB)?.ok == false, "Open picker hotkey duplicate rejected")
    var browserB = m4.bindings(); browserB[.openPicker] = "F6"
    check(m4.save(browserB)?.warnings.contains { $0.message.contains("web browsers") } == true, "browser function key warned")
    var clearB = m4.bindings(); clearB[.openPicker] = ""
    _ = m4.save(clearB)
    RunLoop.main.run(until: Date().addingTimeInterval(0.3))
    check(f4.registered[pid] == nil && d4.string(forKey: "openPickerHotkey") == nil, "Open picker hotkey can be cleared")
    check(f4.registered[HotkeyManager.id(for: .capture)] == "F8" && f4.registered[HotkeyManager.id(for: .captureFreed)] == "F7",
          "Heidi F8 and Freed F7 unchanged")
    UserDefaults().removePersistentDomain(forName: suite4)
}

print("\(passed) passed, \(failed) failed")
exit(failed == 0 ? 0 : 1)
