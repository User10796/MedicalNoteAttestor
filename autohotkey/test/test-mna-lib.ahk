; CI test for mna-lib.ahk. Run: AutoHotkey64.exe /ErrorStdOut autohotkey\test\test-mna-lib.ahk
; Prints results to stdout; exit code = number of failures.
#Requires AutoHotkey v2.0
#NoTrayIcon
#Include %A_ScriptDir%\..\mna-lib.ahk

global failures := 0
global passes := 0
Check(cond, name) {
    global failures, passes
    if cond {
        passes += 1
        FileAppend("ok - " name "`n", "*")
    } else {
        failures += 1
        FileAppend("not ok - " name "`n", "*")
    }
}

dir := A_Temp "\mna-ahk-test-" A_TickCount
DirCreate(dir)

; defaults unchanged
d := MnaDefaultHotkeys()
Check(d["capture"] = "F8" && d["pasteHpi"] = "F9" && d["pasteExam"] = "F10" && d["pasteAp"] = "F11", "defaults are F8/F9/F10/F11")
Check(d["captureFreed"] = "F7", "Freed capture default is F7")

; valid config, rebinding F10 to Ctrl+Shift+F10
good := '{"version": 1, "accelerators": {"pasteExam": "Ctrl+Shift+F10"}, "ahk_capture": "F8", "ahk_pasteHpi": "F9", "ahk_pasteExam": "^+F10", "ahk_pasteAp": "F11"}'
m := MnaParseHotkeysJson(good)
Check(IsObject(m) && m["pasteExam"] = "^+F10", "parses rebinding to ^+F10")
Check(IsObject(MnaParseHotkeysJson(Chr(0xFEFF) good)), "BOM is tolerated")

; corrupt / incomplete / duplicate -> "" (caller falls back to defaults)
Check(MnaParseHotkeysJson('{"version": 1, "ahk_capture": "F8"') = "", "truncated file rejected")
Check(MnaParseHotkeysJson("garbage") = "", "garbage rejected")
Check(MnaParseHotkeysJson(StrReplace(good, '"^+F10"', '"F9"')) = "", "duplicate binding rejected")
Check(MnaParseHotkeysJson(StrReplace(good, '"^+F10"', '"F10 & x"')) = "", "invalid key rejected")

; the parsed key really registers as a hotkey (no restart needed: Hotkey() at runtime)
registered := false
try {
    Hotkey(m["pasteExam"], (*) => 0, "On")
    Hotkey(m["pasteExam"], "Off")
    registered := true
}
Check(registered, "^+F10 registers via Hotkey()")

; composed output is only returned for the matching capture
p := dir "\mna-exam.txt"
FileAppend("MNA1 12345`r`nLine one`r`nLine two ___", p, "UTF-8-RAW")
Check(MnaReadComposed(p, "12345") = "Line one`r`nLine two ___", "composed text read for matching capture")
Check(MnaReadComposed(p, "99999") = "", "stale capture -> no library text")
Check(MnaReadComposed(p, "") = "", "no capture -> no library text")
Check(MnaReadComposed(dir "\missing.txt", "12345") = "", "missing file -> empty")

; failed capture (approved 2026-10-08): empty clipboard or no sections -> paste nothing
Check(MnaCaptureFailed("", "", ""), "empty clipboard is a failed capture")
Check(MnaCaptureFailed("   `r`n", "", ""), "whitespace-only clipboard is a failed capture")
Check(MnaCaptureFailed("random text, no headers", "", ""), "no HPI and no A&P is a failed capture")
Check(!MnaCaptureFailed("note", "hpi text", ""), "HPI only is not a failure")
Check(!MnaCaptureFailed("note", "", "ap text"), "A&P only is not a failure")
Check(MnaContentToPaste(true, "composed", "slot") = "", "after a failed capture F10/F11 paste nothing (even composed)")
Check(MnaContentToPaste(true, "", "exam dot-phrase") = "", "after a failed capture the exam dot-phrase is not pasted")
Check(MnaContentToPaste(false, "composed", "slot") = "composed", "composed library text wins after a good capture")
Check(MnaContentToPaste(false, "", "slot") = "slot", "plain slot after a good capture")
FileAppend("MNA1 1`r`nx", dir "\mna-exam.txt", "UTF-8-RAW")
FileAppend("MNA1 1`r`ny", dir "\mna-ap.txt", "UTF-8-RAW")
MnaClearComposed(dir)
Check(!FileExist(dir "\mna-exam.txt") && !FileExist(dir "\mna-ap.txt"), "failed capture deletes composed library files")
MnaClearComposed(dir)
Check(true, "clearing when nothing exists does not throw")
Check(InStr(MnaCaptureFailedText(), "Capture failed") = 1 && InStr(MnaCaptureFailedText(), "nothing to paste"), "failure message text")

; ── Freed (F7) ──
fixture := A_ScriptDir "\..\..\test\fixtures\freed\freed_result_sample.txt"
sample := FileRead(fixture, "UTF-8")
r := MnaParseFreedResult(sample, "12345")
Check(IsObject(r) && r["kind"] = "ok", "parses Electron's result file (shared contract fixture)")
Check(IsObject(r) && r["hpi"] = "HPI line 1`r`nHPI line 2", "result: HPI slot")
Check(IsObject(r) && r["exam"] = "", "result: empty exam slot is explicit (no stale exam)")
Check(IsObject(r) && r["ap"] = "1. Problem`r`n- Bullet`r`n`r`nFollow-up:`r`n- RTC", "result: A&P slot")
Check(MnaParseFreedResult(sample, "99999") = "", "result for another capture is ignored")
Check(MnaParseFreedResult(sample, "") = "", "no pending capture -> ignored")
Check(MnaParseFreedResult("garbage", "12345") = "", "garbage result ignored")
n := MnaParseFreedResult("MNA-FREED1 777 notice`r`n" MnaFreedInvalidText(), "777")
Check(IsObject(n) && n["kind"] = "notice" && n["message"] = MnaFreedInvalidText(), "notice result")
old := '{"version": 1, "ahk_capture": "F8", "ahk_pasteHpi": "F9", "ahk_pasteExam": "F10", "ahk_pasteAp": "F11"}'
mo := MnaParseHotkeysJson(old)
Check(IsObject(mo) && mo["captureFreed"] = "F7", "older hotkeys.json without F7 still valid; Freed gets F7")
Check(MnaParseHotkeysJson(StrReplace(old, '"F9"', '"F7"')) = "", "binding another action to F7 is a duplicate")

; Freed F10 fallback (2026-10-12): Freed exam, else library text (composed), else default exam
Check(MnaFreedExamFallback("Freed exam", "Default exam") = "Freed exam", "Freed exam wins over the default exam")
Check(MnaFreedExamFallback("", "Default exam") = "Default exam", "Freed exam N/A -> default exam from Settings")
Check(MnaFreedExamFallback("", "") = "", "no Freed exam and no default -> nothing (silent)")
Check(MnaContentToPaste(false, "Library exam", MnaFreedExamFallback("", "Default exam")) = "Library exam", "library text inserted -> library text before the default")
Check(MnaContentToPaste(true, "", MnaFreedExamFallback("", "Default exam")) = "", "failed capture still pastes nothing")

; Notices from Electron (2026-10-12): newer id shown once; malformed or repeated ignored
n := MnaParseNotice("MNA-NOTICE1 17-1`r`nNo planned procedure detected", "")
Check(IsObject(n) && n["id"] = "17-1" && n["message"] = "No planned procedure detected", "notice parsed")
Check(MnaParseNotice("MNA-NOTICE1 17-1`r`nNo planned procedure detected", "17-1") = "", "same notice not shown twice")
Check(IsObject(MnaParseNotice(Chr(0xFEFF) "MNA-NOTICE1 18-2`r`nClaude fill timed out", "17-1")), "BOM tolerated; newer id shown")
Check(MnaParseNotice("MNA-NOTICE1 19-3", "") = "", "truncated notice ignored")
Check(MnaParseNotice("garbage`r`ntext", "") = "", "garbage ignored")

; Hold until processed (2026-10-12)
FileAppend("MNA-HOLD1 555 hold", dir "\mna-hold.txt", "UTF-8-RAW")
h := MnaReadHold(dir "\mna-hold.txt")
Check(IsObject(h) && h["ts"] = "555" && h["state"] = "hold", "hold file parsed")
Check(MnaPasteBlocked("555", false, h, 60000), "held capture: paste blocked")
Check(!MnaPasteBlocked("555", true, h, 60000), "failed capture: not blocked here (pastes nothing anyway)")
Check(!MnaPasteBlocked("555", false, Map("ts", "555", "state", "ready"), 10), "ready: published")
Check(MnaPasteBlocked("777", false, h, 500), "new capture, no verdict yet: blocked")
Check(!MnaPasteBlocked("777", false, h, 3500), "no verdict after 3 s (Electron not answering): published")
Check(!MnaPasteBlocked("", false, "", 0), "no capture: nothing to hold")
Check(MnaReadHold(dir "\missing.txt") = "", "missing hold file")
Check(MnaStillProcessingText() = "Still processing " Chr(0x2014) " wait for the picker/fill to finish.", "still-processing text")

; "Include procedure criteria" switch (2026-10-12)
Check(MnaCriteriaOn(dir "\no-such-file.txt"), "criteria switch: missing file -> On")
FileAppend("MNA-CRIT1 off", dir "\mna-criteria.txt", "UTF-8-RAW")
Check(!MnaCriteriaOn(dir "\mna-criteria.txt"), "criteria switch: off")
FileDelete(dir "\mna-criteria.txt")
FileAppend("MNA-CRIT1 on", dir "\mna-criteria.txt", "UTF-8-RAW")
Check(MnaCriteriaOn(dir "\mna-criteria.txt"), "criteria switch: on")
Check(MnaContentToPaste(false, MnaCriteriaOn(dir "\mna-criteria.txt") ? "A&P + criteria" : "", "A&P") = "A&P + criteria", "on: composed A&P")
Check(MnaContentToPaste(false, false ? "A&P + criteria" : "", "A&P") = "A&P", "off: captured A&P only")

MnaLog(dir, "test log line")
Check(InStr(FileRead(dir "\mna-ahk.log", "UTF-8"), "test log line") > 0, "log written")

try DirDelete(dir, true)
FileAppend(passes " passed, " failures " failed`n", "*")
ExitApp(failures)
