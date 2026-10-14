#!/usr/bin/env bash
# freeze.sh — package the staged macOS sidecar engines into a release bundle
# (ADR 0001): binaries/, frameworks/, gs-resources/ are tarred with paths rooted
# for src-tauri/ into src-tauri/.freeze/sidecar-bundle-<triple>.tar.gz plus a
# sibling .sha256. Refuses non-mac triples and incomplete staged trees.
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

tar_args=()
for engine in $ENGINES; do
  tar_args+=("binaries/${engine}-${TRIPLE}")
done
tar -czf "$BUNDLE" -C "$SRC" "${tar_args[@]}" frameworks gs-resources

(cd "$FREEZE_DIR" && shasum -a 256 "sidecar-bundle-${TRIPLE}.tar.gz" > "sidecar-bundle-${TRIPLE}.tar.gz.sha256")

info "$TRIPLE bundle → src-tauri/.freeze/sidecar-bundle-${TRIPLE}.tar.gz (+ .sha256)"
