#!/usr/bin/env node
import { hostTriple, isMain, parseArgs, run } from "./lib.mjs";

export async function prepTarget(target, root) {
  console.log(`prep: macOS prep for ${target} is implemented in Task 2 (plan 2026-10-02-sidecar-binaries-release) — nothing to do yet`);
  return true;
}

if (isMain(import.meta.url)) {
  const args = parseArgs(process.argv.slice(2));
  const root = args.root ?? process.cwd();
  const target = args.target ?? (await hostTriple());
  if (!target) {
    console.error("FAIL no --target given and host triple undetectable — pass --target <triple>");
    process.exit(1);
  }
  const ok = await prepTarget(target, root);
  process.exit(ok ? 0 : 1);
}
