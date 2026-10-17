#!/usr/bin/env node
import { execFile } from "node:child_process";
import { join } from "node:path";
import { hostTriple, isMain, parseArgs } from "./lib.mjs";
import { syncMacosFrameworks } from "./sync-macos-frameworks.mjs";

export async function allTarget(target, root) {
  const { fetchTarget } = await import("./fetch.mjs");
  const { prepTarget } = await import("./prep.mjs");
  await fetchTarget(target, root);
  await prepTarget(target, root);
  const sync = await syncMacosFrameworks({ target, root });
  if (sync.skip) {
    console.log(`binaries:all — ${sync.reason}`);
  } else if (sync.alreadyInSync) {
    console.log(`binaries:all — tauri.conf.json already in sync with src-tauri/frameworks (${sync.frameworks.length} dylibs)`);
  } else {
    console.log(
      `binaries:all — synced tauri.conf.json to src-tauri/frameworks for ${target} (${sync.frameworks.length} dylibs, was ${sync.previousCount})`,
    );
  }
  const auditScript = join(root, "scripts", "audit-sidecars.sh");
  await new Promise((resolvePromise, reject) => {
    execFile(
      "bash",
      [auditScript],
      { encoding: "utf8", cwd: root, env: { ...process.env, AUDIT_TARGET: target } },
      (error, stdout, stderr) => {
      process.stdout.write(stdout ?? "");
      if (stderr) process.stderr.write(stderr);
      if (error) {
        reject(new Error(`audit failed (${error.message ?? error}) — fix the findings above, then re-run 'yarn binaries:all'`));
        return;
      }
      resolvePromise();
    });
  });
  console.log(`binaries:all — ${target} complete`);
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
    await allTarget(target, root);
  } catch (error) {
    console.error(`FAIL ${error.message ?? error}`);
    process.exit(1);
  }
}
