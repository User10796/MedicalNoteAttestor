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

print("\(passed) passed, \(failed) failed")
exit(failed == 0 ? 0 : 1)
