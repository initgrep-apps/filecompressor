#!/usr/bin/env node
import { basename, join } from "node:path";
import { run } from "./lib.mjs";

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

async function hostTriple() {
  try {
    const { stdout } = await run("rustc", ["-Vv"]);
    const match = /host:\s*(\S+)/.exec(stdout);
    if (match) return match[1];
  } catch {}
  return null;
}

export async function allTarget(target, root) {
  const { fetchTarget } = await import("./fetch.mjs");
  const { prepTarget } = await import("./prep.mjs");
  await fetchTarget(target, root);
  await prepTarget(target, root);
  const { execFile } = await import("node:child_process");
  const auditScript = join(root, "scripts", "audit-sidecars.sh");
  await new Promise((resolvePromise, reject) => {
    execFile("bash", [auditScript], { encoding: "utf8", cwd: root }, (error, stdout, stderr) => {
      process.stdout.write(stdout ?? "");
      if (stderr) process.stderr.write(stderr);
      if (error) {
        reject(new Error(`audit failed — see output above (run 'yarn binaries:all' after fixing)`));
        return;
      }
      resolvePromise();
    });
  });
  console.log(`binaries:all — ${target} complete`);
  return true;
}

const invokedDirectly = process.argv[1] && import.meta.url.endsWith(basename(process.argv[1]));
if (invokedDirectly) {
  const args = parseArgs(process.argv.slice(2));
  const root = args.root ?? process.cwd();
  const target = args.target ?? (await hostTriple());
  if (!target) {
    console.error("FAIL no --target given and host triple undetectable — pass --target <triple>");
    process.exit(1);
  }
  try {
    await allTarget(target, root);
  } catch (error) {
    console.error(`FAIL ${error.message ?? error}`);
    process.exit(1);
  }
}
