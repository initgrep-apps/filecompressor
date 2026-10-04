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
set -eEuo pipefail

failures=()
audit_finished=0
gs_smoke_workdir=""

smoke_mode=0

audit_body_aborted() {
  local status="$1"
  local line="$2"
  local command="$3"
  printf 'FAIL sidecar audit: aborted at line %s (exit %s): %s\n' "$line" "$status" "$command" >&2
  printf "  an unguarded command in the audit body failed, so the checks it feeds are\n" >&2
  printf "  unproven. Fix the reported command, then re-run the audit.\n" >&2
  failures+=("<audit-body>")
  return 1
}

gs_smoke_aborted() {
  local status="$1"
  local line="$2"
  local command="$3"
  printf 'FAIL gs clean-room smoke: aborted at line %s (exit %s): %s\n' "$line" "$status" "$command" >&2
  printf "  an unguarded command inside the smoke failed, so the staged gs resources were\n" >&2
  printf "  left unproven. Fix the reported command, then run 'yarn binaries:prep' and\n" >&2
  printf '  re-run the audit.\n' >&2
  failures+=("<gs-clean-room-smoke>")
  return 1
}

err_trap_active=0

audit_err_trap() {
  local status="$1"
  local line="$2"
  local command="$3"
  if [ "$err_trap_active" -eq 1 ]; then
    return 1
  fi
  err_trap_active=1
  if [ "$smoke_mode" -eq 1 ]; then
    gs_smoke_aborted "$status" "$line" "$command"
  else
    audit_body_aborted "$status" "$line" "$command"
  fi
}

enumerate_count() {
  local dir="$1"
  shift
  local listing
  if ! listing="$(find "$dir" "$@")"; then
    printf 'FAIL could not enumerate %s — the PASS count would be wrong; check the directory exists and is readable\n' "$dir" >&2
    return 1
  fi
  if [ -z "$listing" ]; then
    printf '0'
    return 0
  fi
  printf '%s\n' "$listing" | wc -l | tr -d ' '
  return 0
}

audit_exit_trap() {
  if [ -n "$gs_smoke_workdir" ] && [ -d "$gs_smoke_workdir" ]; then
    if ! rm -rf "$gs_smoke_workdir"; then
      printf 'WARN sidecar audit: could not remove the smoke workdir %s — remove it by hand; the audit result above still stands\n' "$gs_smoke_workdir" >&2
    fi
  fi
  if [ "$audit_finished" -eq 0 ] && [ "${#failures[@]}" -gt 0 ]; then
    printf 'sidecar audit: %d file(s) not self-contained\n' "${#failures[@]}"
  fi
}
trap audit_exit_trap EXIT
trap 'audit_err_trap "$?" "$LINENO" "$BASH_COMMAND"' ERR

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
  deps=""
  if ! deps="$(otool -L "$file" | tail -n +2 | awk '{print $1}' | sort -u)"; then
    printf 'FAIL %s: could not read the dylib load commands (the otool -L pipeline failed)\n' "$file" >&2
    printf '  without the dependency list the @rpath and absolute-path checks below are unproven.\n' >&2
    printf '  Free some disk — find and sort both need temp space — then re-run the audit.\n' >&2
    failures+=("$file")
    return
  fi
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
  kind=""
  if ! kind="$(file -b "$f")"; then
    printf 'FAIL %s: could not determine the file type (file -b failed)\n' "$f" >&2
    printf "  the Mach-O/ELF/PE32 dispatch below is unproven without it. Check that file\n" >&2
    printf '  works on this path, then re-run the audit.\n' >&2
    failures+=("$f")
    continue
  fi
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
  listed=""
  if ! listed="$(grep -o '"frameworks/[^"]*\.dylib"' "$CONF" | tr -d '"' | sort -u)"; then
    printf 'FAIL could not read %s — the dylib cross-check would be wrong; fix the read error, then re-run the audit\n' "$CONF" >&2
    printf "  an unreadable config looks like every bundled dylib being unlisted, which would send\n" >&2
    printf "  you to edit tauri.conf.json instead of fixing the permissions.\n" >&2
    failures+=("$CONF")
    exit 1
  fi
  if [ -d "$FRAMEWORKS_DIR" ]; then
    fw_listing=""
    if ! fw_listing="$(cd "$ROOT/src-tauri" && find frameworks -maxdepth 1 -name '*.dylib' | sort)"; then
      printf 'FAIL could not enumerate %s — the dylib cross-check would be wrong; fix the read error, then re-run the audit\n' "$FRAMEWORKS_DIR" >&2
      printf "  a permission problem here looks like every bundled dylib going missing, which\n" >&2
      printf "  would send you to edit tauri.conf.json instead of fixing the directory.\n" >&2
      failures+=("$FRAMEWORKS_DIR")
      exit 1
    fi
    present="$fw_listing"
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
  local search_dirs declared
  if ! search_dirs="$(gs_smoke_search_dirs)"; then
    return 1
  fi
  if ! declared="$(gs_manifest_resource_dirs)"; then
    printf 'FAIL gs clean-room smoke: no manifest entry for %s declares a "resources" array\n' "$TARGET" >&2
    printf '  add the dirs gs needs (Resource, lib, iccprofiles, fonts) to the gs row in\n' >&2
    printf '  scripts/binaries.manifest.json; without them there is nothing to smoke.\n' >&2
    return 1
  fi
  printf '%s\n' $search_dirs
  for dir in $declared; do
    printf '%s\n' "$dir"
  done
  printf '%s\n' Resource
  return 0
}

gs_smoke_resource_subdirs() {
  local base="$1"
  local entry
  [ -d "$base/Resource" ] || return 0
  for entry in "$base"/Resource/*/; do
    [ -d "$entry" ] || continue
    printf '%s\n' "${entry%/}"
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
  printf '%s\n' "${ordered[@]}"
  return 0
}

gs_sentinel_name=""

gs_sentinel_name_for_dir() {
  case "$1" in
    Resource/Init)
      gs_sentinel_name="$GS_ACCEPTANCE_SENTINEL"
      return 0
      ;;
  esac
  local slug
  if ! slug="$(printf '%s' "$1" | tr '/' '-' | tr 'A-Z' 'a-z')"; then
    return 1
  fi
  gs_sentinel_name="$GS_DIR_SENTINEL_PREFIX$slug-sentinel.ps"
  return 0
}

dir_has_file_recursive() {
  local listing errors status
  errors="$(mktemp -t gs-dir-read-error)"
  listing="$(find "$1" -type f ! -name "$GS_SENTINEL_GLOB" -print -quit 2>"$errors")"
  status=$?
  if [ "$status" -ne 0 ]; then
    printf 'FAIL gs clean-room smoke: could not read %s: %s\n' "$1" "$(tr '\n' ' ' <"$errors")" >&2
    printf "  this is a read error, not an empty tree — 'yarn binaries:prep' will not fix a\n" >&2
    printf "  permissions problem. Fix the reported error, then re-run the audit.\n" >&2
    rm -f "$errors"
    return 2
  fi
  rm -f "$errors"
  [ -n "$listing" ]
}

assert_gs_sentinels() {
  local gs_resources="$1"
  shift
  local pair dir name
  for pair in "$@"; do
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
  done
  return 0
}

gs_smoke_failed() {
  failures+=("<gs-clean-room-smoke>")
  smoke_mode=0
  return 0
}


gs_clean_room_smoke() {
  smoke_mode=1
  set -e
  local gs="$1"
  local gs_resources="$2"
  local work="$3"
  local dir
  local subdir
  local -a gs_includes=()
  local -a required_dirs=()
  local declared_list
  if ! declared_list="$(gs_smoke_required_dirs)"; then
    gs_smoke_failed
    return 0
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
    gs_smoke_failed
    return 0
  fi
  while IFS= read -r dir; do
    [ -n "$dir" ] || continue
    search_dirs+=("$dir")
  done <<EOF
$search_list
EOF
  local -a sentinel_pairs=()
  for dir in "${search_dirs[@]}"; do
    gs_sentinel_name=""
    if ! gs_sentinel_name_for_dir "$dir"; then
      printf 'FAIL gs clean-room smoke: could not derive the sentinel name for %s\n' "$dir" >&2
      printf "  these names are what the -I proof below checks for; an empty or wrong one would\n" >&2
      printf "  let the smoke pass without proving the staged tree. Check that tr works\n" >&2
      printf '  (it is used to build the name), then re-run the audit.\n' >&2
      gs_smoke_failed
      return 0
    fi
    sentinel_pairs+=("$dir:$gs_sentinel_name")
  done
  if [ "${#sentinel_pairs[@]}" -eq 0 ]; then
    printf 'FAIL gs clean-room smoke: the acceptance-sentinel list resolved to zero entries\n' >&2
    printf "  with no sentinel to require and no -I path to pass, this gate would pass\n" >&2
    printf "  vacuously: the smoke would report 'sentinel resolved' while resolving nothing\n" >&2
    printf "  and the staged resources would stay unproven. The list is derived from the\n" >&2
    printf "  manifest gs row, so run 'yarn binaries:prep' to restage, and check that\n" >&2
    printf '  scripts/binaries.manifest.json still declares resources for %s.\n' "$TARGET" >&2
    gs_smoke_failed
    return 0
  fi
  for dir in "${required_dirs[@]}"; do
    if [ ! -d "$gs_resources/$dir" ]; then
      printf 'FAIL gs clean-room smoke: required staged resource dir missing: %s\n' "$gs_resources/$dir" >&2
      printf "  every dir here is load-bearing: run 'yarn binaries:prep' to restage them\n" >&2
      gs_smoke_failed
      return 0
    fi
  done
  for dir in "${required_dirs[@]}"; do
    local dir_has_files=0
    dir_has_file_recursive "$gs_resources/$dir" || dir_has_files=$?
    if [ "$dir_has_files" -eq 2 ]; then
      gs_smoke_failed
      return 0
    fi
    if [ "$dir_has_files" -ne 0 ]; then
      printf 'FAIL gs clean-room smoke: no files anywhere under %s\n' "$gs_resources/$dir" >&2
      printf "  an empty tree here means the app would fall back to whatever the host has.\n" >&2
      printf "  Run 'yarn binaries:prep' to restage the gs resources.\n" >&2
      gs_smoke_failed
      return 0
    fi
  done
  local subdir_list=""
  subdir_list="$(gs_smoke_resource_subdirs "$gs_resources")" || subdir_list=""
  local -a subdirs=()
  while IFS= read -r subdir; do
    [ -n "$subdir" ] || continue
    subdirs+=("$subdir")
  done <<EOF
$subdir_list
EOF
  if [ "${#subdirs[@]}" -eq 0 ]; then
    printf 'FAIL gs clean-room smoke: no Resource subdirs were enumerated under %s\n' "$gs_resources/Resource" >&2
    printf "  with nothing to check, the per-subdir content gate would pass vacuously: a gutted\n" >&2
    printf "  Resource/CMap or Resource/Encoding would ship unnoticed. This also fires when the\n" >&2
    printf "  manifest gs row stops declaring 'Resource', since the per-subdir check would then\n" >&2
    printf "  silently stop covering the tree gs reaches through Resource/Init/gs_init.ps.\n" >&2
    printf "  Run 'yarn binaries:prep' to restage the gs resources.\n" >&2
    gs_smoke_failed
    return 0
  fi
  for subdir in "${subdirs[@]}"; do
    local sub_has_files=0
    dir_has_file_recursive "$subdir" || sub_has_files=$?
    if [ "$sub_has_files" -eq 2 ]; then
      gs_smoke_failed
      return 0
    fi
    if [ "$sub_has_files" -ne 0 ]; then
      printf 'FAIL gs clean-room smoke: no files anywhere under %s\n' "$subdir" >&2
      printf "  gs derives GS_LIBRESOURCE from where it found Resource/Init/gs_init.ps, so\n" >&2
      printf "  every sibling under Resource/ is reached through this same tree. A hole here\n" >&2
      printf "  means gs silently uses whatever the host has instead.\n" >&2
      printf "  Run 'yarn binaries:prep' to restage the gs resources.\n" >&2
      gs_smoke_failed
      return 0
    fi
  done
  if ! assert_gs_sentinels "$gs_resources" "${sentinel_pairs[@]}"; then
    gs_smoke_failed
    return 0
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
    for pair in "${sentinel_pairs[@]}"; do
      printf '(%s) runlibfile\n' "${pair##*:}"
    done
    printf '%s\n' \
      '/Helvetica-Bold findfont 24 scalefont setfont' \
      '72 700 moveto (gs clean-room smoke) show' \
      '/Helvetica findfont 12 scalefont setfont' \
      '72 660 moveto (font resolution must come from the staged resources) show' \
      'showpage'
  } >"$fixture" || {
    printf 'FAIL gs clean-room smoke: could not write the PostScript fixture %s\n' "$fixture" >&2
    gs_smoke_failed
    return 0
  }

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
    gs_smoke_failed
    return 0
  fi
  local size
  size="$(wc -c <"$out" | tr -d ' ')" || size=""
  if [ ! -s "$out" ] || [ -z "$size" ] || [ "$size" -le 1024 ]; then
    printf 'FAIL gs clean-room smoke: rendered %s bytes, expected more than 1024 from a font-using fixture\n' "${size:-<unreadable>}" >&2
    sed -e 's/^/  gs stderr: /' "$work/gs.stderr" >&2
    gs_smoke_failed
    return 0
  fi
  if ! grep -q '%%EOF' "$out"; then
    printf 'FAIL gs clean-room smoke: output is not a complete PDF\n' >&2
    sed -e 's/^/  gs stderr: /' "$work/gs.stderr" >&2
    gs_smoke_failed
    return 0
  fi
  smoke_mode=0
  printf 'gs clean-room smoke: PASS (%s bytes, %s staged resource flags, sentinel resolved)\n' "$size" "${#gs_includes[@]}"
}

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
    if ! gs_smoke_workdir="$(mktemp -d -t gs-clean-room)"; then
      printf 'FAIL gs clean-room smoke: could not create a temp dir (mktemp -d -t gs-clean-room)\n' >&2
      printf '  the smoke must run, not be skipped: check that TMPDIR is writable\n' >&2
      exit 1
    fi
    gs_clean_room_smoke "$BIN_DIR/gs-$TARGET" "$GS_RESOURCES_DIR" "$gs_smoke_workdir"
  fi
fi

if [ ${#failures[@]} -gt 0 ]; then
  audit_finished=1
  printf 'sidecar audit: %d file(s) not self-contained\n' "${#failures[@]}"
  exit 1
fi

binaries_count=""
if ! binaries_count="$(enumerate_count "$BIN_DIR" -type f)"; then
  exit 1
fi
frameworks_count=0
if [ -d "$FRAMEWORKS_DIR" ]; then
  if ! frameworks_count="$(enumerate_count "$FRAMEWORKS_DIR" -name '*.dylib')"; then
    exit 1
  fi
fi
pass_summary="sidecar audit: PASS ($binaries_count binaries, $frameworks_count framework dylibs)"
printf '%s\n' "$pass_summary"
audit_finished=1
