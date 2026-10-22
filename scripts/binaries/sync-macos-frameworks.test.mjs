// @vitest-environment node
import { afterAll, describe, expect, it } from "vitest";

import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";import { tmpdir } from "node:os";
import { join } from "node:path";

import { parseCliTarget, syncMacosFrameworks } from "./sync-macos-frameworks.mjs";

const cleanupRoots = [];
async function tempRoot(prefix) {
  const root = await mkdtemp(`${tmpdir()}/${prefix}`);
  cleanupRoots.push(root);
  return root;
}

afterAll(async () => {
  await Promise.all(cleanupRoots.map((root) => rm(root, { recursive: true, force: true })));
});

const BASE_CONF = {
  $schema: "https://schema.tauri.app/config/2",
  productName: "yard",
  version: "0.1.0",
  identifier: "com.yard.app",
  build: {
    beforeDevCommand: "yarn dev",
    devUrl: "http://localhost:5173",
    beforeBuildCommand: "yarn build",
    frontendDist: "../dist",
  },
  bundle: {
    active: true,
    targets: "all",
    macOS: {
      frameworks: ["frameworks/libStale.9.dylib", "frameworks/libMissing-altogether.3.dylib"],
    },
  },
};

async function writeConf(root, conf = BASE_CONF) {
  await mkdir(join(root, "src-tauri"), { recursive: true });
  const text = `${JSON.stringify(conf, null, 2)}\n`;
  await writeFile(join(root, "src-tauri", "tauri.conf.json"), text, "utf8");
  return text;
}

async function stageFrameworks(root, names) {
  const dir = join(root, "src-tauri", "frameworks");
  await mkdir(dir, { recursive: true });
  for (const name of names) {
    await writeFile(join(dir, name), `${name}-bytes`, "utf8");
  }
  return dir;
}

describe("syncMacosFrameworks", () => {
  it("rewrites bundle.macOS.frameworks to the exact sorted dylib list of the staged tree (top level only)", async () => {
    const root = await tempRoot("sync-fw-");
    const before = await writeConf(root);
    await stageFrameworks(root, ["libzeta.2.dylib", "libAlpha.1.dylib", "libnested-not-ignored.0.dylib"]);
    await mkdir(join(root, "src-tauri", "frameworks", "nested"), { recursive: true });
    await writeFile(join(root, "src-tauri", "frameworks", "nested", "libdeep.1.dylib"), "deep", "utf8");

    const result = await syncMacosFrameworks({ target: "aarch64-apple-darwin", root });
    expect(result.changed).toBe(true);

    const conf = JSON.parse(await readFile(join(root, "src-tauri", "tauri.conf.json"), "utf8"));
    expect(conf.bundle.macOS.frameworks).toEqual([
      "frameworks/libAlpha.1.dylib",
      "frameworks/libnested-not-ignored.0.dylib",
      "frameworks/libzeta.2.dylib",
    ]);
    expect(conf.productName).toBe("yard");
    const after = await readFile(join(root, "src-tauri", "tauri.conf.json"), "utf8");
    expect(after).not.toBe(before);
    expect(after.endsWith("\n")).toBe(true);
  });

  it("is idempotent — the second run reports already-in-sync and leaves the file byte-identical", async () => {
    const root = await tempRoot("sync-fw-");
    await writeConf(root);
    await stageFrameworks(root, ["libA.1.dylib", "libB.2.dylib"]);
    const first = await syncMacosFrameworks({ target: "aarch64-apple-darwin", root });
    expect(first.changed).toBe(true);

    const bytes = await readFile(join(root, "src-tauri", "tauri.conf.json"), "utf8");
    const second = await syncMacosFrameworks({ target: "aarch64-apple-darwin", root });
    expect(second.changed).toBe(false);
    expect(second.frameworks).toEqual(["frameworks/libA.1.dylib", "frameworks/libB.2.dylib"]);
    expect(await readFile(join(root, "src-tauri", "tauri.conf.json"), "utf8")).toBe(bytes);
  });

  it("preserves the rest of the config object and canonical 2-space indentation", async () => {
    const root = await tempRoot("sync-fw-");
    await writeConf(root);
    await stageFrameworks(root, ["libA.1.dylib"]);
    await syncMacosFrameworks({ target: "aarch64-apple-darwin", root });
    const text = await readFile(join(root, "src-tauri", "tauri.conf.json"), "utf8");
    expect(text).toContain('$schema": "https://schema.tauri.app/config/2');
    expect(text).toContain('"beforeDevCommand": "yarn dev"');
    expect(text.split("\n")[0]).toBe("{");
    const serialized = `${JSON.stringify(JSON.parse(text), null, 2)}\n`;
    expect(text).toBe(serialized);
  });

  it("refuses with a clear error when the frameworks dir is missing", async () => {
    const root = await tempRoot("sync-fw-");
    await writeConf(root);
    await expect(syncMacosFrameworks({ target: "aarch64-apple-darwin", root })).rejects.toThrow(
      /frameworks .* missing|missing .*frameworks/,
    );
  });

  it("refuses when the frameworks dir holds no dylib", async () => {
    const root = await tempRoot("sync-fw-");
    await writeConf(root);
    await mkdir(join(root, "src-tauri", "frameworks"), { recursive: true });
    await writeFile(join(root, "src-tauri", "frameworks", "README.txt"), "not a dylib", "utf8");
    await expect(syncMacosFrameworks({ target: "x86_64-apple-darwin", root })).rejects.toThrow(/no .*dylib|empty/i);
  });

  it("repairs an existing empty frameworks list in the conf", async () => {
    const root = await tempRoot("sync-fw-");
    const conf = JSON.parse(JSON.stringify(BASE_CONF));
    conf.bundle.macOS.frameworks = [];
    await writeConf(root, conf);
    await stageFrameworks(root, ["libA.1.dylib"]);
    await syncMacosFrameworks({ target: "aarch64-apple-darwin", root });
    const after = JSON.parse(await readFile(join(root, "src-tauri", "tauri.conf.json"), "utf8"));
    expect(after.bundle.macOS.frameworks).toEqual(["frameworks/libA.1.dylib"]);
  });

  it("skips windows triples — windows staging never creates src-tauri/frameworks", async () => {
    const root = await tempRoot("sync-fw-");
    const before = await writeConf(root);
    const result = await syncMacosFrameworks({ target: "x86_64-pc-windows-msvc", root });
    expect(result.changed).toBe(false);
    expect(result.skip).toBe(true);
    expect(await readFile(join(root, "src-tauri", "tauri.conf.json"), "utf8")).toBe(before);
  });

  it("rejects an unknown triple instead of silently skipping the sync", async () => {
    const root = await tempRoot("sync-fw-");
    await writeConf(root);
    await expect(syncMacosFrameworks({ target: "mips-unknown-linux-gnu", root })).rejects.toThrow(/unknown triple/);
  });

  it("CLI: --target is required, unknown triples refused, missing frameworks/ and missing tauri.conf.json abort loudly", async () => {
    expect(() => parseCliTarget([])).toThrow(/--target .* is required/i);
    expect(() => parseCliTarget(["--target", "mips-unknown-linux-gnu"])).toThrow(/unknown triple/);
    const root = await tempRoot("sync-fw-");
    await mkdir(join(root, "src-tauri"), { recursive: true });
    const { target } = parseCliTarget(["--target", "aarch64-apple-darwin"]);
    await expect(syncMacosFrameworks({ target, root })).rejects.toThrow(/frameworks/);
    await stageFrameworks(root, ["libA.1.dylib"]);
    await mkdir(join(root, "src-tauri", "frameworks"), { recursive: true });
    await rm(join(root, "src-tauri", "tauri.conf.json"), { force: false }).catch(() => {});
    await rm(join(root, "src-tauri", "tauri.conf.json"), { force: true });
    await expect(syncMacosFrameworks({ target, root })).rejects.toThrow(/tauri\.conf\.json/);
  });
});
