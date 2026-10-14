#!/usr/bin/env bash
# unfreeze.sh — restore a frozen macOS sidecar bundle (ADR 0001) into src-tauri/.
# With --archive <tarball>: verify the sibling .sha256, then extract. Without it:
# select and download the newest sidecars-* release bundle for the triple via gh
# (requires GH_TOKEN). The bundle verifies and validates in a temp dir while the
# current tree is backed up next to it; only a fully validated payload is
# swapped in, and any failed install rolls src-tauri back — a failed unfreeze
# never leaves a half-restored tree or temp litter.
# Usage: bash scripts/ci/unfreeze.sh --triple <triple> [--archive <tarball>] [--root <repo-root>]
set -euo pipefail

fail() { echo "unfreeze: FAIL — $*" >&2; exit 1; }
info() { echo "unfreeze: $*"; }

ENGINES="ffmpeg ffprobe qpdf vips gs"
DIR_NAMES="binaries frameworks gs-resources"

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
[ -d "$SRC" ] || fail "repo root '$ROOT' has no src-tauri directory"

WORK=""
LOCK_DIR=""
OWN_LOCK=""
cleanup() {
  if [ -n "$WORK" ]; then
    rm -rf "$WORK" || echo "unfreeze: WARN — could not remove temp dir $WORK" >&2
  fi
  if [ -n "$OWN_LOCK" ] && [ -d "$LOCK_DIR" ]; then
    rmdir "$LOCK_DIR" 2>/dev/null || echo "unfreeze: WARN — could not remove lock dir $LOCK_DIR" >&2
  fi
}
trap cleanup EXIT
trap 'exit 143' HUP INT TERM

sha256_of() {
  shasum -a 256 "$1" | awk '{print $1}'
}

verify_sha() {
  archive="$1"
  sha_file="${archive}.sha256"
  [ -f "$sha_file" ] || fail "missing .sha256 sibling for '$archive' — cannot verify the bundle, refusing to extract"
  expected="$(awk 'NR==1 {print tolower($1); exit}' "$sha_file")" || \
    fail "could not read the expected digest from '$sha_file'"
  printf '%s' "$expected" | grep -Eq '^[0-9a-f]{64}$' || \
    fail "unreadable sha256 list '$sha_file' — expected a line of the form '<digest>  <filename>'"
  actual="$(sha256_of "$archive")" || fail "could not compute sha256 of '$archive'"
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
  [ -d "$extracted/frameworks" ] || \
    fail "bundle has an empty or missing frameworks/ after extraction — refusing to swap in a partial bundle"
  [ -n "$(ls -A "$extracted/frameworks" 2>/dev/null)" ] || \
    fail "bundle has an empty or missing frameworks/ after extraction — refusing to swap in a partial bundle"
}

rollback_tree() {
  installed="$1"
  for name in $DIR_NAMES; do
    [ "$installed" -gt 0 ] || break
    rm -rf "$SRC/$name" || true
    installed=$((installed - 1))
  done
  for name in $DIR_NAMES; do
    if [ -e "$WORK/backup/$name" ]; then
      mv "$WORK/backup/$name" "$SRC/$name" || \
        echo "unfreeze: WARN — could not roll back src-tauri/$name from the pre-swap backup" >&2
    fi
  done
  fail "failed to install the new sidecar tree — src-tauri was rolled back to its pre-swap state"
}

install_tree() {
  mkdir -p "$WORK/backup"
  kept=0
  for name in $DIR_NAMES; do
    if [ -e "$SRC/$name" ] || [ -L "$SRC/$name" ]; then
      mv "$SRC/$name" "$WORK/backup/$name" || \
        fail "could not set aside the existing src-tauri/$name — destination not writable, the tree is untouched"
      kept=$((kept + 1))
    fi
  done
  installed=0
  for name in $DIR_NAMES; do
    if ! mv "$WORK/root/$name" "$SRC/$name"; then
      rollback_tree "$installed"
    fi
    installed=$((installed + 1))
  done
}

extract_and_restore() {
  archive="$1"
  mkdir -p "$WORK/root"
  tar -xzf "$archive" -C "$WORK/root" || fail "tar extraction failed for '$archive' — the bundle may be corrupt"
  validate_payload "$WORK/root"
  install_tree
}

gh_args=()
if [ -n "${GITHUB_REPOSITORY:-}" ]; then
  gh_args+=(--repo "$GITHUB_REPOSITORY")
fi

newest=""

if [ -n "$ARCHIVE" ]; then
  [ -f "$ARCHIVE" ] || fail "archive not found: '$ARCHIVE'"
else
  command -v gh >/dev/null 2>&1 || fail "gh CLI is not on PATH — it is needed to fetch the sidecars-* release"
  [ -n "${GH_TOKEN:-}" ] || fail "GH_TOKEN is not set — unfreeze downloads from the sidecars-* release (ADR 0001)"

  raw_tags="$(gh release list "${gh_args[@]+"${gh_args[@]}"}" --limit 200 --json tagName)" || \
    fail "gh release list failed — cannot look up the sidecars-* release"
  tags="$(printf '%s\n' "$raw_tags" | grep -Eo '"tagName":"[^"]+"' | sed -e 's/^"tagName":"//' -e 's/"$//')" || true
  for candidate in $tags; do
    case "$candidate" in
      sidecars-*)
        if [ -z "$newest" ] || [ "$candidate" \> "$newest" ]; then
          newest="$candidate"
        fi
        ;;
    esac
  done
  [ -n "$newest" ] || fail "no sidecars-* release found — run freeze.yml before the release build (ADR 0001)"
fi

mkdir -p "$SRC/.freeze"
LOCK_DIR="$SRC/.freeze/unfreeze.lock"
if mkdir "$LOCK_DIR" 2>/dev/null; then
  OWN_LOCK=1
else
  fail "another unfreeze holds the lock at $LOCK_DIR — a concurrent restore would interleave swaps, rerun after it finishes"
fi
WORK="$(mktemp -d "$SRC/.freeze/unfreeze.XXXXXX")"

if [ -n "$ARCHIVE" ]; then
  source_archive="$ARCHIVE"
else
  mkdir -p "$WORK/dl"
  gh release download "${gh_args[@]+"${gh_args[@]}"}" "$newest" \
    --pattern "sidecar-bundle-${TRIPLE}.tar.gz" \
    --pattern "sidecar-bundle-${TRIPLE}.tar.gz.sha256" \
    --dir "$WORK/dl" --clobber || fail "gh release download failed for '$newest'"
  source_archive="$WORK/dl/sidecar-bundle-${TRIPLE}.tar.gz"
  [ -f "$source_archive" ] || fail "release '$newest' publishes no sidecar-bundle-${TRIPLE}.tar.gz asset — freeze '$TRIPLE' first"
fi

verify_sha "$source_archive"
extract_and_restore "$source_archive"

info "restored $TRIPLE sidecars into src-tauri/"
