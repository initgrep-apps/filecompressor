#!/usr/bin/env bash
# unfreeze.sh — restore a frozen macOS sidecar bundle (ADR 0001) into src-tauri/.
# With --archive <tarball>: verify the sibling .sha256, then extract. Without it:
# download the newest sidecars-* release bundle for the triple via gh
# (requires GH_TOKEN). Extraction goes to a temp dir, must validate, and only
# then swaps into place — a failed unfreeze never leaves a half-restored tree.
# Usage: bash scripts/ci/unfreeze.sh --triple <triple> [--archive <tarball>] [--root <repo-root>]
set -euo pipefail

fail() { echo "unfreeze: FAIL — $*" >&2; exit 1; }
info() { echo "unfreeze: $*"; }

ENGINES="ffmpeg ffprobe qpdf vips gs"

TRIPLE=""
ROOT=""
ARCHIVE=""
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
    --archive)
      [ -n "${2:-}" ] || fail "--archive requires a value"
      ARCHIVE="$2"
      shift 2
      ;;
    *)
      fail "unknown argument '$1' — supported: --triple <triple> [--archive <tarball>] [--root <repo-root>]"
      ;;
  esac
done
[ -n "$TRIPLE" ] || fail "--triple is required"

case "$TRIPLE" in
  aarch64-apple-darwin|x86_64-apple-darwin) ;;
  *) fail "unsupported target triple '$TRIPLE' — unfreeze restores macOS freeze bundles only (ADR 0001); windows engines stage from the manifest" ;;
esac

ROOT="${ROOT:-$(cd "$(dirname "$0")/../.." && pwd)}"
SRC="$ROOT/src-tauri"

WORK=""

cleanup() {
  if [ -n "$WORK" ]; then
    rm -rf "$WORK" || true
  fi
}
trap cleanup EXIT

sha256_of() {
  (cd "$(dirname "$1")" && shasum -a 256 "$(basename "$1")" | awk '{print $1}')
}

verify_sha() {
  archive="$1"
  sha_file="${archive}.sha256"
  [ -f "$sha_file" ] || fail "missing .sha256 sibling for '$archive' — cannot verify the bundle, refusing to extract"
  expected="$(awk 'NR==1 {print tolower($1); exit}' "$sha_file")"
  printf '%s' "$expected" | grep -Eq '^[0-9a-f]{64}$' || \
    fail "unreadable sha256 list '$sha_file' — expected a line of the form '<digest>  <filename>'"
  actual="$(sha256_of "$archive")"
  if [ -z "$actual" ]; then
    fail "could not compute sha256 of '$archive'"
  fi
  [ "$actual" = "$expected" ] || \
    fail "sha256 mismatch for '$archive' (expected $expected, got $actual) — refusing to extract a tampered or stale bundle"
}

validate_payload() {
  extracted="$1"
  [ -f "$extracted/gs-resources/Resource/Init/gs_init.ps" ] || \
    fail "bundle is missing gs-resources/Resource/Init/gs_init.ps after extraction — refusing to swap in a partial bundle"
  for engine in $ENGINES; do
    [ -f "$extracted/binaries/${engine}-${TRIPLE}" ] || \
      fail "bundle is missing binaries/${engine}-${TRIPLE} after extraction — refusing to swap in a partial bundle"
  done
  [ -n "$(ls -A "$extracted/frameworks" 2>/dev/null)" ] || \
    fail "bundle has an empty frameworks/ after extraction — refusing to swap in a partial bundle"
}

restore_into() {
  mkdir -p "$SRC"
  for name in binaries frameworks gs-resources; do
    rm -rf "${SRC:?unfreeze destination is unset}/$name"
    mv "$WORK/root/$name" "$SRC/$name"
  done
}

extract_and_restore() {
  archive="$1"
  mkdir -p "$SRC/.freeze"
  WORK="$(mktemp -d "$SRC/.freeze/unfreeze.XXXXXX")"
  mkdir -p "$WORK/root/binaries"
  tar -xzf "$archive" -C "$WORK/root" || fail "tar extraction failed for '$archive' — the bundle may be corrupt"
  validate_payload "$WORK/root"
  restore_into
}

gh_release_list() {
  if [ -n "${GITHUB_REPOSITORY:-}" ]; then
    gh release list --repo "$GITHUB_REPOSITORY" "$@"
  else
    gh release list "$@"
  fi
}

gh_release_download() {
  if [ -n "${GITHUB_REPOSITORY:-}" ]; then
    gh release download --repo "$GITHUB_REPOSITORY" "$@"
  else
    gh release download "$@"
  fi
}

if [ -n "$ARCHIVE" ]; then
  [ -f "$ARCHIVE" ] || fail "archive not found: '$ARCHIVE'"
  verify_sha "$ARCHIVE"
  extract_and_restore "$ARCHIVE"
else
  command -v gh >/dev/null 2>&1 || fail "gh CLI is not on PATH — it is needed to fetch the sidecars-* release"
  [ -n "${GH_TOKEN:-}" ] || fail "GH_TOKEN is not set — unfreeze downloads from the sidecars-* release (ADR 0001)"

  mkdir -p "$SRC/.freeze"
  WORK="$(mktemp -d "$SRC/.freeze/unfreeze.XXXXXX")"
  mkdir -p "$WORK/dl"

  tag="$(gh_release_list --limit 100 --json tagName --jq 'map(select(.tagName | startswith("sidecars-"))) | if length == 0 then "" else .[0].tagName end')" || \
    fail "gh release list failed — cannot look up the sidecars-* release"
  [ -n "$tag" ] || fail "no sidecars-* release found — run freeze.yml before the release build (ADR 0001)"

  gh_release_download "$tag" \
    --pattern "sidecar-bundle-${TRIPLE}.tar.gz" \
    --pattern "sidecar-bundle-${TRIPLE}.tar.gz.sha256" \
    --dir "$WORK/dl" --clobber || fail "gh release download failed for '$tag'"
  ARCHIVE="$WORK/dl/sidecar-bundle-${TRIPLE}.tar.gz"
  [ -f "$ARCHIVE" ] || fail "release '$tag' publishes no sidecar-bundle-${TRIPLE}.tar.gz asset — freeze '$TRIPLE' first"

  verify_sha "$ARCHIVE"
  extract_and_restore "$ARCHIVE"
fi

info "restored $TRIPLE sidecars into src-tauri/"
