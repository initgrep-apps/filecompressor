// @vitest-environment node
import { describe, expect, it } from "vitest";

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const FREEZE = join(HERE, "freeze.sh");
const UNFREEZE = join(HERE, "unfreeze.sh");

const ENGINES = ["ffmpeg", "ffprobe", "qpdf", "vips", "gs"];
const MAC_TRIPLE = "aarch64-apple-darwin";
const ENGINE_PAYLOADS = Object.fromEntries(
  ENGINES.map((engine) => [engine, `payload for ${engine} on ${MAC_TRIPLE}\n`]),
);

function runScript(script, args, options = {}) {
  return new Promise((resolvePromise) => {
    execFile("bash", [script, ...args], { encoding: "utf8", timeout: 60_000, ...options }, (error, stdout, stderr) => {
      const code = error?.code ?? (error?.signal ? 255 : 0);
      resolvePromise({ code, stdout, stderr, signal: error?.signal ?? null });
    });
  });
}

async function freezeFixture() {
  const root = await mkdtemp(join(tmpdir(), "unfreeze-src-"));
  const bin = join(root, "src-tauri", "binaries");
  await mkdir(bin, { recursive: true });
  for (const [engine, payload] of Object.entries(ENGINE_PAYLOADS)) {
    await writeFile(join(bin, `${engine}-${MAC_TRIPLE}`), payload);
  }
  const frameworks = join(root, "src-tauri", "frameworks");
  await mkdir(frameworks, { recursive: true });
  await writeFile(join(frameworks, "libvips-test.42.dylib"), "libvips dylib payload\n");
  const init = join(root, "src-tauri", "gs-resources", "Resource", "Init");
  await mkdir(init, { recursive: true });
  await writeFile(join(init, "gs_init.ps"), "ghostscript init payload\n");

  const result = await runScript(FREEZE, ["--triple", MAC_TRIPLE, "--root", root]);
  expect(result.code, `fixture freeze failed: ${result.stderr}`).toBe(0);
  return root;
}

async function withRoot(body) {
  const root = await mkdtemp(join(tmpdir(), "unfreeze-dest-"));
  try {
    return await body(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

const restoredBinary = (root, engine) =>
  readFile(join(root, "src-tauri", "binaries", `${engine}-${MAC_TRIPLE}`), "utf8");
const restoredInit = (root) => readFile(join(root, "src-tauri", "gs-resources", "Resource", "Init", "gs_init.ps"), "utf8");

describe("unfreeze.sh", () => {
  it("restores_the_frozen_tree_into_a_clean_src_tauri_with_no_extraction_litter", async () => {
    const srcRoot = await freezeFixture();
    await withRoot(async (destRoot) => {
      const bundle = join(srcRoot, "src-tauri", ".freeze", `sidecar-bundle-${MAC_TRIPLE}.tar.gz`);

      const result = await runScript(UNFREEZE, ["--triple", MAC_TRIPLE, "--archive", bundle, "--root", destRoot]);

      expect(result.code, `stdout: ${result.stdout}\nstderr: ${result.stderr}`).toBe(0);
      for (const engine of ENGINES) {
        expect(
          await restoredBinary(destRoot, engine),
          "each frozen engine comes back byte-for-byte",
        ).toBe(ENGINE_PAYLOADS[engine]);
      }
      expect(
        await readFile(join(destRoot, "src-tauri", "frameworks", "libvips-test.42.dylib"), "utf8"),
      ).toBe("libvips dylib payload\n");
      expect(await restoredInit(destRoot)).toBe("ghostscript init payload\n");
      expect(
        (await readdir(join(destRoot, "src-tauri", ".freeze"))).length,
        "the extraction temp dir is cleaned up",
      ).toBe(0);
    });
    await rm(srcRoot, { recursive: true, force: true });
  });

  it("fails_closed_on_a_sha_mismatch_without_extracting_anything", async () => {
    const srcRoot = await freezeFixture();
    await withRoot(async (destRoot) => {
      const bundle = join(destRoot, "tampered.tar.gz");
      await copyFile(
        join(srcRoot, "src-tauri", ".freeze", `sidecar-bundle-${MAC_TRIPLE}.tar.gz`),
        bundle,
      );
      await copyFile(
        join(srcRoot, "src-tauri", ".freeze", `sidecar-bundle-${MAC_TRIPLE}.tar.gz.sha256`),
        `${bundle}.sha256`,
      );
      await writeFile(bundle, "\0", { flag: "a" });

      const result = await runScript(UNFREEZE, ["--triple", MAC_TRIPLE, "--archive", bundle, "--root", destRoot]);

      expect(result.code).toBe(1);
      expect(result.stderr).toMatch(/sha256 mismatch/i);
      expect(
        existsSync(join(destRoot, "src-tauri", "binaries")),
        "a tampered bundle must not reach the destination tree",
      ).toBe(false);
      expect(existsSync(join(destRoot, "src-tauri")), "the destination stays untouched until the bundle verifies").toBe(
        false,
      );
    });
    await rm(srcRoot, { recursive: true, force: true });
  });

  it("fails_closed_when_the_archive_does_not_exist", async () => {
    await withRoot(async (destRoot) => {
      const result = await runScript(UNFREEZE, [
        "--triple",
        MAC_TRIPLE,
        "--archive",
        join(destRoot, "absent.tar.gz"),
        "--root",
        destRoot,
      ]);

      expect(result.code).toBe(1);
      expect(result.stderr).toContain("absent.tar.gz");
      expect(existsSync(join(destRoot, "src-tauri"))).toBe(false);
    });
  });

  it("fails_closed_when_the_sha256_sibling_is_missing", async () => {
    const srcRoot = await freezeFixture();
    await withRoot(async (destRoot) => {
      const bundle = join(destRoot, "unverified.tar.gz");
      await copyFile(join(srcRoot, "src-tauri", ".freeze", `sidecar-bundle-${MAC_TRIPLE}.tar.gz`), bundle);

      const result = await runScript(UNFREEZE, ["--triple", MAC_TRIPLE, "--archive", bundle, "--root", destRoot]);

      expect(result.code).toBe(1);
      expect(result.stderr).toMatch(/\.sha256/);
      expect(existsSync(join(destRoot, "src-tauri"))).toBe(false);
    });
    await rm(srcRoot, { recursive: true, force: true });
  });

  it("fails_closed_when_the_extracted_bundle_is_missing_the_gs_init_marker", async () => {
    await withRoot(async (destRoot) => {
      const payload = join(destRoot, "payload");
      await mkdir(join(payload, "binaries"), { recursive: true });
      await mkdir(join(payload, "frameworks"), { recursive: true });
      await writeFile(join(payload, "binaries", `ffmpeg-${MAC_TRIPLE}`), ENGINE_PAYLOADS.ffmpeg);
      await writeFile(join(payload, "frameworks", "libvips-test.42.dylib"), "libvips dylib payload\n");
      const bundle = join(destRoot, "handmade.tar.gz");
      await new Promise((resolvePromise, reject) => {
        execFile("tar", ["-czf", bundle, "-C", payload, "binaries", "frameworks"], (error) =>
          error ? reject(error) : resolvePromise(),
        );
      });
      const digest = createHash("sha256").update(await readFile(bundle)).digest("hex");
      await writeFile(`${bundle}.sha256`, `${digest}  handmade.tar.gz\n`);

      const result = await runScript(UNFREEZE, ["--triple", MAC_TRIPLE, "--archive", bundle, "--root", destRoot]);

      expect(result.code).toBe(1);
      expect(result.stderr).toMatch(/gs_init\.ps/);
      expect(
        existsSync(join(destRoot, "src-tauri", "binaries")),
        "the swap happens only after the whole payload validates",
      ).toBe(false);
    });
  });

  it("rejects_non_mac_triples", async () => {
    await withRoot(async (destRoot) => {
      const result = await runScript(UNFREEZE, [
        "--triple",
        "x86_64-pc-windows-msvc",
        "--archive",
        join(destRoot, "anything.tar.gz"),
        "--root",
        destRoot,
      ]);

      expect(result.code).toBe(1);
      expect(result.stderr).toContain("x86_64-pc-windows-msvc");
      expect(existsSync(join(destRoot, "src-tauri"))).toBe(false);
    });
  });

  it("refuses_the_download_path_without_GH_TOKEN", async () => {
    await withRoot(async (destRoot) => {
      const env = { ...process.env };
      delete env.GH_TOKEN;

      const result = await runScript(UNFREEZE, ["--triple", MAC_TRIPLE, "--root", destRoot], { env });

      expect(result.code).toBe(1);
      expect(result.stderr).toContain("GH_TOKEN");
      expect(existsSync(join(destRoot, "src-tauri"))).toBe(false);
    });
  });
});
