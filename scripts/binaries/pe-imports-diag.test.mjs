// @vitest-environment node
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { buildPe } from "./fixtures/pe-fixture.mjs";
import { analyzePe } from "./pe-imports-diag.mjs";

const dirs = [];

afterAll(async () => {
  await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })));
});

async function makeDir() {
  const dir = await mkdtemp(join(tmpdir(), "pe-imports-diag-"));
  dirs.push(dir);
  return dir;
}

describe("analyzePe", () => {
  it("captures the import table and flags only unresolved non-system dlls", async () => {
    const dir = await makeDir();
    const exePath = join(dir, "test.exe");
    await writeFile(
      exePath,
      buildPe({
        importSpecs: [
          { dll: "libfoo-1.dll", functions: [{ name: "f1" }] },
          { dll: "KERNEL32.dll", functions: [{ name: "LoadLibraryExW" }] },
        ],
      }),
    );
    const report = await analyzePe(exePath);
    expect(report.machine).toBe("x86_64");
    expect(report.imports.map((entry) => entry.dll)).toEqual([
      "libfoo-1.dll",
      "KERNEL32.dll",
    ]);
    expect(report.missing).toEqual([{ dll: "libfoo-1.dll" }]);
  });

  it("does not flag a non-system dll that is staged beside the exe", async () => {
    const dir = await makeDir();
    const exePath = join(dir, "test.exe");
    await writeFile(
      exePath,
      buildPe({ importSpecs: [{ dll: "libfoo-1.dll", functions: [{ name: "f1" }] }] }),
    );
    await writeFile(join(dir, "libfoo-1.dll"), Buffer.alloc(8));
    const report = await analyzePe(exePath);
    expect(report.missing).toEqual([]);
  });

  it("does not flag CRT api-set dlls that are absent beside the exe", async () => {
    const dir = await makeDir();
    const exePath = join(dir, "test.exe");
    await writeFile(
      exePath,
      buildPe({
        importSpecs: [
          { dll: "api-ms-win-crt-heap-l1-1-0.dll", functions: [{ name: "malloc" }] },
        ],
      }),
    );
    const report = await analyzePe(exePath);
    expect(report.missing).toEqual([]);
  });
});
