#!/usr/bin/env node
import { spawn } from "node:child_process";
import { hostTriple, isMain, parseArgs, run } from "./lib.mjs";

function failWithOutput(error) {
  console.error(`FAIL ${error.message ?? error}`);
  if (error.stdout) process.stderr.write(error.stdout);
  if (error.stderr) process.stderr.write(error.stderr);
  process.exit(1);
}

if (isMain(import.meta.url)) {
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
    failWithOutput(error);
  }
  console.log(`app:build — binaries verified for ${target}, starting tauri build (output below)`);
  const child = spawn("yarn", ["tauri", "build", "--target", target], {
    cwd: root,
    stdio: "inherit",
  });
  child.on("error", (error) => failWithOutput(error));
  child.on("close", (code) => {
    if (code === 0) {
      console.log(`app:build — ${target} complete`);
    } else {
      console.error(`FAIL tauri build exited with code ${code}`);
      process.exit(code ?? 1);
    }
  });
}
