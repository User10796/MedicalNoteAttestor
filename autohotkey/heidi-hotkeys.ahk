; MedicalNoteAttestor - Heidi Copy Script
; AutoHotkey v2 — launched by Electron app on startup
; IMPORTANT: Hotkeys at top level, functions defined below

; ── Globals ───────────────────────────────────────────────────────────────────

global slotHPI := ""
global slotAP  := ""
global examDotPhrase := ""
global lastCaptureTs := ""          ; A_TickCount of the capture these slots belong to
global activeHotkeys := Map()       ; action -> AHK key currently registered
global lastHotkeysText := "<unread>"
global HPI_HEADERS := ["Interval history, HPI:", "History of Present Illness (HPI):", "History of Present Illness:"]
global AP_HEADERS  := ["Assessment and Plan:", "Assessment and plan:", "Assessment & Plan:", "Assessment/Plan:", "A&P:", "A/P:"]

#Include %A_ScriptDir%\mna-lib.ahk

; ── Load config on startup ────────────────────────────────────────────────────

LoadConfig()

; Configurable hotkeys (Settings > Hotkeys). Electron writes hotkeys.json; we poll it every
; 250 ms (change notifications don't fire on UNC paths) and re-register on change.
CheckHotkeysFile()
SetTimer(CheckHotkeysFile, 250)

; ── Hotkeys ───────────────────────────────────────────────────────────────────

PgUp:: {
    A_Clipboard := ""
    Send "^a^c"
    ClipWait 2
    extracted := ExtractHPI(A_Clipboard)
    if (extracted != "")
        A_Clipboard := extracted
}

PgDn:: {
    A_Clipboard := ""
    Send "^a^c"
    ClipWait 2
    extracted := ExtractAP(A_Clipboard)
    if (extracted != "")
        A_Clipboard := extracted
}

; F8-F11 defaults are registered dynamically (see ApplyHotkeys); the legacy PgUp/PgDn above stay fixed.

DoCapture() {
    global slotHPI, slotAP, lastCaptureTs
    LoadConfig()
    A_Clipboard := ""
    Send "^a^c"
    ClipWait 2
    text := A_Clipboard
    if (text = "") {
        SoundBeep 300, 200
        return
    }
    slotHPI := ExtractHPI(text)
    slotAP  := ExtractAP(text)
    lastCaptureTs := A_TickCount
    A_Clipboard := text
    WriteSlots()
    if (slotHPI != "" && slotAP != "") {
        SoundBeep 880, 80
        Sleep 60
        SoundBeep 880, 80
    } else if (slotHPI != "" || slotAP != "") {
        SoundBeep 660, 150
    } else {
        SoundBeep 300, 300
    }
}

DoPasteHpi() {
    global slotHPI
    if (slotHPI = "") {
        SoundBeep 300, 200
        return
    }
    PasteText(slotHPI)
}

; Exam: library-composed text for this capture if Sterling confirmed a payer/procedure,
; otherwise exactly today's behavior (exam dot-phrase, or a beep when it's empty).
DoPasteExam() {
    global examDotPhrase, lastCaptureTs
    composed := MnaReadComposed(GetRuntimeDir() "\mna-exam.txt", lastCaptureTs)
    if (composed != "") {
        PasteText(composed)
        return
    }
    if (examDotPhrase = "") {
        SoundBeep 300, 200
        return
    }
    PasteText(examDotPhrase)
}

; A&P: A&P + library dot-phrase(s) for this capture if confirmed, otherwise today's A&P.
DoPasteAp() {
    global slotAP, lastCaptureTs
    composed := MnaReadComposed(GetRuntimeDir() "\mna-ap.txt", lastCaptureTs)
    if (composed != "") {
        PasteText(composed)
        return
    }
    if (slotAP = "") {
        SoundBeep 300, 200
        return
    }
    PasteText(slotAP)
}

RunAction(action) {
    switch action {
        case "capture":   DoCapture()
        case "pasteHpi":  DoPasteHpi()
        case "pasteExam": DoPasteExam()
        case "pasteAp":   DoPasteAp()
    }
}

; A factory so each hotkey's closure captures its own action (not the loop variable).
MakeHandler(action) {
    return (*) => RunAction(action)
}

; Register `bindings` (action -> AHK key). If any key fails, fall back to the defaults.
ApplyHotkeys(bindings, isFallback := false) {
    global activeHotkeys
    for action, key in activeHotkeys {
        try Hotkey(key, "Off")
    }
    activeHotkeys := Map()
    for action, key in bindings {
        try {
            Hotkey(key, MakeHandler(action), "On")
            activeHotkeys[action] := key
        } catch as e {
            MnaLog(GetRuntimeDir(), "hotkey " action "=" key " failed to register (" e.Message ")")
            if !isFallback {
                MnaLog(GetRuntimeDir(), "using default hotkeys F8/F9/F10/F11")
                ApplyHotkeys(MnaDefaultHotkeys(), true)
            }
            return
        }
    }
}

CheckHotkeysFile() {
    global lastHotkeysText
    path := GetRuntimeDir() "\hotkeys.json"
    text := ""
    if FileExist(path) {
        try text := FileRead(path, "UTF-8")
        catch
            return   ; mid-write; try again in 250 ms
    }
    if (text = lastHotkeysText)
        return
    lastHotkeysText := text
    bindings := text = "" ? "" : MnaParseHotkeysJson(text)
    if !IsObject(bindings) {
        MnaLog(GetRuntimeDir(), (text = "" ? "hotkeys.json missing" : "hotkeys.json invalid") "; using defaults F8/F9/F10/F11")
        bindings := MnaDefaultHotkeys()
    }
    ApplyHotkeys(bindings)
}


; ── Functions — defined after hotkeys ─────────────────────────────────────────

CleanText(text) {
    while RegExMatch(text, "\*\*(.+?)\*\*", &match) {
        text := StrReplace(text, match[0], StrUpper(match[1]))
    }
    text := StrReplace(text, "*", "")
    text := RegExReplace(text, "^\s+", "")
    text := Trim(text)
    return text
}

ExtractHPI(text) {
    hpiStart := 0
    for header in HPI_HEADERS {
        pos := InStr(text, header)
        if (pos > 0) {
            hpiStart := pos + StrLen(header)
            break
        }
    }
    if (hpiStart = 0)
        return ""
    apPos := 0
    for header in AP_HEADERS {
        pos := InStr(text, header)
        if (pos > hpiStart) {
            apPos := pos
            break
        }
    }
    if (apPos = 0)
        return ""
    return CleanText(SubStr(text, hpiStart, apPos - hpiStart))
}

ExtractAP(text) {
    apStart := 0
    for header in AP_HEADERS {
        pos := InStr(text, header)
        if (pos > 0) {
            apStart := pos + StrLen(header)
            break
        }
    }
    if (apStart = 0)
        return ""
    return CleanText(SubStr(text, apStart))
}

PasteText(text) {
    if (text = "")
        return
    A_Clipboard := text
    Sleep 80
    Send "^v"
}

JsonEscape(text) {
    text := StrReplace(text, "\", "\\")
    text := StrReplace(text, '"', '\"')
    text := StrReplace(text, "`r`n", "\n")
    text := StrReplace(text, "`n", "\n")
    text := StrReplace(text, "`r", "\n")
    return text
}

GetRuntimeDir() {
    exeDir := EnvGet("PORTABLE_EXECUTABLE_DIR")
    if (exeDir != "")
        return exeDir
    return A_ScriptDir "\..\..\"
}

WriteSlots() {
    global slotHPI, slotAP, lastCaptureTs
    runtimeDir := GetRuntimeDir()
    slotsPath := runtimeDir "\heidi-slots.json"
    ts := lastCaptureTs
    json := '{"hpi":"' . JsonEscape(slotHPI) . '","ap":"' . JsonEscape(slotAP) . '","timestamp":' . ts . '}'
    try {
        FileDelete slotsPath
        FileAppend json, slotsPath, "UTF-8-RAW"
    }
}

LoadConfig() {
    global examDotPhrase
    runtimeDir := GetRuntimeDir()
    configPath := runtimeDir "\heidi-config.ini"
    if FileExist(configPath) {
        examDotPhrase := IniRead(configPath, "Heidi", "ExamDotPhrase", "")
        examDotPhrase := StrReplace(examDotPhrase, "\n", "`n")
    }
}
