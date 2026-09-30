# Shared helpers for the per-engine macOS sidecar bundling scripts
# (bundle-vips-macos.sh, bundle-pdf-macos.sh). Sourced, not executed.
# Callers own: $FRAMEWORKS, the engine/sidecar list, collect_deps_of and the
# orchestration loop. All functions here operate on arguments only.

system_path() {
  case "$1" in
    /usr/lib/system/*|/System/Library/*|/usr/lib/*|@*) return 0 ;;
    /*) return 1 ;;
    *) return 0 ;;
  esac
}

fingerprint() {
  {
    otool -D "$1" | tail -n +2 | awk '{print $1}' | awk -F/ '{print $NF}'
    otool -L "$1" | tail -n +2 | awk '{print $1}' | awk -F/ '{print $NF}' | sort -u
  } | sort -u
}

rewrite() {
  local file="$1"
  chmod u+w "$file"
  for dep in $(otool -L "$file" | tail -n +2 | awk '{print $1}'); do
    system_path "$dep" || install_name_tool -change "$dep" "@rpath/$(basename "$dep")" "$file"
  done
}

has_rpath() {
  local file="$1" rpath="$2"
  otool -l "$file" | awk -v p="$rpath" '$1 == "path" && $2 == p { found = 1 } END { exit !found }'
}

ensure_rpath() {
  local file="$1" rpath="$2"
  has_rpath "$file" "$rpath" || install_name_tool -add_rpath "$rpath" "$file"
}
