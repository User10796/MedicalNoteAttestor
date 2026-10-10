; MedicalNoteAttestor - helper functions for heidi-hotkeys.ahk (AutoHotkey v2).
; Pure functions only, so autohotkey/test/test-mna-lib.ahk can test them in CI.

; Default bindings. Must match lib/mna-core.js HOTKEY_ACTIONS for win32 (F8 / F9 / F10 / F11, F7 Freed).
MnaDefaultHotkeys() {
    m := Map()
    m["capture"]   := "F8"
    m["pasteHpi"]  := "F9"
    m["pasteExam"] := "F10"
    m["pasteAp"]   := "F11"
    m["captureFreed"] := "F7"
    return m
}
; Actions that older hotkeys.json files may lack; they take their default instead of invalidating the file.
MnaOptionalHotkeys() {
    return Map("captureFreed", true)
}

; Parse hotkeys.json written by Electron (UTF-8, no BOM). Reads the "ahk_<action>" fields.
; Returns a Map of action -> AHK key name, or "" if the text is invalid/incomplete.
MnaParseHotkeysJson(text) {
    text := RegExReplace(text, "^\x{FEFF}", "")   ; BOM-strip safety net
    if !RegExMatch(text, '"version"\s*:\s*1\b')
        return ""
    out := Map()
    seen := Map()
    defaults := MnaDefaultHotkeys()
    optional := MnaOptionalHotkeys()
    for action, _ in defaults {
        if RegExMatch(text, '"ahk_' action '"\s*:\s*"([^"]+)"', &m)
            key := m[1]
        else if optional.Has(action)
            key := defaults[action]
        else
            return ""
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

; Shown wherever the user is looking (tooltip at the cursor, and in the MNA window).
MnaCaptureFailedText() {
    return "Capture failed " Chr(0x2014) " nothing to paste"
}

; A capture failed when the clipboard came back empty or neither section was found.
MnaCaptureFailed(text, hpi, ap) {
    return (Trim(text) = "") || (hpi = "" && ap = "")
}

; What F9/F10/F11 should paste. After a failed capture: nothing, ever (not the exam dot-phrase,
; not a previous patient's slot or library text). Otherwise the composed library text for this
; capture if any, else the plain slot / exam dot-phrase.
MnaContentToPaste(captureFailed, composed, fallback) {
    if captureFailed
        return ""
    return composed != "" ? composed : fallback
}

; Delete the composed library outputs (mna-exam.txt / mna-ap.txt) in `dir`.
MnaClearComposed(dir) {
    for name in ["mna-exam.txt", "mna-ap.txt"] {
        try FileDelete(dir "\" name)
    }
}

; ── Freed source (F7) ────────────────────────────────────────────────────────────────────────
; Electron writes mna-freed-result.txt after parsing a Freed "Copy all" clipboard:
;   "MNA-FREED1 <captureTs> ok`r`n<<MNA:HPI>>`r`n...`r`n<<MNA:EXAM>>`r`n...`r`n<<MNA:AP>>`r`n..."
;   "MNA-FREED1 <captureTs> notice`r`n<message>"
; Returns a Map (kind, hpi/exam/ap or message) only for the capture `ts`, else "".
MnaParseFreedResult(raw, ts) {
    if (ts = "")
        return ""
    raw := RegExReplace(raw, "^\x{FEFF}", "")
    pos := InStr(raw, "`r`n")
    if (pos = 0)
        return ""
    parts := StrSplit(SubStr(raw, 1, pos - 1), " ")
    if (parts.Length != 3 || parts[1] != "MNA-FREED1" || parts[2] != ts)
        return ""
    body := SubStr(raw, pos + 2)
    if (parts[3] = "notice")
        return Map("kind", "notice", "message", body)
    if (parts[3] != "ok" || InStr(body, "<<MNA:HPI>>`r`n") != 1)
        return ""
    i1 := InStr(body, "`r`n<<MNA:EXAM>>`r`n")
    i2 := InStr(body, "`r`n<<MNA:AP>>`r`n")
    if (i1 = 0 || i2 < i1)
        return ""
    return Map("kind", "ok",
        "hpi", SubStr(body, 14, i1 - 14),
        "exam", SubStr(body, i1 + 16, i2 - (i1 + 16)),
        "ap", SubStr(body, i2 + 14))
}

MnaFreedInvalidText() {
    return "Clipboard doesn't look like a Freed note. Click Copy all in Freed, then F7."
}
