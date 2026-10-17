derive_windows_lists() {
  local root="$1" triple="$2"
  local manifest="$root/scripts/binaries.manifest.json"
  local out
  WINDOWS_ALL_LIST="ffmpeg ffprobe qpdf vips gs"
  WINDOWS_ENGINE_LIST="vips qpdf gs"
  if [ ! -f "$manifest" ]; then
    return 0
  fi
  if ! out="$(node -e '
    const fs = require("fs");
    const [triple, manifestPath] = process.argv.slice(1);
    let manifest;
    try {
      manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    } catch (error) {
      console.error(`readable JSON expected in ${manifestPath}: ${error.message ?? error}`);
      process.exit(1);
    }
    const target = (manifest.targets ?? {})[triple];
    if (!target) {
      console.error(`manifest has no row for the target "${triple}" — every frozen triple must exist in the manifest`);
      process.exit(1);
    }
    const all = [];
    const engines = [];
    for (const [name, entry] of Object.entries(target)) {
      if (!entry || typeof entry !== "object") {
        console.error(`manifest row ${triple}/${name} is not an object`);
        process.exit(1);
      }
      const dest = typeof entry.dest === "string" && entry.dest.length > 0 ? entry.dest : name;
      all.push(dest);
      if (entry.static !== true) {
        engines.push(dest);
      }
    }
    process.stdout.write(`${all.join(" ")}\n${engines.join(" ")}\n`);
  ' "$triple" "$manifest")"; then
    fail "cannot derive the windows engine lists from $manifest: ${out}"
  fi
  WINDOWS_ALL_LIST="$(printf '%s\n' "$out" | awk 'NR==1 {print}')"
  WINDOWS_ENGINE_LIST="$(printf '%s\n' "$out" | awk 'NR==2 {print}')"
}
