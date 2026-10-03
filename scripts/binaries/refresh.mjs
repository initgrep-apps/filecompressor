#!/usr/bin/env node
import { isMain } from "./lib.mjs";

const invokedDirectly = isMain(import.meta.url);
if (invokedDirectly) {
  console.error(
    "FAIL binaries:refresh is not implemented yet (plan task 6) — see docs/superpowers/plans/2026-10-02-sidecar-binaries-release.md",
  );
  process.exit(1);
}
