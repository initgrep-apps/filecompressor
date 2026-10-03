// @vitest-environment node
import { describe, it, expect, afterAll } from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prepTarget } from "./prep.mjs";

const cleanupRoots = [];

async function makeRoot(manifest) {
  const root = await mkdtemp(`${tmpdir()}/prep-test-`);
  cleanupRoots.push(root);
  await mkdir(`${root}/scripts`, { recursive: true });
  await writeFile(`${root}/scripts/binaries.manifest.json`, JSON.stringify(manifest));
  return root;
}

afterAll(async () => {
  await Promise.all(cleanupRoots.map((root) => rm(root, { recursive: true, force: true })));
});

const URL_ONLY = {
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

const WITH_BREW = {
  targets: {
    "aarch64-apple-darwin": {
      ...URL_ONLY.targets["aarch64-apple-darwin"],
      vips: { source: "brew", formula: "vips", dest: "vips", expectVersion: "8.18.7" },
    },
  },
};

describe("prepTarget", () => {
  it("is a no-op when the target has no brew entries", async () => {
    const root = await makeRoot(URL_ONLY);
    await expect(prepTarget("aarch64-apple-darwin", root)).resolves.toBe(true);
  });

  it("fails loudly when a brew entry has no prep implementation yet", async () => {
    const root = await makeRoot(WITH_BREW);
    await expect(prepTarget("aarch64-apple-darwin", root)).rejects.toThrow(
      /vips for aarch64-apple-darwin are brew-owned entries with no prep implementation/,
    );
  });

  it("fails on a target that is not in the manifest", async () => {
    const root = await makeRoot(URL_ONLY);
    await expect(prepTarget("x86_64-apple-darwin", root)).rejects.toThrow(
      /target 'x86_64-apple-darwin' not in manifest \(known: aarch64-apple-darwin\)/,
    );
  });

  it("fails when the manifest is missing", async () => {
    const root = await mkdtemp(`${tmpdir()}/prep-test-empty-`);
    cleanupRoots.push(root);
    await expect(prepTarget("aarch64-apple-darwin", root)).rejects.toThrow(/manifest missing/);
  });

  it("names the generation command when tauri.conf needs absent frameworks", async () => {
    const root = await makeRoot(URL_ONLY);
    await mkdir(`${root}/src-tauri`, { recursive: true });
    await writeFile(
      `${root}/src-tauri/tauri.conf.json`,
      JSON.stringify({ bundle: { resources: ["frameworks/libfoo.dylib"] } }),
    );

    await expect(prepTarget("aarch64-apple-darwin", root)).rejects.toThrow(
      /references 1 dylibs under src-tauri\/frameworks\/ but that directory is absent/,
    );
    await expect(prepTarget("aarch64-apple-darwin", root)).rejects.toThrow(
      /bundle-vips-macos\.sh && bash scripts\/bundle-pdf-macos\.sh/,
    );
  });

  it("does not complain about frameworks when the directory exists", async () => {
    const root = await makeRoot(URL_ONLY);
    await mkdir(`${root}/src-tauri/frameworks`, { recursive: true });
    await writeFile(
      `${root}/src-tauri/tauri.conf.json`,
      JSON.stringify({ bundle: { resources: ["frameworks/libfoo.dylib"] } }),
    );

    await expect(prepTarget("aarch64-apple-darwin", root)).resolves.toBe(true);
  });
});