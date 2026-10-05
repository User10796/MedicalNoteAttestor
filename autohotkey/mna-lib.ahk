; MedicalNoteAttestor - helper functions for heidi-hotkeys.ahk (AutoHotkey v2).
; Pure functions only, so autohotkey/test/test-mna-lib.ahk can test them in CI.

; Default bindings. Must match lib/mna-core.js HOTKEY_ACTIONS (F8 / F9 / F10 / F11).
MnaDefaultHotkeys() {
    m := Map()
    m["capture"]   := "F8"
    m["pasteHpi"]  := "F9"
    m["pasteExam"] := "F10"
    m["pasteAp"]   := "F11"
    return m
}

; Parse hotkeys.json written by Electron (UTF-8, no BOM). Reads the "ahk_<action>" fields.
; Returns a Map of action -> AHK key name, or "" if the text is invalid/incomplete.
MnaParseHotkeysJson(text) {
    text := RegExReplace(text, "^\x{FEFF}", "")   ; BOM-strip safety net
    if !RegExMatch(text, '"version"\s*:\s*1\b')
        return ""
    out := Map()
    seen := Map()
    for action, _ in MnaDefaultHotkeys() {
        if !RegExMatch(text, '"ahk_' action '"\s*:\s*"([^"]+)"', &m)
            return ""
        key := m[1]
        if !RegExMatch(key, "^[\^\+!#]*([A-Za-z0-9]{1,8})$")
            return ""
        if seen.Has(key)
            return ""
        seen[key] := true
        out[action] := key
    }
    return out
}

; Composed library output for one capture: "MNA1 <captureTs>`r`n<text>".
; Returns the text only when the header names `captureTs` (never a previous patient's text).
MnaReadComposed(path, captureTs) {
    if (captureTs = "" || !FileExist(path))
        return ""
    try raw := FileRead(path, "UTF-8")
    catch
        return ""
    raw := RegExReplace(raw, "^\x{FEFF}", "")
    pos := InStr(raw, "`r`n")
    if (pos = 0)
        return ""
    if (SubStr(raw, 1, pos - 1) != "MNA1 " captureTs)
        return ""
    return SubStr(raw, pos + 2)
}

; Append a one-line, non-PHI status message to mna-ahk.log in the runtime dir.
MnaLog(dir, msg) {
    try FileAppend(FormatTime(, "yyyy-MM-dd HH:mm:ss") " " msg "`n", dir "\mna-ahk.log", "UTF-8-RAW")
}
