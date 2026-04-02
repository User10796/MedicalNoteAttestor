; MedicalNoteAttestor - Heidi Copy Script
; AutoHotkey v2 — launched by Electron app on startup
; IMPORTANT: Hotkeys at top level, functions defined below

; ── Globals ───────────────────────────────────────────────────────────────────

global slotHPI := ""
global slotAP  := ""
global examDotPhrase := ""
global HPI_HEADERS := ["Interval history, HPI:", "History of Present Illness (HPI):"]
global AP_HEADERS  := ["Assessment and Plan:", "Assessment and plan:", "Assessment & Plan:", "Assessment/Plan:", "A&P:", "A/P:"]

; ── Load config on startup ────────────────────────────────────────────────────

LoadConfig()

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

F8:: {
    global slotHPI, slotAP
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

F9:: {
    global slotHPI
    if (slotHPI = "") {
        SoundBeep 300, 200
        return
    }
    PasteText(slotHPI)
}

F10:: {
    global examDotPhrase
    if (examDotPhrase = "") {
        SoundBeep 300, 200
        return
    }
    PasteText(examDotPhrase)
}

F11:: {
    global slotAP
    if (slotAP = "") {
        SoundBeep 300, 200
        return
    }
    PasteText(slotAP)
}

F7::ExitApp

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
    global slotHPI, slotAP
    runtimeDir := GetRuntimeDir()
    slotsPath := runtimeDir "\heidi-slots.json"
    ts := A_TickCount
    json := '{"hpi":"' . JsonEscape(slotHPI) . '","ap":"' . JsonEscape(slotAP) . '","timestamp":' . ts . '}'
    try {
        FileDelete slotsPath
        FileAppend json, slotsPath, "UTF-8"
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
