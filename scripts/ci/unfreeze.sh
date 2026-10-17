#!/usr/bin/env bash
# Verification (ADR 0001) — restore a frozen sidecar bundle into src-tauri/.
# With --archive <tarball>: verify the sibling .sha256, then extract. Without
# it: select and download the newest sidecars-* release bundle for the triple
# via gh (requires GH_TOKEN). macOS bundles restore binaries/, frameworks/,
# gs-resources/; windows bundles restore binaries/ only: binaries/engines/ for
# the non-static manifest entries and the flat exes binaries/<dest>-<triple>.exe
# for every manifest entry (ffmpeg/ffprobe are the tauri externalBin pair, the
# vips/qpdf/gs flat copies exist so the verify.mjs content-arch and
# audit-sidecars gate holds after unfreeze). The bundle
# verifies and validates in a
# temp workspace while the current tree is backed up OUTSIDE that workspace,
# so workspace cleanup can never destroy the only copy; every interrupted or
# failed install restores the pre-swap tree, and signals mid-swap always leave
# the original tree bytes recoverable at a named backup path. Only a fully
# validated payload is swapped in.
# Usage: bash scripts/ci/unfreeze.sh --triple <triple> [--archive <tarball>] [--root <repo-root>]
set -euo pipefail

fail() { echo "unfreeze: FAIL — $*" >&2; exit 1; }
info() { echo "unfreeze: $*"; }

case "$0" in
  */*) manifest_lists_sh="${0%/*}/windows-manifest-lists.sh" ;;
  *) manifest_lists_sh="windows-manifest-lists.sh" ;;
esac
if [ -f "$manifest_lists_sh" ]; then
  . "$manifest_lists_sh"
else
  fail "cannot load ./windows-manifest-lists.sh — it must sit beside unfreeze.sh"
fi

dll_scan() {
  local dir="$1" errors status listing
  errors="$(mktemp -t dll-scan-errors-XXXXXX)" || fail "cannot create a temp file for the DLL scan of $dir — check free disk space and permissions"
  status=0
  listing="$(find "$dir" -type f -name '*.dll' -print -quit 2>"$errors")" || status=$?
  if [ "$status" -ne 0 ]; then
    fail "could not read $dir to scan for DLLs: $(tr '\n' ' ' <"$errors") — a read error is not an empty tree, and restaging will not fix a permissions problem"
  fi
  rm -f "$errors" || echo "unfreeze: WARN — could not remove temp file $errors" >&2
  [ -n "$listing" ]
}

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

case " aarch64-apple-darwin x86_64-apple-darwin " in
  *" $TRIPLE "*) MODE="mac" ;;
  *)
    case " x86_64-pc-windows-msvc aarch64-pc-windows-msvc " in
      *" $TRIPLE "*) MODE="windows" ;;
      *) fail "unsupported target triple '$TRIPLE' — unfreeze restores macOS or Windows freeze bundles only (ADR 0001)" ;;
    esac
    ;;
esac

ROOT="${ROOT:-$(cd "$(dirname "$0")/../.." && pwd)}"
SRC="$ROOT/src-tauri"
[ -d "$SRC" ] || fail "repo root '$ROOT' has no src-tauri directory"

command -v tar >/dev/null 2>&1 || \
  fail "tar is not on PATH — unfreeze extracts the bundle with tar; make sure the GNU/bsdtar binary is installed and reachable (macOS: 'xcode-select --install'; git-bash: run inside the bundled shell tools), then re-run"

if [ "$MODE" = "mac" ]; then
  DIR_NAMES="binaries frameworks gs-resources"
else
  DIR_NAMES="binaries"
fi

WORK=""
LOCK_DIR=""
OWN_LOCK=0
BACKUP_DIR=""
MID_SWAP=0
INSTALL_OK=0
ROLLBACK_DONE=0

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

cleanup() {
  status=$?
  trap '' HUP INT TERM
  if [ "$MID_SWAP" = 1 ] && [ "$INSTALL_OK" = 0 ] && [ "$ROLLBACK_DONE" = 0 ] && [ -n "$BACKUP_DIR" ]; then
    echo "unfreeze: FAIL — interrupted mid-swap; the pre-swap tree copy is preserved at $BACKUP_DIR" >&2
    broken="$(restore_from_backup)"
    if [ -z "$broken" ]; then
      echo "unfreeze: FAIL — interrupted after src-tauri was restored byte-for-byte to its pre-swap state; the safety copy remains at $BACKUP_DIR — verify the tree, then remove that directory" >&2
    else
      echo "unfreeze: FAIL — interrupted mid-swap; the rollback could not complete for:$broken — the original tree is preserved at $BACKUP_DIR; restore it with 'mv $BACKUP_DIR/<name> src-tauri/<name>' for each name listed" >&2
    fi
  fi
  if [ -n "$WORK" ]; then
    rm -rf "$WORK" || echo "unfreeze: WARN — could not remove temp dir $WORK" >&2
  fi
  if [ "$OWN_LOCK" = 1 ] && [ -d "$LOCK_DIR" ]; then
    rm -rf "$LOCK_DIR" || echo "unfreeze: WARN — could not remove lock dir $LOCK_DIR" >&2
  fi
  exit "$status"
}
trap cleanup EXIT
trap 'exit 143' HUP INT TERM

sha256_of() {
  if command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | awk '{print $1}'
  else
    sha256sum "$1" | awk '{print $1}'
  fi
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
  if [ "$MODE" = "mac" ]; then
    [ -f "$extracted/gs-resources/Resource/Init/gs_init.ps" ] || \
      fail "bundle is missing gs-resources/Resource/Init/gs_init.ps after extraction — refusing to swap in a partial bundle"
    for engine in ffmpeg ffprobe qpdf vips gs; do
      [ -f "$extracted/binaries/${engine}-${TRIPLE}" ] || \
        fail "bundle is missing binaries/${engine}-${TRIPLE} after extraction — refusing to swap in a partial bundle"
    done
    [ -d "$extracted/frameworks" ] || \
      fail "bundle has an empty or missing frameworks/ after extraction — refusing to swap in a partial bundle"
    [ -n "$(ls -A "$extracted/frameworks" 2>/dev/null)" ] || \
      fail "bundle has an empty or missing frameworks/ after extraction — refusing to swap in a partial bundle"
  else
    derive_windows_lists "$ROOT" "$TRIPLE"
    for engine in $WINDOWS_ENGINE_LIST; do
      [ -d "$extracted/binaries/engines/$engine" ] || \
        fail "bundle is missing binaries/engines/$engine after extraction — refusing to swap in a partial bundle"
      [ -f "$extracted/binaries/engines/$engine/$engine.exe" ] || \
        fail "bundle is missing binaries/engines/$engine/$engine.exe after extraction — refusing to swap in a partial bundle"
      if ! dll_scan "$extracted/binaries/engines/$engine"; then
        fail "bundle carries no DLL anywhere under binaries/engines/$engine after extraction — refusing to swap in a partial bundle; re-freeze from a freshly staged tree ('yarn binaries:all --target $TRIPLE', then bash scripts/ci/freeze.sh)"
      fi
    done
    for exe in $WINDOWS_ALL_LIST; do
      [ -f "$extracted/binaries/${exe}-${TRIPLE}.exe" ] || \
        fail "bundle is missing binaries/${exe}-${TRIPLE}.exe after extraction — refusing to swap in a partial bundle"
    done
  fi
}

restore_from_backup() {
  broken=""
  for name in $DIR_NAMES; do
    backup_item="$BACKUP_DIR/$name"
    [ -e "$backup_item" ] || [ -L "$backup_item" ] || continue
    if [ -e "$SRC/$name" ] || [ -L "$SRC/$name" ]; then
      if ! rm -rf "$SRC/$name"; then
        echo "unfreeze: could not remove the leftover src-tauri/$name before restoring its backup copy" >&2
        broken="$broken $name"
        continue
      fi
    fi
    if ! mv "$backup_item" "$SRC/$name"; then
      echo "unfreeze: could not restore src-tauri/$name from the backup copy" >&2
      broken="$broken $name"
    fi
  done
  printf '%s' "${broken# }"
}

restore_and_report() {
  broken="$(restore_from_backup)"
  ROLLBACK_DONE=1
  if [ -z "$broken" ]; then
    rm -rf "$BACKUP_DIR" || echo "unfreeze: WARN — could not remove the backup dir $BACKUP_DIR after the restore" >&2
    fail "failed to $1 the new sidecar tree${2:-} — src-tauri was restored byte-for-byte to its pre-swap state"
  fi
  fail "failed to $1 the new sidecar tree${2:-} — rollback incomplete for:$broken — the original tree is preserved at $BACKUP_DIR; restore it with 'mv $BACKUP_DIR/<name> src-tauri/<name>' for each name listed"
}

set_aside_existing() {
  BACKUP_DIR="$SRC/.freeze/unfreeze-backup.$$"
  mkdir -p "$BACKUP_DIR" || fail "cannot create the pre-swap backup dir $BACKUP_DIR — make src-tauri/.freeze writable; the tree is untouched"
  MID_SWAP=1
  for name in $DIR_NAMES; do
    if [ -e "$SRC/$name" ] || [ -L "$SRC/$name" ]; then
      if ! mv "$SRC/$name" "$BACKUP_DIR/$name"; then
        restore_and_report "swap in" "while setting aside src-tauri/$name — the destination is not writable"
      fi
    fi
  done
}

install_payload() {
  for name in $DIR_NAMES; do
    if ! mv "$WORK/root/$name" "$SRC/$name"; then
      restore_and_report "install"
    fi
  done
}

extract_and_restore() {
  archive="$1"
  mkdir -p "$WORK/root" || fail "cannot create the extraction dir $WORK/root — check free disk space"
  tar -xzf "$archive" -C "$WORK/root" || fail "tar extraction failed for '$archive' — the raw tar error is printed above; it may be a truncated, corrupt or tampered bundle (integrity), a volume out of free disk space under '$WORK', or the destination not being writable (permissions); rule those out or re-download the bundle, then re-run — a real integrity break should already have failed the .sha256 check above"
  validate_payload "$WORK/root"
  set_aside_existing
  install_payload
  INSTALL_OK=1
  rm -rf "$BACKUP_DIR" || echo "unfreeze: WARN — could not remove the backup dir $BACKUP_DIR after the successful install" >&2
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
  compact="$(printf '%s' "$raw_tags" | tr -d '[:space:]')"
  tags=""
  if [ -n "$compact" ] && [ "$compact" != "[]" ]; then
    tags="$(printf '%s\n' "$raw_tags" | grep -Eo '"tagName":"[^"]+"' | sed -e 's/^"tagName":"//' -e 's/"$//' || true)"
  fi
  for candidate in $tags; do
    case "$candidate" in
      sidecars-*)
        if [ -z "$newest" ] || [ "$candidate" \> "$newest" ]; then
          newest="$candidate"
        fi
        ;;
    esac
  done
  if [ -z "$newest" ]; then
    if [ -n "$tags" ] || [ -z "$compact" ] || [ "$compact" = "[]" ]; then
      fail "no sidecars-* release found — run freeze.yml before the release build (ADR 0001)"
    fi
    preview="$(printf '%s' "$raw_tags" | tr '\n' ' ' | head -c 120)"
    fail "gh release list returned unparseable output — starting with: $preview — check gh auth/quota/network"
  fi
fi

mkdir -p "$SRC/.freeze" || fail "cannot create $SRC/.freeze — make src-tauri writable and check free disk space"
acquire_lock
WORK="$(mktemp -d "$SRC/.freeze/unfreeze.XXXXXX")" || fail "cannot create the temp workspace under $SRC/.freeze — check free disk space and permissions"

if [ -n "$ARCHIVE" ]; then
  source_archive="$ARCHIVE"
else
  mkdir -p "$WORK/dl" || fail "cannot create the download dir $WORK/dl — check free disk space"
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
