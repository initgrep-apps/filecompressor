#!/usr/bin/env node
import { join } from "node:path";
import { ENGINES_DIR } from "./prep-windows.mjs";
import {
  binaryDir,
  exists,
  expectedDest,
  hostTriple,
  isMain,
  isWindowsTriple,
  manifestPath,
  parseArgs,
  readJson,
} from "./lib.mjs";

const GS_NAME = "gs";

function gsRow(triple, manifest, manifestFile) {
  const entries = manifest.targets?.[triple];
  if (!entries || typeof entries !== "object") {
    throw new Error(`no gs row for target ${triple} in manifest ${manifestFile}`);
  }
  if (Object.prototype.hasOwnProperty.call(entries, GS_NAME)) {
    return [GS_NAME, entries[GS_NAME]];
  }
  for (const [name, entry] of Object.entries(entries)) {
    if (entry && typeof entry === "object" && (entry.dest ?? name) === GS_NAME) {
      return [name, entry];
    }
  }
  throw new Error(`no gs row for target ${triple} in manifest ${manifestFile}`);
}

async function probe(path) {
  try {
    return (await exists(path)) ? "found" : "missing";
  } catch (error) {
    return `unreadable (${error.message ?? error})`;
  }
}

export async function resolveGsSmokeBinary({ target, root }) {
  const bins = binaryDir(root);
  const manifestFile = manifestPath(root);
  let triple = target;
  if (!triple) {
    triple = await hostTriple();
    if (!triple) {
      return {
        path: null,
        reason: "no --target given and the host triple is undetectable — pass --target <triple>",
        notes: [],
      };
    }
  }
  let manifest;
  try {
    manifest = readJson(manifestFile);
  } catch (error) {
    if (error?.code === "ENOENT" || error?.code === "ENOTDIR") {
      return {
        path: null,
        reason: `manifest missing: ${manifestFile}`,
        notes: [],
      };
    }
    return {
      path: null,
      reason: `manifest unreadable at ${manifestFile}: ${error.message ?? error}`,
      notes: [],
    };
  }
  const [, entry] = gsRow(triple, manifest, manifestFile);
  const destName = (entry && typeof entry === "object" ? entry.dest : undefined) ?? GS_NAME;
  const flat = join(bins, expectedDest(destName, triple));
  const enginesExe = join(bins, ENGINES_DIR, destName, `${destName}.exe`);
  const candidates =
    isWindowsTriple(triple) && entry?.static !== true ? [enginesExe, flat] : [flat];
  const notes = [];
  for (const candidate of candidates) {
    const state = await probe(candidate);
    notes.push(`gs resolution: candidate ${candidate} — ${state}`);
    if (state === "found") {
      return { path: candidate, reason: null, notes };
    }
  }
  return {
    path: null,
    reason: `no gs executable found for target ${triple} — candidates tried:\n  ${candidates.join("\n  ")}`,
    notes,
  };
}

if (isMain(import.meta.url)) {
  let status = 0;
  try {
    const args = parseArgs(process.argv.slice(2));
    const resolution = await resolveGsSmokeBinary({
      target: args.target,
      root: args.root ?? process.cwd(),
    });
    for (const note of resolution.notes) {
      process.stderr.write(`${note}\n`);
    }
    if (resolution.path == null) {
      process.stderr.write(`FAIL gs resolution: ${resolution.reason}\n`);
      status = 1;
    } else {
      process.stdout.write(`${resolution.path}\n`);
    }
  } catch (error) {
    process.stderr.write(`FAIL gs resolution: ${error.message ?? error}\n`);
    status = 1;
  }
  process.exit(status);
}
