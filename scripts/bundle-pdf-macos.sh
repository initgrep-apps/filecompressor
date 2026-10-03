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
# qpdf comes from the official vendor archive, whose lib/ dir fetch staged into
# src-tauri/.staging/qpdf-<triple>/lib; that lib wins over a brew-era
# frameworks/libqpdf.* copy and is resolved before any brew fallback. Ghostscript
# comes from brew, and its Resource/lib/iccprofiles/fonts tree is staged into
# src-tauri/gs-resources/ so the sidecar never needs a Homebrew prefix at runtime.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=sidecar-bundle.common.sh
source "$SCRIPT_DIR/sidecar-bundle.common.sh"

ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
FRAMEWORKS="$ROOT/src-tauri/frameworks"
TRIPLE="$(rustc -Vv | grep '^host:' | sed 's/host: //')"
STAGING_QPDF_LIB="$ROOT/src-tauri/.staging/qpdf-$TRIPLE/lib"
GS_RESOURCES="$ROOT/src-tauri/gs-resources"
GS_RESOURCE_DIRS=(Resource lib iccprofiles fonts)
GS_ACCEPTANCE_SENTINEL="fso-sidecar-acceptance-sentinel.ps"
ENGINES=("$ROOT/src-tauri/binaries/qpdf-$TRIPLE" "$ROOT/src-tauri/binaries/gs-$TRIPLE")

for sidecar in "${ENGINES[@]}"; do
  [ -f "$sidecar" ] || { printf 'FAIL sidecar missing: %s\n' "$sidecar"; exit 1; }
done
[ "$(uname)" = "Darwin" ] || { printf 'FAIL macOS only\n'; exit 1; }

staged_qpdf_libs() {
  local staged
  for staged in "$STAGING_QPDF_LIB"/libqpdf*.dylib; do
    [ -f "$staged" ] || continue
    printf '%s\n' "$staged"
  done
}

require_staged_qpdf_lib() {
  if [ ! -d "$STAGING_QPDF_LIB" ]; then
    printf 'FAIL qpdf lib staging dir missing: %s\n' "$STAGING_QPDF_LIB" >&2
    printf "  fetch must stage the official qpdf lib before prep bundles it; without it the\n" >&2
    printf "  collect_deps_of fallback would silently pull brew's libqpdf under the same\n" >&2
    printf '  basename and rpath. Run: yarn binaries:fetch --target %s\n' "$TRIPLE" >&2
    exit 1
  fi
  if [ -z "$(staged_qpdf_libs)" ]; then
    printf 'FAIL no libqpdf*.dylib in %s\n' "$STAGING_QPDF_LIB" >&2
    printf "  same silent-substitution hazard as a missing staging dir: brew's libqpdf would\n" >&2
    printf "  be staged under the official name. Check the qpdf manifest row has a \"lib\" key.\n" >&2
    printf '  Run: yarn binaries:fetch --target %s\n' "$TRIPLE" >&2
    exit 1
  fi
}

assert_frameworks_qpdf_matches_staged() {
  local qpdf_bin="$ROOT/src-tauri/binaries/qpdf-$TRIPLE"
  local depbase staged existing
  [ -f "$qpdf_bin" ] || return 0
  while IFS= read -r depbase; do
    [ -n "$depbase" ] || continue
    staged=""
    local candidate
    for candidate in "$STAGING_QPDF_LIB"/"$depbase"; do
      if [ -e "$candidate" ]; then
        staged="$candidate"
        break
      fi
    done
    if [ -z "$staged" ]; then
      printf 'FAIL qpdf links @rpath/%s but the staged official lib dir has no such file\n' "$depbase" >&2
      printf '  staged dir: %s\n' "$STAGING_QPDF_LIB" >&2
      printf '  Run: yarn binaries:fetch --target %s\n' "$TRIPLE" >&2
      exit 1
    fi
    existing="$FRAMEWORKS/$depbase"
    if [ ! -f "$existing" ]; then
      printf 'FAIL frameworks/%s is linked by qpdf but was not collected\n' "$depbase" >&2
      exit 1
    fi
    if [ "$(fingerprint "$staged")" != "$(fingerprint "$existing")" ]; then
      printf 'FAIL frameworks/%s does not match the staged official qpdf lib — a Homebrew or stale copy won the collection\n' "$depbase" >&2
      printf '  staged:    %s\n' "$staged" >&2
      printf '  collected: %s\n' "$existing" >&2
      printf '  Remove src-tauri/frameworks and re-run, or fix the qpdf manifest row.\n' >&2
      exit 1
    fi
  done < <(otool -L "$qpdf_bin" | tail -n +2 | awk '{print $1}' | sed -n 's|^@rpath/||p')
}

replace_frameworks_with_staged_qpdf_lib() {
  local existing
  for existing in "$FRAMEWORKS"/libqpdf*.dylib; do
    [ -e "$existing" ] || continue
    printf 'note: replacing frameworks/%s with official qpdf lib\n' "$(basename "$existing")" >&2
    rm -f "$existing"
  done
}

copy_tree_sorted() {
  local src="$1"
  local dst="$2"
  command -v cpio >/dev/null 2>&1 || {
    printf 'FAIL required tool missing: cpio (used for the deterministic gs-resource copy)\n' >&2
    exit 1
  }
  mkdir -p "$dst"
  local src_physical dst_physical
  src_physical="$(cd "$src" && pwd -P)"
  dst_physical="$(cd "$dst" && pwd -P)"
  (cd "$src_physical" && find . -print | LC_ALL=C sort | cpio -pdm --quiet "$dst_physical")
}

stage_gs_acceptance_sentinel() {
  local sentinel_dir="$GS_RESOURCES/Resource/Init"
  mkdir -p "$sentinel_dir"
  printf '%%!\n%% Staged-only sentinel: gs resolves it through the -I search paths, so the\n%% audit clean-room smoke fails if gs falls back to its compiled-in Homebrew prefix.\n' \
    >"$sentinel_dir/$GS_ACCEPTANCE_SENTINEL"
  if [ ! -f "$sentinel_dir/$GS_ACCEPTANCE_SENTINEL" ]; then
    printf 'FAIL could not stage the gs acceptance sentinel at %s\n' "$sentinel_dir/$GS_ACCEPTANCE_SENTINEL" >&2
    exit 1
  fi
  printf 'staged: gs acceptance sentinel -> %s/%s\n' "$sentinel_dir" "$GS_ACCEPTANCE_SENTINEL"
}

stage_gs_resources() {
  command -v brew >/dev/null 2>&1 || {
    printf 'FAIL brew not found — the gs sidecar resources come from the build host: run "brew install ghostscript", then re-run "yarn binaries:prep"\n' >&2
    exit 1
  }
  local prefix source_dir
  prefix="$(brew --prefix ghostscript)" || {
    printf 'FAIL brew --prefix ghostscript failed — run "brew install ghostscript", then re-run "yarn binaries:prep"\n' >&2
    exit 1
  }
  source_dir=""
  for candidate in "$prefix"/share/ghostscript/ "$prefix"/share/ghostscript/*/; do
    [ -d "$candidate/Resource" ] || continue
    if [ -n "$source_dir" ]; then
      printf 'FAIL ambiguous ghostscript resource trees under %s/share/ghostscript — reinstall with "brew reinstall ghostscript"\n' "$prefix" >&2
      exit 1
    fi
    source_dir="${candidate%/}"
  done
  if [ -z "$source_dir" ]; then
    printf 'FAIL no ghostscript resource tree (Resource/, lib/, iccprofiles/, fonts/) under %s/share/ghostscript — run "brew reinstall ghostscript", then re-run "yarn binaries:prep"\n' "$prefix" >&2
    exit 1
  fi
  rm -rf "$GS_RESOURCES"
  local name
  for name in "${GS_RESOURCE_DIRS[@]}"; do
    if [ ! -d "$source_dir/$name" ]; then
      printf 'FAIL ghostscript resource dir %s missing at %s — run "brew reinstall ghostscript", then re-run "yarn binaries:prep"\n' "$name" "$source_dir" >&2
      exit 1
    fi
    copy_tree_sorted "$source_dir/$name" "$GS_RESOURCES/$name"
  done
  if [ ! -f "$GS_RESOURCES/Resource/Init/gs_init.ps" ]; then
    printf 'FAIL staged gs-resources lacks Resource/Init/gs_init.ps (source %s) — the gs sidecar cannot start without it\n' "$source_dir" >&2
    exit 1
  fi
  stage_gs_acceptance_sentinel
  printf 'staged: gs resources -> %s (from %s)\n' "$GS_RESOURCES" "$source_dir"
}

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

assert_not_brew_substitute() {
  local src="$1"
  local dest="$2"
  local base="$(basename "$src")"
  local brew_lib
  for brew_lib in /opt/homebrew/opt/qpdf/lib/libqpdf*.dylib /usr/local/opt/qpdf/lib/libqpdf*.dylib; do
    [ -f "$brew_lib" ] || continue
    local src_physical brew_physical
  src_physical="$(cd "$(dirname "$src")" && pwd -P)/$(basename "$src")"
  brew_physical="$(cd "$(dirname "$brew_lib")" && pwd -P)/$(basename "$brew_lib")"
  if [ "$src_physical" = "$brew_physical" ]; then
      printf 'FAIL %s was collected from the Homebrew qpdf build (%s) instead of the staged official archive lib\n' "$dest" "$src" >&2
      printf "  a brew lib under the official basename/soname would pass the version and rpath\n" >&2
      printf "  gates while shipping different code. Fix the qpdf manifest row's \"lib\" key, then:\n" >&2
      printf '  rm -rf src-tauri/frameworks && yarn binaries:fetch --target %s && yarn binaries:prep\n' "$TRIPLE" >&2
      exit 1
    fi
  done
  if [ "${base#libqpdf}" = "$base" ]; then
    return 0
  fi
  local staging_physical src_physical
  staging_physical="$(cd "$STAGING_QPDF_LIB" && pwd -P)"
  src_physical="$(cd "$(dirname "$src")" && pwd -P)/$(basename "$src")"
  case "$src_physical" in
    "$staging_physical"/*) ;;
    *)
      printf 'FAIL %s was collected from %s, outside the staged official lib dir %s\n' "$dest" "$src_physical" "$staging_physical" >&2
      printf "  only the official archive's lib may land in frameworks/ under a libqpdf name\n" >&2
      printf '  Run: yarn binaries:fetch --target %s\n' "$TRIPLE" >&2
      exit 1
      ;;
  esac
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
    assert_not_brew_substitute "$src" "$dest"
    return 0
  fi
  mkdir -p "$FRAMEWORKS"
  cp "$src" "$dest"
  chmod u+w "$dest"
  if [ "$(shasum -a 256 "$src" | awk '{print $1}')" != "$(shasum -a 256 "$dest" | awk '{print $1}')" ]; then
    printf 'FAIL copied dylib %s does not match its source %s byte for byte\n' "$dest" "$src"
    exit 1
  fi
  assert_not_brew_substitute "$src" "$dest"
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
        if [ -f "$STAGING_QPDF_LIB/$depbase" ]; then
          found="$STAGING_QPDF_LIB/$depbase"
        else
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
        fi
        if [ -z "$found" ]; then
          found="$(find_in_brew "$depbase")" || {
            if [ -f "$FRAMEWORKS/$depbase" ]; then
              printf 'FAIL %s is in frameworks but cannot be re-resolved to fingerprint from %s — re-run fetch to restage the official archive, then re-run prep\n' "$dep" "$src"
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

require_staged_qpdf_lib
replace_frameworks_with_staged_qpdf_lib

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
  ensure_rpath "$sidecar" "@executable_path/../frameworks"
  ensure_rpath "$sidecar" "@executable_path/../../frameworks"
done

for lib in "$FRAMEWORKS"/*.dylib; do
  [ -e "$lib" ] || continue
  ensure_rpath "$lib" "@executable_path/../Frameworks"
  ensure_rpath "$lib" "@executable_path/../frameworks"
  ensure_rpath "$lib" "@executable_path/../../frameworks"
done

codesign --force --sign - "${ENGINES[@]}"
for lib in "$FRAMEWORKS"/*.dylib; do
  [ -e "$lib" ] || continue
  codesign --force --sign - "$lib"
done

assert_frameworks_qpdf_matches_staged

stage_gs_resources

printf 'bundled: qpdf + gs sidecars self-contained\n'
