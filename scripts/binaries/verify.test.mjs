// @vitest-environment node
import { vi, describe, expect, it } from "vitest";

vi.setConfig({ testTimeout: 30_000 });
import { spawn } from "node:child_process";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { sha256File } from "./lib.mjs";
import { gsSentinelPaths } from "./gs-sentinels.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const VERIFY = join(HERE, "verify.mjs");
const GS_SENTINELS = gsSentinelPaths();

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

  it("fails on arch flip fixture (x86 Mach-O under arm64 name)", async () => {
    const root = await makeRoot(FFMPEG_MANIFEST);
    compileFixture("x86_64", `${root}/src-tauri/binaries/ffmpeg-aarch64-apple-darwin`, "ffmpeg version 9.0.2");
    const result = await runVerify(["--target", "aarch64-apple-darwin", "--root", root]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("arch x86_64 does not match arm64");
    expect(result.stderr).toContain("ffmpeg-aarch64-apple-darwin");
    await rm(root, { recursive: true, force: true });
  });

  it("fails when version output lacks expectVersion", async () => {
    const root = await makeRoot(FFMPEG_MANIFEST);
    compileFixture("arm64", `${root}/src-tauri/binaries/ffmpeg-aarch64-apple-darwin`, "garbage 1.2.3");
    const result = await runVerify(["--target", "aarch64-apple-darwin", "--root", root]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("version");
    expect(result.stderr).toContain("9.0.2");
    await rm(root, { recursive: true, force: true });
  });

  it("passes when arch and version match", async () => {
    const root = await makeRoot(FFMPEG_MANIFEST);
    compileFixture("arm64", `${root}/src-tauri/binaries/ffmpeg-aarch64-apple-darwin`, "ffmpeg version 9.0.2 Copyright");
    const result = await runVerify(["--target", "aarch64-apple-darwin", "--root", root]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("verify: PASS");
    await rm(root, { recursive: true, force: true });
  });

  it("fails when the staged binary no longer matches the lock's stagedSha256", async () => {
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

  it("does not gate a brew row on a machine-local staged digest", async () => {
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

  it("fails on brew version drift against the manifest pin even when the lock agrees with brew", async () => {
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

  it("compares against the ACTIVE keg, which brew lists last", async () => {
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

  it("fails loudly when the brew drift gate is inactive because brew is off PATH", async () => {
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

  it("proceeds with a stated INACTIVE gate when the allowance is set", async () => {
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

  it("fails when a staged gs acceptance sentinel is missing", async () => {
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

describe("gs Resource subdir content gate (verify side)", () => {
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
