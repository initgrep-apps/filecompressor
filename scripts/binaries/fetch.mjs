#!/usr/bin/env node
import { access, copyFile, mkdir, readdir, rm, chmod } from "node:fs/promises";
import { dirname, basename, join } from "node:path";
import {
  archForTriple,
  binaryDir,
  download,
  expectedDest,
  extract,
  lockPath,
  manifestPath,
  readJson,
  run,
  sha256File,
  stagingDir,
  writeJson,
} from "./lib.mjs";

function parseArgs(argv) {
  const args = { target: null, root: null };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--target") {
      i += 1;
      args.target = argv[i];
    } else if (argv[i] === "--root") {
      i += 1;
      args.root = argv[i];
    }
  }
  return args;
}

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function loadManifest(root) {
  const path = manifestPath(root);
  if (!(await exists(path))) {
    console.error(`FAIL manifest missing: ${path}`);
    process.exit(1);
  }
  return readJson(path);
}

async function loadLock(root) {
  const path = lockPath(root);
  if (!(await exists(path))) {
    return { generated: null, targets: {} };
  }
  return readJson(path);
}

export function validateManifest(manifest) {
  const targets = manifest?.targets;
  if (!targets || typeof targets !== "object") {
    throw new Error(`manifest schema invalid: expected {"targets": {...}} at top level`);
  }
  for (const [triple, binaries] of Object.entries(targets)) {
    archForTriple(triple);
    for (const [name, entry] of Object.entries(binaries)) {
      if (!entry || typeof entry !== "object") {
        throw new Error(`manifest schema invalid: ${triple}/${name} is not an object`);
      }
      if (typeof entry.expectVersion !== "string" || entry.expectVersion.length === 0) {
        throw new Error(`manifest schema invalid: ${triple}/${name} is missing expectVersion`);
      }
      const knownSources = ["url", "brew", "release_tag"];
      if (!knownSources.includes(entry.source)) {
        throw new Error(
          `manifest schema invalid: ${triple}/${name} has unknown source '${entry.source}' (expected one of ${knownSources.join(", ")})`,
        );
      }
      if (entry.source === "url" && typeof entry.url !== "string") {
        throw new Error(`manifest schema invalid: ${triple}/${name} source url requires a url`);
      }
      if (entry.source === "brew" && typeof entry.formula !== "string") {
        throw new Error(`manifest schema invalid: ${triple}/${name} source brew requires a formula`);
      }
    }
  }
}

function fail(message) {
  console.error(`FAIL ${message}`);
  process.exit(1);
}

async function fetchOne(name, entry, triple, root, lockEntry) {
  const dest = expectedDest(entry.dest ?? name, triple);
  const destPath = join(binaryDir(root), dest);
  const staging = stagingDir(root, name, triple);

  if (lockEntry && entry.sha256 && lockEntry.sha256 === entry.sha256 && (await exists(destPath))) {
    if (lockEntry.stagedSha256) {
      const stagedSha = await sha256File(destPath);
      if (stagedSha === lockEntry.stagedSha256) {
        console.log(`fetch: ${dest} unchanged (lock + staged sha256 match)`);
        return null;
      }
      fail(
        `sha256 mismatch for ${dest}: lock records staged ${lockEntry.stagedSha256}, staged file is ${stagedSha} — delete the staged file or update the lock via 'yarn binaries:refresh'`,
      );
    }
  }

  if (!(await exists(staging))) {
    await mkdir(staging, { recursive: true });
  }
  const archiveName = basename(new URL(entry.url).pathname) || "artifact.bin";
  const archivePath = join(staging, archiveName);

  try {
    await download(entry.url, archivePath);
  } catch (error) {
    await rm(staging, { recursive: true, force: true });
    if (/\bHTTP 4(04|10)\b/.test(`${error.message ?? error}`)) {
      fail(
        `artifact unavailable (vendor may have pruned it): ${entry.url} — run 'yarn binaries:refresh'`,
      );
    }
    fail(`download failed for ${name} (${triple}): ${error.message ?? error}`);
  }

  const actualSha = await sha256File(archivePath);
  if (entry.sha256 && actualSha !== entry.sha256) {
    await rm(staging, { recursive: true, force: true });
    fail(
      `sha256 mismatch for ${name} (${triple}): manifest pins ${entry.sha256}, downloaded artifact is ${actualSha} — the download may be corrupt or the pin stale (run 'yarn binaries:refresh')`,
    );
  }
  if (lockEntry?.sha256 && lockEntry.sha256 !== actualSha) {
    await rm(staging, { recursive: true, force: true });
    fail(
      `sha256 mismatch for ${name} (${triple}): lock records ${lockEntry.sha256}, new download is ${actualSha} — the vendor artifact changed; run 'yarn binaries:refresh'`,
    );
  }

  await extract(archivePath, staging);
  await rm(archivePath, { force: true });

  const memberPath = entry.member ? join(staging, entry.member) : staging;
  if (!(await exists(memberPath))) {
    const listing = await readdir(staging, { recursive: true });
    await rm(staging, { recursive: true, force: true });
    fail(
      `archive member '${entry.member}' missing in ${name} artifact for ${triple} — extracted files: ${listing.slice(0, 20).join(", ") || "(empty)"}`,
    );
  }

  await mkdir(dirname(destPath), { recursive: true });
  await copyFile(memberPath, destPath);
  await chmod(destPath, 0o755);

  return {
    dest,
    lockEntry: {
      source: entry.source,
      version: entry.expectVersion,
      url: entry.url,
      sha256: entry.sha256 ?? actualSha,
      stagedSha256: await sha256File(destPath),
      date: new Date().toISOString(),
    },
  };
}

export async function fetchTarget(target, root) {
  const manifest = await loadManifest(root);
  validateManifest(manifest);
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

function repoRootDefault() {
  return process.cwd();
}

async function hostTriple() {
  try {
    const { stdout } = await run("rustc", ["-Vv"]);
    const match = /host:\s*(\S+)/.exec(stdout);
    if (match) return match[1];
  } catch {}
  throw new Error(
    "no --target given and rustc unavailable to detect host triple — pass --target <triple>",
  );
}

const invokedDirectly = process.argv[1] && import.meta.url.endsWith(basename(process.argv[1]));
if (invokedDirectly) {
  const args = parseArgs(process.argv.slice(2));
  const root = args.root ?? repoRootDefault();
  const target = args.target ?? (await hostTriple());
  try {
    await fetchTarget(target, root);
  } catch (error) {
    console.error(`FAIL ${error.message ?? error}`);
    process.exit(1);
  }
}
