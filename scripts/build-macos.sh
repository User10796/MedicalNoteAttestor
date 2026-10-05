#!/bin/bash
# Local macOS release build (spec §6.2): embeds the latest criteria-library snapshot (downloaded
# with Sterling's local `gh` auth) and the build stamp (commit, build time, library tag) shown in
# Settings > About, then writes dist/MedicalNoteAttestor-<shortsha>.dmg. Ad-hoc signed, as before.
set -euo pipefail
cd "$(dirname "$0")/.."

SHA="$(git rev-parse --short HEAD)"
if [ -n "$(git status --porcelain --untracked-files=no)" ]; then
  echo "WARNING: uncommitted changes; the stamp says $SHA but the build includes them" >&2
fi
TAG="$(gh release view --repo User10796/pain-criteria-library --json tagName -q .tagName)"
mkdir -p resources dist
gh release download "$TAG" --repo User10796/pain-criteria-library -p library.json -O resources/library.snapshot.json --clobber
node scripts/stamp-library-snapshot.js resources/library.snapshot.json "$TAG"
BUILT_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

xcodebuild -project MedicalNoteAttestor.xcodeproj -scheme MedicalNoteAttestor -configuration Release \
  -derivedDataPath build/macos CODE_SIGN_IDENTITY=- \
  MNA_BUILD_COMMIT="$SHA" MNA_BUILD_TIME="$BUILT_AT" MNA_LIBRARY_TAG="$TAG" build

APP="build/macos/Build/Products/Release/MedicalNoteAttestor.app"
PL="$APP/Contents/Info.plist"
[ "$(/usr/libexec/PlistBuddy -c 'Print :MNABuildCommit' "$PL")" = "$SHA" ] || { echo "FATAL: build stamp commit mismatch"; exit 1; }
[ "$(/usr/libexec/PlistBuddy -c 'Print :MNALibraryTag' "$PL")" = "$TAG" ] || { echo "FATAL: library tag not stamped"; exit 1; }
test -f "$APP/Contents/Resources/mna-core.js" || { echo "FATAL: mna-core.js not in app bundle"; exit 1; }
test -f "$APP/Contents/Resources/library.snapshot.json" || { echo "FATAL: library snapshot not embedded"; exit 1; }
node -e "const b=JSON.parse(require('fs').readFileSync(process.argv[1],'utf8')); if(!b.built_at||!b.entries.length) process.exit(1)" \
  "$APP/Contents/Resources/library.snapshot.json" || { echo "FATAL: embedded snapshot invalid"; exit 1; }
codesign --verify --deep --strict "$APP"
echo "App OK: commit $SHA, built $BUILT_AT, library $TAG"

DMG="dist/MedicalNoteAttestor-$SHA.dmg"
STAGE="$(mktemp -d)"
cp -R "$APP" "$STAGE/"
ln -s /Applications "$STAGE/Applications"
rm -f "$DMG"
hdiutil create -volname "Medical Note Attestor" -srcfolder "$STAGE" -ov -format UDZO "$DMG" >/dev/null
rm -rf "$STAGE"
echo "DMG: $DMG"
