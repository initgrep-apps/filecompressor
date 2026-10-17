#!/usr/bin/env node
import { readdir, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { WINDOWS_SYSTEM_DLLS } from "./closure-check.mjs";
import { isMain } from "./lib.mjs";
import { parsePeImports, peMachineName } from "./pe-imports.mjs";

const CRT_PREFIXES = ["api-ms-win-", "ext-ms-"];

export async function analyzePe(pePath) {
  const buffer = await readFile(pePath);
  const { machine, imports } = parsePeImports(buffer);
  const dir = dirname(resolve(pePath));
  const available = new Set(
    (await readdir(dir))
      .filter((name) => name.toLowerCase().endsWith(".dll"))
      .map((name) => name.toLowerCase()),
  );
  const missing = imports
    .filter(({ dll }) => {
      const key = dll.toLowerCase();
      return (
        !WINDOWS_SYSTEM_DLLS.has(key) &&
        !CRT_PREFIXES.some((prefix) => key.startsWith(prefix)) &&
        !available.has(key)
      );
    })
    .map(({ dll }) => ({ dll }));
  return { machine: peMachineName(machine), imports, missing };
}

function describeReport(report) {
  const lines = [
    `machine: ${report.machine}`,
    `${report.imports.length} import(s):`,
  ];
  for (const { dll, ordinalOnly } of report.imports) {
    lines.push(`  ${dll}${ordinalOnly ? " (ordinal-only)" : ""}`);
  }
  if (report.missing.length === 0) {
    lines.push("closure check: every non-system import has a DLL beside the exe");
  } else {
    lines.push(
      `${report.missing.length} non-system import(s) with no DLL beside the exe:`,
    );
    for (const { dll } of report.missing) {
      lines.push(`  ${dll}`);
    }
  }
  return lines;
}

if (isMain(import.meta.url)) {
  const pePath = process.argv[2];
  if (!pePath) {
    console.error("usage: node pe-imports-diag.mjs <pe-file>");
    process.exit(2);
  }
  try {
    for (const line of describeReport(await analyzePe(pePath))) {
      console.log(line);
    }
  } catch (error) {
    console.error(`FAIL ${error.message ?? error}`);
    process.exit(1);
  }
}
