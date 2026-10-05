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

MnaLog(dir, "test log line")
Check(InStr(FileRead(dir "\mna-ahk.log", "UTF-8"), "test log line") > 0, "log written")

try DirDelete(dir, true)
FileAppend(passes " passed, " failures " failed`n", "*")
ExitApp(failures)
