#!/bin/bash
# Tests scripts/stamp-macos-build.sh against throwaway git repos (Part A / Part C.8):
# clean tree -> short hash; dirty tree -> "-dirty"; no git -> the build fails (no empty stamp).
set -euo pipefail
cd "$(dirname "$0")/.."
STAMP="$PWD/scripts/stamp-macos-build.sh"
T="$(mktemp -d)"; trap 'rm -rf "$T"' EXIT
pass=0; fail=0
ok() { if eval "$1"; then pass=$((pass+1)); echo "ok - $2"; else fail=$((fail+1)); echo "not ok - $2"; fi; }
newplist() { printf '<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict><key>MNABuildCommit</key><string></string></dict></plist>\n' > "$1"; }
get() { /usr/libexec/PlistBuddy -c "Print :$1" "$2"; }

git -C "$T" init -q repo && git -C "$T/repo" -c user.email=t@t -c user.name=t commit -q --allow-empty -m init
echo a > "$T/repo/f.txt" && git -C "$T/repo" add f.txt && git -C "$T/repo" -c user.email=t@t -c user.name=t commit -q -m f
H="$(git -C "$T/repo" rev-parse --short HEAD)"

newplist "$T/clean.plist"; "$STAMP" "$T/clean.plist" "$T/repo" >/dev/null
ok '[ "$(get MNABuildCommit "$T/clean.plist")" = "$H" ]' "clean tree: commit is the short hash"
ok '[[ "$(get MNABuildTime "$T/clean.plist")" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9:]{8}Z$ ]]' "build time is UTC ISO-8601"

echo untracked > "$T/repo/new.txt"; newplist "$T/untracked.plist"; "$STAMP" "$T/untracked.plist" "$T/repo" >/dev/null
ok '[ "$(get MNABuildCommit "$T/untracked.plist")" = "$H" ]' "untracked files alone don't mark dirty"

echo b > "$T/repo/f.txt"; newplist "$T/dirty.plist"; "$STAMP" "$T/dirty.plist" "$T/repo" >/dev/null
ok '[ "$(get MNABuildCommit "$T/dirty.plist")" = "$H-dirty" ]' "dirty tree: commit gets -dirty"

mkdir "$T/nogit"; newplist "$T/nogit.plist"
ok '! "$STAMP" "$T/nogit.plist" "$T/nogit" >/dev/null 2>&1' "no git commit -> stamp script fails the build"
ok '[ -z "$(get MNABuildCommit "$T/nogit.plist")" ]' "...and writes no stamp"

echo "$pass passed, $fail failed"
[ "$fail" -eq 0 ]
