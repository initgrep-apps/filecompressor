import { readdir, readFile, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import { parsePeImports } from "./pe-imports.mjs";

export const WINDOWS_SYSTEM_DLLS = new Set(
  [
    "advapi32.dll",
    "api-ms-win-core-console-l1-1-0.dll",
    "bcrypt.dll",
    "comctl32.dll",
    "comdlg32.dll",
    "crypt32.dll",
    "dbghelp.dll",
    "dnsapi.dll",
    "dwrite.dll",
    "gdi32.dll",
    "gdiplus.dll",
    "imm32.dll",
    "iphlpapi.dll",
    "kernel32.dll",
    "msvcrt.dll",
    "netapi32.dll",
    "ntdll.dll",
    "ole32.dll",
    "oleaut32.dll",
    "rpcrt4.dll",
    "sechost.dll",
    "setupapi.dll",
    "shcore.dll",
    "shell32.dll",
    "shlwapi.dll",
    "usp10.dll",
    "user32.dll",
    "userenv.dll",
    "version.dll",
    "wininet.dll",
    "winmm.dll",
    "winspool.drv",
    "ws2_32.dll",
    "wsock32.dll",
    "xpsprint.dll",
    "ucrtbase.dll",
  ].map((name) => name.toLowerCase()),
);

const CRT_PREFIXES = ["api-ms-win-", "ext-ms-"];

export class ClosureCheckError extends Error {
  constructor(message) {
    super(message);
    this.name = "ClosureCheckError";
  }
}

function isSystemDll(name) {
  const lower = name.toLowerCase();
  return WINDOWS_SYSTEM_DLLS.has(lower) || CRT_PREFIXES.some((prefix) => lower.startsWith(prefix));
}

function dllFilesOf(entries) {
  return entries.filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".dll"));
}

export async function assertEngineImportsClosed(engineDir, { label = null } = {}) {
  const dirEntries = await readdir(engineDir, { withFileTypes: true });
  const engineName = label ?? basename(engineDir);
  const exeName = `${engineName}.exe`;
  if (!dirEntries.some((entry) => entry.isFile() && entry.name === exeName)) {
    throw new ClosureCheckError(
      `${engineName}: engine closure check failed — ${exeName} is missing from ${engineDir}`,
    );
  }
  const available = new Map(dllFilesOf(dirEntries).map((entry) => [entry.name.toLowerCase(), entry.name]));
  const importers = new Map();
  const queue = [exeName];
  const visited = new Set([exeName]);
  const missing = [];

  while (queue.length > 0) {
    const current = queue.shift();
    const path = join(engineDir, current);
    let parsed;
    try {
      parsed = parsePeImports(await readFile(path));
    } catch (error) {
      if (current === exeName && /not a PE image/.test(`${error.message ?? error}`)) {
        console.log(
          `note: engine import-closure check skipped for ${engineName}: ${exeName} is not a PE image (${error.message ?? error})`,
        );
        return;
      }
      const lower = current.toLowerCase();
      const who = importers.get(lower) ? ` (imported by ${importers.get(lower)})` : "";
      throw new ClosureCheckError(
        `${engineName}: staged ${current}${who} is not a parseable PE image — ${error.message ?? error}`,
      );
    }
    for (const { dll } of parsed.imports) {
      const key = dll.toLowerCase();
      if (isSystemDll(key) || visited.has(key)) {
        continue;
      }
      const file = available.get(key);
      if (file) {
        visited.add(key);
        importers.set(key, current);
        queue.push(file);
        continue;
      }
      visited.add(key);
      missing.push({ dll: dll, importer: current });
    }
  }

  if (missing.length > 0) {
    const lines = missing.map(({ dll, importer }) => `  ${dll}: imported by ${importer}`);
    throw new ClosureCheckError(
      [
        `${engineName}: the engine payload in ${engineDir} would fail to start on a clean Windows box —`,
        `${lines.length} non-system import${lines.length === 1 ? "" : "s"} have no DLL beside ${exeName}:`,
        ...lines,
      ].join("\n"),
    );
  }
}

export async function stagedEngineDirs(root, dests) {
  const enginesRoot = join(root, "src-tauri", "binaries", "engines");
  const out = [];
  for (const dest of dests) {
    const dir = join(enginesRoot, dest);
    const info = await stat(dir).catch(() => null);
    if (info?.isDirectory()) {
      out.push(dir);
    }
  }
  return out;
}
