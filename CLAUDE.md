# MedicalNoteAttestor — conventions for Claude Code sessions

- Canonical clone: `~/Developer/note-attestation-portable` on the Mac Studio (not `~/Documents`, which is iCloud).
  Other clones (MBP) must `git pull` before use. Never copy files between machines; GitHub is the source of truth.
- Two apps in one repo: **Windows** = Electron at the repo root (`main.js`, `renderer.js`, `settings.html`, `lib/`)
  plus bundled AutoHotkey v2 (`autohotkey/heidi-hotkeys.ahk`), which owns the global hotkeys on Windows.
  **macOS** = native Swift (`MedicalNoteAttestor/`, Xcode project; new Swift files must be added to the pbxproj).
- AHK ↔ Electron bridge is files in the runtime dir: `heidi-slots.json` (AHK writes, UTF-8-RAW, no BOM).
  Electron reads them by **250 ms mtime polling** (`lib/slot-poller.js`); `fs.watch` does not fire on the
  workstation's UNC paths. Keep the BOM-strip safety net in every reader.
- Tests: `npm test` (Node built-in `node:test`, no deps). CI: `.github/workflows/test.yml`, `build-windows.yml`
  (runs on PRs too; verifies bundled AHK + app.asar contents).
- Never change clinical text (dot-phrases, exam text, attestation template) or default hotkeys (F8 capture,
  F9 HPI, F10 Exam, F11 A&P) without Sterling's explicit OK.
- No PHI leaves the machine except the pre-existing, user-initiated Claude API calls. Never log note text.
- Tokens/keys: never print, log, commit, or build them into binaries.
- Windows `.exe` goes to Google Drive; never overwrite the canonical file without confirmation.
- Criteria library integration: shared core `lib/mna-core.js` (detection, composition, payer search, hotkey
  validation) runs in Electron and, via JavaScriptCore, in the Swift app (`MNACore.swift`). Change it once,
  test it once: `npm test` (Node) and `scripts/test-swift.sh` (same fixtures through JavaScriptCore).
- Windows composed output for AHK: `mna-exam.txt` / `mna-ap.txt` in the runtime dir, header `MNA1 <captureTs>`;
  AHK pastes them only for the capture it holds. Hotkeys: Electron writes `hotkeys.json`, AHK polls it (250 ms).
- macOS release build: `scripts/build-macos.sh` (embeds the library snapshot + build stamp, DMG in `dist/`).
- Test harness for the picker UI: serve the repo root statically and open `test/ui/picker-harness.html`.
