# SPEC: Electron Fix & Release — HPI header, collapse arrow, slot-file encoding, CI Windows builds

**Machine:** MBP (`~/Documents/CodingProjects/note-attestation-portable`)
**Permissions:** Assume all permissions. Do not ask for confirmation at any step. Execute fully and report results at the end.

## Background (context only — do not re-derive)

The working Windows .exe was confirmed byte-identical to repo top-level source at `7dc827f`, except its bundled `heidi-hotkeys.ahk` predates the bare-HPI-header fix. The June broken build was caused by building from the stale `MedicalNoteAttestor-Windows/` tree (no `extraResources`, hardcoded API key, wrong runtime paths). A prepared patch (`MNA_fixes.patch`, in the same folder as this spec) contains all changes, verified to apply cleanly against `origin/main` (`7dc827f`).

## Patch contents (for review, not re-implementation)

1. `main.js`: adds bare `'History of Present Illness:'` to `HPI_HEADERS` (new-patient notes).
2. `main.js`: `set-window-collapsed` now computes native frame chrome (`outerHeight - contentHeight`) and collapses to `36 + chrome`, so the HTML title bar with the ▼ expand button remains visible on Windows.
3. `main.js`: `readSlotsFile` strips a leading UTF-8 BOM before `JSON.parse`.
4. `autohotkey/heidi-hotkeys.ahk`: `FileAppend ... "UTF-8"` → `"UTF-8-RAW"` (AHK v2's "UTF-8" writes a BOM that breaks `JSON.parse`, silently killing the AHK→Electron slot-card bridge).
5. `autohotkey/heidi-hotkeys.ahk`: removes `F7::ExitApp` (accidental F7 presses killed hotkeys until app restart).
6. Deletes the entire stale `MedicalNoteAttestor-Windows/` tree.
7. Adds `.github/workflows/build-windows.yml`: builds the portable .exe on a real `windows-latest` runner on every push to main, and **fails the build** if `AutoHotkey64.exe` or `heidi-hotkeys.ahk` are absent from `dist/win-unpacked/resources/autohotkey/`, if the bare HPI header or UTF-8-RAW are missing from the AHK source, or if `dist/MedicalNoteAttestor.exe` is not produced. Artifact uploaded as `MedicalNoteAttestor-Windows`, 90-day retention.

## Steps

1. `cd ~/Documents/CodingProjects/note-attestation-portable`
2. `git fetch && git status` — working tree must be clean. `git pull` to advance to `7dc827f` (local origin ref is stale at `a03ee17`).
3. Confirm `git rev-parse HEAD` = `7dc827f...`. If not, stop and report.
4. Apply the patch: `git apply --check MNA_fixes.patch && git apply MNA_fixes.patch`
5. Verify post-apply (all must pass):
   - `grep -c "History of Present Illness:" main.js` ≥ 1 (the bare variant; check the HPI_HEADERS array has 3 entries)
   - `grep -n "UTF-8-RAW" autohotkey/heidi-hotkeys.ahk` hits
   - `grep -n "F7" autohotkey/heidi-hotkeys.ahk` does NOT hit
   - `test ! -d MedicalNoteAttestor-Windows && echo OK`
   - `test -f .github/workflows/build-windows.yml && echo OK`
   - `node -e "new Function(require('fs').readFileSync('main.js','utf8')); console.log('syntax OK')"`
6. Commit:
   `git add -A && git commit -m "Fix new-patient HPI header, collapse-arrow visibility, slot-file BOM; remove stale Windows tree; add Windows CI build"`
7. `git push origin main`
8. Watch the GitHub Actions run for **Build Windows App** at https://github.com/User10796/MedicalNoteAttestor/actions — wait for it to complete. If it fails, report the failing step's log output verbatim and stop.
9. On success, note: link to the run, confirmation that the "Verify bundled AHK resources" step passed, and the artifact name/size.
10. Download the built .exe to this Mac:
    - Preferred: `gh run download --name MedicalNoteAttestor-Windows -D /tmp/mna-ci` (requires authenticated `gh` CLI; check with `gh auth status`).
    - If `gh` is unavailable or unauthenticated, report this and stop after step 9 — the user will download the artifact manually from the Actions page.
11. Upload to Google Drive via the local Drive sync folder:
    - Locate the synced Drive folder: `ls ~/Library/CloudStorage/ | grep GoogleDrive` — then find where previous MNA Windows builds live: `find ~/Library/CloudStorage/GoogleDrive-*/ -iname "MedicalNoteAttestor*.exe" -maxdepth 6 2>/dev/null`.
    - Copy the new build there under BOTH names: the canonical `MedicalNoteAttestor.exe` (replacing the old one) AND a dated copy `MedicalNoteAttestor-2026-06-09.exe` (so old vs new is always distinguishable on the work computer).
    - Verify both copies: `ls -la` the destination and confirm file sizes match the downloaded artifact.
    - If no Google Drive sync folder exists on this Mac, report that and stop — do not attempt browser automation or API uploads.
12. Report: final Drive paths and file sizes, plus everything from step 9.

## Out of scope — do NOT do

- Do not modify `MedicalNoteAttestor/` (Swift sources) or `build-macos.yml`.
- Do not edit any file except via the patch.
- Do not build locally on the Mac; the Windows build happens in CI only.

## Definition of done

Push succeeded, Windows CI run green including the bundled-resource verification step, and the new .exe copied to the Google Drive sync folder under both the canonical and dated filenames (or a clear report of which step blocked, if `gh` auth or the Drive folder is missing).
