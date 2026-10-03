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

const GS_FIXTURE_C = `
#include <stdio.h>
#include <string.h>
int main(int argc, char **argv) {
  if (argc > 1 && strcmp(argv[1], "--version") == 0) { printf("10.08.0\\n"); return 0; }
  const char *out = NULL;
  for (int i = 1; i < argc; i++) {
    if (strncmp(argv[i], "-sOutputFile=", 13) == 0) out = argv[i] + 13;
  }
  if (out == NULL) { fprintf(stderr, "no -sOutputFile=\\n"); return 2; }
#if GS_EXIT_CODE != 0
  fprintf(stderr, "gs fixture refusing to render\\n");
  return GS_EXIT_CODE;
#endif
  FILE *f = fopen(out, "wb");
  if (f == NULL) return 3;
  fputs("%PDF-1.7\\n", f);
  for (int i = 0; i < 500; i++) fputs("0 0 0 rg 10 10 10 10 re f\\n", f);
  fputs("%%EOF\\n", f);
  fclose(f);
  return 0;
}
`;

function compileGsFixture(arch, outPath, exitCode = 0) {
  const source = join(
    tmpdir(),
    `gs-fixture-${exitCode}-${arch}-${process.pid}-${Math.random().toString(36).slice(2)}.c`,
  );
  execFileSync("sh", ["-c", `cat > '${source}' <<'EOF'\n${GS_FIXTURE_C}\nEOF`]);
  execFileSync("clang", [`-DGS_EXIT_CODE=${exitCode}`, "-arch", arch, source, "-o", outPath]);
}

const GS_MANIFEST_ENTRY = {
  source: "brew",
  formula: "ghostscript",
  binary: "gs",
  dest: "gs",
  expectVersion: "10.08.0",
  resources: ["Resource", "lib", "iccprofiles", "fonts"],
};

async function makeGsRoot({ resources = true, icc = true, fonts = true } = {}) {
  await mkdir(`${tmpdir()}/audit-test-roots`, { recursive: true });
  const root = await mkdtemp(`${tmpdir()}/audit-test-roots/r`);
  cleanupRoots.push(root);
  await mkdir(`${root}/src-tauri/binaries`, { recursive: true });
  await mkdir(`${root}/scripts`, { recursive: true });
  await writeFile(
    `${root}/scripts/binaries.manifest.json`,
    JSON.stringify({
      targets: { "aarch64-apple-darwin": { gs: GS_MANIFEST_ENTRY } },
    }),
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
            date: new Date().toISOString(),
          },
        },
      },
    }),
  );
  compileGsFixture("arm64", `${root}/src-tauri/binaries/gs-aarch64-apple-darwin`);
  if (resources) {
    const base = `${root}/src-tauri/gs-resources`;
    for (const [dir, files] of [
      ["Resource/Init", ["gs_init.ps"]],
      ["lib", ["gs_init.ps"]],
      ["Resource/Font", ["Fontmap"]],
      ["iccprofiles", icc ? ["default_rgb.icc"] : []],
      ["fonts", fonts ? ["Helvetica"] : []],
    ]) {
      await mkdir(`${base}/${dir}`, { recursive: true });
      for (const file of files) {
        await writeFile(`${base}/${dir}/${file}`, "content");
      }
    }
  }
  return root;
}

async function makeStubBrew(version = "10.08.0") {
  const dir = await mkdtemp(`${tmpdir()}/audit-stub-brew-`);
  cleanupRoots.push(dir);
  await writeFile(
    `${dir}/brew`,
    `#!/bin/sh\ncase "$1" in\n  --version) echo 'Homebrew 4.6.0' ;;\n  list) printf '%s %s\\n' "$2" '${version}' ;;\n  *) exit 1 ;;\nesac\n`,
    { mode: 0o755 },
  );
  return dir;
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

  it("lets an explicit --target win over AUDIT_TARGET", async () => {
    const root = await makeRoot();
    compileFixture("arm64", `${root}/src-tauri/binaries/ffmpeg-aarch64-apple-darwin`);

    const result = await runAuditArgs(root, ["--target", "aarch64-pc-windows-msvc"], {
      AUDIT_TARGET: "aarch64-apple-darwin",
    });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("aarch64-pc-windows-msvc");
    expect(result.stderr).not.toContain("arch arm64 does not match");
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

  it("passes the clean-room gs smoke with staged resources", async () => {
    const root = await makeGsRoot();
    const stubBrew = await makeStubBrew();

    const result = await runAudit(root, "aarch64-apple-darwin", {
      PATH: `${stubBrew}:${process.env.PATH}`,
    });
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("gs clean-room smoke: PASS");
    expect(result.stdout).toContain("sidecar audit: PASS (1 binaries, 0 framework dylibs)");
  });

  it("fails the clean-room gs smoke when gs exits non-zero", async () => {
    const root = await makeGsRoot();
    compileGsFixture("arm64", `${root}/src-tauri/binaries/gs-aarch64-apple-darwin`, 1);
    const stubBrew = await makeStubBrew();

    const result = await runAudit(root, "aarch64-apple-darwin", {
      PATH: `${stubBrew}:${process.env.PATH}`,
    });
    expect(result.code).toBe(1);
    expect(result.stdout).toContain("FAIL gs clean-room smoke");
    expect(result.stdout).not.toContain("sidecar audit: PASS");
  });

  it("fails when the gs resources dir is missing entirely", async () => {
    const root = await makeGsRoot({ resources: false });
    const stubBrew = await makeStubBrew();

    const result = await runAudit(root, "aarch64-apple-darwin", {
      PATH: `${stubBrew}:${process.env.PATH}`,
    });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("gs resources dir missing");
    expect(result.stderr).toContain("yarn binaries:prep");
    expect(result.stdout).not.toContain("sidecar audit: PASS");
    expect(result.stdout).not.toContain("gs clean-room smoke: PASS");
  });

  it("fails when iccprofiles or fonts is empty", async () => {
    const noFonts = await makeGsRoot({ fonts: false });
    const fontResult = await runAudit(noFonts, "aarch64-apple-darwin", {
      PATH: `${await makeStubBrew()}:${process.env.PATH}`,
    });
    expect(fontResult.code).toBe(1);
    expect(fontResult.stderr).toMatch(/gs resources dir is empty: .*\/fonts/);

    const noIcc = await makeGsRoot({ icc: false });
    const iccResult = await runAudit(noIcc, "aarch64-apple-darwin", {
      PATH: `${await makeStubBrew()}:${process.env.PATH}`,
    });
    expect(iccResult.code).toBe(1);
    expect(iccResult.stderr).toMatch(/gs resources dir is empty: .*\/iccprofiles/);
  });

  it("fails on brew version drift", async () => {
    const root = await makeGsRoot();
    const stubBrew = await makeStubBrew("10.08.1");

    const result = await runAudit(root, "aarch64-apple-darwin", {
      PATH: `${stubBrew}:${process.env.PATH}`,
    });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("brew version drift");
    expect(result.stderr).toContain("formula ghostscript is 10.08.1");
    expect(result.stderr).toContain("the lock pins 10.08.0");
    expect(result.stdout).not.toContain("sidecar audit: PASS");
  });

  it("names the install command when the brew formula is absent", async () => {
    const root = await makeGsRoot();
    const stubBrew = await makeStubBrew();
    await writeFile(`${stubBrew}/brew`, "#!/bin/sh\nexit 1\n", { mode: 0o755 });

    const result = await runAudit(root, "aarch64-apple-darwin", {
      PATH: `${stubBrew}:${process.env.PATH}`,
    });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("brew install ghostscript");
  });
});
