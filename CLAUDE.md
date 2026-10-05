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
