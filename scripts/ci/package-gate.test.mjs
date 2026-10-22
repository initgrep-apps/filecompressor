// @vitest-environment node
import { afterEach, describe, expect, it, vi, beforeEach } from "vitest";
import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { checkVersion } from "../binaries/verify.mjs";
import {
  ENGINES,
  SevenZipMissingError,
  parseGateArgs,
  expectedEnginePaths,
  expectedVersions,
  enginePlan,
  gsRunArgs,
  gsResourcesCheck,
  knownTriples,
  locateBundle,
  extractNsisInstaller,
  checkStepOutput,
  checkEngine,
  validateBundleDir,
  resolverCheck,
  resolverCommand,
  main,
} from "./package-gate.mjs";

vi.mock("node:child_process", () => ({ execFile: vi.fn() }));

const REPO_ROOT = join(import.meta.dirname, "..", "..");
const manifest = JSON.parse(readFileSync(join(REPO_ROOT, "scripts/binaries.manifest.json"), "utf8"));
const baseConf = JSON.parse(readFileSync(join(REPO_ROOT, "src-tauri/tauri.conf.json"), "utf8"));
const windowsConf = JSON.parse(readFileSync(join(REPO_ROOT, "src-tauri/tauri.windows.conf.json"), "utf8"));

function appWithGsTree({ init = true, fonts = "real", icc = "absent" } = {}) {
  const app = mkdtempSync(join(tmpdir(), "gate-app-"));
  const tree = join(app, "Contents", "Resources", "gs-resources");
  for (const dir of ["Resource/Init", "lib", "Resource/Font", "fonts"]) {
    mkdirSync(join(tree, ...dir.split("/")), { recursive: true });
  }
  if (init) {
    writeFileSync(join(tree, "Resource", "Init", "gs_init.ps"), "%!\n");
  }
  const fontName = "n019003l.pfb";
  for (const dir of ["Resource/Font", "fonts"]) {
    if (fonts === "real") {
      writeFileSync(join(tree, ...dir.split("/"), fontName), "font");
    }
    if (fonts === "sentinel") {
      writeFileSync(join(tree, ...dir.split("/"), "fso-sidecar-acceptance-sentinel.ps"), "sentinel");
    }
  }
  if (icc === "directory") {
    mkdirSync(join(tree, "iccprofiles"), { recursive: true });
  }
  if (icc === "file") {
    writeFileSync(join(tree, "iccprofiles"), "not a directory");
  }
  return { app, tree, exeDir: join(app, "Contents", "MacOS") };
}

describe("parseGateArgs", () => {
  it("rejects a missing --triple", () => {
    expect(() => parseGateArgs([])).toThrow(/--triple/);
  });
  it("rejects an unsupported triple", () => {
    expect(() => parseGateArgs(["--triple", "x86_64-unknown-linux-gnu"])).toThrow(/unsupported/i);
  });
  it("accepts a supported triple", () => {
    expect(parseGateArgs(["--triple", "aarch64-apple-darwin"]).triple).toBe("aarch64-apple-darwin");
  });
  it("carries --bundle-dir when given", () => {
    const dir = join("/tmp", "gate-broken.app");
    expect(parseGateArgs(["--triple", "aarch64-apple-darwin", "--bundle-dir", dir])).toEqual({
      triple: "aarch64-apple-darwin",
      bundleDir: dir,
    });
  });
  it("re-exports the same triple list the lib uses", () => {
    expect(knownTriples()).toContain("aarch64-pc-windows-msvc");
  });
});

describe("expectedEnginePaths", () => {
  it("puts the macOS engines next to the app binary", () => {
    const exeDir = join("/app", "Contents", "MacOS");
    const paths = expectedEnginePaths({ triple: "aarch64-apple-darwin", exeDir, manifest, baseConf, windowsConf });
    expect(paths.get("vips")).toBe(join(exeDir, "vips"));
    expect(paths.get("ffmpeg")).toBe(join(exeDir, "ffmpeg"));
  });
  it("puts the Windows engines under resources/engines", () => {
    const exeDir = join("C:", "app");
    const paths = expectedEnginePaths({ triple: "x86_64-pc-windows-msvc", exeDir, manifest, baseConf, windowsConf });
    expect(paths.get("vips")).toBe(join(exeDir, "resources", "engines", "vips", "vips.exe"));
    expect(paths.get("ffmpeg")).toBe(join(exeDir, "ffmpeg.exe"));
  });
  it("throws instead of silently leaving a sixth bundled engine ungated, naming the gate lists", () => {
    const extended = JSON.parse(JSON.stringify(baseConf));
    extended.bundle.externalBin.push("binaries/sixth-engine");
    expect(() =>
      expectedEnginePaths({
        triple: "aarch64-apple-darwin",
        exeDir: join("/app", "Contents", "MacOS"),
        manifest,
        baseConf: extended,
        windowsConf,
      }),
    ).toThrow(/sixth-engine.*ENGINES and enginePlan/);
  });
  it("names bundle.externalBin, not the gate's ENGINES, when the config drops an engine", () => {
    const stripped = JSON.parse(JSON.stringify(baseConf));
    stripped.bundle.externalBin = stripped.bundle.externalBin.filter((entry) => !entry.endsWith("vips"));
    expect(() =>
      expectedEnginePaths({
        triple: "aarch64-apple-darwin",
        exeDir: join("/app", "Contents", "MacOS"),
        manifest,
        baseConf: stripped,
        windowsConf,
      }),
    ).toThrow(/vips.*bundle\.externalBin.*tauri\.conf\.json/);
  });
});

describe("expectedVersions", () => {
  it("reads every engine's version from the manifest for the triple", () => {
    const arm = expectedVersions({ triple: "aarch64-apple-darwin", manifest });
    const armTarget = manifest.targets["aarch64-apple-darwin"];
    for (const name of ENGINES) {
      expect(arm.get(name), name).toBe(armTarget[name].expectVersion);
    }
    const intel = expectedVersions({ triple: "x86_64-apple-darwin", manifest });
    const intelTarget = manifest.targets["x86_64-apple-darwin"];
    expect(intel.get("vips")).toBe(intelTarget.vips.expectVersion);
    expect(intel.get("vips")).not.toBe(arm.get("vips"));
  });
  it("throws when a triple or an engine is missing", () => {
    const missingEngine = JSON.parse(JSON.stringify(manifest));
    delete missingEngine.targets["aarch64-apple-darwin"].vips;
    expect(() =>
      expectedVersions({ triple: "aarch64-apple-darwin", manifest: missingEngine }),
    ).toThrow(/vips/);
    expect(() =>
      expectedVersions({ triple: "x86_64-unknown-linux-gnu", manifest }),
    ).toThrow(/unsupported|unknown|missing/i);
  });
});

describe("enginePlan", () => {
  it("covers all five engines", () => {
    expect([...enginePlan().keys()].sort()).toEqual(["ffmpeg", "ffprobe", "gs", "qpdf", "vips"]);
  });
  it("gives every engine at least one operation, each with a declared check", () => {
    for (const [name, plan] of enginePlan()) {
      expect(plan.steps.length, name).toBeGreaterThan(0);
      for (const step of plan.steps) {
        expect(
          Boolean(step.produces) || step.expectStdout !== undefined,
          `${name}: '${step.args.join(" ")}' declares no produces and no expectStdout`,
        ).toBe(true);
      }
    }
  });
  it("declares magic bytes for every produced step", () => {
    for (const [name, plan] of enginePlan()) {
      for (const step of plan.steps) {
        if (step.produces) {
          expect(step.magic, `${name}: ${step.produces} declares no magic`).toBeDefined();
        }
      }
    }
    expect(enginePlan().get("qpdf").steps.map((step) => step.magic)).toEqual(["%PDF-", "%PDF-"]);
    expect(enginePlan().get("gs").steps[0].magic).toBe("%PDF-");
    expect(enginePlan().get("ffmpeg").steps[0].magic).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    expect(enginePlan().get("vips").steps[1].magic).toEqual([0xff, 0xd8]);
  });
  it("runs ffmpeg before ffprobe because ffprobe reads ffmpeg's PNG", () => {
    expect(ENGINES.indexOf("ffmpeg")).toBeLessThan(ENGINES.indexOf("ffprobe"));
  });
});

describe("gsRunArgs", () => {
  it("prepends -I for every resource dir that exists in the package", () => {
    const { exeDir, tree } = appWithGsTree();
    const stepArgs = enginePlan().get("gs").steps[0].args;
    const args = gsRunArgs({ exeDir, triple: "aarch64-apple-darwin", stepArgs });
    expect(args[0]).toBe("-I");
    expect(args[1]).toBe(join(tree, "Resource", "Init"));
    expect(args[2]).toBe("-I");
    expect(args[3]).toBe(join(tree, "lib"));
    expect(args[4]).toBe("-I");
    expect(args[5]).toBe(join(tree, "Resource", "Font"));
    expect(args[6]).toBe("-I");
    expect(args[7]).toBe(join(tree, "fonts"));
    expect(args.slice(-stepArgs.length)).toEqual(stepArgs);
    expect(args).toContain("-sOutputFile=out.pdf");
  });
  it("filters out search dirs the app would also skip", () => {
    const app = mkdtempSync(join(tmpdir(), "gate-app-"));
    const tree = join(app, "Contents", "Resources", "gs-resources");
    mkdirSync(join(tree, "Resource", "Init"), { recursive: true });
    mkdirSync(join(tree, "lib"), { recursive: true });
    const stepArgs = ["-q", "in.ps"];
    const args = gsRunArgs({ exeDir: join(app, "Contents", "MacOS"), triple: "aarch64-apple-darwin", stepArgs });
    expect(args).toEqual(["-I", join(tree, "Resource", "Init"), "-I", join(tree, "lib"), ...stepArgs]);
  });
  it("adds -uICCProfilesDir when iccprofiles is a directory", () => {
    const { exeDir, tree } = appWithGsTree({ icc: "directory" });
    const stepArgs = ["-q", "in.ps"];
    const args = gsRunArgs({ exeDir, triple: "aarch64-apple-darwin", stepArgs });
    expect(args).toContain(`-uICCProfilesDir=${join(tree, "iccprofiles")}`);
  });
  it("treats a non-directory iccprofiles as absent", () => {
    const { exeDir } = appWithGsTree({ icc: "file" });
    const args = gsRunArgs({ exeDir, triple: "aarch64-apple-darwin", stepArgs: ["-q"] });
    expect(args.some((arg) => arg.startsWith("-uICCProfilesDir="))).toBe(false);
  });
  it("passes no -I flags on Windows (ROM model)", () => {
    const stepArgs = enginePlan().get("gs").steps[0].args;
    const args = gsRunArgs({ exeDir: join("C:", "app"), triple: "x86_64-pc-windows-msvc", stepArgs });
    expect(args.some((arg) => arg.startsWith("-I"))).toBe(false);
    expect(args).toContain("-sOutputFile=out.pdf");
    expect(args).toContain("in.ps");
  });
  it("uses the caller's step args instead of re-reading the engine plan", () => {
    const { exeDir } = appWithGsTree();
    const stepArgs = ["-sDEVICE=pdfwrite", "-sOutputFile=custom.pdf", "custom.ps"];
    const args = gsRunArgs({ exeDir, triple: "aarch64-apple-darwin", stepArgs });
    expect(args.slice(-stepArgs.length)).toEqual(stepArgs);
  });
});

describe("gsResourcesCheck", () => {
  it("passes on a complete tree and says what it verified", async () => {
    const { exeDir } = appWithGsTree();
    const result = await gsResourcesCheck({ exeDir, triple: "aarch64-apple-darwin" });
    expect(result.ok).toBe(true);
    expect(result.detail).toMatch(/gs_init\.ps is a file/);
    expect(result.detail).toMatch(/non-sentinel/);
    expect(result.detail).toMatch(/iccprofiles absent or not a directory/i);
  });
  it("notes when iccprofiles is a directory", async () => {
    const { exeDir } = appWithGsTree({ icc: "directory" });
    const result = await gsResourcesCheck({ exeDir, triple: "aarch64-apple-darwin" });
    expect(result.ok).toBe(true);
    expect(result.detail).toContain("-uICCProfilesDir applied");
  });
  it("fails when the tree is missing, naming every required piece", async () => {
    const result = await gsResourcesCheck({
      exeDir: join(mkdtempSync(join(tmpdir(), "gate-app-")), "Contents", "MacOS"),
      triple: "aarch64-apple-darwin",
    });
    expect(result.ok).toBe(false);
    expect(result.detail).toContain("Resource/Init");
    expect(result.detail).toContain("Resource/Font");
    expect(result.detail).toContain("gs_init.ps");
    expect(result.detail).toMatch(/compiled-in prefix/);
  });
  it("fails when the font dirs are empty, matching the app's runtime predicate", async () => {
    const { exeDir } = appWithGsTree({ fonts: "empty" });
    const result = await gsResourcesCheck({ exeDir, triple: "aarch64-apple-darwin" });
    expect(result.ok).toBe(false);
    expect(result.detail).toContain("Resource/Font");
    expect(result.detail).toContain("fonts");
    expect(result.detail).toMatch(/real non-sentinel font files/);
  });
  it("fails when the font dirs only hold the audit's sentinel files", async () => {
    const { exeDir } = appWithGsTree({ fonts: "sentinel" });
    const result = await gsResourcesCheck({ exeDir, triple: "aarch64-apple-darwin" });
    expect(result.ok).toBe(false);
    expect(result.detail).toMatch(/real non-sentinel font files/);
  });
  it("passes on Windows (ROM model)", async () => {
    const result = await gsResourcesCheck({ exeDir: join("C:", "app"), triple: "x86_64-pc-windows-msvc" });
    expect(result.ok).toBe(true);
    expect(result.detail).toMatch(/ROM/);
  });
});

describe("checkStepOutput", () => {
  it("accepts a produced file that is not empty", () => {
    const dir = mkdtempSync(join(tmpdir(), "gate-"));
    writeFileSync(join(dir, "out.jpg"), "x");
    const result = checkStepOutput({ step: { produces: "out.jpg" }, workDir: dir, stdout: "" });
    expect(result.ok).toBe(true);
  });
  it("rejects a produced file that is empty", () => {
    const dir = mkdtempSync(join(tmpdir(), "gate-"));
    writeFileSync(join(dir, "out.pdf"), "");
    const result = checkStepOutput({ step: { produces: "out.pdf" }, workDir: dir, stdout: "" });
    expect(result.ok).toBe(false);
    expect(result.detail).toMatch(/empty/i);
  });
  it("rejects a produced file that was never written", () => {
    const dir = mkdtempSync(join(tmpdir(), "gate-"));
    const result = checkStepOutput({ step: { produces: "out.pdf" }, workDir: dir, stdout: "" });
    expect(result.ok).toBe(false);
    expect(result.detail).toMatch(/was not produced/);
  });
  it("rejects a missing stdout expectation", () => {
    const result = checkStepOutput({ step: { expectStdout: "64,64" }, workDir: "/tmp", stdout: "1,1" });
    expect(result.ok).toBe(false);
  });
  it("rejects a directory masquerading as the produced file", () => {
    const dir = mkdtempSync(join(tmpdir(), "gate-"));
    mkdirSync(join(dir, "out.pdf"));
    const result = checkStepOutput({ step: { produces: "out.pdf" }, workDir: dir, stdout: "" });
    expect(result.ok).toBe(false);
    expect(result.detail).toMatch(/not a regular file/i);
  });
  it("rejects a step that declares neither an output file nor a stdout expectation", () => {
    const result = checkStepOutput({ step: { args: ["--noop"] }, workDir: "/tmp", stdout: "" });
    expect(result.ok).toBe(false);
    expect(result.detail).toMatch(/neither produces nor expectStdout/);
  });
  it("accepts a file carrying the declared magic bytes", () => {
    const dir = mkdtempSync(join(tmpdir(), "gate-"));
    writeFileSync(join(dir, "out.pdf"), "%PDF-1.7\n");
    const result = checkStepOutput({ step: { produces: "out.pdf", magic: "%PDF-" }, workDir: dir, stdout: "" });
    expect(result.ok).toBe(true);
    expect(result.detail).toContain("%PDF-");
  });
  it("rejects a non-empty file with the wrong magic (an HTML error page)", () => {
    const dir = mkdtempSync(join(tmpdir(), "gate-"));
    writeFileSync(join(dir, "out.pdf"), "<html>engine error</html>");
    const result = checkStepOutput({ step: { produces: "out.pdf", magic: "%PDF-" }, workDir: dir, stdout: "" });
    expect(result.ok).toBe(false);
    expect(result.detail).toMatch(/does not start with '%PDF-'/);
  });
  it("rejects a JPEG that is not JPEG", () => {
    const dir = mkdtempSync(join(tmpdir(), "gate-"));
    writeFileSync(join(dir, "out.jpg"), "<html>");
    const result = checkStepOutput({
      step: { produces: "out.jpg", magic: [0xff, 0xd8] },
      workDir: dir,
      stdout: "",
    });
    expect(result.ok).toBe(false);
    expect(result.detail).toContain("ff d8");
  });
});

describe("locateBundle", () => {
  it("returns the triple-specific bundle and never a stale sibling", () => {
    const root = mkdtempSync(join(tmpdir(), "gate-root-"));
    const stale = join(root, "src-tauri", "target", "release", "bundle", "macos");
    const fresh = join(root, "src-tauri", "target", "aarch64-apple-darwin", "release", "bundle", "macos");
    mkdirSync(stale, { recursive: true });
    mkdirSync(fresh, { recursive: true });
    writeFileSync(join(stale, "stale.app"), "");
    writeFileSync(join(fresh, "fresh.app"), "");
    expect(locateBundle({ root, triple: "aarch64-apple-darwin" })).toEqual({
      kind: "app",
      path: join(fresh, "fresh.app"),
    });
  });
  it("fails closed when only another triple's or a stale bundle exists", () => {
    const root = mkdtempSync(join(tmpdir(), "gate-root-"));
    const stale = join(root, "src-tauri", "target", "release", "bundle", "macos");
    mkdirSync(stale, { recursive: true });
    writeFileSync(join(stale, "arm64.app"), "");
    expect(locateBundle({ root, triple: "x86_64-apple-darwin" })).toBe(null);
  });
  it("finds the Windows NSIS installer under the triple's bundle dir", () => {
    const root = mkdtempSync(join(tmpdir(), "gate-root-"));
    const nsis = join(root, "src-tauri", "target", "x86_64-pc-windows-msvc", "release", "bundle", "nsis");
    mkdirSync(nsis, { recursive: true });
    writeFileSync(join(nsis, "file-compressor_1.0.0_x64-setup.exe"), "");
    expect(locateBundle({ root, triple: "x86_64-pc-windows-msvc" })).toEqual({
      kind: "nsis",
      path: join(nsis, "file-compressor_1.0.0_x64-setup.exe"),
    });
  });
  it("returns null when the package was never built", () => {
    const root = mkdtempSync(join(tmpdir(), "gate-root-"));
    expect(locateBundle({ root, triple: "aarch64-apple-darwin" })).toBe(null);
  });
  it("returns null for a profile dir carrying plain-named engines and no bundle/", () => {
    const root = mkdtempSync(join(tmpdir(), "gate-root-"));
    const debug = join(root, "src-tauri", "target", "aarch64-apple-darwin", "debug");
    mkdirSync(debug, { recursive: true });
    for (const name of ENGINES) {
      writeFileSync(join(debug, name), "");
    }
    expect(
      locateBundle({ root, triple: "aarch64-apple-darwin" }),
      "a profile directory is not a package: tauri-build copies externalBin there with plain names",
    ).toBe(null);
  });
});

describe("extractNsisInstaller", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("runs 7z x -y <setup> -o<dest> with the SEVEN_ZIP override", async () => {
    vi.stubEnv("SEVEN_ZIP", "/custom/7z");
    const destDir = mkdtempSync(join(tmpdir(), "gate-7z-"));
    const runFn = vi.fn(async () => ({ stdout: "", stderr: "" }));
    const result = await extractNsisInstaller({ setupExe: "/setup.exe", destDir, run: runFn });
    expect(result).toBe(destDir);
    expect(runFn).toHaveBeenCalledWith("/custom/7z", ["x", "-y", "/setup.exe", `-o${destDir}`]);
  });

  it("throws a named error naming the expected 7-Zip path when the tool is missing", async () => {
    vi.stubEnv("SEVEN_ZIP", "");
    const error = await extractNsisInstaller({
      setupExe: "/setup.exe",
      destDir: mkdtempSync(join(tmpdir(), "gate-7z-")),
      run: vi.fn(),
      exists: () => false,
    }).catch((caught) => caught);
    expect(error).toBeInstanceOf(SevenZipMissingError);
    expect(error.message).toContain("C:\\Program Files\\7-Zip\\7z.exe");
  });
});

describe("resolverCheck", () => {
  it("passes only on exit 0 plus the marker line", () => {
    const result = resolverCheck({
      code: 0,
      stdout: 'running 1 test\nfso-bundle-resolver-ok: "/pkg/Contents/MacOS"\ntest result: ok. 1 passed\n',
      stderr: "",
    });
    expect(result.ok).toBe(true);
  });
  it("fails on exit 0 without the marker", () => {
    const result = resolverCheck({ code: 0, stdout: "test result: ok. 1 passed\n", stderr: "" });
    expect(result.ok).toBe(false);
    expect(result.detail).toMatch(/fso-bundle-resolver-ok/);
  });
  it("fails on a nonzero exit even when the marker appears", () => {
    const result = resolverCheck({
      code: 101,
      stdout: 'fso-bundle-resolver-ok: "/pkg"\n',
      stderr: "thread panicked",
    });
    expect(result.ok).toBe(false);
    expect(result.detail).toMatch(/exited 101/);
  });
  it("labels a timeout or signal as such instead of exited 1", () => {
    const result = resolverCheck({ code: 1, stdout: "", stderr: "", killed: true, signal: "SIGTERM" });
    expect(result.ok).toBe(false);
    expect(result.detail).toMatch(/timed out or was killed/);
    expect(result.detail).not.toMatch(/exited 1/);
  });
  it("labels a spawn failure as could not start cargo instead of exited ENOENT", () => {
    const result = resolverCheck({ code: 1, stdout: "", stderr: "spawn cargo ENOENT", errorCode: "ENOENT" });
    expect(result.ok).toBe(false);
    expect(result.detail).toMatch(/could not start cargo/);
    expect(result.detail).not.toMatch(/exited ENOENT/);
  });
});

describe("resolverCommand", () => {
  it("spawns --nocapture with the package env and the gate sentinel", () => {
    const exeDir = join("/pkg", "Contents", "MacOS");
    const command = resolverCommand({ root: "/repo", exeDir });
    expect(command.tool).toBe("cargo");
    expect(command.args).toEqual([
      "test",
      "--lib",
      "resolve_for_finds_every_engine_in_a_bundled_package",
      "--",
      "--nocapture",
    ]);
    expect(command.options.cwd).toBe(join("/repo", "src-tauri"));
    expect(command.options.timeout).toBe(900_000);
    expect(command.options.env.FSO_BUNDLE_EXE_DIR).toBe(exeDir);
    expect(command.options.env.FSO_BUNDLE_GATE).toBe("1");
  });
});

describe("checkVersion env override (the gate's no-staging-DYLD contract)", () => {
  beforeEach(() => {
    execFile.mockReset();
    execFile.mockImplementation((_bin, _args, _options, callback) =>
      callback(null, "vips-8.18.7\n", ""),
    );
  });

  it("passes the given env through without injecting DYLD_LIBRARY_PATH", async () => {
    const env = { PATH: "/usr/bin:/bin" };
    await checkVersion("/pkg/vips", "8.18.7", "aarch64-apple-darwin", "/repo", { env });
    const options = execFile.mock.calls[0][2];
    expect(options.env).toEqual(env);
    expect(
      options.env.DYLD_LIBRARY_PATH,
      "the gate passes { env: process.env } so the package must load its own dylibs — the staging-tree injection must never reach it",
    ).toBeUndefined();
  });

  it("injects the staging DYLD_LIBRARY_PATH when no { env } is passed", async () => {
    await checkVersion("/staging/vips", "8.18.7", "aarch64-apple-darwin", "/repo");
    const options = execFile.mock.calls[0][2];
    expect(options.env.DYLD_LIBRARY_PATH).toBe(join("/repo", "src-tauri", "frameworks"));
  });

  it("treats a null env as no override and injects the staging path", async () => {
    await checkVersion("/staging/vips", "8.18.7", "aarch64-apple-darwin", "/repo", { env: null });
    const options = execFile.mock.calls[0][2];
    expect(options.env.DYLD_LIBRARY_PATH).toBe(join("/repo", "src-tauri", "frameworks"));
  });

  it("uses -version for ffmpeg/ffprobe, which reject --version", async () => {
    await checkVersion("/pkg/ffmpeg", "9.0.2", "aarch64-apple-darwin", "/repo", { env: {} });
    await checkVersion("/pkg/ffprobe", "9.0.2", "aarch64-apple-darwin", "/repo", { env: {} });
    await checkVersion("/pkg/vips", "8.18.7", "aarch64-apple-darwin", "/repo", { env: {} });
    expect(execFile.mock.calls[0][1]).toEqual(["-version"]);
    expect(execFile.mock.calls[1][1]).toEqual(["-version"]);
    expect(execFile.mock.calls[2][1]).toEqual(["--version"]);
  });

  it("fails a mismatched version, naming the expected and the observed output", async () => {
    execFile.mockImplementation((_bin, _args, _options, callback) =>
      callback(null, "Ghostscript 10.07.1\n", ""),
    );
    const result = await checkVersion("/pkg/gs", "10.08.0", "aarch64-apple-darwin", "/repo", {
      env: { PATH: "/usr/bin:/bin" },
    });
    expect(result.ok).toBe(false);
    expect(result.detail).toContain("10.08.0");
    expect(result.detail).toContain("10.07.1");
  });

  it("fails a nonzero exit even when the output happens to contain the version", async () => {
    const error = Object.assign(new Error("Command failed"), { code: 1, killed: false });
    execFile.mockImplementation((_bin, _args, _options, callback) =>
      callback(error, "vips-8.18.7\n", ""),
    );
    const result = await checkVersion("/pkg/vips", "8.18.7", "aarch64-apple-darwin", "/repo", {
      env: { PATH: "/usr/bin:/bin" },
    });
    expect(result.ok).toBe(false);
    expect(result.detail).toMatch(/exited 1 after printing a version/);
    expect(result.detail).toContain("must run cleanly");
    expect(result.detail).toContain("vips-8.18.7");
  });

  it("surfaces the loader's own error text when the engine dies on a signal", async () => {
    const error = Object.assign(new Error("Command failed"), { signal: "SIGABRT", killed: false });
    execFile.mockImplementation((_bin, _args, _options, callback) =>
      callback(
        error,
        "",
        "dyld[1234]: Library not loaded: @rpath/libvips.42.dylib\n  Referenced from: /pkg/Contents/MacOS/vips",
      ),
    );
    const result = await checkVersion("/pkg/vips", "8.18.7", "aarch64-apple-darwin", "/repo", {
      env: { PATH: "/usr/bin:/bin" },
    });
    expect(result.ok).toBe(false);
    expect(result.detail).toContain("SIGABRT");
    expect(result.detail).toContain("Library not loaded");
  });
});

describe("checkEngine", () => {
  const plan = { fixtures: [], steps: [{ args: ["--empty", "out.pdf"], produces: "out.pdf", magic: "%PDF-" }] };
  const options = (overrides) => ({
    name: "qpdf",
    expectVersion: "12.4.2",
    triple: "aarch64-apple-darwin",
    root: "/repo",
    exeDir: join("/app", "Contents", "MacOS"),
    plan,
    workDir: mkdtempSync(join(tmpdir(), "gate-engine-")),
    ...overrides,
  });
  const existingBinary = () => {
    const binPath = join(mkdtempSync(join(tmpdir(), "gate-bin-")), "qpdf");
    writeFileSync(binPath, "binary");
    return binPath;
  };

  it("fails when the binary is missing and never runs the version check", async () => {
    const checkVersionFn = vi.fn();
    const result = await checkEngine(
      options({ binPath: join(tmpdir(), "gate-no-such-qpdf"), checkVersion: checkVersionFn }),
    );
    expect(result.ok).toBe(false);
    expect(result.details[0].detail).toMatch(/file not found/);
    expect(checkVersionFn).not.toHaveBeenCalled();
  });

  it("fails on a version mismatch without double-wrapping the reason", async () => {
    const result = await checkEngine(
      options({
        binPath: existingBinary(),
        checkVersion: async () => ({ ok: false, detail: "expected '12.4.2' in version output, got: 12.4.1" }),
      }),
    );
    expect(result.ok).toBe(false);
    const detail = result.details.find((entry) => !entry.ok).detail;
    expect(detail).toContain("12.4.1");
    expect(detail).not.toMatch(/got: expected/);
    expect(detail.match(/12\.4\.1/g)).toHaveLength(1);
  });

  it("fails when a step throws, carrying the engine's own error output", async () => {
    const runFn = vi.fn(async () => {
      throw { stdout: "", stderr: "boom" };
    });
    const result = await checkEngine(
      options({
        binPath: existingBinary(),
        checkVersion: async () => ({ ok: true, detail: "qpdf version 12.4.2" }),
        run: runFn,
      }),
    );
    expect(result.ok).toBe(false);
    expect(result.details.some((detail) => !detail.ok && detail.detail.includes("boom"))).toBe(true);
  });

  it("labels a killed step as timed out instead of exited 1", async () => {
    const runFn = vi.fn(async () => {
      throw Object.assign(new Error("killed"), { killed: true, signal: "SIGTERM" });
    });
    const result = await checkEngine(
      options({
        binPath: existingBinary(),
        checkVersion: async () => ({ ok: true, detail: "qpdf version 12.4.2" }),
        run: runFn,
      }),
    );
    expect(result.ok).toBe(false);
    expect(result.details.some((detail) => /timed out or was killed/.test(detail.detail))).toBe(true);
  });

  it("labels a spawn failure as could not start the engine", async () => {
    const runFn = vi.fn(async () => {
      throw Object.assign(new Error("spawn ENOENT"), { code: "ENOENT" });
    });
    const result = await checkEngine(
      options({
        binPath: existingBinary(),
        checkVersion: async () => ({ ok: true, detail: "qpdf version 12.4.2" }),
        run: runFn,
      }),
    );
    expect(result.ok).toBe(false);
    expect(result.details.some((detail) => /could not start qpdf/.test(detail.detail))).toBe(true);
  });

  it("fails when a step exits 0 but writes an empty file", async () => {
    const runFn = vi.fn(async (_bin, _args, { cwd }) => {
      writeFileSync(join(cwd, "out.pdf"), "");
      return { stdout: "", stderr: "" };
    });
    const result = await checkEngine(
      options({
        binPath: existingBinary(),
        checkVersion: async () => ({ ok: true, detail: "qpdf version 12.4.2" }),
        run: runFn,
      }),
    );
    expect(result.ok).toBe(false);
    expect(result.details.some((detail) => /empty/i.test(detail.detail))).toBe(true);
  });

  it("fails when the step writes a non-PDF into a PDF output", async () => {
    const runFn = vi.fn(async (_bin, _args, { cwd }) => {
      writeFileSync(join(cwd, "out.pdf"), "<html>error</html>");
      return { stdout: "", stderr: "" };
    });
    const result = await checkEngine(
      options({
        binPath: existingBinary(),
        checkVersion: async () => ({ ok: true, detail: "qpdf version 12.4.2" }),
        run: runFn,
      }),
    );
    expect(result.ok).toBe(false);
    expect(result.details.some((detail) => /does not start with '%PDF-'/.test(detail.detail))).toBe(true);
  });

  it("passes when the step produces a non-empty file", async () => {
    const runFn = vi.fn(async (_bin, _args, { cwd }) => {
      writeFileSync(join(cwd, "out.pdf"), "%PDF-1.7");
      return { stdout: "", stderr: "" };
    });
    const result = await checkEngine(
      options({
        binPath: existingBinary(),
        checkVersion: async () => ({ ok: true, detail: "qpdf version 12.4.2" }),
        run: runFn,
      }),
    );
    expect(result.ok).toBe(true);
    expect(result.details.every((detail) => detail.ok)).toBe(true);
  });

  it("strips an ambient DYLD_LIBRARY_PATH from both the version check and the operations", async () => {
    vi.stubEnv("DYLD_LIBRARY_PATH", "/repo/src-tauri/frameworks");
    const checkVersionFn = vi.fn(async () => ({ ok: true, detail: "qpdf version 12.4.2" }));
    const runFn = vi.fn(async (_bin, _args, { cwd }) => {
      writeFileSync(join(cwd, "out.pdf"), "%PDF-1.7");
      return { stdout: "", stderr: "" };
    });
    try {
      await checkEngine(options({ binPath: existingBinary(), checkVersion: checkVersionFn, run: runFn }));
      const checkEnv = checkVersionFn.mock.calls[0][4].env;
      expect(checkEnv.DYLD_LIBRARY_PATH).toBeUndefined();
      expect(checkEnv.PATH).toBe(process.env.PATH);
      const runOptions = runFn.mock.calls[0][2];
      expect(runOptions.timeout).toBe(60_000);
      expect(runOptions.env.DYLD_LIBRARY_PATH).toBeUndefined();
      expect(runOptions.env.PATH).toBe(process.env.PATH);
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

describe("validateBundleDir", () => {
  it("rejects a path that is not a .app directory, naming the value", () => {
    const dir = mkdtempSync(join(tmpdir(), "gate-bdir-"));
    expect(() => validateBundleDir({ bundleDir: dir, triple: "aarch64-apple-darwin" })).toThrow(
      `--bundle-dir '${dir}' must point at a .app package`,
    );
    expect(() =>
      validateBundleDir({ bundleDir: join(dir, "missing.app"), triple: "aarch64-apple-darwin" }),
    ).toThrow(/does not exist/);
  });
  it("resolves a relative --bundle-dir to an absolute path for the Rust resolver", () => {
    const appDir = join(mkdtempSync(join(tmpdir(), "gate-bdir-")), "relative.app");
    mkdirSync(appDir, { recursive: true });
    const relativePath = relative(process.cwd(), appDir);
    expect(validateBundleDir({ bundleDir: relativePath, triple: "aarch64-apple-darwin" })).toBe(appDir);
  });
});

describe("main", () => {
  const appDir = () => {
    const dir = join(mkdtempSync(join(tmpdir(), "gate-empty-")), "empty.app");
    mkdirSync(dir, { recursive: true });
    return dir;
  };
  const successDeps = (overrides = {}) => ({
    gsResourcesCheck: async () => ({ ok: true, detail: "stub gs tree" }),
    checkEngine: async ({ name }) => ({ ok: true, details: [{ ok: true, label: name, detail: "stub engine" }] }),
    run: async () => ({ stdout: 'fso-bundle-resolver-ok: "/pkg/Contents/MacOS"\n', stderr: "" }),
    ...overrides,
  });

  it("returns 1 when the package carries no engines", async () => {
    execFile.mockImplementation((_bin, _args, _options, callback) =>
      callback(null, 'fso-bundle-resolver-ok: "/nowhere"\n', ""),
    );
    const code = await main(["--triple", "aarch64-apple-darwin", "--bundle-dir", appDir()]);
    expect(code).toBe(1);
  });

  it("returns 0 and prints the PASS summary when every check succeeds", async () => {
    const logs = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const code = await main(["--triple", "aarch64-apple-darwin", "--bundle-dir", appDir()], successDeps());
      expect(code).toBe(0);
      const printed = logs.mock.calls.flat().join("\n");
      expect(printed).toMatch(/package gate: PASS \(\d+ checks for aarch64-apple-darwin\)/);
    } finally {
      logs.mockRestore();
    }
  });

  it("returns 1 when one engine fails even though the rest pass", async () => {
    const logs = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const code = await main(
        ["--triple", "aarch64-apple-darwin", "--bundle-dir", appDir()],
        successDeps({
          checkEngine: async ({ name }) =>
            name === "gs"
              ? { ok: false, details: [{ ok: false, label: "gs", detail: "stub failure" }] }
              : { ok: true, details: [{ ok: true, label: name, detail: "stub engine" }] },
        }),
      );
      expect(code).toBe(1);
      expect(logs.mock.calls.flat().join("\n")).toMatch(/FAIL gs — stub failure/);
    } finally {
      logs.mockRestore();
    }
  });

  it("prints exactly one FAIL package line when no package is found", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const code = await main(["--triple", "aarch64-apple-darwin"], { locateBundle: () => null });
      expect(code).toBe(1);
      const packageFailures = errors.mock.calls
        .flat()
        .filter((line) => typeof line === "string" && line.startsWith("FAIL package"));
      expect(packageFailures).toHaveLength(1);
    } finally {
      errors.mockRestore();
    }
  });
});
