#!/usr/bin/env bash
# Makes the bundled vips sidecar self-contained on macOS.
# 1. Recursively collects every transitive non-system dylib into
#    src-tauri/frameworks/ (single source per test run, committed).
#    @rpath/* dependencies are resolved through the referencing image's
#    LC_RPATH entries so brew dylibs pre-wired with @rpath deps are collected.
# 2. Rewrites every load command (dylibs + sidecar) to @rpath/<basename>.
# 3. Adds rpaths for both layouts: bundled (Contents/MacOS → ../Frameworks)
#    and dev (src-tauri/target/<profile> → ../../frameworks). rpaths are
#    presence-checked via otool -l; a real install_name_tool failure aborts.
# 4. Ad-hoc signs everything (install_name_tool invalidates signatures);
#    signing failures abort.
# Known limitation: gdk-pixbuf loader modules are dlopened at runtime from a
# compiled-in prefix and are NOT collected. Harmless for the vips chain;
# slices 5-8 should ship loaders + a GDK_PIXBUF_MODULE_FILE override only if
# a future engine actually initializes gdk-pixbuf.
# Re-runnable: already-bundled state is detected and left untouched
# (the audit verifies final state); a fresh sidecar triggers a full re-collect.
# Basename collisions between distinct dylibs abort with a fingerprint
# mismatch instead of silently unifying.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=sidecar-bundle.common.sh
source "$SCRIPT_DIR/sidecar-bundle.common.sh"

ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
FRAMEWORKS="$ROOT/src-tauri/frameworks"
TRIPLE="$(rustc -Vv | grep '^host:' | sed 's/host: //')"
SIDECAR="$ROOT/src-tauri/binaries/vips-$TRIPLE"

[ -f "$SIDECAR" ] || { printf 'FAIL sidecar missing: %s\n' "$SIDECAR"; exit 1; }
[ "$(uname)" = "Darwin" ] || { printf 'FAIL macOS only\n'; exit 1; }

collect() {
  local src="$1"
  local base="$(basename "$src")"
  local dest="$FRAMEWORKS/$base"
  if [ -f "$dest" ]; then
    if [ "$(fingerprint "$src")" != "$(fingerprint "$dest")" ]; then
      printf 'FAIL duplicate dylib basename with different content: %s vs %s\n' "$src" "$dest"
      exit 1
    fi
    return 0
  fi
  mkdir -p "$FRAMEWORKS"
  cp "$src" "$dest"
  chmod u+w "$dest"
  collect_deps_of "$src"
}

collect_deps_of() {
  local src="$1"
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

collect_deps_of "$SIDECAR"

for lib in "$FRAMEWORKS"/*.dylib; do
  [ -e "$lib" ] || continue
  install_name_tool -id "@rpath/$(basename "$lib")" "$lib"
  rewrite "$lib"
done
rewrite "$SIDECAR"

ensure_rpath "$SIDECAR" "@executable_path/../Frameworks"
ensure_rpath "$SIDECAR" "@executable_path/../../frameworks"

for lib in "$FRAMEWORKS"/*.dylib; do
  [ -e "$lib" ] || continue
  ensure_rpath "$lib" "@executable_path/../Frameworks"
  ensure_rpath "$lib" "@executable_path/../../frameworks"
done

codesign --force --sign - "$SIDECAR"
for lib in "$FRAMEWORKS"/*.dylib; do
  [ -e "$lib" ] || continue
  codesign --force --sign - "$lib"
done
