#!/usr/bin/env node
import { spawn } from "node:child_process";
import { chmod, copyFile, mkdir, readdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";
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
  validateLock,
  validateManifest,
  writeJson,
} from "./lib.mjs";

const BUNDLE_SCRIPTS = ["bundle-vips-macos.sh", "bundle-pdf-macos.sh"];
const GS_INIT_MARKER = join("Resource", "Init", "gs_init.ps");
const REWRITTEN_BY_BUNDLE = ["vips", "qpdf", "gs"];

function fail(message) {
  throw new Error(message);
}

async function loadManifest(root) {
  const manifestFile = manifestPath(root);
  if (!(await exists(manifestFile))) {
    fail(
      `manifest missing: ${manifestFile} — restore scripts/binaries.manifest.json before prepping`,
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
      `lock unreadable or invalid at ${path}: ${error.message ?? error} — fix or delete it and re-run 'yarn binaries:prep'`,
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
      fail(`brew --prefix ${formula} printed no path — run 'brew reinstall ${formula}'`);
    }
    return prefix;
  } catch (error) {
    if (error.message?.startsWith("brew --prefix")) {
      throw error;
    }
    if (brewMissing(error)) {
      fail(
        `brew not found — vips and gs are brew-owned build ingredients: install Homebrew from https://brew.sh, then re-run 'yarn binaries:prep'`,
      );
    }
    fail(
      `brew --prefix ${formula} failed: ${error.message ?? error} — install it with 'brew install ${formula}', then re-run 'yarn binaries:prep'`,
    );
  }
}

export function parseBrewVersion(output, formula) {
  const fields = output.trim().split(/\s+/).filter(Boolean);
  if (fields.length < 2) {
    fail(`brew list --versions ${formula} printed '${output.trim()}' — expected '<formula> <version>'`);
  }
  return fields[1];
}

export async function brewVersion(formula) {
  try {
    const { stdout } = await run("brew", ["list", "--versions", formula]);
    return parseBrewVersion(stdout, formula);
  } catch (error) {
    if (brewMissing(error)) {
      fail(
        `brew not found — install Homebrew from https://brew.sh, then re-run 'yarn binaries:prep'`,
      );
    }
    fail(
      `brew list --versions ${formula} failed: ${error.message ?? error} — install it with 'brew install ${formula}', then re-run 'yarn binaries:prep'`,
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
      `brew formula ${formula} has no ${binary} at ${source} — run 'brew reinstall ${formula}', then re-run 'yarn binaries:prep'`,
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

async function contentArchMac(path) {
  const { stdout } = await run("lipo", ["-archs", path]);
  return stdout.trim().split(/\s+/);
}

export async function assertStagedArch(staged, expectedArch) {
  const archs = await contentArchMac(staged.destPath);
  if (!archs.includes(expectedArch)) {
    fail(
      `${staged.dest}: staged from brew formula ${staged.formula} is ${archs.join(" ")}, expected ${expectedArch} — the host formula is built for another architecture; reinstall on this host, then re-run 'yarn binaries:prep'`,
    );
  }
  return archs;
}

function runScript(root, script) {
  const path = join(root, "scripts", script);
  return new Promise((resolvePromise, reject) => {
    const child = spawn("bash", [path], { cwd: root, stdio: "inherit" });
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

export async function runBundleScripts(root) {
  for (const script of BUNDLE_SCRIPTS) {
    if (!(await exists(join(root, "scripts", script)))) {
      fail(`${script} missing from scripts/ — restore it before prepping`);
    }
    await runScript(root, script);
  }
}

export async function assertGsResourcesStaged(root, entry) {
  const resources = entry.resources ?? [];
  if (resources.length === 0) {
    return false;
  }
  const base = join(root, "src-tauri", "gs-resources");
  if (!(await exists(base))) {
    fail(
      `gs resources dir missing: ${base} — run 'yarn binaries:prep' to stage it (the gs sidecar cannot render fonts or ICC profiles without it)`,
    );
  }
  if (resources.includes("Resource") && !(await exists(join(base, GS_INIT_MARKER)))) {
    fail(
      `gs resources marker missing: ${join(base, GS_INIT_MARKER)} — run 'yarn binaries:prep' to restage them`,
    );
  }
  for (const name of resources) {
    const dir = join(base, name);
    const info = await stat(dir).catch(() => null);
    if (!info || !info.isDirectory()) {
      fail(`gs resources dir missing: ${dir} — run 'yarn binaries:prep' to restage them`);
    }
    if ((await readdir(dir)).length === 0) {
      fail(`gs resources dir empty: ${dir} — the gs sidecar would fail on a real PDF; run 'yarn binaries:prep' to restage them`);
    }
  }
  return true;
}

export async function writeBrewLockEntries(lock, target, root, entries) {
  for (const [name, entry] of entries) {
    const version = await brewVersion(entry.formula);
    const destPath = join(binaryDir(root), expectedDest(entry.dest ?? name, target));
    if (!(await exists(destPath))) {
      fail(`${expectedDest(entry.dest ?? name, target)} was not staged — run 'yarn binaries:prep' again`);
    }
    if (version !== entry.expectVersion) {
      console.warn(
        `WARN ${name}: brew ${entry.formula} is ${version}, manifest pins ${entry.expectVersion} — 'yarn binaries:verify' will fail on this drift until the manifest pin is updated`,
      );
    }
    lock.targets[target][name] = {
      source: entry.source,
      formula: entry.formula,
      version,
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
        `${expectedDest(entry.dest ?? name, target)}: sha256 mismatch — the lock records the file fetch staged (${recorded}) but the staged file is ${staged}; it was swapped or modified outside this pipeline — re-run 'yarn binaries:fetch'`,
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
      `prep for ${target} is not implemented yet — the Windows engine-folder layout lands in Task 3 of docs/superpowers/plans/2026-10-02-sidecar-binaries-release.md`,
    );
  }
  const expectedArch = archForTriple(target);

  const brewEntries = Object.entries(targetEntries).filter(([, entry]) => entry.source === "brew");
  const staged = [];
  for (const [name, entry] of brewEntries) {
    const stagedBinary = await stageBrewBinary(root, target, name, entry);
    const archs = await assertStagedArch(stagedBinary, expectedArch);
    staged.push(stagedBinary);
    console.log(
      `prep: ${stagedBinary.dest} staged from brew ${entry.formula} (${archs.join(" ")})`,
    );
  }

  const lock = await loadLock(root);
  lock.targets[target] = lock.targets[target] ?? {};
  await assertFetchedEntriesUntouched(lock, target, root, Object.entries(targetEntries));

  await runBundleScripts(root);

  for (const [, entry] of brewEntries) {
    await assertGsResourcesStaged(root, entry);
  }

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
    process.exit(1);
  }
}