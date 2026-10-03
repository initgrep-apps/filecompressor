// @vitest-environment node
import { describe, it, expect, afterAll } from "vitest";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const SCRIPTS = dirname(fileURLToPath(import.meta.url));
const AUDIT = join(SCRIPTS, "..", "audit-sidecars.sh");

const cleanupRoots = [];

function manifestEntry() {
  return {
    source: "url",
    url: "https://x/ffmpeg.zip",
    sha256: "c8ed4c4e6978a03c485edbfe4e0a5dc2380f8a30bba5150531b31b094492d924",
    expectVersion: "9.0.2",
    dest: "ffmpeg",
  };
}

async function makeRoot() {
  await mkdir(`${tmpdir()}/audit-test-roots`, { recursive: true });
  const root = await mkdtemp(`${tmpdir()}/audit-test-roots/r`);
  cleanupRoots.push(root);
  await mkdir(`${root}/src-tauri/binaries`, { recursive: true });
  await mkdir(`${root}/scripts`, { recursive: true });
  await writeFile(
    `${root}/scripts/binaries.manifest.json`,
    JSON.stringify({
      targets: {
        "aarch64-apple-darwin": { ffmpeg: manifestEntry() },
      },
    }),
  );
  return root;
}

function compileFixture(arch, outPath) {
  const source = join(tmpdir(), `audit-fixture-${arch}-${process.pid}-${Math.random().toString(36).slice(2)}.c`);
  execFileSync("sh", ["-c", `cat > '${source}' <<'EOF'
#include <stdio.h>
int main(void) { printf("ffmpeg version 9.0.2\\n"); return 0; }
EOF`]);
  execFileSync("clang", ["-arch", arch, source, "-o", outPath]);
}

function runAudit(root, target, extraEnv = {}) {
  return runAuditArgs(root, [], { ROOT: root, AUDIT_TARGET: target ?? "", ...extraEnv });
}

function runAuditArgs(root, args, extraEnv = {}) {
  return new Promise((resolvePromise) => {
    const env = { ...process.env, ROOT: root, AUDIT_TARGET: "", ...extraEnv };
    for (const [key, value] of Object.entries(env)) {
      if (value === undefined || value === null) delete env[key];
    }
    const child = spawn("bash", [AUDIT, ...args], {
      env,
      cwd: SCRIPTS,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("close", (code) => resolvePromise({ code, stdout, stderr }));
  });
}

afterAll(async () => {
  await Promise.all(cleanupRoots.map((root) => rm(root, { recursive: true, force: true })));
});

describe("audit-sidecars.sh", () => {
  it("fails on an x86 Mach-O under an arm64 name via the verify delegate", async () => {
    const root = await makeRoot();
    compileFixture("x86_64", `${root}/src-tauri/binaries/ffmpeg-aarch64-apple-darwin`);

    const result = await runAudit(root, "aarch64-apple-darwin");
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("arch x86_64 does not match arm64");
    expect(result.stderr).toContain("ffmpeg-aarch64-apple-darwin");
    expect(result.stdout).not.toContain("sidecar audit: PASS");
  });

  it("passes for a correct arm64 fixture and keeps the summary line", async () => {
    const root = await makeRoot();
    compileFixture("arm64", `${root}/src-tauri/binaries/ffmpeg-aarch64-apple-darwin`);

    const result = await runAudit(root, "aarch64-apple-darwin");
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("sidecar audit: PASS (1 binaries, 0 framework dylibs)");
  });

  it("fails with an actionable message when the binaries dir is missing", async () => {
    const root = await makeRoot();
    await rm(`${root}/src-tauri/binaries`, { recursive: true, force: true });

    const result = await runAudit(root, "aarch64-apple-darwin");
    expect(result.code).toBe(1);
    expect(result.stdout + result.stderr).toContain("run 'yarn binaries:all'");
  });

  it("prints a FAIL line when the host triple cannot be parsed, never dying silently", async () => {
    const root = await makeRoot();
    compileFixture("arm64", `${root}/src-tauri/binaries/ffmpeg-aarch64-apple-darwin`);
    const stubDir = await mkdtemp(`${tmpdir()}/audit-stub-rustc-`);
    cleanupRoots.push(stubDir);
    await writeFile(`${stubDir}/rustc`, "#!/bin/sh\necho 'rustc 1.90.0 (no host line)'\n", { mode: 0o755 });

    const result = await runAudit(root, undefined, {
      PATH: `${stubDir}:${process.env.PATH}`,
      AUDIT_TARGET: "",
    });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("could not parse host triple");
    expect(result.stdout + result.stderr).not.toBe("");
  });

  it("honours an explicit --target instead of auditing the host", async () => {
    const root = await makeRoot();
    await writeFile(
      `${root}/scripts/binaries.manifest.json`,
      JSON.stringify({
        targets: {
          "aarch64-apple-darwin": { ffmpeg: manifestEntry() },
          "x86_64-apple-darwin": { ffmpeg: manifestEntry() },
        },
      }),
    );
    compileFixture("arm64", `${root}/src-tauri/binaries/ffmpeg-x86_64-apple-darwin`);

    const result = await runAuditArgs(root, ["--target", "x86_64-apple-darwin"]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("arch arm64 does not match x86_64");
    expect(result.stderr).toContain("ffmpeg-x86_64-apple-darwin");
    expect(result.stdout).not.toContain("sidecar audit: PASS");
  });

  it("rejects an unknown argument rather than silently ignoring it", async () => {
    const root = await makeRoot();
    compileFixture("arm64", `${root}/src-tauri/binaries/ffmpeg-aarch64-apple-darwin`);

    const unknown = await runAuditArgs(root, ["--targt", "x86_64-apple-darwin"]);
    expect(unknown.code).toBe(1);
    expect(unknown.stderr).toContain("unknown argument: --targt");

    const noValue = await runAuditArgs(root, ["--target"]);
    expect(noValue.code).toBe(1);
    expect(noValue.stderr).toContain("--target requires a value");
  });

  it("does not need rustc when --target is supplied", async () => {
    const root = await makeRoot();
    compileFixture("arm64", `${root}/src-tauri/binaries/ffmpeg-aarch64-apple-darwin`);
    const stubDir = await mkdtemp(`${tmpdir()}/audit-stub-rustc-`);
    cleanupRoots.push(stubDir);
    await writeFile(`${stubDir}/rustc`, "#!/bin/sh\necho 'rustc 1.90.0 (no host line)'\n", { mode: 0o755 });

    const result = await runAuditArgs(root, ["--target", "aarch64-apple-darwin"], {
      PATH: `${stubDir}:${process.env.PATH}`,
    });
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("sidecar audit: PASS");
  });
});
