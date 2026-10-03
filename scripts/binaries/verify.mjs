#!/usr/bin/env node
import { execFile } from "node:child_process";
import { readdir, stat } from "node:fs/promises";
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
} from "./lib.mjs";

async function contentArchMac(path) {
  try {
    const { stdout } = await run("lipo", ["-archs", path]);
    return stdout.trim().split(/\s+/);
  } catch (error) {
    return { error: `${error.message ?? error}` };
  }
}

async function contentArchWindows(path) {
  try {
    const { stdout } = await run("file", ["-b", path]);
    if (/x86-64|x86_64/i.test(stdout)) return ["x86_64"];
    if (/ARM64|Aarch64/i.test(stdout)) return ["arm64"];
    return { error: `unrecognized PE arch in: ${stdout.trim()}` };
  } catch (error) {
    return { error: `${error.message ?? error}` };
  }
}

async function checkVersion(binPath, expectVersion, triple, root) {
  const env = { ...process.env };
  if (!isWindowsTriple(triple)) {
    env.DYLD_LIBRARY_PATH = join(root, "src-tauri", "frameworks");
  }
  return new Promise((resolvePromise) => {
    execFile(
      binPath,
      ["--version"],
      { encoding: "utf8", timeout: 20000, env },
      (error, stdout, stderr) => {
        const combined = `${stdout ?? ""}${stderr ?? ""}`;
        if (error && (error.killed || error.signal)) {
          resolvePromise({
            ok: false,
            detail: `execution timed out or was killed before reporting a version (${error.signal ?? "timeout"})`,
          });
          return;
        }
        if (error && !combined) {
          resolvePromise({ ok: false, detail: `failed to execute: ${error.message ?? error}` });
          return;
        }
        if (combined.includes(expectVersion)) {
          resolvePromise({ ok: true, detail: combined.trim().split("\n")[0] ?? "" });
          return;
        }
        resolvePromise({
          ok: false,
          detail: `expected '${expectVersion}' in version output, got: ${combined.trim().slice(0, 200) || "(empty)"}`,
        });
      },
    );
  });
}

export function gsResourcesDir(root) {
  return join(root, "src-tauri", "gs-resources");
}

const GS_INIT_MARKER = join("Resource", "Init", "gs_init.ps");

export async function checkGsResources(root, name, entry, problems) {
  const resources = entry.resources;
  if (!Array.isArray(resources) || resources.length === 0) {
    return;
  }
  const base = gsResourcesDir(root);
  if (!(await exists(base))) {
    problems.push(
      `${name}: gs resources dir missing: ${base} — run 'yarn binaries:prep' to stage it; without it the gs sidecar resolves fonts and ICC profiles from a Homebrew prefix and PDF compression fails on machines without brew Ghostscript`,
    );
    return;
  }
  if (resources.includes("Resource") && !(await exists(join(base, GS_INIT_MARKER)))) {
    problems.push(
      `${name}: gs resource marker missing: ${join(base, GS_INIT_MARKER)} — run 'yarn binaries:prep' to restage them`,
    );
  }
  for (const dirName of resources) {
    const dir = join(base, dirName);
    const info = await stat(dir).catch(() => null);
    if (!info || !info.isDirectory()) {
      problems.push(`${name}: gs resources dir missing: ${dir} — run 'yarn binaries:prep' to stage it`);
      continue;
    }
    const contents = await readdir(dir).catch(() => []);
    if (contents.length === 0) {
      problems.push(
        `${name}: gs resources dir is empty: ${dir} — a real PDF needs fonts and ICC profiles from it; run 'yarn binaries:prep' to restage them`,
      );
    }
  }
}

export async function checkBrewVersion(name, entry, lockEntry, problems) {
  if (entry.source !== "brew") {
    return;
  }
  if (!(await toolOnPath("brew"))) {
    console.warn(`WARN ${name}: brew not on PATH — skipping the brew version check for ${entry.formula}`);
    return;
  }
  let installed;
  try {
    const { stdout } = await run("brew", ["list", "--versions", entry.formula]);
    const fields = stdout.trim().split(/\s+/).filter(Boolean);
    installed = fields[1];
    if (!installed) {
      problems.push(
        `${name}: 'brew list --versions ${entry.formula}' printed '${stdout.trim()}' — the formula is not installed; run 'brew install ${entry.formula}' then re-run 'yarn binaries:prep'`,
      );
      return;
    }
  } catch (error) {
    problems.push(
      `${name}: 'brew list --versions ${entry.formula}' failed: ${error.message ?? error} — run 'brew install ${entry.formula}' then re-run 'yarn binaries:prep'`,
    );
    return;
  }
  const expected = lockEntry?.version ?? entry.expectVersion;
  if (installed !== expected) {
    problems.push(
      `${name}: brew version drift — formula ${entry.formula} is ${installed}, the lock pins ${expected} — re-pin the manifest expectVersion and re-run 'yarn binaries:all' (refresh automation lands with 'yarn binaries:refresh')`,
    );
  }
}

async function toolOnPath(tool) {
  try {
    await run("sh", ["-c", `command -v ${tool}`]);
    return true;
  } catch {
    return false;
  }
}

export async function verifyTarget(target, root) {
  const problems = [];
  let triple = target;
  if (!triple) {
    triple = await hostTriple();
    if (!triple) {
      console.error("FAIL no --target given and host triple undetectable — pass --target <triple>");
      return false;
    }
  }
  let expectedArch;
  try {
    expectedArch = archForTriple(triple);
  } catch {
    console.error(
      `FAIL unknown triple '${triple}' — pass --target <triple> with a known target (e.g. aarch64-apple-darwin)`,
    );
    return false;
  }

  const manifestFile = manifestPath(root);
  if (!(await exists(manifestFile))) {
    console.error(`FAIL manifest missing: ${manifestFile}`);
    return false;
  }
  let manifest;
  try {
    manifest = readJson(manifestFile);
  } catch (error) {
    console.error(`FAIL manifest unreadable at ${manifestFile}: ${error.message ?? error}`);
    return false;
  }
  try {
    validateManifest(manifest);
  } catch (error) {
    console.error(`FAIL ${error.message ?? error} (scripts/binaries.manifest.json)`);
    return false;
  }
  const entries = manifest.targets?.[triple];
  if (!entries) {
    console.error(
      `FAIL target '${triple}' not in manifest (known: ${Object.keys(manifest.targets ?? {}).join(", ") || "none"}) — pass --target <triple> naming a manifest target`,
    );
    return false;
  }

  const bins = binaryDir(root);
  let checked = 0;

  const lockFile = lockPath(root);
  let lockTarget = {};
  if (await exists(lockFile)) {
    let lock;
    try {
      lock = readJson(lockFile);
      validateLock(lock);
    } catch (error) {
      console.error(
        `FAIL lock unreadable or invalid at ${lockFile}: ${error.message ?? error} — fix or delete scripts/binaries.lock.json and re-run 'yarn binaries:fetch'`,
      );
      return false;
    }
    lockTarget = lock.targets?.[triple] ?? {};
  }

  for (const [name, entry] of Object.entries(entries)) {
    const dest = expectedDest(entry.dest ?? name, triple);
    const binPath = join(bins, dest);

    if (!(await exists(binPath))) {
      problems.push(`missing ${dest} — run 'yarn binaries:all'`);
      continue;
    }

    const contentArch = isWindowsTriple(triple)
      ? await contentArchWindows(binPath)
      : await contentArchMac(binPath);
    let archOk = false;
    if (contentArch.error) {
      problems.push(`${dest}: arch check failed — ${contentArch.error}`);
    } else if (!contentArch.includes(expectedArch)) {
      problems.push(
        `${dest}: arch ${contentArch.join(" ")} does not match ${expectedArch} (filename triple ${triple})`,
      );
    } else {
      archOk = true;
      checked += 1;
    }

    if (!archOk) {
      continue;
    }

    const lockEntry = lockTarget[name];
    if (lockEntry?.stagedSha256) {
      const stagedSha = await sha256File(binPath);
      if (stagedSha !== lockEntry.stagedSha256) {
        problems.push(
          `${dest}: sha256 mismatch — lock records staged ${lockEntry.stagedSha256}, file is ${stagedSha} — the staged binary was swapped or corrupted; re-run 'yarn binaries:fetch'`,
        );
        continue;
      }
    }

    const version = await checkVersion(binPath, entry.expectVersion, triple, root);
    if (!version.ok) {
      problems.push(`${dest}: version check failed — ${version.detail}`);
    } else {
      console.log(`verify: ${dest} ${entry.expectVersion} (${expectedArch}) OK`);
    }

    await checkGsResources(root, dest, entry, problems);
    await checkBrewVersion(dest, entry, lockEntry, problems);
  }

  if (problems.length > 0) {
    for (const problem of problems) {
      console.error(`FAIL ${problem}`);
    }
    return false;
  }
  if (checked === 0) {
    const listed = Object.keys(entries);
    if (listed.length === 0) {
      console.error(
        `FAIL no binaries verified for ${triple} — the manifest lists target '${triple}' with zero entries; add its binaries to scripts/binaries.manifest.json before auditing`,
      );
      return false;
    }
    console.error(
      `FAIL no binaries verified for ${triple} — none of ${listed.join(", ")} passed the arch, lock and version gates`,
    );
    return false;
  }
  console.log(`verify: PASS (${checked} binaries checked for ${triple})`);
  return true;
}

if (isMain(import.meta.url)) {
  try {
    const args = parseArgs(process.argv.slice(2));
    const ok = await verifyTarget(args.target, args.root ?? process.cwd());
    process.exit(ok ? 0 : 1);
  } catch (error) {
    console.error(`FAIL ${error.message ?? error}`);
    process.exit(1);
  }
}
