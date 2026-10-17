#!/usr/bin/env bash
# freeze.sh — package the staged sidecar engines into a release bundle (ADR
# 0001). macOS triple: binaries/<engine>-<triple> plus frameworks/ and
# gs-resources/. Windows triple: binaries/engines/<engine>/ payload dirs for
# the non-static manifest entries, the flat exes binaries/<dest>-<triple>.exe
# for every manifest entry (ffmpeg/ffprobe are the tauri externalBin pair,
# the vips/qpdf/gs flat copies exist so the verify.mjs content-arch and
# audit-sidecars gate holds after unfreeze; static:true entries ship as the
# flat exe only) — everything tauri.windows.conf.json consumes; windows gs
# runs on its compiled-in resources, so no gs-resources/ is bundled. Both
# shapes extract directly into src-tauri/. The bundle is built under a temp
# name and the pair is published with the .sha256 first, then the bundle, so a
# torn publish reads as a digest mismatch rather than a complete-looking stale
# pair; the final pair is re-verified before success. A failed freeze keeps
# the previous bundle and its digest intact, and the shared src-tauri/.freeze
# lock keeps freeze and unfreeze from mutating .freeze concurrently. Refuses
# triples without a frozen-bundle design and incomplete trees.
# Usage: bash scripts/ci/freeze.sh --triple <mac-or-windows-triple> [--root <repo-root>]
set -euo pipefail

fail() { echo "freeze: FAIL — $*" >&2; exit 1; }
info() { echo "freeze: $*"; }

case "$0" in
  */*) manifest_lists_sh="${0%/*}/windows-manifest-lists.sh" ;;
  *) manifest_lists_sh="windows-manifest-lists.sh" ;;
esac
if [ -f "$manifest_lists_sh" ]; then
  . "$manifest_lists_sh"
else
  fail "cannot load ./windows-manifest-lists.sh — it must sit beside freeze.sh"
fi

dll_scan() {
  local dir="$1" errors status listing
  errors="$(mktemp -t dll-scan-errors-XXXXXX)" || fail "cannot create a temp file for the DLL scan of $dir — check free disk space and permissions"
  status=0
  listing="$(find "$dir" -type f -name '*.dll' -print -quit 2>"$errors")" || status=$?
  if [ "$status" -ne 0 ]; then
    fail "could not read $dir to scan for DLLs: $(tr '\n' ' ' <"$errors") — a read error is not an empty tree, and restaging will not fix a permissions problem"
  fi
  rm -f "$errors" || echo "freeze: WARN — could not remove temp file $errors" >&2
  [ -n "$listing" ]
}

MAC_TRIPLES="aarch64-apple-darwin x86_64-apple-darwin"
WINDOWS_TRIPLES="x86_64-pc-windows-msvc aarch64-pc-windows-msvc"

TRIPLE=""
ROOT=""
while [ $# -gt 0 ]; do
  case "$1" in
    --triple)
      [ -n "${2:-}" ] || fail "--triple requires a value"
      TRIPLE="$2"
      shift 2
      ;;
    --root)
      [ -n "${2:-}" ] || fail "--root requires a value"
      ROOT="$2"
      shift 2
      ;;
    *)
      fail "unknown argument '$1' — supported: --triple <mac-or-windows-triple> [--root <repo-root>]"
      ;;
  esac
done
[ -n "$TRIPLE" ] || fail "--triple is required"

case " $MAC_TRIPLES " in
  *" $TRIPLE "*) MODE="mac" ;;
  *)
    case " $WINDOWS_TRIPLES " in
      *" $TRIPLE "*) MODE="windows" ;;
      *) fail "unsupported target triple '$TRIPLE' — freeze bundles macOS or Windows engines only (ADR 0001)" ;;
    esac
    ;;
esac

ROOT="${ROOT:-$(cd "$(dirname "$0")/../.." && pwd)}"
SRC="$ROOT/src-tauri"
[ -d "$SRC" ] || fail "repo root '$ROOT' has no src-tauri directory"

if [ "$MODE" = "mac" ]; then
  for engine in ffmpeg ffprobe qpdf vips gs; do
    [ -f "$SRC/binaries/${engine}-${TRIPLE}" ] || \
      fail "missing staged binary src-tauri/binaries/${engine}-${TRIPLE} — run 'yarn binaries:all --target $TRIPLE' first"
  done

  [ -d "$SRC/frameworks" ] || fail "missing src-tauri/frameworks — the staged tree has no dylib directory"
  [ -n "$(ls -A "$SRC/frameworks" 2>/dev/null)" ] || fail "src-tauri/frameworks is empty — the vips dylibs are not staged"

  [ -f "$SRC/gs-resources/Resource/Init/gs_init.ps" ] || \
    fail "missing src-tauri/gs-resources/Resource/Init/gs_init.ps — the ghostscript resources are not staged"
else
  derive_windows_lists "$ROOT" "$TRIPLE"
  for engine in $WINDOWS_ENGINE_LIST; do
    [ -d "$SRC/binaries/engines/$engine" ] || \
      fail "missing staged payload dir src-tauri/binaries/engines/$engine — run 'yarn binaries:all --target $TRIPLE' first"
    [ -f "$SRC/binaries/engines/$engine/$engine.exe" ] || \
      fail "missing staged engine binary src-tauri/binaries/engines/$engine/$engine.exe — run 'yarn binaries:all --target $TRIPLE' first"
    if ! dll_scan "$SRC/binaries/engines/$engine"; then
      fail "src-tauri/binaries/engines/$engine carries no DLL anywhere under it — run 'yarn binaries:all --target $TRIPLE' to restage the engine: a windows engine without its DLL siblings fails only at compression time"
    fi
  done
  for exe in $WINDOWS_ALL_LIST; do
    [ -f "$SRC/binaries/${exe}-${TRIPLE}.exe" ] || \
      fail "missing staged external binary src-tauri/binaries/${exe}-${TRIPLE}.exe — run 'yarn binaries:all --target $TRIPLE' first"
  done
fi

LOCK_DIR=""
OWN_LOCK=0

lock_age_seconds() {
  mtime=""
  if command -v stat >/dev/null 2>&1; then
    mtime="$(stat -f %m "$1" 2>/dev/null || stat -c %Y "$1" 2>/dev/null || true)"
  fi
  if [ -z "$mtime" ]; then
    mtime="$(python3 -c 'import os,sys;print(int(os.stat(sys.argv[1]).st_mtime))' "$1" 2>/dev/null || true)"
  fi
  [ -n "$mtime" ] || return 1
  echo $(( $(date +%s) - mtime ))
}

acquire_lock() {
  LOCK_DIR="$SRC/.freeze/freeze.lock"
  if mkdir "$LOCK_DIR" 2>/dev/null; then
    OWN_LOCK=1
    echo "$$" > "$LOCK_DIR/pid" || fail "cannot write the lock pid into $LOCK_DIR — remove $LOCK_DIR and retry"
    return 0
  fi
  lock_pid="$(cat "$LOCK_DIR/pid" 2>/dev/null || true)"
  lock_pid_alive=0
  case "$lock_pid" in
    ''|*[!0-9]*) ;;
    *) if kill -0 "$lock_pid" 2>/dev/null; then lock_pid_alive=1; fi ;;
  esac
  if [ "$lock_pid_alive" = 1 ]; then
    fail "another freeze or unfreeze (pid $lock_pid) holds the lock at $LOCK_DIR — rerun after it finishes; if none is running, remove $LOCK_DIR and retry"
  fi
  lock_age="$(lock_age_seconds "$LOCK_DIR" 2>/dev/null || true)"
  if [ -n "$lock_age" ] && [ "$lock_age" -ge 3600 ]; then
    rm -rf "$LOCK_DIR" 2>/dev/null || fail "the previous holder left a stale lock at $LOCK_DIR and it cannot be removed — remove $LOCK_DIR and retry"
    info "removed stale lock from dead pid ${lock_pid:-unknown}"
    if mkdir "$LOCK_DIR" 2>/dev/null; then
      OWN_LOCK=1
      echo "$$" > "$LOCK_DIR/pid" || fail "cannot write the lock pid into $LOCK_DIR — remove $LOCK_DIR and retry"
      return 0
    fi
  fi
  fail "another freeze or unfreeze holds the lock at $LOCK_DIR — rerun after it finishes; if none is running, remove $LOCK_DIR and retry"
}

FREEZE_DIR="$SRC/.freeze"
BUNDLE="$FREEZE_DIR/sidecar-bundle-${TRIPLE}.tar.gz"
TMP_NAME=".sidecar-bundle-${TRIPLE}.tmp$$"
TMP_BUNDLE="$FREEZE_DIR/$TMP_NAME"
TMP_SHA="${TMP_BUNDLE}.sha256"

cleanup() {
  status=$?
  if [ -e "$TMP_BUNDLE" ] || [ -e "$TMP_SHA" ]; then
    rm -f "$TMP_BUNDLE" "$TMP_SHA" || echo "freeze: WARN — could not remove temp artifacts $TMP_BUNDLE / $TMP_SHA" >&2
  fi
  if [ "$OWN_LOCK" = 1 ] && [ -d "$LOCK_DIR" ]; then
    rm -rf "$LOCK_DIR" || echo "freeze: WARN — could not remove lock dir $LOCK_DIR" >&2
  fi
  exit "$status"
}
trap cleanup EXIT
trap 'exit 143' HUP INT TERM

compute_sha() {
  if command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1"
  else
    sha256sum "$1"
  fi
}

mkdir -p "$FREEZE_DIR" || fail "cannot create $FREEZE_DIR — make src-tauri writable and check free disk space"
acquire_lock

if [ "$MODE" = "mac" ]; then
  tar_args=()
  for engine in ffmpeg ffprobe qpdf vips gs; do
    tar_args+=("binaries/${engine}-${TRIPLE}")
  done
  tar -czf "$TMP_BUNDLE" -C "$SRC" "${tar_args[@]}" frameworks gs-resources
else
  tar_args=()
  if [ -n "$WINDOWS_ENGINE_LIST" ]; then
    tar_args+=(binaries/engines)
  fi
  for exe in $WINDOWS_ALL_LIST; do
    tar_args+=("binaries/${exe}-${TRIPLE}.exe")
  done
  tar -czf "$TMP_BUNDLE" -C "$SRC" "${tar_args[@]}"
fi
(cd "$FREEZE_DIR" && compute_sha "$TMP_NAME" > "${TMP_NAME}.sha256")
mv -f "$TMP_SHA" "$BUNDLE.sha256"
mv -f "$TMP_BUNDLE" "$BUNDLE"

published_sha="$(compute_sha "$BUNDLE" | awk '{print $1}')" || \
  fail "cannot compute sha256 of the published bundle $BUNDLE"
printf '%s  %s\n' "$published_sha" "$(basename "$BUNDLE")" > "$BUNDLE.sha256" || \
  fail "cannot rewrite $BUNDLE.sha256 with the final bundle filename"
expected_sha="$(awk 'NR==1 {print tolower($1); exit}' "$BUNDLE.sha256")" || \
  fail "published .sha256 $BUNDLE.sha256 is unreadable"
[ "$published_sha" = "$expected_sha" ] || \
  fail "published bundle $BUNDLE does not match its .sha256 — remove both artifacts and re-run freeze"

info "$TRIPLE bundle → src-tauri/.freeze/sidecar-bundle-${TRIPLE}.tar.gz (+ .sha256)"
