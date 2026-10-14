#!/usr/bin/env bash
# freeze.sh — package the staged macOS sidecar engines into a release bundle
# (ADR 0001): binaries/, frameworks/, gs-resources/ are tarred with paths rooted
# for src-tauri/ into src-tauri/.freeze/sidecar-bundle-<triple>.tar.gz plus a
# sibling .sha256. The bundle is built under a temp name and published only
# after tar and shasum both succeed, so a failed freeze keeps the previous
# bundle and its digest intact. Refuses non-mac triples and incomplete trees.
# Usage: bash scripts/ci/freeze.sh --triple <mac-triple> [--root <repo-root>]
set -euo pipefail

fail() { echo "freeze: FAIL — $*" >&2; exit 1; }
info() { echo "freeze: $*"; }

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
      fail "unknown argument '$1' — supported: --triple <mac-triple> [--root <repo-root>]"
      ;;
  esac
done
[ -n "$TRIPLE" ] || fail "--triple is required"

case "$TRIPLE" in
  aarch64-apple-darwin|x86_64-apple-darwin) ;;
  *) fail "unsupported target triple '$TRIPLE' — freeze bundles macOS engines only (ADR 0001)" ;;
esac

ROOT="${ROOT:-$(cd "$(dirname "$0")/../.." && pwd)}"
SRC="$ROOT/src-tauri"
[ -d "$SRC" ] || fail "repo root '$ROOT' has no src-tauri directory"

ENGINES="ffmpeg ffprobe qpdf vips gs"
for engine in $ENGINES; do
  [ -f "$SRC/binaries/${engine}-${TRIPLE}" ] || \
    fail "missing staged binary src-tauri/binaries/${engine}-${TRIPLE} — run 'yarn binaries:all --target $TRIPLE' first"
done

[ -d "$SRC/frameworks" ] || fail "missing src-tauri/frameworks — the staged tree has no dylib directory"
[ -n "$(ls -A "$SRC/frameworks" 2>/dev/null)" ] || fail "src-tauri/frameworks is empty — the vips dylibs are not staged"

[ -f "$SRC/gs-resources/Resource/Init/gs_init.ps" ] || \
  fail "missing src-tauri/gs-resources/Resource/Init/gs_init.ps — the ghostscript resources are not staged"

FREEZE_DIR="$SRC/.freeze"
mkdir -p "$FREEZE_DIR"
BUNDLE="$FREEZE_DIR/sidecar-bundle-${TRIPLE}.tar.gz"
TMP_NAME=".sidecar-bundle-${TRIPLE}.tmp$$"
TMP_BUNDLE="$FREEZE_DIR/$TMP_NAME"
TMP_SHA="${TMP_BUNDLE}.sha256"

cleanup() {
  if [ -e "$TMP_BUNDLE" ] || [ -e "$TMP_SHA" ]; then
    rm -f "$TMP_BUNDLE" "$TMP_SHA" || echo "freeze: WARN — could not remove temp artifacts $TMP_BUNDLE" >&2
  fi
}
trap cleanup EXIT
trap 'exit 143' HUP INT TERM

tar_args=()
for engine in $ENGINES; do
  tar_args+=("binaries/${engine}-${TRIPLE}")
done

tar -czf "$TMP_BUNDLE" -C "$SRC" "${tar_args[@]}" frameworks gs-resources
(cd "$FREEZE_DIR" && shasum -a 256 "$TMP_NAME" > "${TMP_NAME}.sha256")
mv -f "$TMP_BUNDLE" "$BUNDLE"
mv -f "$TMP_SHA" "$BUNDLE.sha256"

info "$TRIPLE bundle → src-tauri/.freeze/sidecar-bundle-${TRIPLE}.tar.gz (+ .sha256)"
