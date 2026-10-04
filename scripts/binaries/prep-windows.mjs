#!/usr/bin/env node
import { cp, mkdir, readdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  archForTriple,
  binaryDir,
  exists,
  isMain,
  isWindowsTriple,
  manifestPath,
  parseArgs,
  readJson,
  stagingDir,
  validateManifest,
} from "./lib.mjs";
import { gsSentinelPaths } from "./gs-sentinels.mjs";

export const GS_RESOURCES_DIR = "gs-resources";
export const ENGINES_DIR = "engines";
const GS_INIT_MARKER = join("Resource", "Init", "gs_init.ps");

export class PrepWindowsError extends Error {
  constructor(message) {
    super(message);
    this.name = "PrepWindowsError";
  }
}

export function engineDir(root, dest) {
  return join(binaryDir(root), ENGINES_DIR, dest);
}

export function gsResourcesDir(root) {
  return join(root, "src-tauri", GS_RESOURCES_DIR);
}

function payloadDirOf(member) {
  const parent = dirname(member);
  return parent === "." ? "" : parent;
}

function packageRootOf(member) {
  const parts = member.split("/").filter(Boolean);
  return parts.length > 1 ? parts[0] : "";
}

async function listDir(dir) {
  try {
    return await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

async function swapIn(stagingDirPath, finalDir) {
  const previous = `${finalDir}.previous-${process.pid}`;
  await rm(previous, { recursive: true, force: true });
  if (await exists(finalDir)) {
    await rename(finalDir, previous);
  }
  await mkdir(dirname(finalDir), { recursive: true });
  try {
    await rename(stagingDirPath, finalDir);
  } catch (error) {
    if (await exists(previous)) {
      await rename(previous, finalDir);
    }
    throw error;
  }
  await rm(previous, { recursive: true, force: true });
}

async function stageEngine(root, name, entry, triple) {
  const staging = stagingDir(root, name, triple);
  const payload = join(staging, payloadDirOf(entry.member));
  const memberPath = join(staging, entry.member);
  if (!(await exists(memberPath))) {
    const found = await listDir(payload);
    throw new PrepWindowsError(
      `${name} (${triple}): staged member '${entry.member}' is missing from ${staging} — ` +
        `the archive layout is not what the manifest declares. Payload dir holds: ` +
        `${found.map((item) => item.name).slice(0, 20).join(", ") || "(empty)"}. ` +
        `Re-check the member pin in scripts/binaries.manifest.json, then re-run 'yarn binaries:prep'`,
    );
  }

  const work = `${engineDir(root, entry.dest)}.staging-${process.pid}`;
  await rm(work, { recursive: true, force: true });
  await mkdir(work, { recursive: true });

  const siblings = await listDir(payload);
  let payloadCount = 0;
  for (const item of siblings) {
    const from = join(payload, item.name);
    if (item.isDirectory()) {
      await cp(from, join(work, item.name), { recursive: true });
      payloadCount += 1;
      continue;
    }
    if (!item.name.toLowerCase().endsWith(".dll")) {
      continue;
    }
    await cp(from, join(work, item.name));
    payloadCount += 1;
  }
  if (payloadCount === 0) {
    await rm(work, { recursive: true, force: true });
    throw new PrepWindowsError(
      `${name} (${triple}): no DLLs or payload beside '${entry.member}' in ${payload} — ` +
        `a Windows engine without its DLLs cannot start, and staging just the exe would ship a ` +
        `binary that fails only at compression time. Check the member pin, then re-run 'yarn binaries:prep'`,
    );
  }

  await cp(memberPath, join(work, `${entry.dest}.exe`));
  await swapIn(work, engineDir(root, entry.dest));
  return engineDir(root, entry.dest);
}

async function stageGsResources(root, name, entry, triple) {
  const staging = stagingDir(root, name, triple);
  const packageRoot = packageRootOf(entry.member);
  const declared = Array.isArray(entry.resources) ? entry.resources : [];
  if (declared.length === 0) {
    return [];
  }

  const finalDir = gsResourcesDir(root);
  const work = `${finalDir}.staging-${process.pid}`;
  await rm(work, { recursive: true, force: true });
  await mkdir(work, { recursive: true });

  const stagedDirs = [];
  for (const relative of declared) {
    const source = join(staging, packageRoot, relative);
    if (!(await exists(source))) {
      await rm(work, { recursive: true, force: true });
      throw new PrepWindowsError(
        `${name} (${triple}): ghostscript resource dir '${join(packageRoot, relative)}' is missing ` +
          `from the staged package. Without it gs resolves fonts and ICC profiles from whatever the ` +
          `machine has, so PDF output silently differs per machine — the exact failure the staged ` +
          `tree exists to prevent. Check the resources pin in scripts/binaries.manifest.json against ` +
          `the package layout, then re-run 'yarn binaries:prep'`,
      );
    }
    const name_ = relative.split("/").filter(Boolean).pop();
    await cp(source, join(work, name_), { recursive: true });
    stagedDirs.push(name_);
  }

  for (const relative of gsSentinelPaths()) {
    const topLevel = relative.split("/")[0];
    if (!stagedDirs.includes(topLevel)) {
      continue;
    }
    const sentinel = join(work, relative);
    await mkdir(dirname(sentinel), { recursive: true });
    await writeFile(sentinel, "%!\n");
  }

  const marker = join(work, GS_INIT_MARKER);
  if (!(await exists(marker))) {
    await rm(work, { recursive: true, force: true });
    throw new PrepWindowsError(
      `${name} (${triple}): staged gs-resources has no ${GS_INIT_MARKER} — gs cannot start without it. ` +
        `Run 'yarn binaries:prep' after checking the resources pin`,
    );
  }

  await swapIn(work, finalDir);
  return stagedDirs;
}

export async function prepWindowsEngines(root, triple, entries) {
  if (!isWindowsTriple(triple)) {
    throw new PrepWindowsError(
      `prepWindowsEngines called for non-Windows target '${triple}' — use prepTarget for macOS`,
    );
  }
  archForTriple(triple);
  const staged = [];
  for (const [name, entry] of Object.entries(entries)) {
    if (!entry?.member) {
      throw new PrepWindowsError(
        `${name} (${triple}) has no 'member' pin — the Windows layout copies the payload dir beside it, ` +
          `which cannot be derived without one`,
      );
    }
    staged.push(await stageEngine(root, name, entry, triple));
    if (Array.isArray(entry.resources) && entry.resources.length > 0) {
      await stageGsResources(root, name, entry, triple);
    }
  }
  return staged;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const root = args.root ?? process.cwd();
  const target = args.target;
  if (!target) {
    console.error("FAIL --target <windows-triple> is required");
    process.exit(1);
  }
  const manifest = readJson(manifestPath(root));
  try {
    validateManifest(manifest);
  } catch (error) {
    console.error(`FAIL ${error.message ?? error} (scripts/binaries.manifest.json)`);
    process.exit(1);
  }
  const entries = manifest.targets?.[target];
  if (!entries) {
    console.error(
      `FAIL target '${target}' not in manifest (known: ${Object.keys(manifest.targets ?? {}).join(", ") || "none"})`,
    );
    process.exit(1);
  }
  try {
    const staged = await prepWindowsEngines(root, target, entries);
    for (const dir of staged) {
      console.log(`prep: staged ${dir}`);
    }
    console.log(`prep: PASS for ${target} (${staged.length} engine folders)`);
  } catch (error) {
    console.error(`FAIL ${error.message ?? error}`);
    process.exit(1);
  }
}

if (isMain(import.meta.url)) {
  await main();
}