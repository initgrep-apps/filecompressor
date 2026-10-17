#!/usr/bin/env node
import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { archForTriple, isWindowsTriple, knownTriples, isMain, parseArgs } from "./lib.mjs";

export class SyncFrameworksError extends Error {
  constructor(message) {
    super(message);
    this.name = "SyncFrameworksError";
  }
}

export function frameworksDir(root) {
  return join(root, "src-tauri", "frameworks");
}

export function confPath(root) {
  return join(root, "src-tauri", "tauri.conf.json");
}

export async function stagedFrameworkEntries(root) {
  let entries;
  try {
    entries = await readdir(frameworksDir(root));
  } catch (error) {
    if (error.code === "ENOENT" || error.code === "ENOTDIR") {
      throw new SyncFrameworksError(
        `src-tauri/frameworks is missing for the macOS bundle — it is staged by 'yarn binaries:all' (or unfreeze) before the tauri build; run the staging step and re-run this sync`,
      );
    }
    throw new SyncFrameworksError(
      `could not read src-tauri/frameworks (${error.message ?? error}) — a read error is not an empty tree, and restaging will not fix a permissions problem`,
    );
  }
  const dylibs = entries.filter((name) => name.endsWith(".dylib")).sort((a, b) => (a < b ? -1 : 1));
  if (dylibs.length === 0) {
    throw new SyncFrameworksError(
      "src-tauri/frameworks holds no .dylib — refusing to write an empty frameworks list, the tree would be staged wrong and every bundled dylib would go missing",
    );
  }
  return dylibs.map((name) => `frameworks/${name}`);
}

export async function syncMacosFrameworks({ target, root }) {
  archForTriple(target);
  if (isWindowsTriple(target)) {
    return { changed: false, skip: true, reason: "windows staging never creates src-tauri/frameworks" };
  }
  const paths = await stagedFrameworkEntries(root);
  const path = confPath(root);
  let raw;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") {
      throw new SyncFrameworksError(
        `tauri.conf.json is missing at ${path} — the sync cannot rewrite a config that does not exist; restore it from git, then re-run`,
      );
    }
    throw error;
  }
  const conf = JSON.parse(raw);
  conf.bundle ??= {};
  conf.bundle.macOS ??= {};
  const current = conf.bundle.macOS.frameworks;
  if (
    Array.isArray(current) &&
    current.length === paths.length &&
    current.every((entry, index) => entry === paths[index])
  ) {
    return { changed: false, skip: false, frameworks: paths, alreadyInSync: true };
  }
  conf.bundle.macOS.frameworks = paths;
  await writeFile(path, `${JSON.stringify(conf, null, 2)}\n`, "utf8");
  return { changed: true, skip: false, frameworks: paths, previousCount: Array.isArray(current) ? current.length : 0 };
}

export function parseCliTarget(argv) {
  const args = parseArgs(argv);
  if (!args.target) {
    throw new SyncFrameworksError(
      `FAIL --target <${knownTriples().join(" or ")}> is required — the sync is per-target because each triple stages its own frameworks tree`,
    );
  }
  archForTriple(args.target);
  return { target: args.target, root: args.root };
}

async function main() {
  const { target, root } = parseCliTarget(process.argv.slice(2));
  const resolvedRoot = root ?? process.cwd();
  try {
    const result = await syncMacosFrameworks({ target, root: resolvedRoot });
    if (result.skip) {
      console.log(`sync-macos-frameworks: skip for ${target} — ${result.reason}`);
      return;
    }
    if (result.alreadyInSync) {
      console.log(`sync-macos-frameworks: already in sync for ${target} (${result.frameworks.length} dylibs)`);
      return;
    }
    console.log(
      `sync-macos-frameworks: wrote ${result.frameworks.length} frameworks entries for ${target} (was ${result.previousCount}) to src-tauri/tauri.conf.json`,
    );
  } catch (error) {
    console.error(`FAIL ${error.message ?? error}`);
    process.exit(1);
  }
}

if (isMain(import.meta.url)) {
  await main();
}
