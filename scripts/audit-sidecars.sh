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
# any host. Unknown arguments fail rather than being ignored. An explicit
# --target whose gs sidecar is not staged fails: the clean-room smoke must not
# silently disappear while the audit still reports PASS.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="${ROOT:-$(cd "$SCRIPT_DIR/.." && pwd)}"
BIN_DIR="$ROOT/src-tauri/binaries"
FRAMEWORKS_DIR="$ROOT/src-tauri/frameworks"
GS_RESOURCES_DIR="$ROOT/src-tauri/gs-resources"
CONF="$ROOT/src-tauri/tauri.conf.json"
MANIFEST="$ROOT/scripts/binaries.manifest.json"
GS_ACCEPTANCE_SENTINEL="fso-sidecar-acceptance-sentinel.ps"
GS_SENTINEL_GLOB='fso-sidecar-acceptance-*'
GS_DIR_SENTINEL_PREFIX="fso-sidecar-acceptance-"

TARGET=""
TARGET_EXPLICIT=0
while [ $# -gt 0 ]; do
  case "$1" in
    --target)
      if [ $# -lt 2 ] || [ -z "$2" ] || [ "${2#--}" != "$2" ]; then
        printf "FAIL --target requires a value\n" >&2
        exit 1
      fi
      TARGET="$2"
      TARGET_EXPLICIT=1
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

gs_manifest_resource_dirs() {
  node -e '
    const fs = require("fs");
    const manifest = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    const entries = (manifest.targets ?? {})[process.argv[2]] ?? {};
    for (const entry of Object.values(entries)) {
      if (Array.isArray(entry.resources) && entry.resources.length > 0) {
        console.log(entry.resources.join(" "));
        process.exit(0);
      }
    }
    process.exit(3);
  ' "$MANIFEST" "$TARGET"
}

gs_smoke_required_dirs() {
  local search_dirs declared dir
  if ! search_dirs="$(gs_smoke_search_dirs)"; then
    return 1
  fi
  if ! declared="$(gs_manifest_resource_dirs)"; then
    return 1
  fi
  printf '%s\n' $search_dirs
  for dir in $declared; do
    if [ "$dir" = "iccprofiles" ]; then
      printf '%s\n' "$dir"
    fi
  done
  return 0
}

gs_smoke_search_dirs() {
  local declared dir
  local -a ordered=()
  if ! declared="$(gs_manifest_resource_dirs)"; then
    printf 'FAIL gs clean-room smoke: no manifest entry for %s declares a "resources" array\n' "$TARGET" >&2
    printf "  add the dirs gs needs (Resource, lib, iccprofiles, fonts) to the gs row in\n" >&2
    printf '  scripts/binaries.manifest.json; without them there is nothing to smoke.\n' >&2
    return 1
  fi
  for dir in $declared; do
    case "$dir" in
      Resource) ordered+=("Resource/Init" "Resource/Font") ;;
      iccprofiles) ;;
      *) ordered+=("$dir") ;;
    esac
  done
  if [ "${#ordered[@]}" -eq 0 ]; then
    printf 'FAIL gs clean-room smoke: the manifest resources for %s yield no gs search path\n' "$TARGET" >&2
    return 1
  fi
  printf '%s\n' "${ordered[@]}"
}

gs_smoke_sentinels() {
  local search_dirs dir
  if ! search_dirs="$(gs_smoke_search_dirs)"; then
    return 1
  fi
  for dir in $search_dirs; do
    case "$dir" in
      Resource/Init) printf '%s\n' "Resource/Init:$GS_ACCEPTANCE_SENTINEL" ;;
      *) printf '%s\n' "$dir:$GS_DIR_SENTINEL_PREFIX$(printf '%s' "$dir" | tr '/' '-' | tr 'A-Z' 'a-z')-sentinel.ps" ;;
    esac
  done
}

dir_has_file_recursive() {
  find "$1" -type f ! -name "$GS_SENTINEL_GLOB" -print -quit 2>/dev/null | grep -q .
}

assert_gs_sentinels() {
  local gs_resources="$1"
  local pair dir name
  while IFS= read -r pair; do
    [ -n "$pair" ] || continue
    dir="${pair%%:*}"
    name="${pair##*:}"
    if [ ! -f "$gs_resources/$dir/$name" ]; then
      printf 'FAIL gs clean-room smoke: staged acceptance sentinel missing: %s\n' "$gs_resources/$dir/$name" >&2
      printf "  this tree was staged before the sentinel existed, so the -I flags would\n" >&2
      printf "  load unproven resources (and a real missing sentinel would be misreported as\n" >&2
      printf "  a compiled-in Homebrew fallback). This is NOT a font/prefix problem:\n" >&2
      printf "  Run 'yarn binaries:prep' to restage gs-resources, then re-run the audit.\n" >&2
      return 1
    fi
  done <<EOF
$(gs_smoke_sentinels)
EOF
}

gs_clean_room_smoke() {
  local gs="$1"
  local gs_resources="$2"
  local work="$3"
  local dir
  local -a gs_includes=()
  local -a required_dirs=()
  local declared_list
  if ! declared_list="$(gs_smoke_required_dirs)"; then
    return 1
  fi
  while IFS= read -r dir; do
    [ -n "$dir" ] || continue
    required_dirs+=("$dir")
  done <<EOF
$declared_list
EOF
  local -a search_dirs=()
  local search_list
  if ! search_list="$(gs_smoke_search_dirs)"; then
    return 1
  fi
  while IFS= read -r dir; do
    [ -n "$dir" ] || continue
    search_dirs+=("$dir")
  done <<EOF
$search_list
EOF
  for dir in "${required_dirs[@]}"; do
    if [ ! -d "$gs_resources/$dir" ]; then
      printf 'FAIL gs clean-room smoke: required staged resource dir missing: %s\n' "$gs_resources/$dir" >&2
      printf "  every dir here is load-bearing: run 'yarn binaries:prep' to restage them\n" >&2
      return 1
    fi
  done
  for dir in "${required_dirs[@]}"; do
    if ! dir_has_file_recursive "$gs_resources/$dir"; then
      printf 'FAIL gs clean-room smoke: no files anywhere under %s\n' "$gs_resources/$dir" >&2
      printf "  an empty tree here means the app would fall back to whatever the host has.\n" >&2
      printf "  Run 'yarn binaries:prep' to restage the gs resources.\n" >&2
      return 1
    fi
  done
  if ! assert_gs_sentinels "$gs_resources"; then
    return 1
  fi
  for dir in "${search_dirs[@]}"; do
    gs_includes+=("-I$gs_resources/$dir")
  done
  if [ -d "$gs_resources/iccprofiles" ]; then
    gs_includes+=("-uICCProfilesDir=$gs_resources/iccprofiles")
  fi

  local fixture="$work/font-fixture.ps"
  local out="$work/font-fixture.pdf"
  {
    printf '%s\n' '%!PS'
    while IFS= read -r pair; do
      [ -n "$pair" ] || continue
      printf '(%s) runlibfile\n' "${pair##*:}"
    done < <(gs_smoke_sentinels)
    printf '%s\n' \
      '/Helvetica-Bold findfont 24 scalefont setfont' \
      '72 700 moveto (gs clean-room smoke) show' \
      '/Helvetica findfont 12 scalefont setfont' \
      '72 660 moveto (font resolution must come from the staged resources) show' \
      'showpage'
  } >"$fixture"

  local status=0
  env -i HOME=/nonexistent PATH=/usr/bin:/bin \
    DYLD_LIBRARY_PATH="$FRAMEWORKS_DIR" \
    "$gs" "${gs_includes[@]}" \
    -sDEVICE=pdfwrite -dNOPAUSE -dQUIET -dBATCH \
    -sOutputFile="$out" "$fixture" >"$work/gs.stderr" 2>&1 || status=$?
  if [ "$status" -ne 0 ]; then
    printf 'FAIL gs clean-room smoke: gs exited %s with only the staged resources\n' "$status" >&2
    printf "  the acceptance sentinels were present and resolved, so this is a real gs\n" >&2
    printf '  failure, not a compiled-in Homebrew fallback.\n' >&2
    sed -e 's/^/  gs stderr: /' "$work/gs.stderr" >&2
    return 1
  fi
  local size
  size="$(wc -c <"$out" | tr -d ' ')"
  if [ ! -s "$out" ] || [ "$size" -le 1024 ]; then
    printf 'FAIL gs clean-room smoke: rendered %s bytes, expected more than 1024 from a font-using fixture\n' "$size" >&2
    sed -e 's/^/  gs stderr: /' "$work/gs.stderr" >&2
    return 1
  fi
  if ! grep -q '%%EOF' "$out"; then
    printf 'FAIL gs clean-room smoke: output is not a complete PDF\n' >&2
    sed -e 's/^/  gs stderr: /' "$work/gs.stderr" >&2
    return 1
  fi
  printf 'gs clean-room smoke: PASS (%s bytes, %s staged resource flags, sentinel resolved)\n' "$size" "${#gs_includes[@]}"
}

gs_smoke_workdir=""
gs_smoke_required=0
if [ -n "$TARGET" ] && [ -f "$BIN_DIR/gs-$TARGET" ]; then
  gs_smoke_required=1
elif [ -n "$TARGET" ]; then
  if [ "$TARGET_EXPLICIT" -eq 1 ]; then
    printf 'FAIL gs clean-room smoke: gs sidecar not staged for the explicitly requested target: %s\n' "$BIN_DIR/gs-$TARGET" >&2
    printf "  an explicit --target asks for a real cross-target audit; a missing gs makes\n" >&2
    printf "  the smoke silently vanish while the audit still reports PASS.\n" >&2
    printf "  Run 'yarn binaries:all --target %s' to stage it, then re-run the audit.\n" "$TARGET" >&2
    failures+=("<gs-clean-room-smoke>")
  else
    printf 'note: gs clean-room smoke SKIPPED — %s not staged\n' "$BIN_DIR/gs-$TARGET"
  fi
fi
if [ "$gs_smoke_required" -eq 1 ]; then
  require_tool env
  if [ ! -d "$GS_RESOURCES_DIR" ]; then
    printf 'FAIL gs clean-room smoke: staged gs-resources tree missing: %s\n' "$GS_RESOURCES_DIR" >&2
    printf "  run 'yarn binaries:prep' to stage it — PDF compression cannot work without it\n" >&2
    failures+=("<gs-clean-room-smoke>")
  else
    gs_smoke_workdir="$(mktemp -d -t gs-clean-room)"
    if ! gs_clean_room_smoke "$BIN_DIR/gs-$TARGET" "$GS_RESOURCES_DIR" "$gs_smoke_workdir"; then
      failures+=("<gs-clean-room-smoke>")
    fi
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
