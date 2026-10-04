#!/usr/bin/env node
import { spawn } from "node:child_process";
import { chmod, copyFile, mkdir, readdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import {
  GS_INIT_SENTINEL,
  GS_SENTINEL_PREFIX,
  gsSentinelPaths,
  isGsSentinel,
} from "./gs-sentinels.mjs";
import {
  archForTriple,
  binaryDir,
  expectedDest,
  exists,
  hostTriple,
  isMain,
  isWindowsTriple,
  lockPath,
  manifestPath,
  parseArgs,
  readJson,
  run,
  sha256File,
  sha256Tree,
  stagingDir,
  validateLock,
  validateManifest,
  writeJson,
} from "./lib.mjs";

const BUNDLE_SCRIPTS = ["bundle-vips-macos.sh", "bundle-pdf-macos.sh"];
const GS_INIT_MARKER = join("Resource", "Init", "gs_init.ps");
const REWRITTEN_BY_BUNDLE = ["vips", "qpdf", "gs"];

export const GS_ACCEPTANCE_SENTINEL = GS_INIT_SENTINEL;
export const GS_ACCEPTANCE_SENTINELS = gsSentinelPaths().map((relative) => join(...relative.split("/")));

export class PipelinesError extends Error {
  constructor(message, { remedy = null } = {}) {
    super(message);
    this.name = "PipelinesError";
    this.remedy = remedy;
  }
}

function fail(message, remedy = null) {
  throw new PipelinesError(message, { remedy });
}

async function loadManifest(root) {
  const manifestFile = manifestPath(root);
  if (!(await exists(manifestFile))) {
    fail(
      `manifest missing: ${manifestFile}`,
      "restore scripts/binaries.manifest.json before prepping",
    );
  }
  let manifest;
  try {
    manifest = readJson(manifestFile);
    validateManifest(manifest);
  } catch (error) {
    fail(`${error.message ?? error} (scripts/binaries.manifest.json)`);
  }
  return manifest;
}

async function loadLock(root) {
  const path = lockPath(root);
  if (!(await exists(path))) {
    return { generated: null, targets: {} };
  }
  try {
    const lock = readJson(path);
    validateLock(lock);
    return lock;
  } catch (error) {
    fail(
      `lock unreadable or invalid at ${path}: ${error.message ?? error}`,
      "fix or delete it, then re-run 'yarn binaries:prep'",
    );
  }
}

function brewMissing(error) {
  return error.code === "ENOENT";
}

async function brewPrefix(formula) {
  try {
    const { stdout } = await run("brew", ["--prefix", formula]);
    const prefix = stdout.trim();
    if (!prefix) {
      fail(
        `brew --prefix ${formula} printed no path`,
        `run 'brew reinstall ${formula}', then re-run 'yarn binaries:prep'`,
      );
    }
    return prefix;
  } catch (error) {
    if (error instanceof PipelinesError) {
      throw error;
    }
    if (brewMissing(error)) {
      fail(
        "brew not found — vips and gs are brew-owned build ingredients",
        "install Homebrew from https://brew.sh, then re-run 'yarn binaries:prep'",
      );
    }
    fail(
      `brew --prefix ${formula} failed: ${error.message ?? error}`,
      `install it with 'brew install ${formula}', then re-run 'yarn binaries:prep'`,
    );
  }
}

export function parseBrewVersion(output, formula) {
  const fields = output.trim().split(/\s+/).filter(Boolean);
  if (fields.length < 2) {
    fail(
      `brew list --versions ${formula} printed '${output.trim()}'`,
      "expected '<formula> <version>' — run 'brew install <formula>'",
    );
  }
  return fields[fields.length - 1];
}

export async function brewVersion(formula) {
  try {
    const { stdout } = await run("brew", ["list", "--versions", formula]);
    return parseBrewVersion(stdout, formula);
  } catch (error) {
    if (error instanceof PipelinesError) {
      throw error;
    }
    if (brewMissing(error)) {
      fail(
        "brew not found",
        "install Homebrew from https://brew.sh, then re-run 'yarn binaries:prep'",
      );
    }
    fail(
      `brew list --versions ${formula} failed: ${error.message ?? error}`,
      `install it with 'brew install ${formula}', then re-run 'yarn binaries:prep'`,
    );
  }
}

export async function stageBrewBinary(root, triple, name, entry) {
  const formula = entry.formula;
  const binary = entry.binary ?? name;
  const prefix = await brewPrefix(formula);
  const source = join(prefix, "bin", binary);
  if (!(await exists(source))) {
    fail(
      `brew formula ${formula} has no ${binary} at ${source}`,
      `run 'brew reinstall ${formula}', then re-run 'yarn binaries:prep'`,
    );
  }
  const dest = expectedDest(entry.dest ?? name, triple);
  const destPath = join(binaryDir(root), dest);
  await mkdir(binaryDir(root), { recursive: true });
  await rm(destPath, { force: true });
  await copyFile(source, destPath);
  await chmod(destPath, 0o755);
  return { name, dest, destPath, source, formula };
}

async function contentArchMac(path, label) {
  try {
    const { stdout } = await run("lipo", ["-archs", path]);
    return stdout.trim().split(/\s+/);
  } catch (error) {
    fail(
      `${label}: cannot read the architecture of ${path} — lipo failed (${error.message ?? error}). The staged file is most likely truncated, empty or not a Mach-O image`,
      `delete it and re-run 'yarn binaries:prep' (or 'yarn binaries:fetch' for url-sourced engines) to restage it`,
    );
  }
}

export async function assertStagedArch(staged, expectedArch) {
  const archs = await contentArchMac(staged.destPath, staged.dest);
  if (!archs.includes(expectedArch)) {
    fail(
      `${staged.dest}: staged from brew formula ${staged.formula} is ${archs.join(" ")}, expected ${expectedArch} — the host formula is built for another architecture`,
      "reinstall the formula on this host, then re-run 'yarn binaries:prep'",
    );
  }
  return archs;
}

function runScript(root, script, env) {
  const path = join(root, "scripts", script);
  return new Promise((resolvePromise, reject) => {
    const child = spawn("bash", [path], {
      cwd: root,
      stdio: "inherit",
      env: { ...process.env, ...env },
    });
    child.on("error", (error) =>
      reject(new Error(`cannot run ${script}: ${error.message ?? error}`)),
    );
    child.on("close", (code, signal) => {
      if (signal) {
        reject(new Error(`${script} was killed by signal ${signal}`));
        return;
      }
      if (code !== 0) {
        reject(
          new Error(`${script} exited with code ${code} — fix the reported cause, then re-run 'yarn binaries:prep'`),
        );
        return;
      }
      resolvePromise();
    });
  });
}

export function gsResourceDirs(targetEntries) {
  for (const entry of Object.values(targetEntries)) {
    if (Array.isArray(entry.resources) && entry.resources.length > 0) {
      return entry.resources;
    }
  }
  return [];
}

export async function runBundleScripts(root, targetEntries = {}) {
  const dirs = gsResourceDirs(targetEntries);
  const env = dirs.length > 0 ? { FSO_GS_RESOURCE_DIRS: dirs.join(" ") } : {};
  for (const script of BUNDLE_SCRIPTS) {
    if (!(await exists(join(root, "scripts", script)))) {
      fail(`${script} missing from scripts/ — restore it before prepping`);
    }
    await runScript(root, script, env);
  }
}

export async function treeHasFile(dir) {
  const entries = await readdir(dir, { withFileTypes: true, recursive: true }).catch(() => []);
  return entries.some((entry) => entry.isFile() && !isGsSentinel(entry.name));
}

export async function resourceSubdirsWithoutFiles(base) {
  const resourceDir = join(base, "Resource");
  const entries = await readdir(resourceDir, { withFileTypes: true }).catch(() => []);
  const empty = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }
    const sub = join(resourceDir, entry.name);
    if (!(await treeHasFile(sub))) {
      empty.push(sub);
    }
  }
  return empty;
}

export async function assertGsResourcesStaged(root, entry, label = entry.formula ?? "gs") {
  const resources = entry.resources ?? [];
  if (resources.length === 0) {
    return false;
  }
  const base = join(root, "src-tauri", "gs-resources");
  if (!(await exists(base))) {
    fail(
      `${label}: gs resources dir missing: ${base}`,
      "run 'yarn binaries:prep' to stage it — the gs sidecar cannot render fonts or ICC profiles without it",
    );
  }
  for (const name of resources) {
    const dir = join(base, name);
    const info = await stat(dir).catch(() => null);
    if (!info || !info.isDirectory()) {
      fail(
        `${label}: gs resources dir missing: ${dir}`,
        "run 'yarn binaries:prep' to restage them",
      );
    }
  }
  if (resources.includes("Resource")) {
    const marker = join(base, GS_INIT_MARKER);
    if (!(await exists(marker))) {
      fail(
        `${label}: gs resource marker missing: ${marker}`,
        "run 'yarn binaries:prep' to restage them",
      );
    }
  }
  for (const name of resources) {
    const dir = join(base, name);
    if (!(await treeHasFile(dir))) {
      fail(
        `${label}: gs resources dir has no files anywhere under it: ${dir}`,
        "the gs sidecar would fail on a real PDF; run 'yarn binaries:prep' to restage them",
      );
    }
  }
  if (resources.includes("Resource")) {
    const emptySubdirs = await resourceSubdirsWithoutFiles(base);
    if (emptySubdirs.length > 0) {
      fail(
        `${label}: these Resource subdirs hold no files: ${emptySubdirs.join(", ")}`,
        "gs derives GS_LIBRESOURCE from where it found Resource/Init/gs_init.ps, so every sibling under Resource/ is reached through this same tree; run 'yarn binaries:prep' to restage them",
      );
    }
  }
  for (const relative of GS_ACCEPTANCE_SENTINELS) {
    const sentinel = join(base, relative);
    if (await exists(sentinel)) {
      continue;
    }
    fail(
      `${label}: gs acceptance sentinel missing: ${sentinel} — a clean-room audit cannot prove the -I flags are load-bearing without it`,
      "run 'yarn binaries:prep' — gs-resources was staged before the acceptance sentinel existed, so the audit's gs smoke would misdiagnose the failure as a compiled-in Homebrew fallback",
    );
  }
  return true;
}

export async function assertStagedLibsPinned(lock, target, root, entries) {
  for (const [name, entry] of entries) {
    if (entry.source !== "url" || !entry.lib) {
      continue;
    }
    const libDir = join(stagingDir(root, name, target), "lib");
    const remedy = `run 'yarn binaries:fetch --target ${target}'`;
    const pinned = lock.targets[target]?.[name]?.libStagedSha256;
    if (!pinned) {
      fail(
        `${name}: the lock records no libStagedSha256 for ${target}, so the staged lib would ship unpinned`,
        remedy,
      );
    }
    const staged = await sha256Tree(libDir).catch(() => null);
    if (!staged) {
      fail(
        `${name}: staged lib dir missing: ${libDir} — nothing left to pin`,
        `${remedy} to re-stage it from the vendor archive`,
      );
    }
    const stagedNames = Object.keys(staged).sort();
    const pinnedNames = Object.keys(pinned).sort();
    if (stagedNames.join(",") !== pinnedNames.join(",")) {
      fail(
        `${name}: staged lib dir does not match the lock — staged [${stagedNames.join(", ")}] vs pinned [${pinnedNames.join(", ")}]`,
        remedy,
      );
    }
    for (const file of stagedNames) {
      if (staged[file] !== pinned[file]) {
        fail(
          `${name}: staged lib ${file} sha256 mismatch — the lock records ${pinned[file]}, the staged file is ${staged[file]}; it was modified outside this pipeline`,
          remedy,
        );
      }
    }
  }
}

export async function assertBrewVersionsPinned(entries) {
  const drifted = [];
  for (const [name, entry] of entries) {
    const version = await brewVersion(entry.formula);
    if (version !== entry.expectVersion) {
      drifted.push(
        `  ${name}: brew ${entry.formula} is ${version}, the manifest pins ${entry.expectVersion}`,
      );
    }
  }
  if (drifted.length > 0) {
    fail(
      `brew version drift — the staged engines no longer match the manifest pins:\n${drifted.join("\n")}`,
      "bump the expectVersion values in scripts/binaries.manifest.json to the versions above (or reinstall the pinned formula), then re-run 'yarn binaries:prep'",
    );
  }
}

export async function writeBrewLockEntries(lock, target, root, entries) {
  await assertBrewVersionsPinned(entries);
  for (const [name, entry] of entries) {
    const destPath = join(binaryDir(root), expectedDest(entry.dest ?? name, target));
    if (!(await exists(destPath))) {
      fail(
        `${expectedDest(entry.dest ?? name, target)} was not staged`,
        "re-run 'yarn binaries:prep'",
      );
    }
    lock.targets[target][name] = {
      source: entry.source,
      formula: entry.formula,
      version: await brewVersion(entry.formula),
      stagedSha256: await sha256File(destPath),
      date: new Date().toISOString(),
    };
  }
  return lock;
}

export async function assertFetchedEntriesUntouched(lock, target, root, entries) {
  for (const [name, entry] of entries) {
    if (entry.source === "brew") {
      continue;
    }
    const recorded = lock.targets[target]?.[name]?.stagedSha256;
    if (!recorded) {
      continue;
    }
    const destPath = join(binaryDir(root), expectedDest(entry.dest ?? name, target));
    if (!(await exists(destPath))) {
      continue;
    }
    const staged = await sha256File(destPath);
    if (staged !== recorded) {
      fail(
        `${expectedDest(entry.dest ?? name, target)}: sha256 mismatch — the lock records the file fetch staged (${recorded}) but the staged file is ${staged}; it was swapped or modified outside this pipeline`,
        "re-run 'yarn binaries:fetch'",
      );
    }
  }
}

export async function refreshBundledStagedShas(lock, target, root, entries) {
  for (const [name, entry] of entries) {
    if (!REWRITTEN_BY_BUNDLE.includes(name)) {
      continue;
    }
    const locked = lock.targets[target]?.[name];
    if (!locked) {
      continue;
    }
    const destPath = join(binaryDir(root), expectedDest(entry.dest ?? name, target));
    if (!(await exists(destPath))) {
      continue;
    }
    locked.stagedSha256 = await sha256File(destPath);
  }
  return lock;
}

export async function assertAllEnginesStaged(root, target, targetEntries) {
  const missing = [];
  for (const [name, entry] of Object.entries(targetEntries)) {
    const dest = expectedDest(entry.dest ?? name, target);
    const path = join(binaryDir(root), dest);
    const info = await stat(path).catch(() => null);
    if (!info || !info.isFile()) {
      missing.push(dest);
      continue;
    }
    if ((info.mode & 0o111) === 0) {
      missing.push(`${dest} (not executable)`);
    }
  }
  if (missing.length > 0) {
    fail(
      `these manifest rows are not staged and executable after prep: ${missing.join(", ")}`,
      "run 'yarn binaries:all --target " + target + "' (fetch then prep)",
    );
  }
}

export async function prepTarget(target, root) {
  const manifest = await loadManifest(root);
  const targetEntries = manifest.targets?.[target];
  if (!targetEntries) {
    fail(
      `target '${target}' not in manifest (known: ${Object.keys(manifest.targets ?? {}).join(", ") || "none"})`,
    );
  }
  if (isWindowsTriple(target)) {
    fail(
      `prep for ${target} is not implemented yet`,
      "the Windows engine-folder layout lands in Task 3 of docs/superpowers/plans/2026-10-02-sidecar-binaries-release.md",
    );
  }
  const expectedArch = archForTriple(target);

  const brewEntries = Object.entries(targetEntries).filter(([, entry]) => entry.source === "brew");

  const lock = await loadLock(root);
  lock.targets[target] = lock.targets[target] ?? {};
  await assertBrewVersionsPinned(brewEntries);
  await assertFetchedEntriesUntouched(lock, target, root, Object.entries(targetEntries));
  await assertStagedLibsPinned(lock, target, root, Object.entries(targetEntries));

  const staged = [];
  for (const [name, entry] of brewEntries) {
    const stagedBinary = await stageBrewBinary(root, target, name, entry);
    const archs = await assertStagedArch(stagedBinary, expectedArch);
    staged.push(stagedBinary);
    console.log(
      `prep: ${stagedBinary.dest} staged from brew ${entry.formula} (${archs.join(" ")})`,
    );
  }

  await runBundleScripts(root, targetEntries);

  const resourceEntries = Object.entries(targetEntries).filter(
    ([, entry]) => Array.isArray(entry.resources) && entry.resources.length > 0,
  );
  for (const [name, entry] of resourceEntries) {
    await assertGsResourcesStaged(root, entry, name);
  }

  await assertAllEnginesStaged(root, target, targetEntries);
  await writeBrewLockEntries(lock, target, root, brewEntries);
  await refreshBundledStagedShas(lock, target, root, Object.entries(targetEntries));
  lock.generated = new Date().toISOString();
  await writeJson(lockPath(root), lock);

  for (const stagedBinary of staged) {
    console.log(`prep: ${stagedBinary.dest} bundled and signed`);
  }
  console.log(`prep: PASS for ${target} (${staged.length} brew engines bundled)`);
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
    if (error instanceof PipelinesError && error.remedy) {
      console.error(`REMEDY ${error.remedy}`);
    }
    process.exit(1);
  }
}