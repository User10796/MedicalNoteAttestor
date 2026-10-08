#!/bin/bash
# Swift tests for the macOS library integration (shared core via JavaScriptCore + hotkeys).
set -euo pipefail
cd "$(dirname "$0")/.."
OUT="$(mktemp -d)/mna-swift-tests"
xcrun swiftc -o "$OUT" MedicalNoteAttestor/MNACore.swift MedicalNoteAttestor/Hotkeys.swift MedicalNoteAttestor/CaptureGate.swift tests/swift/main.swift \
  -framework JavaScriptCore -framework Carbon
"$OUT" "$PWD"
