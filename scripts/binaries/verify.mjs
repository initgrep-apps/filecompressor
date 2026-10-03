#!/usr/bin/env node
import { execFile } from "node:child_process";
import { basename, join } from "node:path";
import {
  archForTriple,
  binaryDir,
  expectedDest,
  exists,
  hostTriple,
  isMain,
  isWindowsTriple,
  manifestPath,
  parseArgs,
  readJson,
  run,
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

    const version = await checkVersion(binPath, entry.expectVersion, triple, root);
    if (!version.ok) {
      problems.push(`${dest}: version check failed — ${version.detail}`);
    } else {
      console.log(`verify: ${dest} ${entry.expectVersion} (${expectedArch}) OK`);
    }
  }

  if (problems.length > 0) {
    for (const problem of problems) {
      console.error(`FAIL ${problem}`);
    }
    return false;
  }
  console.log(`verify: PASS (${checked} binaries checked for ${triple})`);
  return true;
}

if (isMain(import.meta.url)) {
  const args = parseArgs(process.argv.slice(2));
  try {
    const ok = await verifyTarget(args.target, args.root ?? process.cwd());
    process.exit(ok ? 0 : 1);
  } catch (error) {
    console.error(`FAIL ${error.message ?? error}`);
    process.exit(1);
  }
}
