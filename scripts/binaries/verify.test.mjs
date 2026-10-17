// @vitest-environment node
import { vi, describe, expect, it } from "vitest";

vi.setConfig({ testTimeout: 30_000 });
import { spawn } from "node:child_process";
import { execFileSync, execFile } from "node:child_process";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { knownTriples, sha256File, validateManifest } from "./lib.mjs";
import { gsSentinelPaths } from "./gs-sentinels.mjs";
import { describeDarwin, itDarwin } from "../test-platform.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const VERIFY = join(HERE, "verify.mjs");
const GS_SENTINELS = gsSentinelPaths();

function mergePatch(target, patch) {
  if (patch === null) {
    return null;
  }
  if (typeof patch !== "object" || Array.isArray(patch)) {
    return structuredClone(patch);
  }
  if (typeof target !== "object" || target === null || Array.isArray(target)) {
    target = {};
  }
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) {
      delete target[key];
    } else {
      target[key] = mergePatch(target[key] ?? null, value);
      if (target[key] === null) {
        delete target[key];
      }
    }
  }
  return target;
}

async function stageGsResources(root, { sentinels = true } = {}) {
  const base = join(root, "src-tauri", "gs-resources");
  for (const [dir, files] of [
    ["Resource/Init", ["gs_init.ps"]],
    ["Resource/Font", ["Fontmap"]],
    ["Resource/CMap", ["Identity-H"]],
    ["Resource/Encoding", ["Differences"]],
    ["lib", ["gs_init.ps"]],
    ["iccprofiles", ["default_rgb.icc"]],
    ["fonts", ["Helvetica"]],
  ]) {
    await mkdir(join(base, dir), { recursive: true });
    for (const file of files) {
      await writeFile(join(base, dir, file), "content");
    }
  }
  if (sentinels) {
    for (const relative of GS_SENTINELS) {
      await writeFile(join(base, relative), "%!\n");
    }
  }
  return base;
}

async function makeStubBrewDir(listLine) {
  const dir = await mkdtemp(`${tmpdir()}/verify-stub-brew-`);
  await writeFile(
    join(dir, "brew"),
    `#!/bin/sh
case "$1" in
  --version) echo ok ;;
  list) printf '%s\\n' '${listLine}' ;;
  *) exit 1 ;;
esac
`,
    { mode: 0o755 },
  );
  return dir;
}

async function makeStubBrewNoKegDir() {
  const dir = await mkdtemp(`${tmpdir()}/verify-stub-brew-nokeg-`);
  await writeFile(
    join(dir, "brew"),
    `#!/bin/sh
case "$1" in
  --version) echo ok ;;
  list) echo "Error: No such keg: $3" >&2; exit 1 ;;
  *) exit 1 ;;
esac
`,
    { mode: 0o755 },
  );
  return dir;
}

const TOOL_PATH = "/usr/bin:/bin";

function compileFixture(arch, outPath, versionOutput) {
  const source = join(tmpdir(), `verify-fixture-${arch}-${process.pid}-${Math.random().toString(36).slice(2)}.c`);
  execFileSync("sh", ["-c", `cat > '${source}' <<'EOF'
#include <stdio.h>
int main(void) { printf("${versionOutput}\\n"); return 0; }
EOF`]);
  execFileSync("clang", ["-arch", arch, source, "-o", outPath]);
}

function runVerify(args, env = process.env) {
  return new Promise((resolvePromise) => {
    const child = spawn(process.execPath, [VERIFY, ...args], { env, cwd: HERE });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("close", (code) => resolvePromise({ code, stdout, stderr }));
  });
}

async function makeRoot(manifest) {
  const root = await mkdtemp(`${tmpdir()}/verify-test-`);
  await mkdir(`${root}/scripts`, { recursive: true });
  await mkdir(`${root}/src-tauri/binaries`, { recursive: true });
  if (manifest !== null) {
    await writeFile(`${root}/scripts/binaries.manifest.json`, JSON.stringify(manifest));
  }
  return root;
}

const PE_MACHINE_X86_64 = 0x8664;
const PE_MACHINE_ARM64 = 0xaa64;

function buildPe32Plus(machine) {
  const b = Buffer.alloc(0xd0, 0);
  b.write("MZ", 0, "ascii");
  b.writeUInt32LE(0x40, 0x3c);
  b.write("PE\0\0", 0x40, "ascii");
  b.writeUInt16LE(machine, 0x44);
  b.writeUInt16LE(1, 0x46);
  b.writeUInt16LE(0xf0, 0x54);
  b.writeUInt16LE(0x0022, 0x56);
  b.writeUInt16LE(0x020b, 0x58);
  b.writeUInt16LE(3, 0x9c);
  return b;
}

async function classifyPeFixture(fixturePath) {
  return new Promise((resolvePromise) => {
    execFile("file", ["-b", fixturePath], { encoding: "utf8" }, (error, stdout, stderr) => {
      if (error && error.code === "ENOENT") {
        resolvePromise({ unavailable: "file(1) is not on PATH on this host" });
        return;
      }
      resolvePromise({
        description: `${stdout ?? ""}${stderr ?? ""}`.trim(),
        classifyError: error?.message ?? null,
      });
    });
  });
}

const FFMPEG_MANIFEST = {
  targets: {
    "aarch64-apple-darwin": {
      ffmpeg: {
        source: "url",
        url: "https://x/ffmpeg.zip",
        sha256: "c8ed4c4e6978a03c485edbfe4e0a5dc2380f8a30bba5150531b31b094492d924",
        expectVersion: "9.0.2",
        dest: "ffmpeg",
      },
    },
  },
};

describe("verify.mjs", () => {
  it("reports missing binary and names run 'yarn binaries:all'", async () => {
    const root = await makeRoot(FFMPEG_MANIFEST);
    const result = await runVerify(["--target", "aarch64-apple-darwin", "--root", root]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("missing ffmpeg-aarch64-apple-darwin");
    expect(result.stderr).toContain("run 'yarn binaries:all'");
    await rm(root, { recursive: true, force: true });
  });

  itDarwin("fails on arch flip fixture (x86 Mach-O under arm64 name)", async () => {
    const root = await makeRoot(FFMPEG_MANIFEST);
    compileFixture("x86_64", `${root}/src-tauri/binaries/ffmpeg-aarch64-apple-darwin`, "ffmpeg version 9.0.2");
    const result = await runVerify(["--target", "aarch64-apple-darwin", "--root", root]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("arch x86_64 does not match arm64");
    expect(result.stderr).toContain("ffmpeg-aarch64-apple-darwin");
    await rm(root, { recursive: true, force: true });
  });

  itDarwin("fails when version output lacks expectVersion", async () => {
    const root = await makeRoot(FFMPEG_MANIFEST);
    compileFixture("arm64", `${root}/src-tauri/binaries/ffmpeg-aarch64-apple-darwin`, "garbage 1.2.3");
    const result = await runVerify(["--target", "aarch64-apple-darwin", "--root", root]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("version");
    expect(result.stderr).toContain("9.0.2");
    await rm(root, { recursive: true, force: true });
  });

  itDarwin("passes when arch and version match", async () => {
    const root = await makeRoot(FFMPEG_MANIFEST);
    compileFixture("arm64", `${root}/src-tauri/binaries/ffmpeg-aarch64-apple-darwin`, "ffmpeg version 9.0.2 Copyright");
    const result = await runVerify(["--target", "aarch64-apple-darwin", "--root", root]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("verify: PASS");
    await rm(root, { recursive: true, force: true });
  });

  itDarwin("fails when the staged binary no longer matches the lock's stagedSha256", async () => {
    const root = await makeRoot(FFMPEG_MANIFEST);
    compileFixture("arm64", `${root}/src-tauri/binaries/ffmpeg-aarch64-apple-darwin`, "ffmpeg version 9.0.2");
    await writeFile(
      `${root}/scripts/binaries.lock.json`,
      JSON.stringify({
        generated: new Date().toISOString(),
        targets: {
          "aarch64-apple-darwin": {
            ffmpeg: {
              source: "url",
              version: "9.0.2",
              url: "https://x/ffmpeg.zip",
              sha256: "c8ed4c4e6978a03c485edbfe4e0a5dc2380f8a30bba5150531b31b094492d924",
              stagedSha256: "0000000000000000000000000000000000000000000000000000000000000000",
              date: new Date().toISOString(),
            },
          },
        },
      }),
    );

    const result = await runVerify(["--target", "aarch64-apple-darwin", "--root", root]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("sha256 mismatch");
    expect(result.stderr).toContain("swapped or corrupted");
    expect(
      result.stderr,
      "the remedy must be the command that actually re-stages and re-records the digest",
    ).toContain("yarn binaries:prep");
    await rm(root, { recursive: true, force: true });
  });

  itDarwin("does not gate a brew row on a machine-local staged digest", async () => {
    const root = await makeRoot({
      targets: {
        "aarch64-apple-darwin": {
          vips: {
            source: "brew",
            formula: "vips",
            dest: "vips",
            expectVersion: "8.18.7",
          },
        },
      },
    });
    compileFixture("arm64", `${root}/src-tauri/binaries/vips-aarch64-apple-darwin`, "8.18.7");
    const stubBrew = await makeStubBrewDir("vips 8.18.7");
    await writeFile(
      `${root}/scripts/binaries.lock.json`,
      JSON.stringify({
        generated: new Date().toISOString(),
        targets: {
          "aarch64-apple-darwin": {
            vips: {
              source: "brew",
              version: "8.18.7",
              formula: "vips",
              stagedSha256: "0000000000000000000000000000000000000000000000000000000000000000",
              date: new Date().toISOString(),
            },
          },
        },
      }),
    );

    const result = await runVerify(["--target", "aarch64-apple-darwin", "--root", root], {
      ...process.env,
      PATH: `${stubBrew}:${process.env.PATH}`,
    });

    expect(
      result.stderr,
      "a brew row has no upstream digest: the bytes are a local build plus a local codesign, so \
       pinning them would fail on every other machine with no working remedy",
    ).not.toContain("sha256 mismatch");
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("verify: PASS");
    await rm(root, { recursive: true, force: true });
    await rm(stubBrew, { recursive: true, force: true });
  });

  itDarwin("fails on brew version drift against the manifest pin even when the lock agrees with brew", async () => {
    const root = await makeRoot({
      targets: {
        "aarch64-apple-darwin": {
          gs: {
            source: "brew",
            formula: "ghostscript",
            binary: "gs",
            dest: "gs",
            expectVersion: "10.08.0",
          },
        },
      },
    });
    compileFixture("arm64", `${root}/src-tauri/binaries/gs-aarch64-apple-darwin`, "10.08.1");
    await stageGsResources(root);
    const stagedSha256 = await sha256File(
      `${root}/src-tauri/binaries/gs-aarch64-apple-darwin`,
    );
    await writeFile(
      `${root}/scripts/binaries.lock.json`,
      JSON.stringify({
        generated: new Date().toISOString(),
        targets: {
          "aarch64-apple-darwin": {
            gs: {
              source: "brew",
              formula: "ghostscript",
              version: "10.08.1",
              stagedSha256,
              date: new Date().toISOString(),
            },
          },
        },
      }),
    );
    const stubDir = await makeStubBrewDir("ghostscript 10.08.1");

    const result = await runVerify(["--target", "aarch64-apple-darwin", "--root", root], {
      ...process.env,
      PATH: `${stubDir}:${process.env.PATH}`,
    });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("brew version drift");
    expect(result.stderr).toContain("ghostscript is 10.08.1");
    expect(result.stderr).toContain("binaries.manifest.json pins 10.08.0");
    await rm(root, { recursive: true, force: true });
    await rm(stubDir, { recursive: true, force: true });
  });

  itDarwin("compares against the ACTIVE keg, which brew lists last", async () => {
    const makeCase = async (pin) => {
      const root = await makeRoot({
        targets: {
          "aarch64-apple-darwin": {
            gs: {
              source: "brew",
              formula: "ghostscript",
              binary: "gs",
              dest: "gs",
              expectVersion: pin,
            },
          },
        },
      });
      compileFixture("arm64", `${root}/src-tauri/binaries/gs-aarch64-apple-darwin`, pin);
      await stageGsResources(root);
      const stagedSha256 = await sha256File(
        `${root}/src-tauri/binaries/gs-aarch64-apple-darwin`,
      );
      await writeFile(
        `${root}/scripts/binaries.lock.json`,
        JSON.stringify({
          generated: new Date().toISOString(),
          targets: {
            "aarch64-apple-darwin": {
              gs: {
                source: "brew",
                formula: "ghostscript",
                version: pin,
                stagedSha256,
                date: new Date().toISOString(),
              },
            },
          },
        }),
      );
      return root;
    };

    const activeLast = await makeCase("10.08.1");
    const activeLastStub = await makeStubBrewDir("ghostscript 10.08.0 10.08.1");
    const passing = await runVerify(["--target", "aarch64-apple-darwin", "--root", activeLast], {
      ...process.env,
      PATH: `${activeLastStub}:${process.env.PATH}`,
    });
    expect(
      passing.stderr,
      "the stale first keg must not be compared against the pin",
    ).not.toContain("brew version drift");
    expect(passing.code).toBe(0);

    const activeFirst = await makeCase("10.08.0");
    const activeFirstStub = await makeStubBrewDir("ghostscript 10.08.0 10.08.1");
    const failing = await runVerify(["--target", "aarch64-apple-darwin", "--root", activeFirst], {
      ...process.env,
      PATH: `${activeFirstStub}:${process.env.PATH}`,
    });
    expect(failing.code).toBe(1);
    expect(failing.stderr).toContain("brew version drift");
    expect(failing.stderr).toContain("ghostscript is 10.08.1");

    for (const dir of [activeLast, activeFirst, activeLastStub, activeFirstStub]) {
      await rm(dir, { recursive: true, force: true });
    }
  });

  itDarwin("fails loudly when the brew drift gate is inactive because brew is off PATH", async () => {
    const root = await makeRoot({
      targets: {
        "aarch64-apple-darwin": {
          gs: {
            source: "brew",
            formula: "ghostscript",
            binary: "gs",
            dest: "gs",
            expectVersion: "10.08.0",
          },
        },
      },
    });
    compileFixture("arm64", `${root}/src-tauri/binaries/gs-aarch64-apple-darwin`, "10.08.0");
    await stageGsResources(root);
    const emptyBin = await mkdtemp(`${tmpdir()}/verify-no-brew-`);

    const result = await runVerify(["--target", "aarch64-apple-darwin", "--root", root], {
      ...process.env,
      PATH: `${TOOL_PATH}:${emptyBin}`,
    });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("brew is not on PATH");
    expect(result.stderr).toContain("INACTIVE");
    expect(result.stderr).toContain("BINARIES_ALLOW_INACTIVE_BREW=1");
    await rm(root, { recursive: true, force: true });
    await rm(emptyBin, { recursive: true, force: true });
  });

  itDarwin("proceeds with a stated INACTIVE gate when the allowance is set", async () => {
    const root = await makeRoot({
      targets: {
        "aarch64-apple-darwin": {
          gs: {
            source: "brew",
            formula: "ghostscript",
            binary: "gs",
            dest: "gs",
            expectVersion: "10.08.0",
          },
        },
      },
    });
    compileFixture("arm64", `${root}/src-tauri/binaries/gs-aarch64-apple-darwin`, "10.08.0");
    await stageGsResources(root);
    const emptyBin = await mkdtemp(`${tmpdir()}/verify-no-brew-`);

    const result = await runVerify(["--target", "aarch64-apple-darwin", "--root", root], {
      ...process.env,
      PATH: `${TOOL_PATH}:${emptyBin}`,
      BINARIES_ALLOW_INACTIVE_BREW: "1",
    });
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("INACTIVE");
    expect(result.stdout).toContain("BINARIES_ALLOW_INACTIVE_BREW=1");
    expect(result.stdout).toContain("verify: PASS");
    await rm(root, { recursive: true, force: true });
    await rm(emptyBin, { recursive: true, force: true });
  });

  itDarwin("fails when the formula is not installed on a brew-present host without the allowance", async () => {
    const root = await makeRoot({
      targets: {
        "aarch64-apple-darwin": {
          gs: {
            source: "brew",
            formula: "ghostscript",
            binary: "gs",
            dest: "gs",
            expectVersion: "10.08.0",
          },
        },
      },
    });
    compileFixture("arm64", `${root}/src-tauri/binaries/gs-aarch64-apple-darwin`, "10.08.0");
    await stageGsResources(root);
    const stubBrew = await makeStubBrewDir("");

    const result = await runVerify(["--target", "aarch64-apple-darwin", "--root", root], {
      ...process.env,
      PATH: `${stubBrew}:${process.env.PATH}`,
    });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("the formula is not installed");
    expect(result.stderr).toContain("brew install ghostscript");
    expect(result.stdout).not.toContain("verify: PASS");
    await rm(root, { recursive: true, force: true });
    await rm(stubBrew, { recursive: true, force: true });
  });

  itDarwin("proceeds with a stated INACTIVE note when brew is present but the formula is not installed and the allowance is set", async () => {
    const root = await makeRoot({
      targets: {
        "aarch64-apple-darwin": {
          gs: {
            source: "brew",
            formula: "ghostscript",
            binary: "gs",
            dest: "gs",
            expectVersion: "10.08.0",
          },
        },
      },
    });
    compileFixture("arm64", `${root}/src-tauri/binaries/gs-aarch64-apple-darwin`, "10.08.0");
    await stageGsResources(root);
    const stubBrew = await makeStubBrewDir("");

    const result = await runVerify(["--target", "aarch64-apple-darwin", "--root", root], {
      ...process.env,
      PATH: `${stubBrew}:${process.env.PATH}`,
      BINARIES_ALLOW_INACTIVE_BREW: "1",
    });
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("INACTIVE");
    expect(result.stdout).toContain("the formula is not installed");
    expect(result.stdout).toContain("BINARIES_ALLOW_INACTIVE_BREW=1");
    expect(result.stdout).toContain("verify: PASS");
    await rm(root, { recursive: true, force: true });
    await rm(stubBrew, { recursive: true, force: true });
  });

  itDarwin("proceeds with a stated INACTIVE note when the installed brewed formula drifted and the allowance is set", async () => {
    const root = await makeRoot({
      targets: {
        "aarch64-apple-darwin": {
          gs: {
            source: "brew",
            formula: "ghostscript",
            binary: "gs",
            dest: "gs",
            expectVersion: "10.08.0",
          },
        },
      },
    });
    compileFixture("arm64", `${root}/src-tauri/binaries/gs-aarch64-apple-darwin`, "10.08.0");
    await stageGsResources(root);
    const stagedSha256 = await sha256File(
      `${root}/src-tauri/binaries/gs-aarch64-apple-darwin`,
    );
    await writeFile(
      `${root}/scripts/binaries.lock.json`,
      JSON.stringify({
        generated: new Date().toISOString(),
        targets: {
          "aarch64-apple-darwin": {
            gs: {
              source: "brew",
              formula: "ghostscript",
              version: "10.08.0",
              stagedSha256,
              date: new Date().toISOString(),
            },
          },
        },
      }),
    );
    const stubDir = await makeStubBrewDir("ghostscript 10.08.1");

    const allowed = await runVerify(["--target", "aarch64-apple-darwin", "--root", root], {
      ...process.env,
      PATH: `${stubDir}:${process.env.PATH}`,
      BINARIES_ALLOW_INACTIVE_BREW: "1",
    });
    expect(
      allowed.code,
      "on frozen-payload verification the brew lifecycle is inert: a runner keg drifting above the pin must not kill the audit when the allowance is set",
    ).toBe(0);
    expect(allowed.stderr).not.toContain("brew version drift");
    expect(
      allowed.stdout,
      "the note must state both the drifted keg version and the manifest pin",
    ).toContain("formula ghostscript is 10.08.1 but scripts/binaries.manifest.json pins 10.08.0");
    expect(allowed.stdout).toContain("INACTIVE");
    expect(allowed.stdout).toContain("BINARIES_ALLOW_INACTIVE_BREW=1");
    expect(allowed.stdout).toContain("verify: PASS");

    const denied = await runVerify(["--target", "aarch64-apple-darwin", "--root", root], {
      ...process.env,
      PATH: `${stubDir}:${process.env.PATH}`,
    });
    expect(
      denied.code,
      "without the allowance the installed-but-drifted keg stays a hard failure",
    ).toBe(1);
    expect(denied.stderr).toContain("brew version drift");
    expect(denied.stderr).toContain("ghostscript is 10.08.1");
    expect(denied.stderr).toContain("binaries.manifest.json pins 10.08.0");

    await rm(root, { recursive: true, force: true });
    await rm(stubDir, { recursive: true, force: true });
  });

  itDarwin("treats a No-such-keg brew failure as a missing formula gate", async () => {
    const root = await makeRoot({
      targets: {
        "aarch64-apple-darwin": {
          gs: {
            source: "brew",
            formula: "ghostscript",
            binary: "gs",
            dest: "gs",
            expectVersion: "10.08.0",
          },
        },
      },
    });
    compileFixture("arm64", `${root}/src-tauri/binaries/gs-aarch64-apple-darwin`, "10.08.0");
    await stageGsResources(root);
    const stubNoKeg = await makeStubBrewNoKegDir();

    const allowed = await runVerify(["--target", "aarch64-apple-darwin", "--root", root], {
      ...process.env,
      PATH: `${stubNoKeg}:${process.env.PATH}`,
      BINARIES_ALLOW_INACTIVE_BREW: "1",
    });
    expect(allowed.code).toBe(0);
    expect(allowed.stdout).toContain("INACTIVE");
    expect(allowed.stdout).toContain("No such keg");
    expect(allowed.stdout).toContain("verify: PASS");

    const rejected = await runVerify(["--target", "aarch64-apple-darwin", "--root", root], {
      ...process.env,
      PATH: `${stubNoKeg}:${process.env.PATH}`,
    });
    expect(rejected.code).toBe(1);
    expect(rejected.stderr).toContain("the formula is not installed");
    expect(rejected.stderr).toContain("brew install ghostscript");

    await rm(root, { recursive: true, force: true });
    await rm(stubNoKeg, { recursive: true, force: true });
  });

  itDarwin("fails when a staged gs acceptance sentinel is missing", async () => {
    const root = await makeRoot({
      targets: {
        "aarch64-apple-darwin": {
          gs: {
            source: "brew",
            formula: "ghostscript",
            binary: "gs",
            dest: "gs",
            expectVersion: "10.08.0",
            resources: ["Resource", "lib", "iccprofiles", "fonts"],
          },
        },
      },
    });
    compileFixture("arm64", `${root}/src-tauri/binaries/gs-aarch64-apple-darwin`, "10.08.0");
    const base = await stageGsResources(root, { sentinels: false });
    const stubDir = await makeStubBrewDir("ghostscript 10.08.0");

    const result = await runVerify(["--target", "aarch64-apple-darwin", "--root", root], {
      ...process.env,
      PATH: `${stubDir}:${process.env.PATH}`,
    });
    expect(result.code).toBe(1);
    for (const relative of GS_SENTINELS) {
      expect(result.stderr).toContain(join("gs-resources", relative));
    }
    expect(result.stderr).toContain("yarn binaries:prep");
    expect(base).toContain("gs-resources");
    await rm(root, { recursive: true, force: true });
    await rm(stubDir, { recursive: true, force: true });
  });

  it("presents usage error when target missing or unknown", async () => {
    const root = await makeRoot(FFMPEG_MANIFEST);
    const unknown = await runVerify(["--target", "bogus-triple", "--root", root]);
    expect(unknown.code).not.toBe(0);
    expect(unknown.stderr).toContain("--target");
    expect(unknown.stderr).toContain("bogus-triple");

    const strippedEnv = { ...process.env, PATH: "/usr/bin:/bin" };
    const absent = await runVerify(["--root", root], strippedEnv);
    expect(absent.code).not.toBe(0);
    expect(absent.stderr).toContain("--target");

    const noManifest = await makeRoot(null);
    const missingManifest = await runVerify(["--target", "aarch64-apple-darwin", "--root", noManifest]);
    expect(missingManifest.code).not.toBe(0);
    expect(missingManifest.stderr).toContain("manifest");
    await rm(root, { recursive: true, force: true });
    await rm(noManifest, { recursive: true, force: true });
  });
});

describeDarwin("gs Resource subdir content gate (verify side)", () => {
  const GS_MANIFEST = {
    targets: {
      "aarch64-apple-darwin": {
        gs: {
          source: "brew",
          formula: "ghostscript",
          binary: "gs",
          dest: "gs",
          expectVersion: "10.08.0",
          resources: ["Resource", "lib", "iccprofiles", "fonts"],
        },
      },
    },
  };

  it.each(["CMap", "Encoding"])("fails when Resource/%s holds no files", async (subdir) => {
    const root = await makeRoot(GS_MANIFEST);
    compileFixture("arm64", `${root}/src-tauri/binaries/gs-aarch64-apple-darwin`, "10.08.0");
    const base = await stageGsResources(root);
    await rm(join(base, "Resource", subdir), { recursive: true, force: true });
    await mkdir(join(base, "Resource", subdir), { recursive: true });
    const stubDir = await makeStubBrewDir("ghostscript 10.08.0");

    const result = await runVerify(["--target", "aarch64-apple-darwin", "--root", root], {
      ...process.env,
      PATH: `${stubDir}:${process.env.PATH}`,
    });

    expect(result.code, `Resource/${subdir} empty must not pass verify`).toBe(1);
    expect(result.stderr).toContain(`Resource/${subdir}`);
    expect(result.stderr).toContain("GS_LIBRESOURCE");
    expect(result.stderr).toContain("yarn binaries:prep");
    expect(result.stdout).not.toContain("verify: PASS");
    await rm(root, { recursive: true, force: true });
    await rm(stubDir, { recursive: true, force: true });
  });

  it("passes for a complete Resource tree, proving the subdir gate is not vacuous", async () => {
    const root = await makeRoot(GS_MANIFEST);
    compileFixture("arm64", `${root}/src-tauri/binaries/gs-aarch64-apple-darwin`, "10.08.0");
    await stageGsResources(root);
    const stubDir = await makeStubBrewDir("ghostscript 10.08.0");

    const result = await runVerify(["--target", "aarch64-apple-darwin", "--root", root], {
      ...process.env,
      PATH: `${stubDir}:${process.env.PATH}`,
    });

    expect(result.code).toBe(0);
    expect(result.stdout).toContain("verify: PASS");
    await rm(root, { recursive: true, force: true });
    await rm(stubDir, { recursive: true, force: true });
  });
});

describe("the shipped manifest", () => {
  const REPO_ROOT = join(HERE, "..", "..");
  const manifest = JSON.parse(
    readFileSync(join(REPO_ROOT, "scripts", "binaries.manifest.json"), "utf8"),
  );

  it("manifest_contains_intel_rows_with_pinned_shas", () => {
    validateManifest(manifest);
    const intel = manifest.targets["x86_64-apple-darwin"];
    expect(intel, "the Intel target must exist in the shipped manifest").toBeDefined();

    const pinned = {
      ffmpeg: "7c6b4125b191cbf773832dc51f424cf2b6bb7da43007d1e066f95909e47cacd4",
      ffprobe: "2322438ed2f6319a691291b247d09c69dcaa3a982460d1f269a7e1af335cfdfd",
      qpdf: "dd3b01f4414d198529bb0f13bba59c2f016a328bb3506695087a96fb80fc1481",
    };
    for (const [name, sha256] of Object.entries(pinned)) {
      expect(intel[name], `${name} must be declared for Intel`).toBeDefined();
      expect(intel[name].source).toBe("url");
      expect(
        intel[name].sha256,
        `${name} must carry the hash of the artifact actually downloaded, not a placeholder`,
      ).toBe(sha256);
      expect(intel[name].url).toMatch(/^https:\/\//);
    }
    expect(intel.qpdf.member, "the Intel qpdf archive has the same flat bin/ + lib layout as arm64").toBe(
      "bin/qpdf",
    );
    expect(intel.qpdf.lib).toBe("lib");
    expect(intel.vips).toMatchObject({
      source: "brew",
      formula: "vips",
      expectVersion: "8.18.6",
    });
    expect(intel.gs).toMatchObject({
      source: "brew",
      formula: "ghostscript",
      binary: "gs",
      expectVersion: "10.07.1",
    });
    expect(
      intel.vips.expectVersion,
      "Intel vips is frozen at 8.18.6 — the last sonoma-bottled version; 8.18.7 has no x86_64 bottle ever (ADR 0001)",
    ).not.toBe(manifest.targets["aarch64-apple-darwin"].vips.expectVersion);
    expect(
      intel.gs.expectVersion,
      "Intel ghostscript is frozen at 10.07.1 — the last sonoma-bottled version; 10.08.0 bottles postdate the x86_64 cutoff (ADR 0001)",
    ).not.toBe(manifest.targets["aarch64-apple-darwin"].gs.expectVersion);
    expect(
      intel.gs.resources,
      "the Intel gs row must declare the same resource tree the clean-room smoke proves",
    ).toEqual(manifest.targets["aarch64-apple-darwin"].gs.resources);
  });
});

describe("the shipped windows gs rows and platform config", () => {
  const REPO_ROOT = join(HERE, "..", "..");
  const manifest = JSON.parse(
    readFileSync(join(REPO_ROOT, "scripts", "binaries.manifest.json"), "utf8"),
  );
  const baseConf = JSON.parse(
    readFileSync(join(REPO_ROOT, "src-tauri", "tauri.conf.json"), "utf8"),
  );
  const windowsConf = JSON.parse(
    readFileSync(join(REPO_ROOT, "src-tauri", "tauri.windows.conf.json"), "utf8"),
  );

  it.each(["x86_64-pc-windows-msvc", "aarch64-pc-windows-msvc"])(
    "%s_gs_row_declares_no_resources",
    (triple) => {
      expect(
        manifest.targets[triple].gs,
        "msys2 ships no resource payload for gs (ROM model) — the row must not stage gs-resources",
      ).not.toHaveProperty("resources");
    },
  );

  it("keeps_the_mac_gs_resource_declarations_intact", () => {
    expect(
      manifest.targets["aarch64-apple-darwin"].gs.resources,
      "the arm64 gs row must declare the four staged resource dirs",
    ).toEqual(["Resource", "lib", "iccprofiles", "fonts"]);
  });

  it("merges_the_windows_conf_into_a_resources_map_without_gs_resources", () => {
    const merged = mergePatch(structuredClone(baseConf), windowsConf);
    expect(
      merged.bundle.resources,
      "tauri-build copies the resolved resources map on every cargo run — a gs-resources key today would demand a tree windows never stages",
    ).toEqual({ "binaries/engines/": "engines/" });
  });

  it("merges_the_windows_conf_into_the_two_entry_externalBin", () => {
    const merged = mergePatch(structuredClone(baseConf), windowsConf);
    expect(merged.bundle.externalBin).toEqual([
      "binaries/ffmpeg",
      "binaries/ffprobe",
    ]);
  });

  it("keeps_the_base_conf_gs_resources_mapping_for_mac", () => {
    expect(baseConf.bundle.resources).toEqual({ "gs-resources/": "gs-resources/" });
  });
});

describe("windows handcrafted PE machine-field fixtures (portable pins for contentArchWindows)", () => {

  function peManifestFor(triple) {
    return {
      targets: {
        [triple]: {
          vips: {
            source: "url",
            url: "https://fixtures.invalid/pe32-plus.zip",
            sha256: "5".repeat(64),
            dest: "vips",
            expectVersion: "1.0.0",
            static: true,
          },
        },
      },
    };
  }

  async function writePeFixture(root, triple, machine) {
    const fixturePath = join(root, "src-tauri", "binaries", `vips-${triple}.exe`);
    await writeFile(fixturePath, buildPe32Plus(machine));
    return fixturePath;
  }

  async function classifyWithFile(fixturePath) {
    return classifyPeFixture(fixturePath);
  }

  it("machine_field_0x8664_clears_the_arch_gate_for_x86_64_pc_windows_msvc_and_reaches_the_execution_gate", async (ctx) => {
    const root = await makeRoot(peManifestFor("x86_64-pc-windows-msvc"));
    const fixturePath = await writePeFixture(root, "x86_64-pc-windows-msvc", PE_MACHINE_X86_64);
    const classification = await classifyWithFile(fixturePath);
    if (classification.unavailable) {
      ctx.skip(`${classification.unavailable} — contentArchWindows classification of the PE machine field needs file(1)`);
    }
    expect(
      classification.description,
      "file -b must classify the hand-crafted MZ + PE\\0\\0 COFF bytes (machine 0x8664, optional-header magic 0x020B) as a PE32+ x86-64 image on any host",
    ).toMatch(/PE32\+ executable/);
    expect(classification.description).toMatch(/x86-64/i);

    const result = await runVerify(["--target", "x86_64-pc-windows-msvc", "--root", root]);
    expect(result.code).toBe(1);
    expect(
      result.stderr,
      "the matching machine field must clear the content-arch gate — no arch failure may reach the report",
    ).not.toMatch(/arch check failed|does not match/);
    expect(
      result.stderr,
      "with the arch gate satisfied, the run proceeds to the execution gate; the fixture bytes cannot execute on any host, which is the only portable failing gate",
    ).toContain("version check failed");
    await rm(root, { recursive: true, force: true });
  });

  it("machine_field_0xaa64_clears_the_arch_gate_for_aarch64_pc_windows_msvc_and_reaches_the_execution_gate", async (ctx) => {
    const root = await makeRoot(peManifestFor("aarch64-pc-windows-msvc"));
    const fixturePath = await writePeFixture(root, "aarch64-pc-windows-msvc", PE_MACHINE_ARM64);
    const classification = await classifyWithFile(fixturePath);
    if (classification.unavailable) {
      ctx.skip(`${classification.unavailable} — contentArchWindows classification of the PE machine field needs file(1)`);
    }
    expect(
      classification.description,
      "file -b must classify the hand-crafted MZ + PE\\0\\0 COFF bytes (machine 0xAA64, optional-header magic 0x020B) as a PE32+ Aarch64 image on any host",
    ).toMatch(/PE32\+ executable/);
    expect(classification.description).toMatch(/Aarch64|ARM64/i);

    const result = await runVerify(["--target", "aarch64-pc-windows-msvc", "--root", root]);
    expect(result.code).toBe(1);
    expect(result.stderr).not.toMatch(/arch check failed|does not match/);
    expect(result.stderr).toContain("version check failed");
    await rm(root, { recursive: true, force: true });
  });

  it("swapped_machine_field_fails_the_arch_gate_with_a_triple_arch_mismatch", async (ctx) => {
    const root = await makeRoot(peManifestFor("x86_64-pc-windows-msvc"));
    const fixturePath = await writePeFixture(root, "x86_64-pc-windows-msvc", PE_MACHINE_X86_64);
    const swapped = buildPe32Plus(PE_MACHINE_ARM64);
    await writeFile(fixturePath, swapped);
    const classification = await classifyWithFile(fixturePath);
    if (classification.unavailable) {
      ctx.skip(`${classification.unavailable} — contentArchWindows classification of the PE machine field needs file(1)`);
    }
    expect(classification.description).toMatch(/Aarch64|ARM64/i);

    const result = await runVerify(["--target", "x86_64-pc-windows-msvc", "--root", root]);
    expect(result.code).toBe(1);
    expect(
      result.stderr,
      "swapping the COFF machine field to ARM64 under an x86_64 filename triple must fail the content-arch gate",
    ).toContain("does not match x86_64");
    expect(
      result.stderr,
      "the arch gate must stop the run before the execution gate is reached",
    ).not.toContain("version check failed");
    await rm(root, { recursive: true, force: true });
  });
});

describe("windows verify must execute what the app executes", () => {
  const TRIPLE = "x86_64-pc-windows-msvc";
  const FLAT_EXE = `vips-${TRIPLE}.exe`;

  function manifestFor(entry) {
    return {
      targets: {
        [TRIPLE]: {
          vips: {
            source: "url",
            url: "https://fixtures.invalid/vips.zip",
            sha256: "5".repeat(64),
            dest: "vips",
            expectVersion: "1.0.0",
            ...entry,
          },
        },
      },
    };
  }

  async function writeFlatPe(root, ctx) {
    const flatPath = join(root, "src-tauri", "binaries", FLAT_EXE);
    await writeFile(flatPath, buildPe32Plus(PE_MACHINE_X86_64));
    const classification = await classifyPeFixture(flatPath);
    if (classification.unavailable || classification.classifyError) {
      ctx.skip(`PE classification unavailable on this host: ${classification.unavailable ?? classification.classifyError}`);
    }
    expect(classification.description).toMatch(/PE32\+ executable/);
    expect(classification.description).toMatch(/x86-64/i);
    return flatPath;
  }

  it("static rows keep executing the flat externalBin copy", async (ctx) => {
    const root = await makeRoot(manifestFor({ static: true }));
    await writeFlatPe(root, ctx);

    const result = await runVerify(["--target", TRIPLE, "--root", root]);

    expect(result.code).toBe(1);
    expect(result.stderr).toContain("version check failed");
    expect(
      result.stderr,
      "the failure must name the flat copy the app actually runs",
    ).toMatch(new RegExp(`binaries[\\\\/]${FLAT_EXE}`));
    expect(
      result.stderr,
      "a static engine ships no engines/ payload dir, so no engines/ demand may appear",
    ).not.toMatch(/engines/);
    await rm(root, { recursive: true, force: true });
  });

  it("fails loudly naming the engines exe when a non-static row has no engine payload", async (ctx) => {
    const root = await makeRoot(manifestFor({}));
    await writeFlatPe(root, ctx);

    const result = await runVerify(["--target", TRIPLE, "--root", root]);

    expect(result.code).toBe(1);
    expect(
      result.stderr,
      "the remedy is prep, which stages engines/<dest>/<dest>.exe beside its DLLs",
    ).toContain("yarn binaries:prep");
    expect(
      result.stderr,
      "the report must name the exact app-relevant executable path",
    ).toMatch(/engines[\\/]vips[\\/]vips\.exe/);
    expect(
      result.stderr,
      "the flat copy cannot run without its DLLs, so an opaque exec failure must not be reported",
    ).not.toContain("failed to execute");
    await rm(root, { recursive: true, force: true });
  });

  itDarwin("executes engines/<dest>/<dest>.exe for a non-static row, the path the app probes", async (ctx) => {
    const root = await makeRoot(manifestFor({}));
    await writeFlatPe(root, ctx);
    const enginesExe = join(root, "src-tauri", "binaries", "engines", "vips", "vips.exe");
    await mkdir(dirname(enginesExe), { recursive: true });
    compileFixture("arm64", enginesExe, "vips 1.0.0");

    const result = await runVerify(["--target", TRIPLE, "--root", root]);

    expect(result.code).toBe(0);
    expect(result.stdout).toContain("verify: PASS");
    expect(result.stdout).toContain(`${FLAT_EXE} 1.0.0`);
    expect(
      result.stderr,
      "the reachable app-relevant exe must be executed, not the DLL-less flat copy",
    ).not.toContain("failed to execute");
    await rm(root, { recursive: true, force: true });
  });
});

describe("no arm64 assumption hides in the script logic", () => {
  const scriptsDir = join(HERE, "..");
  const archSet = () => {
    const libSource = readFileSync(join(HERE, "lib.mjs"), "utf8");
    const table = libSource.slice(
      libSource.indexOf("const TRIPLE_ARCH"),
      libSource.indexOf("};", libSource.indexOf("const TRIPLE_ARCH")),
    );
    expect(table, "the triple table is the one legitimate place arch names appear").toContain(
      '"aarch64-apple-darwin": "arm64"',
    );
    return {
      table,
      triples: table
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.startsWith('"'))
        .map((line) => line.split('"')[1]),
      arches: [...new Set([...table.matchAll(/: "([a-z0-9_]+)"/g)].map((m) => m[1]))].sort(),
    };
  };

  it("verify_no_hardcoded_aarch64_in_script_logic", () => {
    const { arches } = archSet();
    const files = [
      ...readdirSync(scriptsDir)
        .filter((name) => name.endsWith(".sh"))
        .map((name) => join(scriptsDir, name)),
      ...readdirSync(HERE)
        .filter((name) => name.endsWith(".mjs") && !name.endsWith(".test.mjs"))
        .map((name) => join(HERE, name)),
    ];
    expect(files.length).toBeGreaterThan(0);

    const archPattern = /\b(aarch64|arm64|x86_64|x64)\b/;
    const parserPattern = /function (contentArch\w+|\w*[Aa]rch\w*)\([^)]*\) \{[\s\S]*?\n\}/g;

    const offences = [];
    for (const file of files) {
      const relative = file.replace(`${scriptsDir}/`, "");
      if (relative === "binaries/lib.mjs") {
        continue;
      }
      const source = readFileSync(file, "utf8");
      const parserSpans = [...source.matchAll(parserPattern)].map((m) => [m.index, m.index + m[0].length]);
      const inParser = (offset) => parserSpans.some(([start, end]) => offset >= start && offset < end);

      source.split("\n").forEach((line, index) => {
        const match = archPattern.exec(line);
        if (!match) {
          return;
        }
        const offset = source.split("\n").slice(0, index).join("\n").length + 1;
        if (inParser(offset)) {
          return;
        }
        offences.push(`${relative}:${index + 1}: ${line.trim()}`);
      });

      for (const [start, end] of parserSpans) {
        const body = source.slice(start, end);
        if (!archPattern.test(body)) {
          continue;
        }
        const missing = arches.filter((arch) => !new RegExp(`\\b${arch}\\b`).test(body));
        expect(
          missing,
          `${relative}: an arch parser that does not handle ${missing.join(", ")} is a \
               per-arch assumption in waiting — it would pass every arm64 target and fail Intel`,
        ).toEqual([]);
      }
    }

    expect(
      offences,
      `arch names outside the TRIPLE_ARCH table or an arch parser mean the pipeline would \
       keep working on the host arch while silently shipping the wrong binaries: \
       ${offences.join(" | ")}`,
    ).toEqual([]);
  });

  it("names every triple the tooling knows, so no target is half-added", () => {
    const { triples } = archSet();
    expect(triples.sort()).toEqual([...knownTriples()].sort());
  });
});
