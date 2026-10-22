// @vitest-environment node
import { describe, expect, it, vi, beforeEach } from "vitest";
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
  locateBundle,
  checkStepOutput,
  resolverCheck,
  resolverCommand,
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
  it("gives every engine a version check and at least one operation", () => {
    for (const [name, plan] of enginePlan()) {
      expect(plan.versionArgs.length, name).toBeGreaterThan(0);
      expect(plan.steps.length, name).toBeGreaterThan(0);
    }
  });
});

describe("gsRunArgs", () => {
  it("prepends the package's own gs-resources -I flags on macOS", () => {
    const exeDir = join("/app", "Contents", "MacOS");
    const tree = join(exeDir, "..", "Resources", "gs-resources");
    const args = gsRunArgs({ exeDir, triple: "aarch64-apple-darwin" });
    expect(args[0]).toBe("-I");
    expect(args[1]).toBe(join(tree, "Resource", "Init"));
    expect(args[2]).toBe("-I");
    expect(args[3]).toBe(join(tree, "lib"));
    expect(args[4]).toBe("-I");
    expect(args[5]).toBe(join(tree, "Resource", "Font"));
    expect(args[6]).toBe("-I");
    expect(args[7]).toBe(join(tree, "fonts"));
    expect(args).toContain("-sOutputFile=out.pdf");
  });
  it("passes no -I flags on Windows (ROM model)", () => {
    const args = gsRunArgs({ exeDir: join("C:", "app"), triple: "x86_64-pc-windows-msvc" });
    expect(args.some((arg) => arg.startsWith("-I"))).toBe(false);
    expect(args).toContain("-sOutputFile=out.pdf");
    expect(args).toContain("in.ps");
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
});

describe("locateBundle", () => {
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
});
