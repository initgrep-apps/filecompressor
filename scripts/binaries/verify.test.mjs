// @vitest-environment node
import { describe, it, expect } from "vitest";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const HERE = dirname(fileURLToPath(import.meta.url));
const VERIFY = join(HERE, "verify.mjs");

function compileFixture(arch, outPath, versionOutput) {
  const source = join(`${outPath}.c`);
  execFileSync("sh", ["-c", `cat > '${source}' <<'EOF'
#include <stdio.h>
int main(void) { printf("${versionOutput}\\n"); return 0; }
EOF`]);
  execFileSync("clang", ["-arch", arch, source, "-o", outPath]);
  return source;
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
      ffmpeg: { source: "url", url: "https://x/ffmpeg.zip", expectVersion: "9.0.2", dest: "ffmpeg" },
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
