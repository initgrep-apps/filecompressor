// @vitest-environment node
import { describe, it, expect, afterAll } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync, cpSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPTS = dirname(dirname(fileURLToPath(import.meta.url)));
const BUNDLE_PDF = join(SCRIPTS, "bundle-pdf-macos.sh");

const cleanupRoots = [];

function makeRoot() {
  const root = mkdtempSync(`${tmpdir()}/bundle-pdf-test-`);
  cleanupRoots.push(root);
  mkdirSync(join(root, "scripts"), { recursive: true });
  cpSync(BUNDLE_PDF, join(root, "scripts", "bundle-pdf-macos.sh"));
  cpSync(join(SCRIPTS, "sidecar-bundle.common.sh"), join(root, "scripts", "sidecar-bundle.common.sh"));
  return root;
}

function sh(command, cwd, extraEnv = {}) {
  const result = spawnSync("bash", ["-c", command], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, ...extraEnv },
  });
  return { code: result.status, out: result.stdout ?? "", err: result.stderr ?? "" };
}

function arm64Fixture(outPath, marker) {
  const source = join(dirname(outPath), `${marker}.c`);
  writeFileSync(
    source,
    `#include <stdio.h>\nint main(void){return 0;}\n`,
  );
  execFileSync("clang", [
    "-arch",
    "arm64",
    "-Wl,-headerpad_max_install_names",
    source,
    "-o",
    outPath,
  ]);
  rmSync(source, { force: true });
}

function dylibFixture(outPath, symbol) {
  const source = join(dirname(outPath), `${symbol}.c`);
  writeFileSync(source, `int ${symbol}(void){return 0;}\n`);
  execFileSync("clang", ["-dynamiclib", source, "-o", outPath]);
  rmSync(source, { force: true });
}

function qpdfFixture(outPath, dylibPath) {
  const dir = dirname(outPath);
  const source = join(dir, "qpdfbin.c");
  writeFileSync(
    source,
    "extern int fso_qpdf_marker(void);\nint main(void){return fso_qpdf_marker();}\n",
  );
  execFileSync("clang", [
    "-arch",
    "arm64",
    source,
    dylibPath,
    "-Wl,-rpath,@loader_path/../lib",
    "-o",
    outPath,
  ]);
  rmSync(source, { force: true });
}

afterAll(() => {
  for (const root of cleanupRoots) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("bundle-pdf-macos.sh qpdf lib staging gate", () => {
  it("refuses to bundle when the fetch staging lib dir is absent", () => {
    const root = makeRoot();
    const binDir = join(root, "src-tauri", "binaries");
    mkdirSync(binDir, { recursive: true });
    arm64Fixture(join(binDir, "qpdf-aarch64-apple-darwin"), "qpdf");
    arm64Fixture(join(binDir, "gs-aarch64-apple-darwin"), "gs");

    const result = sh(`bash scripts/bundle-pdf-macos.sh 2>&1; echo "EXIT:$?"`, root);
    expect(result.out).toMatch(/qpdf lib staging dir missing/);
    expect(result.out).toMatch(/yarn binaries:fetch --target/);
  });

  it("refuses when the staging dir exists but carries no libqpdf", () => {
    const root = makeRoot();
    const binDir = join(root, "src-tauri", "binaries");
    mkdirSync(binDir, { recursive: true });
    arm64Fixture(join(binDir, "qpdf-aarch64-apple-darwin"), "qpdf");
    arm64Fixture(join(binDir, "gs-aarch64-apple-darwin"), "gs");
    mkdirSync(join(root, "src-tauri", ".staging", "qpdf-aarch64-apple-darwin", "lib"), {
      recursive: true,
    });
    writeFileSync(
      join(root, "src-tauri", ".staging", "qpdf-aarch64-apple-darwin", "lib", "unrelated.txt"),
      "not a dylib",
    );

    const result = sh(`bash scripts/bundle-pdf-macos.sh 2>&1; echo "EXIT:$?"`, root);
    expect(result.out).toMatch(/no libqpdf\*\.dylib in/);
    expect(result.out).toMatch(/yarn binaries:fetch --target/);
  });

  it("stages gs resources from a source reached through a symlinked path", () => {
    const root = makeRoot();
    const binDir = join(root, "src-tauri", "binaries");
    mkdirSync(binDir, { recursive: true });

    const stagingLib = join(root, "src-tauri", ".staging", "qpdf-aarch64-apple-darwin", "lib");
    mkdirSync(stagingLib, { recursive: true });
    const qpdfLib = join(stagingLib, "libqpdf.30.dylib");
    dylibFixture(qpdfLib, "fso_qpdf_marker");
    qpdfFixture(join(binDir, "qpdf-aarch64-apple-darwin"), qpdfLib);
    arm64Fixture(join(binDir, "gs-aarch64-apple-darwin"), "gs");

    const realShare = join(root, "real-share");
    for (const dir of ["Resource/Init", "lib", "iccprofiles", "fonts"]) {
      mkdirSync(join(realShare, "ghostscript", "share", "ghostscript", dir), { recursive: true });
      writeFileSync(
        join(realShare, "ghostscript", "share", "ghostscript", dir, "file.txt"),
        dir,
      );
    }
    writeFileSync(
      join(realShare, "ghostscript", "share", "ghostscript", "Resource", "Init", "gs_init.ps"),
      "%!\n",
    );
    const linkParent = join(root, "linked");
    mkdirSync(linkParent, { recursive: true });
    symlinkSync(join(realShare, "ghostscript"), join(linkParent, "ghostscript"));

    const stubBin = join(root, "stub-bin");
    mkdirSync(stubBin, { recursive: true });
    writeFileSync(
      join(stubBin, "brew"),
      `#!/bin/sh\ncase "$1" in\n  --prefix) printf '%s\\n' '${join(linkParent, "ghostscript")}' ;;\n  *) exit 1 ;;\nesac\n`,
      { mode: 0o755 },
    );
    writeFileSync(join(stubBin, "rustc"), `#!/bin/sh\necho 'host: aarch64-apple-darwin'\n`, {
      mode: 0o755,
    });

    const result = sh(`bash scripts/bundle-pdf-macos.sh 2>&1; echo "EXIT:$?"`, root, {
      PATH: `${stubBin}:${process.env.PATH}`,
    });
    expect(result.out).not.toMatch(/cpio:/);
    expect(result.out).toMatch(/staged: gs resources/);
    const staged = join(root, "src-tauri", "gs-resources");
    expect(readFileSync(join(staged, "Resource", "Init", "gs_init.ps"), "utf8")).toBe("%!\n");
    for (const dir of ["lib", "iccprofiles", "fonts"]) {
      expect(readFileSync(join(staged, dir, "file.txt"), "utf8")).toBe(dir);
    }
  });
});