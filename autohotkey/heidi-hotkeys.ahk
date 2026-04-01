; MedicalNoteAttestor - Heidi Copy Script
; AutoHotkey v2 — launched by Electron app on startup

; ── Slot storage ──────────────────────────────────────────────────────────────

global slotHPI := ""
global slotAP  := ""
global examDotPhrase := ""

; ── Header definitions ────────────────────────────────────────────────────────

global HPI_HEADERS := ["Interval history, HPI:", "History of Present Illness (HPI):"]
global AP_HEADERS  := ["Assessment and Plan:", "Assessment and plan:", "Assessment & Plan:", "Assessment/Plan:", "A&P:", "A/P:"]

; ── Helper functions ──────────────────────────────────────────────────────────

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

; Load exam dot phrase from config file next to the exe
; Electron writes this file when the user saves their exam dot phrase
LoadConfig() {
    global examDotPhrase
    configPath := A_ScriptDir "\heidi-config.ini"
    if FileExist(configPath) {
        examDotPhrase := IniRead(configPath, "Heidi", "ExamDotPhrase", "")
        ; Convert \n literal to real newlines
        examDotPhrase := StrReplace(examDotPhrase, "\n", "`n")
    }
}

LoadConfig()

; ── Legacy hotkeys ────────────────────────────────────────────────────────────

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

; ── F8 — Capture both slots ───────────────────────────────────────────────────

F8:: {
    global slotHPI, slotAP
    ; Reload config in case exam phrase was updated
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

; ── F9 — Paste HPI ────────────────────────────────────────────────────────────

F9:: {
    global slotHPI
    if (slotHPI = "") {
        SoundBeep 300, 200
        return
    }
    PasteText(slotHPI)
}

; ── F10 — Paste Exam dot phrase ───────────────────────────────────────────────

F10:: {
    global examDotPhrase
    if (examDotPhrase = "") {
        SoundBeep 300, 200
        return
    }
    PasteText(examDotPhrase)
}

; ── F11 — Paste A&P ───────────────────────────────────────────────────────────

F11:: {
    global slotAP
    if (slotAP = "") {
        SoundBeep 300, 200
        return
    }
    PasteText(slotAP)
}

; ── F7 — Exit ─────────────────────────────────────────────────────────────────

F7::ExitApp
