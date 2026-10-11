#!/bin/bash
# Local macOS release build: embeds the latest criteria-library snapshot (downloaded with
# Sterling's local `gh` auth). The build stamp (commit + -dirty, build time) is written by the
# Xcode "Stamp build info" phase (scripts/stamp-macos-build.sh); the DMG is named from that stamp:
# dist/MedicalNoteAttestor-<stamp>.dmg. Ad-hoc signed, as before. Never overwrites an existing DMG.
set -euo pipefail
cd "$(dirname "$0")/.."

if [ -n "$(git status --porcelain --untracked-files=no)" ]; then
  echo "WARNING: uncommitted changes; the build stamp will end in -dirty" >&2
fi
TAG="$(gh release view --repo User10796/pain-criteria-library --json tagName -q .tagName)"
mkdir -p resources dist
gh release download "$TAG" --repo User10796/pain-criteria-library -p library.json -O resources/library.snapshot.json --clobber
node scripts/stamp-library-snapshot.js resources/library.snapshot.json "$TAG"
xcodebuild -project MedicalNoteAttestor.xcodeproj -scheme MedicalNoteAttestor -configuration Release \
  -derivedDataPath build/macos CODE_SIGN_IDENTITY=- \
  MNA_LIBRARY_TAG="$TAG" build

APP="build/macos/Build/Products/Release/MedicalNoteAttestor.app"
PL="$APP/Contents/Info.plist"
STAMP="$(/usr/libexec/PlistBuddy -c 'Print :MNABuildCommit' "$PL")"
BUILT_AT="$(/usr/libexec/PlistBuddy -c 'Print :MNABuildTime' "$PL")"
EXPECT="$(git rev-parse --short HEAD)"; [ -n "$(git status --porcelain --untracked-files=no)" ] && EXPECT="$EXPECT-dirty"
[ -n "$STAMP" ] && [ "$STAMP" = "$EXPECT" ] || { echo "FATAL: build stamp '$STAMP' != expected '$EXPECT'"; exit 1; }
[ "$(/usr/libexec/PlistBuddy -c 'Print :MNALibraryTag' "$PL")" = "$TAG" ] || { echo "FATAL: library tag not stamped"; exit 1; }
test -f "$APP/Contents/Resources/mna-core.js" || { echo "FATAL: mna-core.js not in app bundle"; exit 1; }
test -f "$APP/Contents/Resources/library.snapshot.json" || { echo "FATAL: library snapshot not embedded"; exit 1; }
node -e "const b=JSON.parse(require('fs').readFileSync(process.argv[1],'utf8')); if(!b.built_at||!b.entries.length) process.exit(1)" \
  "$APP/Contents/Resources/library.snapshot.json" || { echo "FATAL: embedded snapshot invalid"; exit 1; }
codesign --verify --deep --strict "$APP"
echo "App OK: commit $STAMP, built $BUILT_AT, library $TAG"

DMG="dist/MedicalNoteAttestor-$STAMP.dmg"
[ -e "$DMG" ] && { echo "FATAL: $DMG already exists; not overwriting"; exit 1; }
STAGE="$(mktemp -d)"
cp -R "$APP" "$STAGE/"
# --skip-jenkins: no Finder AppleScript window layout (it hangs unattended); --no-internet-enable.
create-dmg --volname "Medical Note Attestor" --app-drop-link 450 185 --skip-jenkins "$DMG" "$STAGE"
rm -rf "$STAGE"
echo "DMG: $DMG"
