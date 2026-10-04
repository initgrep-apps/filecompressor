// @vitest-environment node
import { vi, afterAll, describe, expect, it } from "vitest";

vi.setConfig({ testTimeout: 30_000 });
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { chmodSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { sha256File } from "./lib.mjs";
import { gsSentinelPairs, gsSentinelPaths } from "./gs-sentinels.mjs";
const GS_SENTINEL_NAMES = Object.fromEntries(
  gsSentinelPairs().map(([dir, name]) => [dir.split("/").pop(), name]),
);

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
static const char *const kSentinelDirs[] = {
  "Resource/Init",
  "Resource/Font",
  "lib",
  "fonts",
};
static const char *const kSentinelNames[] = {
  "fso-sidecar-acceptance-sentinel.ps",
  "fso-sidecar-acceptance-resource-font-sentinel.ps",
  "fso-sidecar-acceptance-lib-sentinel.ps",
  "fso-sidecar-acceptance-fonts-sentinel.ps",
};
static const size_t kSentinelCount = sizeof(kSentinelDirs) / sizeof(kSentinelDirs[0]);

static int ends_with(const char *text, const char *suffix) {
  size_t tl = strlen(text);
  size_t sl = strlen(suffix);
  if (sl > tl) return 0;
  return strcmp(text + tl - sl, suffix) == 0;
}

int main(int argc, char **argv) {
  if (argc > 1 && strcmp(argv[1], "--version") == 0) { printf("10.08.0\\n"); return 0; }
  const char *out = NULL;
  const char *fixture = NULL;
  for (int i = 1; i < argc; i++) {
    if (strncmp(argv[i], "-sOutputFile=", 13) == 0) out = argv[i] + 13;
    if (strstr(argv[i], ".ps") != NULL) fixture = argv[i];
  }
  if (out == NULL) { fprintf(stderr, "no -sOutputFile=\\n"); return 2; }
  if (fixture == NULL) { fprintf(stderr, "no postscript fixture argument\\n"); return 3; }
  {
    FILE *src = fopen(fixture, "rb");
    if (src == NULL) { fprintf(stderr, "cannot read fixture %s\\n", fixture); return 4; }
    char line[1024];
    int saw[16];
    memset(saw, 0, sizeof(saw));
    while (fgets(line, sizeof(line), src) != NULL) {
      if (strstr(line, "runlibfile") == NULL) continue;
      for (size_t s = 0; s < kSentinelCount; s++) {
        if (strstr(line, kSentinelNames[s]) != NULL) saw[s] = 1;
      }
    }
    fclose(src);
    for (size_t s = 0; s < kSentinelCount; s++) {
      if (!saw[s]) {
        fprintf(stderr, "fixture does not runlibfile %s\\n", kSentinelNames[s]);
        return 5;
      }
    }
  }
  for (size_t s = 0; s < kSentinelCount; s++) {
    int resolved = 0;
    for (int i = 1; i < argc; i++) {
      if (strncmp(argv[i], "-I", 2) != 0) continue;
      const char *dir = argv[i] + 2;
      if (!ends_with(dir, kSentinelDirs[s])) continue;
      char path[4096];
      snprintf(path, sizeof(path), "%s/%s", dir, kSentinelNames[s]);
      FILE *f = fopen(path, "rb");
      if (f != NULL) { fclose(f); resolved = 1; break; }
    }
    if (!resolved) {
      fprintf(stderr, "no -I dir for %s carries %s: gs would resolve it elsewhere\\n",
              kSentinelDirs[s], kSentinelNames[s]);
      return 6;
    }
  }
#if GS_EXIT_CODE != 0
  fprintf(stderr, "gs fixture refusing to render\\n");
  return GS_EXIT_CODE;
#endif
  FILE *f = fopen(out, "wb");
  if (f == NULL) return 7;
  fputs("%PDF-1.7\\n", f);
  fputs("1 0 0 RG 3 w 20 20 100 100 re S\\n", f);
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

const SENTINEL = "fso-sidecar-acceptance-sentinel.ps";
const FONT_SENTINEL = "fso-sidecar-acceptance-fonts-sentinel.ps";
const RESOURCE_FONT_SENTINEL = "fso-sidecar-acceptance-resource-font-sentinel.ps";
const LIB_SENTINEL = "fso-sidecar-acceptance-lib-sentinel.ps";

const GS_MANIFEST_ENTRY = {
  source: "brew",
  formula: "ghostscript",
  binary: "gs",
  dest: "gs",
  expectVersion: "10.08.0",
  resources: ["Resource", "lib", "iccprofiles", "fonts"],
};

async function makeGsRoot({
  resources = true,
  icc = true,
  fonts = true,
  sentinel = true,
  fontSentinel = true,
  resourceFontSentinel = true,
  libSentinel = true,
  manifestEntry = GS_MANIFEST_ENTRY,
  stageGs = true,
} = {}) {
  await mkdir(`${tmpdir()}/audit-test-roots`, { recursive: true });
  const root = await mkdtemp(`${tmpdir()}/audit-test-roots/r`);
  cleanupRoots.push(root);
  await mkdir(`${root}/src-tauri/binaries`, { recursive: true });
  await mkdir(`${root}/scripts`, { recursive: true });
  await writeFile(
    `${root}/scripts/binaries.manifest.json`,
    JSON.stringify({
      targets: { "aarch64-apple-darwin": { gs: manifestEntry } },
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
  if (stageGs) {
    compileGsFixture("arm64", `${root}/src-tauri/binaries/gs-aarch64-apple-darwin`);
  }
  if (resources) {
    const base = `${root}/src-tauri/gs-resources`;
    for (const [dir, files] of [
      ["Resource/Init", ["gs_init.ps"]],
      ["Resource/Font", ["Fontmap"]],
      ["Resource/CMap", ["Identity-H"]],
      ["Resource/Encoding", ["Differences"]],
      ["lib", ["gs_init.ps"]],
      ["iccprofiles", icc ? ["default_rgb.icc"] : []],
      ["fonts", fonts ? ["Helvetica"] : []],
    ]) {
      await mkdir(`${base}/${dir}`, { recursive: true });
      for (const file of files) {
        await writeFile(`${base}/${dir}/${file}`, "content");
      }
    }
    if (sentinel) {
      await writeFile(`${base}/Resource/Init/${SENTINEL}`, "%!\n");
    }
    if (fontSentinel && fonts) {
      await writeFile(`${base}/fonts/${FONT_SENTINEL}`, "%!\n");
    }
    if (resourceFontSentinel) {
      await writeFile(`${base}/Resource/Font/${RESOURCE_FONT_SENTINEL}`, "%!\n");
    }
    if (libSentinel) {
      await writeFile(`${base}/lib/${LIB_SENTINEL}`, "%!\n");
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

async function makeStubMktemp() {
  const dir = await mkdtemp(`${tmpdir()}/audit-stub-mktemp-`);
  cleanupRoots.push(dir);
  await writeFile(`${dir}/mktemp`, "#!/bin/sh\nexit 1\n", { mode: 0o755 });
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
    const root = await makeGsRoot();
    const stubDir = await mkdtemp(`${tmpdir()}/audit-stub-rustc-`);
    cleanupRoots.push(stubDir);
    await writeFile(`${stubDir}/rustc`, "#!/bin/sh\necho 'rustc 1.90.0 (no host line)'\n", { mode: 0o755 });
    const stubBrew = await makeStubBrew();

    const result = await runAuditArgs(root, ["--target", "aarch64-apple-darwin"], {
      PATH: `${stubDir}:${stubBrew}:${process.env.PATH}`,
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
    expect(result.stdout + result.stderr).toContain("FAIL gs clean-room smoke");
    expect(result.stdout).not.toContain("sidecar audit: PASS");
  });

  it("fails the smoke when the staged sentinel is missing, so a brew-prefix fallback cannot pass", async () => {
    const root = await makeGsRoot({ sentinel: false });
    const stubBrew = await makeStubBrew();

    const result = await runAudit(root, "aarch64-apple-darwin", {
      PATH: `${stubBrew}:${process.env.PATH}`,
    });
    expect(result.code).toBe(1);
    expect(result.stdout + result.stderr).toContain("FAIL gs clean-room smoke");
    expect(result.stdout + result.stderr).toContain(SENTINEL);
    expect(result.stdout).not.toContain("sentinel resolved");
  });

  it("fails the smoke when a staged resource dir keeps only its sentinel", async () => {
    const root = await makeGsRoot();
    const fontDir = `${root}/src-tauri/gs-resources/Resource/Font`;
    for (const entry of readdirSync(fontDir)) {
      if (entry.startsWith("fso-sidecar-acceptance-")) {
        continue;
      }
      rmSync(`${fontDir}/${entry}`, { recursive: true, force: true });
    }
    expect(readdirSync(fontDir), "only the sentinel must remain").toEqual([
      RESOURCE_FONT_SENTINEL,
    ]);
    const stubBrew = await makeStubBrew();

    const result = await runAudit(root, "aarch64-apple-darwin", {
      PATH: `${stubBrew}:${process.env.PATH}`,
    });
    expect(result.code).toBe(1);
    expect(result.stdout + result.stderr).toMatch(
      /no files anywhere under .*Resource\/Font/,
    );
    expect(result.stdout).not.toContain("sentinel resolved");
  });

  it("fails when a required staged resource dir is absent entirely", async () => {
    const root = await makeGsRoot();
    rmSync(`${root}/src-tauri/gs-resources/iccprofiles`, { recursive: true, force: true });
    const stubBrew = await makeStubBrew();

    const result = await runAudit(root, "aarch64-apple-darwin", {
      PATH: `${stubBrew}:${process.env.PATH}`,
    });
    expect(result.code).toBe(1);
    expect(result.stdout + result.stderr).toMatch(
      /gs resources dir missing: .*iccprofiles/,
    );
    expect(result.stdout).not.toContain("sentinel resolved");
  });

  it("audit_fails_when_gs_resources_missing_entirely", async () => {
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

  it("audit_fails_when_iccprofiles_or_fonts_dir_has_no_files_at_all", async () => {
    const noFonts = await makeGsRoot({ fonts: false });
    const fontResult = await runAudit(noFonts, "aarch64-apple-darwin", {
      PATH: `${await makeStubBrew()}:${process.env.PATH}`,
    });
    expect(fontResult.code).toBe(1);
    expect(fontResult.stderr).toMatch(/has no files anywhere under it: .*\/fonts/);

    const noIcc = await makeGsRoot({ icc: false });
    const iccResult = await runAudit(noIcc, "aarch64-apple-darwin", {
      PATH: `${await makeStubBrew()}:${process.env.PATH}`,
    });
    expect(iccResult.code).toBe(1);
    expect(iccResult.stderr).toMatch(/has no files anywhere under it: .*\/iccprofiles/);
  });

  it.each(gsSentinelPairs())(
    "fails when %s is gutted down to junk with no sentinel",
    async (dir, sentinelName) => {
    const root = await makeGsRoot();
    const fontDir = `${root}/src-tauri/gs-resources/${dir}`;
    rmSync(`${fontDir}/${sentinelName}`, { force: true });
    for (const entry of readdirSync(fontDir)) {
      rmSync(`${fontDir}/${entry}`, { recursive: true, force: true });
    }
    mkdirSync(fontDir, { recursive: true });
    for (const junk of ["only.txt", "also-only.txt"]) {
      writeFileSync(`${fontDir}/${junk}`, "junk");
    }
    const stubBrew = await makeStubBrew();

    const result = await runAudit(root, "aarch64-apple-darwin", {
      PATH: `${stubBrew}:${process.env.PATH}`,
    });
    expect(result.code, `${dir} gutted to junk must not pass`).toBe(1);
    expect(result.stdout + result.stderr).toMatch(
      new RegExp(`acceptance sentinel missing: .*${dir.replace("/", "\\/")}`),
    );
    expect(result.stdout).not.toContain("sentinel resolved");
    expect(result.stdout).not.toContain("sidecar audit: PASS");
  }, 30000);

  it("names the real remedy when the Resource/Init sentinel is missing", async () => {
    const root = await makeGsRoot({ sentinel: false });
    const stubBrew = await makeStubBrew();

    const result = await runAudit(root, "aarch64-apple-darwin", {
      PATH: `${stubBrew}:${process.env.PATH}`,
    });
    const output = result.stdout + result.stderr;
    expect(result.code).toBe(1);
    expect(output).toContain(`acceptance sentinel missing: `);
    expect(output).toContain("yarn binaries:prep");
    expect(output).toMatch(/staged before the sentinel existed/);
    expect(output).not.toMatch(/compiled-in Homebrew prefix/);
    expect(result.stdout).not.toContain("sentinel resolved");
  });

  it("passes for a complete staged tree with every search-path sentinel", async () => {
    const root = await makeGsRoot();
    const stubBrew = await makeStubBrew();

    const result = await runAudit(root, "aarch64-apple-darwin", {
      PATH: `${stubBrew}:${process.env.PATH}`,
    });
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("sentinel resolved");
    expect(result.stdout).toContain("sidecar audit: PASS (1 binaries, 0 framework dylibs)");
  });

  it("says the smoke was SKIPPED instead of silently dropping it", async () => {
    const root = await makeGsRoot({ stageGs: false });
    const stubBrew = await makeStubBrew();

    const result = await runAudit(root, "aarch64-apple-darwin", {
      PATH: `${stubBrew}:${process.env.PATH}`,
    });
    expect(result.code).toBe(1);
    expect(result.stdout + result.stderr).toMatch(
      /gs clean-room smoke SKIPPED — .*gs-aarch64-apple-darwin not staged/,
    );
  });

  it("fails when an explicit --target has no staged gs, instead of skipping the smoke", async () => {
    const root = await makeGsRoot({ stageGs: false });
    const stubBrew = await makeStubBrew();

    const result = await runAuditArgs(
      root,
      ["--target", "aarch64-apple-darwin"],
      { PATH: `${stubBrew}:${process.env.PATH}` },
    );
    expect(result.code).toBe(1);
    expect(result.stdout + result.stderr).toContain(
      "gs clean-room smoke: gs sidecar not staged for the explicitly requested target",
    );
    expect(result.stdout).not.toContain("sidecar audit: PASS");
  });

  it("derives the smoke's dirs from the manifest, so a renamed dir cannot pass", async () => {
    const root = await makeGsRoot({
      manifestEntry: {
        ...GS_MANIFEST_ENTRY,
        resources: ["Resource", "lib", "iccprofiles", "fonts", "extra-stuff"],
      },
    });
    const stubBrew = await makeStubBrew();

    const result = await runAudit(root, "aarch64-apple-darwin", {
      PATH: `${stubBrew}:${process.env.PATH}`,
    });
    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(/extra-stuff/);
    expect(result.stdout).not.toContain("sidecar audit: PASS");
  });

  it("does not demand a dir the manifest no longer declares", async () => {
    const root = await makeGsRoot({
      icc: false,
      manifestEntry: { ...GS_MANIFEST_ENTRY, resources: ["Resource", "lib", "fonts"] },
    });
    rmSync(`${root}/src-tauri/gs-resources/iccprofiles`, { recursive: true, force: true });
    const stubBrew = await makeStubBrew();

    const result = await runAudit(root, "aarch64-apple-darwin", {
      PATH: `${stubBrew}:${process.env.PATH}`,
    });
    expect(result.stdout + result.stderr).not.toMatch(/iccprofiles/);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("gs clean-room smoke: PASS");
  });

  it("fails when the manifest declares no resources at all", async () => {
    const { resources: _ignored, ...withoutResources } = GS_MANIFEST_ENTRY;
    const root = await makeGsRoot({ manifestEntry: withoutResources });
    const stubBrew = await makeStubBrew();

    const result = await runAudit(root, "aarch64-apple-darwin", {
      PATH: `${stubBrew}:${process.env.PATH}`,
    });
    expect(result.code).toBe(1);
    expect(result.stdout + result.stderr).toMatch(
      /no manifest entry for aarch64-apple-darwin declares a "resources" array/,
    );
  });

  it("fails when a resource dir holds only empty subdirectories", async () => {
    const root = await makeGsRoot();
    const fontDir = `${root}/src-tauri/gs-resources/Resource/Font`;
    for (const entry of readdirSync(fontDir)) {
      if (entry.startsWith("fso-sidecar-acceptance-")) {
        continue;
      }
      rmSync(`${fontDir}/${entry}`, { recursive: true, force: true });
    }
    mkdirSync(`${fontDir}/Init`, { recursive: true });
    const stubBrew = await makeStubBrew();

    const result = await runAudit(root, "aarch64-apple-darwin", {
      PATH: `${stubBrew}:${process.env.PATH}`,
    });
    expect(result.code).toBe(1);
    const output = result.stdout + result.stderr;
    expect(output).toMatch(
      /no files anywhere under .*Resource\/Font/,
      "an empty Resource/Font is a search dir gs loads, so the smoke must reject it",
    );
    expect(result.stdout).not.toContain("sentinel resolved");
  });

  it("audit_fails_on_brew_version_drift", async () => {
    const root = await makeGsRoot();
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
    const stubBrew = await makeStubBrew("10.08.1");

    const result = await runAudit(root, "aarch64-apple-darwin", {
      PATH: `${stubBrew}:${process.env.PATH}`,
    });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("brew version drift");
    expect(result.stderr).toContain("formula ghostscript is 10.08.1");
    expect(result.stderr).toContain("binaries.manifest.json pins 10.08.0");
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

describe("gs sentinel coverage is shared, not duplicated", () => {
  it("the audit demands exactly the sentinels the shared module defines", () => {
    expect(gsSentinelPaths()).toEqual([
      "Resource/Init/fso-sidecar-acceptance-sentinel.ps",
      "lib/fso-sidecar-acceptance-lib-sentinel.ps",
      "Resource/Font/fso-sidecar-acceptance-resource-font-sentinel.ps",
      "fonts/fso-sidecar-acceptance-fonts-sentinel.ps",
    ]);
  });

  it("prep and the audit agree on the sentinel set", async () => {
    const prep = await import("./prep.mjs");
    const verify = await import("./verify.mjs");
    expect(prep.GS_ACCEPTANCE_SENTINELS).toEqual(verify.GS_ACCEPTANCE_SENTINELS);
    expect(prep.GS_ACCEPTANCE_SENTINELS.map((p) => p.split("/").join("/"))).toEqual(
      gsSentinelPaths(),
    );
  });
});

describe("gs Resource subdir content gate (audit side)", () => {
  it.each(["CMap", "Encoding"])("fails when Resource/%s holds no files", async (subdir) => {
    const root = await makeGsRoot();
    const dir = `${root}/src-tauri/gs-resources/Resource/${subdir}`;
    for (const entry of readdirSync(dir)) {
      rmSync(`${dir}/${entry}`, { recursive: true, force: true });
    }
    mkdirSync(dir, { recursive: true });
    const stubBrew = await makeStubBrew();

    const result = await runAudit(root, "aarch64-apple-darwin", {
      PATH: `${stubBrew}:${process.env.PATH}`,
    });
    expect(result.code, `Resource/${subdir} empty must not pass`).toBe(1);
    expect(result.stdout + result.stderr).toMatch(
      new RegExp(`no files anywhere under .*Resource/${subdir}`),
    );
    expect(result.stdout).not.toContain("sentinel resolved");
    expect(result.stdout).not.toContain("sidecar audit: PASS");
  });
});

describe("gs smoke temp-dir failures are reported, never silent", () => {
  it("fails with a message when mktemp cannot create a workdir", async () => {
    const root = await makeGsRoot();
    const stubBrew = await makeStubBrew();
    const stubMktemp = await makeStubMktemp();

    const result = await runAudit(root, "aarch64-apple-darwin", {
      PATH: `${stubMktemp}:${stubBrew}:${process.env.PATH}`,
    });

    expect(result.code, "a failed mktemp must not be swallowed by set -e").toBe(1);
    expect(result.stdout + result.stderr).toContain(
      "FAIL gs clean-room smoke: could not create a temp dir",
    );
    expect(result.stdout).not.toContain("gs clean-room smoke: PASS");
    expect(result.stdout).not.toContain("sidecar audit: PASS");
  });
});

async function makeStubNode(script) {
  const dir = await mkdtemp(`${tmpdir()}/audit-stub-node-`);
  cleanupRoots.push(dir);
  const real = execFileSync("which", ["node"]).toString().trim();
  await writeFile(
    `${dir}/node`,
    `#!/bin/sh
for a in "$@"; do
  if [ "$a" = "-e" ]; then
    ${script}
  fi
done
exec ${real} "$@"
`,
    { mode: 0o755 },
  );
  return dir;
}

describe("the gs smoke fails closed instead of passing vacuously", () => {
  it.each([1, 2, 3])(
    "fails when the %s'th manifest read fails, printing neither sentinel resolved nor PASS",
    async (nth) => {
      const root = await makeGsRoot();
      const stubBrew = await makeStubBrew();
      const counter = `${root}/node-calls`;
      const stubNode = await makeStubNode(
        `n=$(cat ${counter} 2>/dev/null || echo 0); n=$((n+1)); printf '%s' "$n" > ${counter}; if [ "$n" -ge ${nth} ]; then exit 1; fi`,
      );

      const result = await runAudit(root, "aarch64-apple-darwin", {
        PATH: `${stubNode}:${stubBrew}:${process.env.PATH}`,
      });

      expect(result.code, `node -e call #${nth} failing must not pass the audit`).toBe(1);
      expect(result.stdout + result.stderr).toMatch(
        /FAIL gs clean-room smoke: no manifest entry for aarch64-apple-darwin declares a "resources" array/,
      );
      expect(result.stdout).not.toContain("sentinel resolved");
      expect(result.stdout).not.toContain("sidecar audit: PASS");
      expect(result.stdout).not.toContain("gs clean-room smoke: PASS");
    },
  );

  it("fails when the manifest read succeeds but yields no resources", async () => {
    const root = await makeGsRoot();
    const stubBrew = await makeStubBrew();
    const stubNode = await makeStubNode("exit 0");

    const result = await runAudit(root, "aarch64-apple-darwin", {
      PATH: `${stubNode}:${stubBrew}:${process.env.PATH}`,
    });

    expect(result.code, "an empty sentinel list must not pass vacuously").toBe(1);
    expect(result.stdout + result.stderr).toContain(
      "FAIL gs clean-room smoke: the acceptance-sentinel list resolved to zero entries",
    );
    expect(result.stdout + result.stderr).toContain("pass\n  vacuously");
    expect(result.stdout + result.stderr).toContain("yarn binaries:prep");
    expect(result.stdout).not.toContain("sentinel resolved");
    expect(result.stdout).not.toContain("sidecar audit: PASS");
  });

  it("aborts with a FAIL line when a command inside the smoke misbehaves", async () => {
    const root = await makeGsRoot();
    const stubBrew = await makeStubBrew();
    const stubBin = await mkdtemp(`${tmpdir()}/audit-stub-wc-`);
    cleanupRoots.push(stubBin);
    await writeFile(`${stubBin}/wc`, "#!/bin/sh\nexit 3\n", { mode: 0o755 });

    const result = await runAudit(root, "aarch64-apple-darwin", {
      PATH: `${stubBin}:${stubBrew}:${process.env.PATH}`,
    });

    expect(result.code, "an unreadable render size must not continue past the check").toBe(1);
    expect(result.stdout + result.stderr).toContain("FAIL gs clean-room smoke: rendered");
    expect(result.stdout).not.toContain("sidecar audit: PASS");
    expect(result.stdout).not.toContain("sentinel resolved");
  });
});

async function isolatedTmpdir(label) {
  const dir = await mkdtemp(`${tmpdir()}/audit-${label}-`);
  cleanupRoots.push(dir);
  return dir;
}

const EARLY_ANCHOR = '  local gs="$1"\n';
const LATE_ANCHOR = '  local fixture="$work/font-fixture.ps"\n';
const MACHO_LOOP_ANCHOR = 'for f in "$BIN_DIR"/*; do\n';
const VERIFY_ANCHOR = 'if ! node "$SCRIPT_DIR/binaries/verify.mjs" --target "$TARGET" --root "$ROOT"; then\n';
const MACHO_FN_ANCHOR = '  if ! deps="$(otool -L "$file"';

function runPatchedAudit(root, anchor, extraEnv = {}) {
  const patched = `${root}/scripts/audit-sidecars-injected.sh`;
  const source = readFileSync(AUDIT, "utf8");
  if (!source.includes(anchor)) {
    throw new Error("the injection anchor moved in audit-sidecars.sh; update this test");
  }
  writeFileSync(patched, source.replace(anchor, `  false\n${anchor}`));
  symlinkSync(SCRIPTS, `${root}/scripts/binaries`);
  return new Promise((resolvePromise) => {
    const env = { ...process.env, ROOT: root, AUDIT_TARGET: "aarch64-apple-darwin", ...extraEnv };
    for (const [key, value] of Object.entries(env)) {
      if (value === undefined || value === null) delete env[key];
    }
    const child = spawn("bash", [patched], { env, cwd: SCRIPTS });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("close", (code) => resolvePromise({ code, stdout, stderr }));
  });
}

describe("an unguarded failure inside the gs smoke is reported, not silent", () => {
  it("prints a FAIL naming line/status/command and leaves no temp workdir", async () => {
    const root = await makeGsRoot();
    const stubBrew = await makeStubBrew();
    const tmp = await isolatedTmpdir("abort");

    const result = await runPatchedAudit(root, EARLY_ANCHOR, {
      PATH: `${stubBrew}:${process.env.PATH}`,
      TMPDIR: tmp,
    });

    expect(result.code, "an unguarded smoke failure must not exit 0").toBe(1);
    expect(result.stderr).toMatch(
      /FAIL gs clean-room smoke: aborted at line \d+ \(exit 1\): false/,
    );
    expect(result.stderr).toContain("yarn binaries:prep");
    expect(result.stdout).not.toContain("sidecar audit: PASS");
    expect(result.stdout).not.toContain("gs clean-room smoke: PASS");
    expect(
      result.stdout.match(/sidecar audit:/g) ?? [],
      "the summary must be printed exactly once",
    ).toHaveLength(1);
    expect(
      readdirSync(tmp),
      "the smoke workdir must be cleaned up on the failure path too",
    ).toEqual([]);
  });

  it("does not double-report the explicit failure paths", async () => {
    const root = await makeGsRoot();
    const stubBrew = await makeStubBrew();
    await rm(`${root}/src-tauri/gs-resources/fonts/${GS_SENTINEL_NAMES.fonts}`, { force: true });

    const result = await runPatchedAudit(root, LATE_ANCHOR, {
      PATH: `${stubBrew}:${process.env.PATH}`,
    });

    expect(result.code).toBe(1);
    expect(result.stderr).toContain(
      "FAIL gs clean-room smoke: staged acceptance sentinel missing",
    );
    expect(result.stderr, "the ERR trap must not fire on an explicit failure path").not.toContain(
      "aborted at line",
    );
    expect(
      result.stdout.match(/sidecar audit:/g) ?? [],
      "the EXIT trap must not re-print a summary the body already printed",
    ).toHaveLength(1);
  });
});

describe("the smoke's ERR trap cannot outlive the smoke", () => {
  const source = readFileSync(AUDIT, "utf8");

  it("disarms the ERR trap on the success path and on every explicit failure path", () => {
    const start = source.indexOf("gs_clean_room_smoke() {");
    const body = source.slice(start, source.indexOf("\ngs_smoke_required=0", start));
    expect(body).toContain('trap \'gs_smoke_aborted "$?" "$LINENO" "$BASH_COMMAND"\' ERR');
    expect(
      body,
      "the smoke must disarm its own ERR trap and hand the body trap back before the PASS \
       line, so neither trap outlives the smoke nor the body is left unarmed",
    ).toMatch(/trap - ERR\n\s*audit_body_trap\n\s*printf 'gs clean-room smoke: PASS/);
    expect(
      source.slice(source.indexOf("gs_smoke_failed() {"), source.indexOf("gs_smoke_aborted() {")),
      "the ERR trap must be handed back on the explicit failure path too, or the rest of the \
       audit runs unarmed",
    ).toMatch(/trap - ERR[\s\S]*audit_body_trap/);
    expect(
      source.slice(source.indexOf("gs_smoke_failed() {"), source.indexOf("gs_smoke_aborted() {")),
      "the ERR trap must be disarmed on the explicit failure path too, or it fires on the next unrelated failure",
    ).toContain("trap - ERR");
  });

  it("the ERR trap is not inherited by the rest of the audit after the smoke returns", async () => {
    const root = await makeGsRoot();
    const stubBrew = await makeStubBrew();
    const result = await runAudit(root, "aarch64-apple-darwin", {
      PATH: `${stubBrew}:${process.env.PATH}`,
    });
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("gs clean-room smoke: PASS");
    expect(
      result.stdout + result.stderr,
      "a green smoke must leave no armed ERR trap behind",
    ).not.toContain("aborted at line");
  });
});

async function makeStubTool(name, script) {
  const dir = await mkdtemp(`${tmpdir()}/audit-stub-${name}-`);
  cleanupRoots.push(dir);
  await writeFile(`${dir}/${name}`, script, { mode: 0o755 });
  return dir;
}

describe("the audit's own claims are fail-closed", () => {
  it("marks the summary as emitted only after it has actually printed", () => {
    const source = readFileSync(AUDIT, "utf8");
    expect(
      source,
      "audit_finished must be set after the PASS printf, so a failure inside that printf \
       still lets the EXIT trap emit a summary",
    ).toMatch(
      /printf 'sidecar audit: PASS \(%d binaries, %d framework dylibs\)[\s\S]{0,80}audit_finished=1/,
    );
    expect(source).toContain('if [ "$audit_finished" -eq 0 ] && [ "${#failures[@]}" -gt 0 ]; then');
  });

  it("refuses to print a PASS summary when the binary count cannot be enumerated", async () => {
    const root = await makeGsRoot();
    const stubBrew = await makeStubBrew();
    const stubFind = await makeStubTool(
      "find",
      '#!/bin/sh\nif [ "$#" -eq 3 ] && [ "$2" = "-type" ]; then exit 1; fi\nexec /usr/bin/find "$@"\n',
    );

    const result = await runAudit(root, "aarch64-apple-darwin", {
      PATH: `${stubFind}:${stubBrew}:${process.env.PATH}`,
    });

    expect(result.code, "a failed enumeration must not exit 0").toBe(1);
    expect(result.stdout + result.stderr).toContain(
      "FAIL could not enumerate",
    );
    expect(result.stdout + result.stderr).toContain("the PASS count would be wrong");
    expect(result.stdout).not.toContain("sidecar audit: PASS");
  });

  it("names the framework enumeration failure too", async () => {
    const root = await makeGsRoot();
    const stubBrew = await makeStubBrew();
    await mkdir(`${root}/src-tauri/frameworks`, { recursive: true });
    const stubFind = await makeStubTool(
      "find",
      '#!/bin/sh\nif [ "$#" -eq 3 ] && [ "$2" = "-name" ]; then exit 1; fi\nexec /usr/bin/find "$@"\n',
    );

    const result = await runAudit(root, "aarch64-apple-darwin", {
      PATH: `${stubFind}:${stubBrew}:${process.env.PATH}`,
    });

    expect(result.code).toBe(1);
    expect(result.stdout).not.toContain("sidecar audit: PASS");
    expect(result.stdout + result.stderr).toMatch(/FAIL could not enumerate \S*frameworks/);
  });

  it.each([
    ["inside the Mach-O per-file loop", MACHO_LOOP_ANCHOR],
    ["before the gs smoke, at the verify step", VERIFY_ANCHOR],
    ["inside the audit_macho function body", MACHO_FN_ANCHOR],
  ])(
    "reports an unguarded failure %s with the line, status and command",
    async (_label, anchor) => {
      const root = await makeGsRoot();
      const stubBrew = await makeStubBrew();

      const result = await runPatchedAudit(root, anchor, {
        PATH: `${stubBrew}:${process.env.PATH}`,
      });

      expect(result.code).toBe(1);
      expect(
        result.stderr.length,
        "an unguarded body failure must never exit with empty stderr",
      ).toBeGreaterThan(0);
      expect(result.stderr).toMatch(
        /FAIL sidecar audit: aborted at line \d+ \(exit 1\): false/,
      );
      expect(
        result.stderr,
        "a body failure must never be attributed to the gs smoke",
      ).not.toContain("gs clean-room smoke");
      expect(
        result.stdout.match(/sidecar audit:/g) ?? [],
        "the summary must be printed exactly once",
      ).toHaveLength(1);
      expect(result.stdout).not.toContain("sidecar audit: PASS");
    },
  );

  it("fails closed when the Resource subdir enumeration yields nothing", async () => {
    const root = await makeGsRoot({
      manifestEntry: {
        source: "brew",
        formula: "ghostscript",
        binary: "gs",
        dest: "gs",
        expectVersion: "10.08.0",
        resources: ["lib", "iccprofiles", "fonts"],
      },
    });
    const stubBrew = await makeStubBrew();
    const base = `${root}/src-tauri/gs-resources`;
    await rm(`${base}/Resource`, { recursive: true, force: true });
    await mkdir(`${base}/Resource`, { recursive: true });
    await writeFile(`${base}/Resource/gs_load.ps`, "%!PS\n");

    const result = await runAudit(root, "aarch64-apple-darwin", {
      PATH: `${stubBrew}:${process.env.PATH}`,
    });

    expect(
      result.code,
      "an empty Resource subdir list must not pass vacuously: the per-subdir content gate \
       would silently stop covering the tree gs reaches through Resource/Init/gs_init.ps",
    ).toBe(1);
    expect(result.stdout + result.stderr).toContain(
      "no Resource subdirs were enumerated",
    );
    expect(result.stdout + result.stderr).toContain("vacuous");
    expect(result.stdout).not.toContain("sidecar audit: PASS");
    expect(result.stdout).not.toContain("gs clean-room smoke: PASS");
  });
});

describe("an unreadable staged dir is not reported as an empty one", () => {
  it("names the read error and points at permissions, not at restaging", async () => {
    const root = await makeGsRoot();
    const stubBrew = await makeStubBrew();
    const locked = `${root}/src-tauri/gs-resources/Resource/CMap`;
    chmodSync(locked, 0o000);

    let result;
    try {
      result = await runAudit(root, "aarch64-apple-darwin", {
        PATH: `${stubBrew}:${process.env.PATH}`,
      });
    } finally {
      chmodSync(locked, 0o755);
    }

    expect(result.code).toBe(1);
    const output = result.stdout + result.stderr;
    expect(output).toMatch(/FAIL gs clean-room smoke: could not read .*Resource\/CMap/);
    expect(output).toMatch(/Permission denied/);
    expect(output).toContain("permissions problem");
    expect(
      output,
      "the empty-tree remedy must not be the advice for a read error",
    ).not.toMatch(/could not read [^\n]*\n(?:.*\n){0,3}.*Run 'yarn binaries:prep' to restage the gs resources\./);
    expect(result.stdout).not.toContain("sidecar audit: PASS");
  });
});

describe("the dylib cross-check does not mistake a read error for missing dylibs", () => {
  it("names the enumeration failure instead of blaming tauri.conf.json", async () => {
    const root = await makeGsRoot();
    const stubBrew = await makeStubBrew();
    const frameworks = `${root}/src-tauri/frameworks`;
    await mkdir(frameworks, { recursive: true });
    await writeFile(
      `${root}/src-tauri/tauri.conf.json`,
      JSON.stringify({ bundle: { frameworks: ["frameworks/libz.1.dylib"] } }),
    );
    chmodSync(frameworks, 0o000);

    let result;
    try {
      result = await runAudit(root, "aarch64-apple-darwin", {
        PATH: `${stubBrew}:${process.env.PATH}`,
      });
    } finally {
      chmodSync(frameworks, 0o755);
    }

    expect(result.code).toBe(1);
    const output = result.stdout + result.stderr;
    expect(output).toMatch(/FAIL could not enumerate \S*frameworks/);
    expect(output).toContain("fix the read error");
    expect(output).not.toContain("lists missing dylib");
  });
});

describe("a real tool failure inside the audit is an audit finding, not a silent exit", () => {
  it("names the binary whose otool -L pipeline failed, without a duplicate trap message", async () => {
    const root = await makeGsRoot();
    const stubBrew = await makeStubBrew();
    const stubSort = await makeStubTool("sort", "#!/bin/sh\nexit 5\n");

    const result = await runAudit(root, "aarch64-apple-darwin", {
      PATH: `${stubSort}:${stubBrew}:${process.env.PATH}`,
    });

    expect(result.code).toBe(1);
    const output = result.stdout + result.stderr;
    expect(output).toContain("could not read the dylib load commands");
    expect(
      output,
      "the finding must name the affected binary file",
    ).toMatch(/gs-aarch64-apple-darwin/);
    expect(
      output,
      "the guarded pipeline must record one finding, not also fire the ERR trap",
    ).not.toContain("aborted at line");
    expect(
      result.stdout.match(/sidecar audit:/g) ?? [],
      "the summary must be printed exactly once",
    ).toHaveLength(1);
    expect(result.stdout).not.toContain("sidecar audit: PASS");
  });

  it("a failing cleanup degrades to a WARN and leaves the audit verdict intact", async () => {
    const root = await makeGsRoot();
    const stubBrew = await makeStubBrew();
    const tmp = await isolatedTmpdir("cleanup");
    const stubRm = await makeStubTool("rm", "#!/bin/sh\nexit 1\n");

    const result = await runAudit(root, "aarch64-apple-darwin", {
      PATH: `${stubRm}:${stubBrew}:${process.env.PATH}`,
      TMPDIR: tmp,
    });

    expect(result.stdout).toContain("sidecar audit: PASS");
    expect(
      result.code,
      "a failing rm -rf in the EXIT trap must not turn a green audit into exit 1",
    ).toBe(0);
    expect(result.stderr).toContain("WARN sidecar audit: could not remove the smoke workdir");
    expect(result.stderr).toMatch(/gs-clean-room\./);
    expect(
      result.stdout.match(/sidecar audit: PASS/g) ?? [],
      "the PASS line must print exactly once",
    ).toHaveLength(1);
  });
});
