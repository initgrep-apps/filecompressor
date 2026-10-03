#!/usr/bin/env node
import {
  exists,
  hostTriple,
  isMain,
  manifestPath,
  parseArgs,
  readJson,
  validateManifest,
} from "./lib.mjs";

export async function prepTarget(target, root) {
  const manifestFile = manifestPath(root);
  if (await exists(manifestFile)) {
    let manifest;
    try {
      manifest = readJson(manifestFile);
      validateManifest(manifest);
    } catch (error) {
      throw new Error(`${error.message ?? error} (scripts/binaries.manifest.json)`);
    }
    const brewEntries = Object.entries(manifest.targets?.[target] ?? {}).filter(
      ([, entry]) => entry.source === "brew",
    );
    if (brewEntries.length > 0) {
      const names = brewEntries.map(([name]) => name).join(", ");
      throw new Error(
        `prep: ${names} for ${target} are brew-owned entries with no prep implementation yet — macOS prep lands in Task 2 of docs/superpowers/plans/2026-10-02-sidecar-binaries-release.md; refusing to report success with the binary uninstalled`,
      );
    }
  }
  console.log(
    `prep: macOS prep for ${target} is implemented in Task 2 (plan 2026-10-02-sidecar-binaries-release) — nothing to do yet`,
  );
  return true;
}

if (isMain(import.meta.url)) {
  try {
    const args = parseArgs(process.argv.slice(2));
    const root = args.root ?? process.cwd();
    const target = args.target ?? (await hostTriple());
    if (!target) {
      console.error(
        "FAIL no --target given and host triple could not be detected (see warning above) — pass --target <triple>",
      );
      process.exit(1);
    }
    const ok = await prepTarget(target, root);
    process.exit(ok ? 0 : 1);
  } catch (error) {
    console.error(`FAIL ${error.message ?? error}`);
    process.exit(1);
  }
}