#!/usr/bin/env bash
# Makes the bundled vips sidecar self-contained on macOS.
# 1. Recursively collects every transitive non-system dylib into
#    src-tauri/frameworks/ (single source per test run, committed).
# 2. Rewrites every load command (dylibs + sidecar) to @rpath/<basename>.
# 3. Adds rpaths for both layouts: bundled (Contents/MacOS → ../Frameworks)
#    and dev (src-tauri/target/<profile> → ../../frameworks).
# 4. Ad-hoc signs everything (install_name_tool invalidates signatures).
# Re-runnable: already-bundled state is detected and left untouched
# (the audit verifies final state); a fresh sidecar triggers a full re-collect.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BIN="$ROOT/src-tauri/binaries"
FRAMEWORKS="$ROOT/src-tauri/frameworks"
TRIPLE="$(rustc -Vv | grep '^host:' | sed 's/host: //')"
SIDECAR="$BIN/vips-$TRIPLE"

[ -f "$SIDECAR" ] || { printf 'FAIL sidecar missing: %s\n' "$SIDECAR"; exit 1; }
[ "$(uname)" = "Darwin" ] || { printf 'FAIL macOS only\n'; exit 1; }

system_path() {
  case "$1" in
    /usr/lib/system/*|/System/Library/*|/usr/lib/*|@*) return 0 ;;
    /*) return 1 ;;
    *) return 0 ;;
  esac
}

collect() {
  local src="$1"
  local base="$(basename "$src")"
  local dest="$FRAMEWORKS/$base"
  [ -f "$dest" ] && return 0
  mkdir -p "$FRAMEWORKS"
  cp "$src" "$dest"
  chmod u+w "$dest"
  local dep depbase cand rp found
  for dep in $(otool -L "$src" | tail -n +2 | awk '{print $1}'); do
    case "$dep" in
      @rpath/*)
        depbase="${dep#@rpath/}"
        [ -f "$FRAMEWORKS/$depbase" ] && continue
        found=""
        while IFS= read -r rp; do
          [ -z "$rp" ] && continue
          cand="$rp"
          cand="${cand//@loader_path/$(dirname "$src")}"
          cand="${cand//@executable_path/$(dirname "$SIDECAR")}"
          if [ -f "$cand/$depbase" ]; then
            found="$cand/$depbase"
            break
          fi
        done < <(otool -l "$src" | grep -A3 LC_RPATH | awk '$1 == "path" {print $2}')
        if [ -z "$found" ]; then
          printf 'FAIL cannot resolve %s (dep of %s) via LC_RPATH\n' "$dep" "$src"
          exit 1
        fi
        collect "$found"
        ;;
      /*) system_path "$dep" || collect "$dep" ;;
    esac
  done
}

rewrite() {
  local file="$1"
  chmod u+w "$file"
  for dep in $(otool -L "$file" | tail -n +2 | awk '{print $1}'); do
    system_path "$dep" || install_name_tool -change "$dep" "@rpath/$(basename "$dep")" "$file"
  done
}

needs_bundle=0
for dep in $(otool -L "$SIDECAR" | tail -n +2 | awk '{print $1}'); do
  if ! system_path "$dep"; then
    needs_bundle=1
    break
  fi
done

if [ "$needs_bundle" -eq 0 ]; then
  if [ -d "$FRAMEWORKS" ] && ls "$FRAMEWORKS"/*.dylib >/dev/null 2>&1; then
    exit 0
  fi
  printf 'FAIL sidecar already rewritten but frameworks/ missing — restore both from git\n'
  exit 1
fi

rm -rf "$FRAMEWORKS"

for dep in $(otool -L "$SIDECAR" | tail -n +2 | awk '{print $1}'); do
  system_path "$dep" || collect "$dep"
done

for lib in "$FRAMEWORKS"/*.dylib; do
  install_name_tool -id "@rpath/$(basename "$lib")" "$lib"
  rewrite "$lib"
done
rewrite "$SIDECAR"

install_name_tool -add_rpath "@executable_path/../Frameworks" "$SIDECAR" 2>/dev/null || true
install_name_tool -add_rpath "@executable_path/../../frameworks" "$SIDECAR" 2>/dev/null || true

for lib in "$FRAMEWORKS"/*.dylib; do
  install_name_tool -add_rpath "@executable_path/../Frameworks" "$lib" 2>/dev/null || true
  install_name_tool -add_rpath "@executable_path/../../frameworks" "$lib" 2>/dev/null || true
done

codesign --force --sign - "$SIDECAR" 2>/dev/null || true
for lib in "$FRAMEWORKS"/*.dylib; do
  codesign --force --sign - "$lib" 2>/dev/null || true
done
