// @vitest-environment node
import { afterAll, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildPe } from "./fixtures/pe-fixture.mjs";

const roots = [];
afterAll(async () => {
  for (const root of roots) {
    await rm(root, { recursive: true, force: true }).catch(() => {});
  }
});

async function tempRoot(label) {
  const root = await mkdtemp(join(tmpdir(), `closure-${label}-`));
  roots.push(root);
  return root;
}

async function stageEngine(root, files) {
  const engine = join(root, "src-tauri", "binaries", "engines", "gs");
  await mkdir(engine, { recursive: true });
  for (const [name, spec] of Object.entries(files)) {
    await writeFile(join(engine, name), buildPe({ importSpecs: spec }));
  }
  return engine;
}

const KERNEL = { dll: "KERNEL32.dll", functions: [{ name: "LoadLibraryExW" }] };
const CRT = { dll: "api-ms-win-crt-runtime-l1-1-0.dll", functions: [{ name: "rand" }] };

describe("assertEngineImportsClosed", () => {
  it("closes a gs-like engine where every mingw dll is staged", async () => {
    const { assertEngineImportsClosed } = await import("./closure-check.mjs");
    const root = await tempRoot("ok");
    const engine = await stageEngine(root, {
      "gs.exe": [
        { dll: "libgs-10.dll", functions: [{ name: "gsapi_new_instance" }] },
        KERNEL,
        CRT,
        { dll: "WINSPOOL.DRV", functions: [{ name: "OpenPrinterW" }] },
      ],
      "libgs-10.dll": [
        { dll: "libpng16-16.dll", functions: [{ name: "png_sig_cmp" }] },
        { dll: "zlib1.dll", functions: [{ name: "inflate" }] },
        { dll: "ADVAPI32.dll", functions: [{ name: "RegOpenKeyW" }] },
        { dll: "api-ms-win-crt-stdio-l1-1-0.dll", functions: [{ name: "fopen" }] },
      ],
      "libpng16-16.dll": [{ dll: "zlib1.dll", functions: [{ name: "inflate" }] }],
      "zlib1.dll": [CRT],
      "libharfbuzz-0.dll": [
        { dll: "dwrite.dll", functions: [{ name: "DWriteCreateFactory" }] },
        { dll: "rpcrt4.dll", functions: [{ name: "RpcAsyncAbortCall" }] },
      ],
    });
    await expect(assertEngineImportsClosed(engine)).resolves.toBeUndefined();
  });

  it("fails naming the missing mingw dll and who reached for it", async () => {
    const { assertEngineImportsClosed } = await import("./closure-check.mjs");
    const root = await tempRoot("missing");
    const engine = await stageEngine(root, {
      "gs.exe": [{ dll: "libgs-10.dll", functions: [{ name: "gsapi_new_instance" }] }, KERNEL],
      "libgs-10.dll": [{ dll: "libpng16-16.dll", functions: [{ name: "png_sig_cmp" }] }],
    });
    await expect(assertEngineImportsClosed(engine)).rejects.toThrow(/libpng16-16\.dll/);
    await expect(assertEngineImportsClosed(engine)).rejects.toThrow(/libgs-10\.dll/);
  });

  it("matches dll names case-insensitively", async () => {
    const { assertEngineImportsClosed } = await import("./closure-check.mjs");
    const root = await tempRoot("case");
    const engine = await stageEngine(root, {
      "gs.exe": [{ dll: "LIBPNG16-16.dll", functions: [{ name: "png_sig_cmp" }] }, KERNEL],
      "libpng16-16.dll": [KERNEL],
    });
    await expect(assertEngineImportsClosed(engine)).resolves.toBeUndefined();
  });

  it("rejects a non-PE payload in the engine dir", async () => {
    const { assertEngineImportsClosed, ClosureCheckError } = await import("./closure-check.mjs");
    const root = await tempRoot("junk");
    const engine = await stageEngine(root, {
      "gs.exe": [{ dll: "zlib1.dll", functions: [{ name: "inflate" }] }, KERNEL],
      "zlib1.dll": [],
    });
    await writeFile(join(engine, "zlib1.dll"), "not a pe");
    await expect(assertEngineImportsClosed(engine)).rejects.toBeInstanceOf(ClosureCheckError);
    await expect(assertEngineImportsClosed(engine)).rejects.toThrow(/zlib1\.dll/);
  });

  it("requires the engine exe and only reads real files", async () => {
    const { assertEngineImportsClosed } = await import("./closure-check.mjs");
    const root = await tempRoot("bare");
    const engine = join(root, "src-tauri", "binaries", "engines", "gs");
    await mkdir(engine, { recursive: true });
    await expect(assertEngineImportsClosed(engine)).rejects.toThrow(/gs\.exe/);
  });
});
