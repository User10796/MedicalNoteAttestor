#!/bin/bash
# Build-time stamp for the macOS app (Settings > About: Commit, Built). Runs as the Xcode
# "Stamp build info" phase on every build (Xcode, CI, scripts/build-macos.sh) and writes into the
# BUILT Info.plist, before code signing. Nothing is read from git at runtime.
#   commit: short HEAD, plus "-dirty" if tracked files have uncommitted changes
#   time:   UTC ISO-8601
# Fails the build if the commit can't be determined (missing/empty stamp).
#   usage: stamp-macos-build.sh <path/to/Info.plist> [<source root>]
set -euo pipefail
PLIST="${1:?usage: stamp-macos-build.sh <Info.plist> [<source root>]}"
ROOT="${2:-${SRCROOT:-$(cd "$(dirname "$0")/.." && pwd)}}"

COMMIT="$(git -C "$ROOT" rev-parse --short HEAD 2>/dev/null || true)"
if [ -z "$COMMIT" ]; then
  echo "error: build stamp: could not read the git commit in $ROOT; refusing to build an unstamped app" >&2
  exit 1
fi
if [ -n "$(git -C "$ROOT" status --porcelain --untracked-files=no 2>/dev/null)" ]; then
  COMMIT="$COMMIT-dirty"
fi
BUILT_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

set_key() {  # Set, or Add if the key is missing
  /usr/libexec/PlistBuddy -c "Set :$1 $2" "$PLIST" 2>/dev/null || /usr/libexec/PlistBuddy -c "Add :$1 string $2" "$PLIST"
}
set_key MNABuildCommit "$COMMIT"
set_key MNABuildTime "$BUILT_AT"

GOT="$(/usr/libexec/PlistBuddy -c 'Print :MNABuildCommit' "$PLIST" 2>/dev/null || true)"
if [ -z "$GOT" ] || [ "$GOT" != "$COMMIT" ]; then
  echo "error: build stamp: MNABuildCommit missing or empty in $PLIST" >&2
  exit 1
fi
echo "Build stamp: $COMMIT, built $BUILT_AT"
