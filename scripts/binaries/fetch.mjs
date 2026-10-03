#!/usr/bin/env node
import { copyFile, cp, mkdir, readdir, rm, chmod } from "node:fs/promises";
import { dirname, basename, join } from "node:path";
import {
  binaryDir,
  download,
  expectedDest,
  exists,
  extract,
  hostTriple,
  isMain,
  lockPath,
  manifestPath,
  parseArgs,
  readJson,
  sha256File,
  stagingDir,
  validateLock,
  validateManifest,
  writeJson,
} from "./lib.mjs";

function fail(message) {
  console.error(`FAIL ${message}`);
  process.exit(1);
}

async function loadManifest(root) {
  const path = manifestPath(root);
  if (!(await exists(path))) {
    fail(`manifest missing: ${path}`);
  }
  try {
    return readJson(path);
  } catch (error) {
    fail(`manifest unreadable at ${path}: ${error.message ?? error}`);
  }
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
    fail(`lock unreadable or invalid at ${path}: ${error.message ?? error} — fix or delete the lock (binaries.lock.json) and re-run fetch`);
  }
}

function archiveArtifactPath(root, name, triple, url) {
  const originalName = basename(new URL(url).pathname) || "artifact.bin";
  return join(root, "src-tauri", ".staging", `${name}-${triple}.${originalName}`);
}

async function removeStaging(staging) {
  await rm(staging, { recursive: true, force: true }).catch(() => {});
}

async function stageLibDir(name, entry, triple, staging) {
  if (!entry.lib) {
    return;
  }
  const libSource = join(staging, entry.lib);
  if (!(await exists(libSource))) {
    const listing = await readdir(staging, { recursive: true }).catch((error) => [
      `<listing unavailable: ${error.message ?? error}>`,
    ]);
    await removeStaging(staging);
    fail(
      `lib dir '${entry.lib}' missing in ${name} artifact for ${triple} — extracted files: ${listing.slice(0, 20).join(", ") || "(empty)"}`,
    );
  }
  const libDest = join(staging, "lib");
  if (libSource === libDest) {
    return;
  }
  await rm(libDest, { recursive: true, force: true });
  await cp(libSource, libDest, { recursive: true, verbatimSymlinks: true });
}

async function fetchOne(name, entry, triple, root, lockEntry) {
  const dest = expectedDest(entry.dest ?? name, triple);
  const destPath = join(binaryDir(root), dest);
  const staging = stagingDir(root, name, triple);
  const archivePath = archiveArtifactPath(root, name, triple, entry.url);

  if (
    lockEntry &&
    entry.sha256 &&
    lockEntry.sha256 === entry.sha256 &&
    lockEntry.stagedSha256 &&
    (await exists(destPath))
  ) {
    const stagedSha = await sha256File(destPath);
    if (stagedSha === lockEntry.stagedSha256) {
      console.log(`fetch: ${dest} unchanged (lock + staged sha256 match)`);
      return null;
    }
    fail(
      `sha256 mismatch for ${dest}: lock records staged ${lockEntry.stagedSha256}, staged file is ${stagedSha} — delete the staged file, or update the lock with 'yarn binaries:refresh' once it exists (task 6)`,
    );
  }

  try {
    await mkdir(dirname(archivePath), { recursive: true });
    await download(entry.url, archivePath);
  } catch (error) {
    await removeStaging(staging);
    await rm(archivePath, { force: true }).catch(() => {});
    if (/\bHTTP 4(04|10)\b/.test(`${error.message ?? error}`)) {
      fail(
        `artifact unavailable (vendor may have pruned it): ${entry.url} — download the archive manually, update url + sha256 in scripts/binaries.manifest.json, then re-run 'yarn binaries:fetch' (version-bump automation arrives with 'yarn binaries:refresh' in task 6)`,
      );
    }
    fail(`download failed for ${name} (${triple}): ${error.message ?? error}`);
  }

  const actualSha = await sha256File(archivePath);
  if (actualSha !== entry.sha256) {
    await removeStaging(staging);
    await rm(archivePath, { force: true }).catch(() => {});
    fail(
      `sha256 mismatch for ${name} (${triple}): manifest pins ${entry.sha256}, downloaded artifact is ${actualSha} — the download may be corrupt or the pin stale; update url + sha256 in scripts/binaries.manifest.json for the current release, then re-run (version-bump automation arrives with 'yarn binaries:refresh' in task 6)`,
    );
  }
  if (lockEntry?.sha256 && lockEntry.sha256 !== actualSha) {
    await removeStaging(staging);
    await rm(archivePath, { force: true }).catch(() => {});
    fail(
      `sha256 mismatch for ${name} (${triple}): lock records ${lockEntry.sha256}, new download is ${actualSha} — the vendor artifact changed; update url + sha256 in scripts/binaries.manifest.json to the new release, then re-run (version-bump automation arrives with 'yarn binaries:refresh' in task 6)`,
    );
  }

  try {
    await rm(staging, { recursive: true, force: true });
  } catch (error) {
    fail(
      `cannot clear stale staging for ${name} (${triple}) at ${staging}: ${error.message ?? error} — remove the directory manually and re-run`,
    );
  }
  await extract(archivePath, staging);
  await rm(archivePath, { force: true });

  const memberPath = entry.member ? join(staging, entry.member) : staging;
  if (!(await exists(memberPath))) {
    const listing = await readdir(staging, { recursive: true }).catch((error) => [
      `<listing unavailable: ${error.message ?? error}>`,
    ]);
    await removeStaging(staging);
    fail(
      `archive member '${entry.member}' missing in ${name} artifact for ${triple} — extracted files: ${listing.slice(0, 20).join(", ") || "(empty)"}`,
    );
  }

  await stageLibDir(name, entry, triple, staging);

  await mkdir(dirname(destPath), { recursive: true });
  await copyFile(memberPath, destPath);
  await chmod(destPath, 0o755);

  return {
    dest,
    lockEntry: {
      source: entry.source,
      version: entry.expectVersion,
      url: entry.url,
      sha256: entry.sha256,
      stagedSha256: await sha256File(destPath),
      date: new Date().toISOString(),
    },
  };
}

export async function fetchTarget(target, root) {
  const manifest = await loadManifest(root);
  try {
    validateManifest(manifest);
  } catch (error) {
    fail(`${error.message ?? error} (scripts/binaries.manifest.json)`);
  }
  const lock = await loadLock(root);

  const targetEntries = manifest.targets[target];
  if (!targetEntries) {
    fail(`target '${target}' not found in manifest (known: ${Object.keys(manifest.targets).join(", ")})`);
  }

  const lockTarget = lock.targets[target] ?? {};
  let changed = false;

  for (const [name, entry] of Object.entries(targetEntries)) {
    if (entry.source === "brew") {
      console.log(`fetch: ${name} is a brew entry — owned by binaries:prep, skipped`);
      continue;
    }
    const result = await fetchOne(name, entry, target, root, lockTarget[name]);
    if (result) {
      lockTarget[name] = result.lockEntry;
      changed = true;
    }
  }

  lock.targets[target] = lockTarget;

  if (changed) {
    lock.generated = new Date().toISOString();
    await writeJson(lockPath(root), lock);
  }
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
    await fetchTarget(target, root);
  } catch (error) {
    console.error(`FAIL ${error.message ?? error}`);
    process.exit(1);
  }
}
