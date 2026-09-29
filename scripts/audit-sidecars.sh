#!/usr/bin/env bash
# Audits every sidecar binary in src-tauri/binaries/ and every collected dylib
# in src-tauri/frameworks/: absolute non-system dylib paths are a release bug
# (dev-only paths like /opt/homebrew abort on end-user machines).
# A Mach-O image fails the audit when it: is not parseable by otool, carries
# no dylib load commands, loads an absolute non-system or relative path, loads
# @rpath/<name> without <name> present in frameworks/, has @rpath loads but
# no LC_RPATH of its own, or has an invalid/missing code signature.
# @loader_path/* and @executable_path/* load commands pass: they resolve
# relative to the loading image itself, so they are self-contained by
# construction.
# Tool absence is fail-closed: otool/codesign are required whenever a Mach-O
# is audited, ldd whenever an ELF is audited.
# Exit 0 = self-contained. Exit 1 = findings printed.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BIN_DIR="$ROOT/src-tauri/binaries"
FRAMEWORKS_DIR="$ROOT/src-tauri/frameworks"
CONF="$ROOT/src-tauri/tauri.conf.json"

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
  if [ "$has_rpath_loads" -eq 1 ] && ! otool -l "$file" | grep -q "LC_RPATH"; then
    printf 'FAIL %s: @rpath loads but no LC_RPATH entry\n' "$file"
    failures+=("$file")
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
  printf 'FAIL binaries dir missing: %s\n' "$BIN_DIR"
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
  present="$(cd "$ROOT/src-tauri" && find frameworks -maxdepth 1 -name '*.dylib' | sort)" || present=""
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

if [ ${#failures[@]} -gt 0 ]; then
  printf 'sidecar audit: %d file(s) not self-contained\n' "${#failures[@]}"
  exit 1
fi

printf 'sidecar audit: PASS (%d binaries, %d framework dylibs)\n' \
  "$(find "$BIN_DIR" -type f | wc -l)" \
  "$( [ -d "$FRAMEWORKS_DIR" ] && find "$FRAMEWORKS_DIR" -name '*.dylib' | wc -l || echo 0 )"
