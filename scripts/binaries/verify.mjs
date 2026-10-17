#!/usr/bin/env node
import { execFile } from "node:child_process";
import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { gsSentinelPaths, isGsSentinel } from "./gs-sentinels.mjs";
import { ENGINES_DIR } from "./prep-windows.mjs";
import { archForTriple, binaryDir, exists, expectedDest, hostTriple, isMain, isWindowsTriple, knownTriples, lockPath, manifestPath, parseArgs, readJson, run, sha256File, validateLock, validateManifest } from "./lib.mjs";
import { assertEngineImportsClosed } from "./closure-check.mjs";

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
export const GS_ACCEPTANCE_SENTINELS = gsSentinelPaths().map((relative) => join(...relative.split("/")));

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
  for (const dirName of resources) {
    const dir = join(base, dirName);
    const info = await stat(dir).catch(() => null);
    if (!info || !info.isDirectory()) {
      problems.push(`${name}: gs resources dir missing: ${dir} — run 'yarn binaries:prep' to stage it`);
    }
  }
  if (resources.includes("Resource") && !(await exists(join(base, GS_INIT_MARKER)))) {
    problems.push(
      `${name}: gs resource marker missing: ${join(base, GS_INIT_MARKER)} — run 'yarn binaries:prep' to restage them`,
    );
  }
  if (resources.includes("Resource")) {
    for (const sub of await resourceSubdirsWithoutFiles(base)) {
      problems.push(
        `${name}: Resource subdir holds no files: ${sub} — gs derives GS_LIBRESOURCE from where it found Resource/Init/gs_init.ps, so every sibling under Resource/ is reached through this same tree; run 'yarn binaries:prep' to restage them`,
      );
    }
  }
  for (const relative of GS_ACCEPTANCE_SENTINELS) {
    const sentinel = join(base, relative);
    if (!(await exists(sentinel))) {
      problems.push(
        `${name}: gs acceptance sentinel missing: ${sentinel} — run 'yarn binaries:prep': gs-resources was staged before the acceptance sentinel existed, so the audit's clean-room smoke cannot prove the -I flags are load-bearing`,
      );
    }
  }
  for (const dirName of resources) {
    const dir = join(base, dirName);
    if (!(await exists(dir))) {
      continue;
    }
    if (!(await treeHasFile(dir))) {
      problems.push(
        `${name}: gs resources dir has no files anywhere under it: ${dir} — a real PDF needs fonts and ICC profiles from it; run 'yarn binaries:prep' to restage them`,
      );
    }
  }
}

export const ALLOW_INACTIVE_BREW = "BINARIES_ALLOW_INACTIVE_BREW";

export async function checkBrewVersion(name, entry, problems) {
  if (entry.source !== "brew") {
    return;
  }
  if (!(await toolOnPath("brew"))) {
    if (process.env[ALLOW_INACTIVE_BREW] === "1") {
      console.log(
        `note: brew version-drift gate INACTIVE for ${name} (formula ${entry.formula}) — ${ALLOW_INACTIVE_BREW}=1 allows the audit to proceed without Homebrew, so a drifted build would pass this run`,
      );
      return;
    }
    problems.push(
      `${name}: brew is not on PATH, so the version-drift gate for formula ${entry.formula} is INACTIVE — a drifted Homebrew build would pass this audit. Install Homebrew (https://brew.sh), or set ${ALLOW_INACTIVE_BREW}=1 to acknowledge the gap on a brew-less host (e.g. CI), then re-run the audit`,
    );
    return;
  }
  let installed;
  let notInstalled = null;
  try {
    const { stdout } = await run("brew", ["list", "--versions", entry.formula]);
    const fields = stdout.trim().split(/\s+/).filter(Boolean);
    installed = fields[fields.length - 1];
    if (!installed) {
      notInstalled = `'brew list --versions ${entry.formula}' printed '${stdout.trim()}' — the formula is not installed`;
    }
  } catch (error) {
    const detail = `${error.stdout ?? ""}${error.stderr ?? ""}${error.message ?? error}`.trim();
    if (/no such keg|not installed/i.test(detail)) {
      notInstalled = `'brew list --versions ${entry.formula}' failed: ${detail} — the formula is not installed`;
    } else {
      problems.push(
        `${name}: 'brew list --versions ${entry.formula}' failed: ${error.message ?? error} — run 'brew install ${entry.formula}' then re-run 'yarn binaries:prep'`,
      );
      return;
    }
  }
  if (notInstalled) {
    if (process.env[ALLOW_INACTIVE_BREW] === "1") {
      console.log(
        `note: brew version-drift gate INACTIVE for ${name} (formula ${entry.formula}) — ${notInstalled}; ${ALLOW_INACTIVE_BREW}=1 allows the audit to proceed without the formula installed on this host, so a drifted build would pass this run`,
      );
      return;
    }
    problems.push(
      `${name}: ${notInstalled}; run 'brew install ${entry.formula}' then re-run 'yarn binaries:prep'`,
    );
    return;
  }
  if (installed !== entry.expectVersion) {
    const driftDetail = `formula ${entry.formula} is ${installed} but scripts/binaries.manifest.json pins ${entry.expectVersion}`;
    if (process.env[ALLOW_INACTIVE_BREW] === "1") {
      console.log(
        `note: brew version-drift gate INACTIVE for ${name} (formula ${entry.formula}) — ${driftDetail}; ${ALLOW_INACTIVE_BREW}=1 allows the audit to proceed with a drifted brew formula (the brew lifecycle is inert on a frozen payload), so a drifted build would pass this run`,
      );
      return;
    }
    problems.push(
      `${name}: brew version drift — ${driftDetail}. Re-pin expectVersion to ${installed} in the manifest (or reinstall the pinned formula), then re-run 'yarn binaries:all'`,
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
      `FAIL unknown triple '${triple}' — pass --target <triple> with one of: ${knownTriples().join(", ")}`,
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
    const destName = entry.dest ?? name;
    const dest = expectedDest(destName, triple);
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
    if (lockEntry?.stagedSha256 && entry.source !== "brew") {
      const stagedSha = await sha256File(binPath);
      if (stagedSha !== lockEntry.stagedSha256) {
        problems.push(
          `${dest}: sha256 mismatch — lock records staged ${lockEntry.stagedSha256}, file is ${stagedSha} — the staged binary was swapped or corrupted; re-run 'yarn binaries:prep', which re-stages it and re-records the digest ('yarn binaries:refresh' will automate this once it lands)`,
        );
        continue;
      }
    }

    const enginesExe = isWindowsTriple(triple) && entry.static !== true ? join(bins, ENGINES_DIR, destName, `${destName}.exe`) : null;
    if (enginesExe && !(await exists(enginesExe))) {
      problems.push(
        `${dest}: windows engine executable missing: ${enginesExe} — the app runs ${ENGINES_DIR}/${destName}/${destName}.exe (its dependent DLLs live beside it) and the flat copy beside the app binary cannot start without them; run 'yarn binaries:prep' to stage it`,
      );
      continue;
    }
    const execPath = enginesExe ?? binPath;

    if (enginesExe) {
      const engineDir = join(bins, ENGINES_DIR, destName);
      const closed = await assertEngineImportsClosed(engineDir).then(
        () => true,
        (error) => ({ error }),
      );
      if (closed !== true) {
        problems.push(`${dest}: engine import closure failed — ${closed.error.message ?? closed.error}`);
        continue;
      }
    }

    const version = await checkVersion(execPath, entry.expectVersion, triple, root);
    if (!version.ok) {
      problems.push(`${dest}: version check failed — ${version.detail}`);
    } else {
      console.log(`verify: ${dest} ${entry.expectVersion} (${expectedArch}) OK`);
    }

    await checkGsResources(root, dest, entry, problems);
    await checkBrewVersion(dest, entry, problems);
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
