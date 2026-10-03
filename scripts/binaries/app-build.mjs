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

const invokedDirectly = process.argv[1] && import.meta.url.endsWith(basename(process.argv[1]));
if (invokedDirectly) {
  const args = parseArgs(process.argv.slice(2));
  const root = args.root ?? process.cwd();
  const target = args.target ?? (await hostTriple());
  if (!target) {
    console.error("FAIL no --target given and host triple undetectable — pass --target <triple>");
    process.exit(1);
  }
  const { allTarget } = await import("./all.mjs");
  try {
    await allTarget(target, root);
  } catch (error) {
    console.error(`FAIL ${error.message ?? error}`);
    process.exit(1);
  }
  await run("yarn", ["tauri", "build", "--target", target], { cwd: root });
}
