// @vitest-environment node
import { afterEach, describe, expect, it, vi, beforeEach } from "vitest";
import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkVersion } from "../binaries/verify.mjs";
import {
  parseGateArgs,
  expectedEnginePaths,
  expectedVersions,
  enginePlan,
  gsRunArgs,
  gsResourcesCheck,
  locateBundle,
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
  it("throws instead of silently leaving a sixth bundled engine ungated", () => {
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
    ).toThrow(/sixth-engine/);
  });
});

describe("expectedVersions", () => {
  it("reads every engine's version from the manifest for the triple", () => {
    const arm = expectedVersions({ triple: "aarch64-apple-darwin", manifest });
    const armTarget = manifest.targets["aarch64-apple-darwin"];
    for (const name of ["vips", "gs", "qpdf", "ffmpeg", "ffprobe"]) {
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
});

describe("gsRunArgs", () => {
  it("prepends the package's own gs-resources -I flags on macOS", () => {
    const exeDir = join("/app", "Contents", "MacOS");
    const tree = join(exeDir, "..", "Resources", "gs-resources");
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
  it("passes no -I flags on Windows (ROM model)", () => {
    const stepArgs = enginePlan().get("gs").steps[0].args;
    const args = gsRunArgs({ exeDir: join("C:", "app"), triple: "x86_64-pc-windows-msvc", stepArgs });
    expect(args.some((arg) => arg.startsWith("-I"))).toBe(false);
    expect(args).toContain("-sOutputFile=out.pdf");
    expect(args).toContain("in.ps");
  });
  it("uses the caller's step args instead of re-reading the engine plan", () => {
    const stepArgs = ["-sDEVICE=pdfwrite", "-sOutputFile=custom.pdf", "custom.ps"];
    const args = gsRunArgs({ exeDir: join("/app", "Contents", "MacOS"), triple: "aarch64-apple-darwin", stepArgs });
    expect(args.slice(-stepArgs.length)).toEqual(stepArgs);
  });
});

describe("gsResourcesCheck", () => {
  it("passes on a complete package resource tree", () => {
    const app = mkdtempSync(join(tmpdir(), "gate-app-"));
    const tree = join(app, "Contents", "Resources", "gs-resources");
    for (const dir of ["Resource/Init", "lib", "Resource/Font", "fonts"]) {
      mkdirSync(join(tree, ...dir.split("/")), { recursive: true });
    }
    writeFileSync(join(tree, "Resource", "Init", "gs_init.ps"), "%!\n");
    const result = gsResourcesCheck({ exeDir: join(app, "Contents", "MacOS"), triple: "aarch64-apple-darwin" });
    expect(result.ok).toBe(true);
    expect(result.detail).toMatch(/iccprofiles absent/i);
  });
  it("notes when iccprofiles is present", () => {
    const app = mkdtempSync(join(tmpdir(), "gate-app-"));
    const tree = join(app, "Contents", "Resources", "gs-resources");
    for (const dir of ["Resource/Init", "lib", "Resource/Font", "fonts", "iccprofiles"]) {
      mkdirSync(join(tree, ...dir.split("/")), { recursive: true });
    }
    writeFileSync(join(tree, "Resource", "Init", "gs_init.ps"), "%!\n");
    const result = gsResourcesCheck({ exeDir: join(app, "Contents", "MacOS"), triple: "aarch64-apple-darwin" });
    expect(result.ok).toBe(true);
    expect(result.detail).toContain("-uICCProfilesDir applied");
  });
  it("fails when the tree is missing, naming every required piece", () => {
    const result = gsResourcesCheck({
      exeDir: join(mkdtempSync(join(tmpdir(), "gate-app-")), "Contents", "MacOS"),
      triple: "aarch64-apple-darwin",
    });
    expect(result.ok).toBe(false);
    expect(result.detail).toContain("Resource/Init");
    expect(result.detail).toContain("Resource/Font");
    expect(result.detail).toContain("gs_init.ps");
    expect(result.detail).toMatch(/compiled-in prefix/);
  });
  it("passes on Windows (ROM model)", () => {
    const result = gsResourcesCheck({ exeDir: join("C:", "app"), triple: "x86_64-pc-windows-msvc" });
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
});

describe("locateBundle", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("prefers the triple-specific bundle over a stale one", () => {
    const root = mkdtempSync(join(tmpdir(), "gate-root-"));
    const stale = join(root, "src-tauri", "target", "release", "bundle", "macos");
    const fresh = join(root, "src-tauri", "target", "aarch64-apple-darwin", "release", "bundle", "macos");
    mkdirSync(stale, { recursive: true });
    mkdirSync(fresh, { recursive: true });
    writeFileSync(join(stale, "stale.app"), "");
    writeFileSync(join(fresh, "fresh.app"), "");
    const found = locateBundle({ root, triple: "aarch64-apple-darwin" });
    expect(found.path).toBe(join(fresh, "fresh.app"));
  });
  it("refuses the broad fallback in CI so a wrong-triple bundle cannot pass", () => {
    const root = mkdtempSync(join(tmpdir(), "gate-root-"));
    const stale = join(root, "src-tauri", "target", "release", "bundle", "macos");
    mkdirSync(stale, { recursive: true });
    writeFileSync(join(stale, "arm64.app"), "");
    vi.stubEnv("GITHUB_ACTIONS", "true");
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(locateBundle({ root, triple: "x86_64-apple-darwin" })).toBe(null);
    const printed = errors.mock.calls.flat().join("\n");
    expect(printed).toContain(join("x86_64-apple-darwin", "release", "bundle"));
    expect(printed).toMatch(/fallback search is disabled in CI/);
  });
  it("falls back locally and prints which bundle it chose", () => {
    const root = mkdtempSync(join(tmpdir(), "gate-root-"));
    const stale = join(root, "src-tauri", "target", "release", "bundle", "macos");
    mkdirSync(stale, { recursive: true });
    writeFileSync(join(stale, "local.app"), "");
    vi.stubEnv("GITHUB_ACTIONS", "");
    const logs = vi.spyOn(console, "log").mockImplementation(() => {});
    const found = locateBundle({ root, triple: "x86_64-apple-darwin" });
    expect(found.path).toBe(join(stale, "local.app"));
    expect(logs.mock.calls.flat().join("\n")).toContain(join(stale, "local.app"));
  });
  it("returns null when the package was never built", () => {
    const root = mkdtempSync(join(tmpdir(), "gate-root-"));
    expect(locateBundle({ root, triple: "aarch64-apple-darwin" })).toBe(null);
  });
  it("returns null for a profile dir carrying plain-named engines and no bundle/", () => {
    const root = mkdtempSync(join(tmpdir(), "gate-root-"));
    const debug = join(root, "src-tauri", "target", "aarch64-apple-darwin", "debug");
    mkdirSync(debug, { recursive: true });
    for (const name of ["vips", "qpdf", "gs", "ffmpeg", "ffprobe"]) {
      writeFileSync(join(debug, name), "");
    }
    expect(
      locateBundle({ root, triple: "aarch64-apple-darwin" }),
      "a profile directory is not a package: tauri-build copies externalBin there with plain names",
    ).toBe(null);
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
  const plan = { fixtures: [], steps: [{ args: ["--empty", "out.pdf"], produces: "out.pdf" }] };
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

  it("fails on a version mismatch", async () => {
    const result = await checkEngine(
      options({
        binPath: existingBinary(),
        checkVersion: async () => ({ ok: false, detail: "expected '12.4.2', got: 12.4.1" }),
      }),
    );
    expect(result.ok).toBe(false);
    expect(result.details.some((detail) => !detail.ok && detail.detail.includes("12.4.1"))).toBe(true);
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

  it("asks checkVersion for the package env and strips DYLD_LIBRARY_PATH from the operations", async () => {
    const checkVersionFn = vi.fn(async () => ({ ok: true, detail: "qpdf version 12.4.2" }));
    const runFn = vi.fn(async (_bin, _args, { cwd }) => {
      writeFileSync(join(cwd, "out.pdf"), "%PDF-1.7");
      return { stdout: "", stderr: "" };
    });
    await checkEngine(options({ binPath: existingBinary(), checkVersion: checkVersionFn, run: runFn }));
    expect(checkVersionFn.mock.calls[0][4]).toEqual({ env: process.env });
    const runOptions = runFn.mock.calls[0][2];
    expect(runOptions.timeout).toBe(60_000);
    expect(runOptions.env.DYLD_LIBRARY_PATH).toBeUndefined();
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
});

describe("main", () => {
  it("returns 1 when the package carries no engines", async () => {
    const appDir = join(mkdtempSync(join(tmpdir(), "gate-empty-")), "empty.app");
    mkdirSync(appDir, { recursive: true });
    execFile.mockImplementation((_bin, _args, _options, callback) =>
      callback(null, 'fso-bundle-resolver-ok: "/nowhere"\n', ""),
    );
    const code = await main(["--triple", "aarch64-apple-darwin", "--bundle-dir", appDir]);
    expect(code).toBe(1);
  });
});
