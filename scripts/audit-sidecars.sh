#!/usr/bin/env bash
# Audits every sidecar binary in src-tauri/binaries/ and every collected dylib
# in src-tauri/frameworks/: absolute non-system dylib paths are a release bug
# (dev-only paths like /opt/homebrew abort on end-user machines).
# Exit 0 = self-contained. Exit 1 = findings printed.
set -u

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BIN_DIR="$ROOT/src-tauri/binaries"
FRAMEWORKS_DIR="$ROOT/src-tauri/frameworks"

failures=()

audit_macho() {
  local file="$1"
  local depbase
  while IFS= read -r path; do
    [ -z "$path" ] && continue
    case "$path" in
      @rpath/*)
        depbase="${path#@rpath/}"
        if [ ! -e "$FRAMEWORKS_DIR/$depbase" ]; then
          printf 'FAIL %s: @rpath dependency not bundled: %s\n' "$file" "$path"
          failures+=("$file")
        fi
        ;;
      /usr/lib/system/*|/System/Library/*|/usr/lib/*) ;;
      /*)
        printf 'FAIL %s: absolute non-system dylib path: %s\n' "$file" "$path"
        failures+=("$file")
        ;;
      *)
        printf 'FAIL %s: relative dylib path: %s\n' "$file" "$path"
        failures+=("$file")
        ;;
    esac
  done < <(otool -L "$file" | tail -n +2 | awk '{print $1}' | sort -u)
}

audit_elf() {
  local file="$1"
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
    *) printf 'FAIL unknown binary type: %s (%s)\n' "$f" "$kind"; failures+=("$f") ;;
  esac
done

if [ -d "$FRAMEWORKS_DIR" ]; then
  for lib in "$FRAMEWORKS_DIR"/*.dylib; do
    [ -e "$lib" ] || continue
    audit_macho "$lib"
  done
fi

CONF="$ROOT/src-tauri/tauri.conf.json"
if command -v python3 >/dev/null 2>&1 && [ -f "$CONF" ]; then
  while IFS= read -r mismatch; do
    [ -z "$mismatch" ] && continue
    printf 'FAIL %s\n' "$mismatch"
    failures+=("$CONF")
  done < <(python3 - "$CONF" "$FRAMEWORKS_DIR" <<'PYEOF'
import json, os, sys
conf, fw = sys.argv[1], sys.argv[2]
with open(conf) as f:
    cfg = json.load(f)
listed = cfg.get("bundle", {}).get("macOS", {}).get("frameworks") or []
present = sorted(os.path.basename(p) for p in os.listdir(fw) if p.endswith(".dylib")) if os.path.isdir(fw) else []
names = sorted(os.path.basename(p) for p in listed)
for n in sorted(set(names) - set(present)):
    print(f"tauri.conf.json lists missing dylib: {n}")
for n in sorted(set(present) - set(names)):
    print(f"tauri.conf.json missing bundled dylib: {n}")
PYEOF
)
fi

if [ ${#failures[@]} -gt 0 ]; then
  printf 'sidecar audit: %d file(s) not self-contained\n' "${#failures[@]}"
  exit 1
fi

printf 'sidecar audit: PASS (%d binaries, %d framework dylibs)\n' \
  "$(find "$BIN_DIR" -type f | wc -l)" \
  "$( [ -d "$FRAMEWORKS_DIR" ] && find "$FRAMEWORKS_DIR" -name '*.dylib' | wc -l || echo 0 )"
