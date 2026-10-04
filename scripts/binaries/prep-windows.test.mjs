// @vitest-environment node
import { vi, describe, expect, it, afterAll } from "vitest";

vi.setConfig({ testTimeout: 30_000 });
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));

const roots = [];

afterAll(async () => {
  for (const root of roots) {
    await rm(root, { recursive: true, force: true }).catch(() => {});
  }
});

async function tempRoot(label) {
  const root = await mkdtemp(join(tmpdir(), label));
  roots.push(root);
  return root;
}

async function writeFileAt(path, content = "x") {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content);
}

async function stageEntry(root, name, triple, files) {
  for (const [relative, content] of Object.entries(files)) {
    await writeFileAt(join(root, "src-tauri", ".staging", `${name}-${triple}`, relative), content);
  }
}

const X64 = "x86_64-pc-windows-msvc";

const VIPS_MEMBER = "vips-dev-8.18/bin/vips.exe";
const QPDF_MEMBER = "qpdf-12.4.2-msvc64/bin/qpdf.exe";
const GS_MEMBER = "ucrt64/bin/gswin64c.exe";

const GS_RESOURCE_DIRS = ["Resource", "lib", "iccprofiles", "fonts"];

function gsResources() {
  return GS_RESOURCE_DIRS.map((name) => `share/ghostscript/10.08.0/${name}`);
}

function gsResourceFiles() {
  return {
    "ucrt64/share/ghostscript/10.08.0/Resource/Init/gs_init.ps": "%!PS\n",
    "ucrt64/share/ghostscript/10.08.0/Resource/Font/NimbusRoman-Regular": "font",
    "ucrt64/share/ghostscript/10.08.0/lib/gs_init.ps": "%!PS\n",
    "ucrt64/share/ghostscript/10.08.0/iccprofiles/default_rgb.icc": "profile",
    "ucrt64/share/ghostscript/10.08.0/fonts/NimbusRoman-Regular": "font",
  };
}

async function prepWindows(root, triple, entries) {
  const { prepWindowsEngines } = await import("./prep-windows.mjs");
  return prepWindowsEngines(root, triple, entries);
}

describe("prep-windows engine folders", () => {
  it("prep_stages_vips_exe_with_sibling_dlls_and_modules_subdir", async () => {
    const root = await tempRoot("prep-win-vips-");
    await stageEntry(root, "vips", X64, {
      [VIPS_MEMBER]: "vips-exe",
      "vips-dev-8.18/bin/foo.dll": "dll",
      "vips-dev-8.18/bin/libglib-2.0-0.dll": "dll",
      "vips-dev-8.18/bin/vips-modules-8.18/vips-jxl.dll": "module",
      "vips-dev-8.18/include/vips.h": "header",
    });

    const staged = await prepWindows(root, X64, {
      vips: { member: VIPS_MEMBER, dest: "vips", resources: [] },
    });

    const engine = join(root, "src-tauri", "binaries", "engines", "vips");
    expect(staged).toEqual([engine]);
    expect(existsSync(join(engine, "vips.exe"))).toBe(true);
    expect(existsSync(join(engine, "foo.dll"))).toBe(true);
    expect(existsSync(join(engine, "libglib-2.0-0.dll"))).toBe(true);
    expect(existsSync(join(engine, "vips-modules-8.18", "vips-jxl.dll"))).toBe(true);
    expect(
      existsSync(join(engine, "vips.h")),
      "headers and sources are not runtime payload and must not be shipped",
    ).toBe(false);
  });

  it("prep_stages_qpdf_exe_with_vc_runtime_dlls", async () => {
    const root = await tempRoot("prep-win-qpdf-");
    await stageEntry(root, "qpdf", X64, {
      [QPDF_MEMBER]: "qpdf-exe",
      "qpdf-12.4.2-msvc64/bin/msvcp140.dll": "dll",
      "qpdf-12.4.2-msvc64/bin/vcruntime140_1.dll": "dll",
      "qpdf-12.4.2-msvc64/bin/fix-qdf.exe": "other-tool",
      "qpdf-12.4.2-msvc64/lib/libqpdf.dll.a": "import-lib",
    });

    const staged = await prepWindows(root, X64, {
      qpdf: { member: QPDF_MEMBER, dest: "qpdf", resources: [] },
    });

    const engine = join(root, "src-tauri", "binaries", "engines", "qpdf");
    expect(staged).toEqual([engine]);
    expect(existsSync(join(engine, "qpdf.exe"))).toBe(true);
    expect(existsSync(join(engine, "msvcp140.dll"))).toBe(true);
    expect(existsSync(join(engine, "vcruntime140_1.dll"))).toBe(true);
    expect(
      existsSync(join(engine, "fix-qdf.exe")),
      "only the engine's own exe is staged; sibling tools would shadow nothing and bloat the bundle",
    ).toBe(false);
  });

  it("prep_stages_gs_renamed_exe_dlls_and_resources_tree", async () => {
    const root = await tempRoot("prep-win-gs-");
    await stageEntry(root, "gs", X64, {
      [GS_MEMBER]: "gswin64c",
      "ucrt64/bin/libgs-10.dll": "dll",
      "ucrt64/bin/gs.exe": "msys-wrapper",
      ...gsResourceFiles(),
    });

    const staged = await prepWindows(root, X64, {
      gs: {
        member: GS_MEMBER,
        dest: "gs",
        resources: gsResources(),
      },
    });

    const engine = join(root, "src-tauri", "binaries", "engines", "gs");
    expect(staged).toContain(engine);
    expect(
      existsSync(join(engine, "gs.exe")),
      "gswin64c.exe must be staged as gs.exe, which is the name the Rust resolver asks for",
    ).toBe(true);
    expect(existsSync(join(engine, "libgs-10.dll"))).toBe(true);
    const resources = join(root, "src-tauri", "gs-resources");
    expect(
      await readFile(join(resources, "Resource", "Init", "gs_init.ps"), "utf8"),
    ).toBe("%!PS\n");
    for (const name of GS_RESOURCE_DIRS) {
      expect(existsSync(join(resources, name)), `${name} must be staged`).toBe(true);
    }
  });

  it("names the missing ghostscript resource tree instead of staging a hollow gs", async () => {
    const root = await tempRoot("prep-win-gs-missing-");
    await stageEntry(root, "gs", X64, {
      [GS_MEMBER]: "gswin64c",
      "ucrt64/bin/libgs-10.dll": "dll",
      "ucrt64/share/ghostscript/10.08.0/lib/gs_init.ps": "%!PS\n",
    });

    await expect(
      prepWindows(root, X64, { gs: { member: GS_MEMBER, dest: "gs", resources: gsResources() } }),
    ).rejects.toThrow(
      /'ucrt64\/share\/ghostscript\/10\.08\.0\/Resource' is missing from the staged package/,
    );
  });

  it("refuses a resource tree with no Resource/Init/gs_init.ps", async () => {
    const root = await tempRoot("prep-win-gs-noinit-");
    const files = gsResourceFiles();
    delete files["ucrt64/share/ghostscript/10.08.0/Resource/Init/gs_init.ps"];
    await stageEntry(root, "gs", X64, {
      [GS_MEMBER]: "gswin64c",
      "ucrt64/bin/libgs-10.dll": "dll",
      ...files,
    });

    await expect(
      prepWindows(root, X64, { gs: { member: GS_MEMBER, dest: "gs", resources: gsResources() } }),
    ).rejects.toThrow(/has no Resource\/Init\/gs_init\.ps/);
  });

  it("stages the four acceptance sentinels next to the real resource files", async () => {
    const { gsSentinelPaths } = await import("./gs-sentinels.mjs");
    const root = await tempRoot("prep-win-gs-sentinels-");
    await stageEntry(root, "gs", X64, {
      [GS_MEMBER]: "gswin64c",
      "ucrt64/bin/libgs-10.dll": "dll",
      ...gsResourceFiles(),
      "share/ghostscript/10.08.0/Resource/Font/NimbusRoman-Regular": "font",
    });

    await prepWindows(root, X64, {
      gs: { member: GS_MEMBER, dest: "gs", resources: gsResources() },
    });

    const resources = join(root, "src-tauri", "gs-resources");
    for (const relative of gsSentinelPaths()) {
      expect(existsSync(join(resources, relative)), `${relative} must be staged`).toBe(true);
    }
  });

  it("reports a missing staged member with the archive layout it did find", async () => {
    const root = await tempRoot("prep-win-missing-member-");
    await stageEntry(root, "vips", X64, { "vips-dev-8.18/bin/other.dll": "dll" });

    await expect(
      prepWindows(root, X64, { vips: { member: VIPS_MEMBER, dest: "vips", resources: [] } }),
    ).rejects.toThrow(
      new RegExp(`staged member '${VIPS_MEMBER.replace(/\//g, "\\/")}' is missing`),
    );
  });

  it("refuses to stage an engine with no dlls or payload beside the exe", async () => {
    const root = await tempRoot("prep-win-bare-");
    await stageEntry(root, "vips", X64, { [VIPS_MEMBER]: "vips-exe" });

    await expect(
      prepWindows(root, X64, { vips: { member: VIPS_MEMBER, dest: "vips", resources: [] } }),
    ).rejects.toThrow(/no DLLs or payload/i);
  });

  it("replaces a previous engine folder transactionally", async () => {
    const root = await tempRoot("prep-win-stale-");
    const engine = join(root, "src-tauri", "binaries", "engines", "vips");
    mkdirSync(engine, { recursive: true });
    writeFileSync(join(engine, "stale.dll"), "stale");
    await stageEntry(root, "vips", X64, {
      [VIPS_MEMBER]: "vips-exe",
      "vips-dev-8.18/bin/fresh.dll": "dll",
    });

    await prepWindows(root, X64, { vips: { member: VIPS_MEMBER, dest: "vips", resources: [] } });

    expect(existsSync(join(engine, "fresh.dll"))).toBe(true);
    expect(
      existsSync(join(engine, "stale.dll")),
      "a re-prep must not leave artifacts from a previous run behind",
    ).toBe(false);
  });
});