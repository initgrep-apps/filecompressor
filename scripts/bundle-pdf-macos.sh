#!/usr/bin/env bash
# Makes the qpdf + gs sidecars self-contained on macOS (pattern of
# bundle-vips-macos.sh, run incrementally — frameworks/ is committed and
# shared with vips, so this script only ADDS dylibs and never deletes).
# 1. Recursively collects every transitive non-system dylib of the qpdf/gs
#    sidecars into src-tauri/frameworks/ (single source per run, committed).
#    @rpath/* deps resolve through the referencing image's LC_RPATH entries;
#    an unresolved @rpath/<base> falls back to scanning Homebrew's opt/lib
#    prefixes (brew binaries like qpdf carry @loader_path/../lib rpaths that
#    only make sense at their original prefix).
# 2. Rewrites every load command (dylibs + sidecars) to @rpath/<basename>.
# 3. Adds rpaths for both layouts: bundled (Contents/MacOS → ../Frameworks)
#    and dev (src-tauri/target/<profile> → ../../frameworks).
# 4. Ad-hoc signs everything (install_name_tool invalidates signatures).
# Re-runnable: when the sidecars are already self-contained, collection and
# install-id rewriting of committed dylibs is skipped, but load commands and
# rpaths are still re-verified and everything is re-signed on every run (the
# audit verifies final state). Basename collisions between distinct dylibs
# abort with a fingerprint mismatch instead of silently unifying.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=sidecar-bundle.common.sh
source "$SCRIPT_DIR/sidecar-bundle.common.sh"

ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
FRAMEWORKS="$ROOT/src-tauri/frameworks"
TRIPLE="$(rustc -Vv | grep '^host:' | sed 's/host: //')"
ENGINES=("$ROOT/src-tauri/binaries/qpdf-$TRIPLE" "$ROOT/src-tauri/binaries/gs-$TRIPLE")

for sidecar in "${ENGINES[@]}"; do
  [ -f "$sidecar" ] || { printf 'FAIL sidecar missing: %s\n' "$sidecar"; exit 1; }
done
[ "$(uname)" = "Darwin" ] || { printf 'FAIL macOS only\n'; exit 1; }

find_in_brew() {
  local base="$1" hit
  for prefix in /opt/homebrew /usr/local; do
    for hit in "$prefix"/opt/*/lib/"$base" "$prefix"/lib/"$base"; do
      [ -f "$hit" ] || continue
      printf 'note: resolved %s from brew: %s\n' "$base" "$hit" >&2
      printf '%s\n' "$hit"
      return 0
    done
  done
  return 1
}

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
  local dep depbase cand found
  for dep in $(otool -L "$src" | tail -n +2 | awk '{print $1}'); do
    case "$dep" in
      @rpath/*)
        depbase="${dep#@rpath/}"
        found=""
        while IFS= read -r rp; do
          [ -z "$rp" ] && continue
          cand="$rp"
          cand="${cand//@loader_path/$(dirname "$src")}"
          cand="${cand//@executable_path/$(dirname "${ENGINES[0]}")}"
          if [ -f "$cand/$depbase" ]; then
            found="$cand/$depbase"
            break
          fi
        done < <(otool -l "$src" | grep -A3 LC_RPATH | awk '$1 == "path" {print $2}')
        if [ -z "$found" ]; then
          found="$(find_in_brew "$depbase")" || {
            if [ -f "$FRAMEWORKS/$depbase" ]; then
              printf 'FAIL %s is in frameworks but cannot be re-resolved to fingerprint from %s — restore both binaries and frameworks/ from git\n' "$dep" "$src"
              exit 1
            fi
            printf 'FAIL cannot resolve %s (dep of %s)\n' "$dep" "$src"
            exit 1
          }
        fi
        collect "$found"
        ;;
      /*) system_path "$dep" || collect "$dep" ;;
    esac
  done
}

needs_bundle=0
for sidecar in "${ENGINES[@]}"; do
  for dep in $(otool -L "$sidecar" | tail -n +2 | awk '{print $1}'); do
    case "$dep" in
      @rpath/*) [ -e "$FRAMEWORKS/${dep#@rpath/}" ] || { needs_bundle=1; break 2; } ;;
      /opt/homebrew/*|/usr/local/*) needs_bundle=1; break 2 ;;
      *) system_path "$dep" || { needs_bundle=1; break 2; } ;;
    esac
  done
done

if [ "$needs_bundle" -eq 0 ]; then
  # Sidecars already rewritten but the committed frameworks/ dylibs are
  # missing — the bundle would abort on @rpath deps at load time.
  if [ ! -d "$FRAMEWORKS" ] || ! ls "$FRAMEWORKS"/*.dylib >/dev/null 2>&1; then
    printf 'FAIL sidecars already rewritten but frameworks/ missing — restore both from git\n'
    exit 1
  fi
fi

if [ "$needs_bundle" -eq 1 ]; then
  for sidecar in "${ENGINES[@]}"; do
    collect_deps_of "$sidecar"
  done

  for lib in "$FRAMEWORKS"/*.dylib; do
    [ -e "$lib" ] || continue
    if [ "$(otool -D "$lib" | tail -n +2 | awk '{print $1}')" != "@rpath/$(basename "$lib")" ]; then
      install_name_tool -id "@rpath/$(basename "$lib")" "$lib"
      rewrite "$lib"
    fi
  done
fi

for sidecar in "${ENGINES[@]}"; do
  rewrite "$sidecar"
  ensure_rpath "$sidecar" "@executable_path/../Frameworks"
  ensure_rpath "$sidecar" "@executable_path/../../frameworks"
done

for lib in "$FRAMEWORKS"/*.dylib; do
  [ -e "$lib" ] || continue
  ensure_rpath "$lib" "@executable_path/../Frameworks"
  ensure_rpath "$lib" "@executable_path/../../frameworks"
done

codesign --force --sign - "${ENGINES[@]}"
for lib in "$FRAMEWORKS"/*.dylib; do
  [ -e "$lib" ] || continue
  codesign --force --sign - "$lib"
done

printf 'bundled: qpdf + gs sidecars self-contained\n'
