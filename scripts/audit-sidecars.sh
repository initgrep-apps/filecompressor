#!/usr/bin/env bash
# Audits every Mach-O sidecar binary in src-tauri/binaries/ (PE32/Windows
# binaries skipped — the audit covers macOS and Linux ELF targets) and every
# collected dylib in src-tauri/frameworks/: absolute non-system dylib paths
# are a release bug (dev-only paths like /opt/homebrew abort on end-user
# machines).
# A Mach-O image fails the audit when it: is not parseable by otool, carries
# no dylib load commands, loads an absolute non-system or relative path, loads
# @rpath/<name> without <name> present in frameworks/, has @rpath loads but
# no LC_RPATH of its own, or has an invalid/missing code signature.
# Architecture and version gates are delegated to scripts/binaries/verify.mjs
# (manifest presence, arch content vs filename triple, version vs manifest);
# any verify failure fails the whole audit.
# @loader_path/* and @executable_path/* load commands pass: @loader_path
# resolves relative to the loading image itself, while @executable_path
# resolves relative to the process's main executable (NOT each loading
# image) — both land inside the app bundle our sidecars ship in, so they are
# self-contained by construction.
# Tool absence is fail-closed: otool/codesign are required whenever a Mach-O
# is audited, ldd whenever an ELF is audited.
# Exit 0 = self-contained. Exit 1 = findings printed.
# Env overrides (for tests): ROOT=<repo root>, AUDIT_TARGET=<triple>.
# Usage: audit-sidecars.sh [--target <triple>] — an explicit --target wins over
# AUDIT_TARGET and over host detection, so cross-target audits are possible from
# any host. Unknown arguments fail rather than being ignored.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="${ROOT:-$(cd "$SCRIPT_DIR/.." && pwd)}"
BIN_DIR="$ROOT/src-tauri/binaries"
FRAMEWORKS_DIR="$ROOT/src-tauri/frameworks"
CONF="$ROOT/src-tauri/tauri.conf.json"

TARGET=""
while [ $# -gt 0 ]; do
  case "$1" in
    --target)
      if [ $# -lt 2 ] || [ -z "$2" ] || [ "${2#--}" != "$2" ]; then
        printf "FAIL --target requires a value\n" >&2
        exit 1
      fi
      TARGET="$2"
      shift 2
      ;;
    --help|-h)
      printf 'usage: %s [--target <triple>]\n' "$0"
      exit 0
      ;;
    *)
      printf "FAIL unknown argument: %s (supported: --target <triple>)\n" "$1" >&2
      exit 1
      ;;
  esac
done
if [ -z "$TARGET" ]; then
  TARGET="${AUDIT_TARGET:-}"
fi

failures=()

require_tool() {
  command -v "$1" >/dev/null 2>&1 || {
    printf 'FAIL required tool missing: %s\n' "$1"
    exit 1
  }
}

audit_macho() {
  local file="$1"
  local deps dep has_rpath_loads
  require_tool otool
  if ! otool -L "$file" >/dev/null 2>&1; then
    printf 'FAIL %s: invalid Mach-O (otool -L failed)\n' "$file"
    failures+=("$file")
    return
  fi
  deps="$(otool -L "$file" | tail -n +2 | awk '{print $1}' | sort -u)"
  if [ -z "$deps" ]; then
    printf 'FAIL %s: no dylib load commands found\n' "$file"
    failures+=("$file")
    return
  fi
  has_rpath_loads=0
  while IFS= read -r dep; do
    [ -z "$dep" ] && continue
    case "$dep" in
      @rpath/*)
        has_rpath_loads=1
        if [ ! -e "$FRAMEWORKS_DIR/${dep#@rpath/}" ]; then
          printf 'FAIL %s: @rpath dependency not bundled: %s\n' "$file" "$dep"
          failures+=("$file")
        fi
        ;;
      @loader_path/*|@executable_path/*) ;;
      /usr/lib/system/*|/System/Library/*|/usr/lib/*) ;;
      /*)
        printf 'FAIL %s: absolute non-system dylib path: %s\n' "$file" "$dep"
        failures+=("$file")
        ;;
      *)
        printf 'FAIL %s: relative dylib path: %s\n' "$file" "$dep"
        failures+=("$file")
        ;;
    esac
  done <<< "$deps"
  if [ "$has_rpath_loads" -eq 1 ]; then
    # grep -A3 mirrors bundle-pdf's LC_RPATH section extraction; a plain
    # `otool -l | grep -q` is a SIGPIPE false-FAIL risk under pipefail when
    # grep exits before otool finishes writing a long load listing.
    if ! otool -l "$file" | grep -A3 "LC_RPATH" >/dev/null; then
      printf 'FAIL %s: @rpath loads but no LC_RPATH entry\n' "$file"
      failures+=("$file")
    fi
  fi
  require_tool codesign
  if ! codesign --verify "$file" >/dev/null 2>&1; then
    printf 'FAIL %s: code signature invalid or missing\n' "$file"
    failures+=("$file")
  fi
}

audit_elf() {
  local file="$1"
  require_tool ldd
  if ldd "$file" >/dev/null 2>&1; then
    printf 'FAIL %s: dynamically linked — ELF engines must be musl-static\n' "$file"
    failures+=("$file")
  fi
}

if [ ! -d "$BIN_DIR" ]; then
  printf "FAIL binaries dir missing: %s — run 'yarn binaries:all' first\n" "$BIN_DIR"
  exit 1
fi

require_tool file

if command -v node >/dev/null 2>&1; then
  if [ -z "$TARGET" ]; then
    require_tool rustc
    TARGET="$(rustc -Vv | sed -n 's/^host: //p')"
    if [ -z "$TARGET" ]; then
      printf "FAIL could not parse host triple from \`rustc -Vv\` — pass --target <triple>\n" >&2
      exit 1
    fi
  fi
  if ! node "$SCRIPT_DIR/binaries/verify.mjs" --target "$TARGET" --root "$ROOT"; then
    failures+=("<verify>")
  fi
else
  printf 'FAIL required tool missing: node (verify delegate unavailable)\n'
  exit 1
fi

for f in "$BIN_DIR"/*; do
  [ -f "$f" ] || continue
  kind=$(file -b "$f")
  case "$kind" in
    *"Mach-O"*) audit_macho "$f" ;;
    *"ELF"*) audit_elf "$f" ;;
    *"PE32"*) : ;;
    *)
      printf 'FAIL unknown binary type: %s (%s)\n' "$f" "$kind"
      failures+=("$f")
      ;;
  esac
done

if [ -d "$FRAMEWORKS_DIR" ]; then
  for lib in "$FRAMEWORKS_DIR"/*.dylib; do
    [ -e "$lib" ] || continue
    audit_macho "$lib"
  done
fi

if [ -f "$CONF" ]; then
  listed="$(grep -o '"frameworks/[^"]*\.dylib"' "$CONF" | tr -d '"' | sort -u)" || listed=""
  if [ -d "$FRAMEWORKS_DIR" ]; then
    present="$(cd "$ROOT/src-tauri" && find frameworks -maxdepth 1 -name '*.dylib' | sort)" || present=""
  else
    present=""
    if [ -n "$listed" ]; then
      printf "FAIL %s references src-tauri/frameworks/ but that directory is absent — it is gitignored and generated by the macOS bundle scripts: run 'bash scripts/bundle-vips-macos.sh && bash scripts/bundle-pdf-macos.sh' (or 'yarn binaries:prep'), then re-run the audit\n" "$CONF"
      failures+=("$FRAMEWORKS_DIR")
      exit 1
    fi
  fi
  for entry in $listed; do
    if ! printf '%s\n' "$present" | grep -Fxq "$entry"; then
      printf 'FAIL tauri.conf.json lists missing dylib: %s\n' "$entry"
      failures+=("$CONF")
    fi
  done
  for entry in $present; do
    if ! printf '%s\n' "$listed" | grep -Fxq "$entry"; then
      printf 'FAIL tauri.conf.json missing bundled dylib: %s\n' "$entry"
      failures+=("$CONF")
    fi
  done
fi

gs_clean_room_smoke() {
  local gs="$1"
  local gs_resources="$2"
  local work="$3"
  local -a gs_includes=()
  local dir
  for dir in Resource/Init lib Resource/Font fonts; do
    [ -d "$gs_resources/$dir" ] || continue
    gs_includes+=("-I$gs_resources/$dir")
  done
  if [ -d "$gs_resources/iccprofiles" ]; then
    gs_includes+=("-uICCProfilesDir=$gs_resources/iccprofiles")
  fi
  if [ "${#gs_includes[@]}" -eq 0 ]; then
    printf 'FAIL gs clean-room smoke: no staged resource dirs under %s\n' "$gs_resources"
    return 1
  fi
  local fixture="$work/font-fixture.ps"
  local out="$work/font-fixture.pdf"
  printf '%s\n' \
    '%!PS' \
    '/Helvetica-Bold findfont 24 scalefont setfont' \
    '72 700 moveto (gs clean-room smoke) show' \
    '/Helvetica findfont 12 scalefont setfont' \
    '72 660 moveto (font resolution must come from the staged resources) show' \
    'showpage' >"$fixture"
  if ! env -i HOME=/nonexistent PATH=/usr/bin:/bin \
    DYLD_LIBRARY_PATH="$FRAMEWORKS_DIR" \
    "$gs" "${gs_includes[@]}" \
    -sDEVICE=pdfwrite -dNOPAUSE -dQUIET -dBATCH \
    -sOutputFile="$out" "$fixture" 2>"$work/gs.stderr"; then
    printf 'FAIL gs clean-room smoke: gs exited non-zero with only the staged resources\n'
    sed -e 's/^/  gs stderr: /' "$work/gs.stderr" >&2 || true
    return 1
  fi
  local size
  size="$(wc -c <"$out" | tr -d ' ')"
  if [ ! -s "$out" ] || [ "$size" -le 1024 ]; then
    printf 'FAIL gs clean-room smoke: rendered %s bytes, expected more than 1024 from a font-using fixture\n' "$size"
    return 1
  fi
  if ! grep -q '%%EOF' "$out"; then
    printf 'FAIL gs clean-room smoke: output is not a complete PDF\n'
    return 1
  fi
  printf 'gs clean-room smoke: PASS (%s bytes, %s staged resource flags)\n' "$size" "${#gs_includes[@]}"
}

gs_smoke_workdir=""
if [ -n "$TARGET" ] && [ -f "$BIN_DIR/gs-$TARGET" ] && [ -d "$ROOT/src-tauri/gs-resources" ]; then
  require_tool env
  gs_smoke_workdir="$(mktemp -d -t gs-clean-room)"
  if ! gs_clean_room_smoke "$BIN_DIR/gs-$TARGET" "$ROOT/src-tauri/gs-resources" "$gs_smoke_workdir"; then
    failures+=("<gs-clean-room-smoke>")
  fi
fi
if [ -n "$gs_smoke_workdir" ]; then
  rm -rf "$gs_smoke_workdir"
fi

if [ ${#failures[@]} -gt 0 ]; then
  printf 'sidecar audit: %d file(s) not self-contained\n' "${#failures[@]}"
  exit 1
fi

printf 'sidecar audit: PASS (%d binaries, %d framework dylibs)\n' \
  "$(find "$BIN_DIR" -type f | wc -l)" \
  "$( [ -d "$FRAMEWORKS_DIR" ] && find "$FRAMEWORKS_DIR" -name '*.dylib' | wc -l || echo 0 )"
