// @vitest-environment node
import { vi, afterAll, describe, expect, it } from "vitest";

vi.setConfig({ testTimeout: 30_000 });
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPTS = dirname(dirname(fileURLToPath(import.meta.url)));

const cleanupRoots = [];

function makeRoot() {
  const root = mkdtempSync(`${tmpdir()}/bundle-vips-test-`);
  cleanupRoots.push(root);
  mkdirSync(join(root, "scripts"), { recursive: true });
  copyFileSync(join(SCRIPTS, "bundle-vips-macos.sh"), join(root, "scripts", "bundle-vips-macos.sh"));
  copyFileSync(
    join(SCRIPTS, "sidecar-bundle.common.sh"),
    join(root, "scripts", "sidecar-bundle.common.sh"),
  );
  mkdirSync(join(root, "src-tauri", "binaries"), { recursive: true });
  mkdirSync(join(root, "stub-bin"), { recursive: true });
  writeFileSync(
    join(root, "stub-bin", "rustc"),
    `#!/bin/sh\necho 'host: aarch64-apple-darwin'\n`,
    { mode: 0o755 },
  );
  return root;
}

function dylib(outPath, symbol) {
  const source = `${outPath}.c`;
  writeFileSync(source, `int ${symbol}(void){return 0;}\n`);
  execFileSync("clang", [
    "-dynamiclib",
    "-Wl,-headerpad_max_install_names",
    source,
    "-o",
    outPath,
  ]);
  rmSync(source, { force: true });
}

function vipsFixture(outPath, dylibPath, dylibName) {
  const source = `${outPath}.c`;
  writeFileSync(
    source,
    `extern int fso_${dylibName.replace(/-/g, "_")}(void);\nint main(void){return fso_${dylibName.replace(/-/g, "_")}();}\n`,
  );
  execFileSync("clang", [
    "-arch",
    "arm64",
    "-Wl,-headerpad_max_install_names",
    source,
    dylibPath,
    "-Wl,-rpath,@loader_path",
    "-o",
    outPath,
  ]);
  rmSync(source, { force: true });
}

function runBundle(root) {
  const result = spawnSync("bash", ["scripts/bundle-vips-macos.sh"], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, PATH: `${join(root, "stub-bin")}:${process.env.PATH}` },
  });
  return { code: result.status, out: `${result.stdout ?? ""}${result.stderr ?? ""}` };
}

afterAll(() => {
  for (const root of cleanupRoots) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("bundle-vips-macos.sh transactional frameworks swap", () => {
  it("keeps a previously built frameworks/ tree when a later run cannot resolve a dep", () => {
    const root = makeRoot();
    const binDir = join(root, "src-tauri", "binaries");
    const sidecar = join(binDir, "vips-aarch64-apple-darwin");
    const libDir = join(root, "libs");
    mkdirSync(libDir, { recursive: true });
    const good = join(libDir, "libfso-good.dylib");
    dylib(good, "fso_libfso_good");
    vipsFixture(sidecar, good, "libfso-good");

    const first = runBundle(root);
    expect(first.out).not.toMatch(/FAIL/);
    const frameworks = join(root, "src-tauri", "frameworks");
    expect(readdirSync(frameworks)).toContain("libfso-good.dylib");
    const before = readdirSync(frameworks).sort();

    const missing = join(libDir, "libfso-absent.dylib");
    dylib(missing, "fso_libfso_absent");
    vipsFixture(sidecar, missing, "libfso-absent");
    rmSync(missing, { force: true });

    const second = runBundle(root);
    expect(second.code).not.toBe(0);
    expect(second.out).toMatch(/cannot resolve|No such file or directory/);
    expect(
      readdirSync(frameworks).sort(),
      "a failed re-bundle must not leave frameworks/ wiped or half-populated",
    ).toEqual(before);
    expect(readFileSync(join(frameworks, "libfso-good.dylib"))).not.toBe("");
  }, 60000);

  it("swaps the staged tree into place on success", () => {
    const root = makeRoot();
    const binDir = join(root, "src-tauri", "binaries");
    const libDir = join(root, "libs");
    mkdirSync(libDir, { recursive: true });
    const good = join(libDir, "libfso-good.dylib");
    dylib(good, "fso_libfso_good");
    vipsFixture(join(binDir, "vips-aarch64-apple-darwin"), good, "libfso-good");

    const result = runBundle(root);

    expect(result.out).not.toMatch(/FAIL/);
    expect(readdirSync(join(root, "src-tauri", "frameworks"))).toContain("libfso-good.dylib");
    expect(
      readdirSync(join(root, "src-tauri")).filter((entry) => entry.includes(".frameworks-staging")),
      "the staging dir must not survive a successful run",
    ).toEqual([]);
  }, 60000);
});
describe("staging dirs never leak", () => {
  it("removes the staging dir after a failed run and git-ignores the pattern", () => {
    const root = makeRoot();
    const binDir = join(root, "src-tauri", "binaries");
    const libDir = join(root, "libs");
    mkdirSync(libDir, { recursive: true });
    const good = join(libDir, "libfso-good.dylib");
    dylib(good, "fso_libfso_good");
    const sidecar = join(binDir, "vips-aarch64-apple-darwin");
    vipsFixture(sidecar, good, "libfso-good");
    const absent = join(libDir, "libfso-absent.dylib");
    dylib(absent, "fso_libfso_absent");
    vipsFixture(sidecar, absent, "libfso-absent");
    rmSync(absent, { force: true });

    const result = runBundle(root);

    expect(result.code).not.toBe(0);
    expect(
      readdirSync(join(root, "src-tauri")).filter((entry) => entry.startsWith(".frameworks-staging")),
      "a failed run must not leave a multi-MB staging tree behind",
    ).toEqual([]);
  }, 60000);

  it("git-ignores both staging patterns", () => {
    const repo = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
    for (const pattern of [
      "src-tauri/.frameworks-staging.12345/x.dylib",
      "src-tauri/gs-resources.staging.999/x.ps",
    ]) {
      const probe = spawnSync("git", ["check-ignore", "-q", pattern], { cwd: repo });
      expect(probe.status, `${pattern} must be git-ignored`).toBe(0);
    }
  });
});
