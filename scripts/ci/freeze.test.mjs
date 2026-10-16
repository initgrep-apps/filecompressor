// @vitest-environment node
import { describe, expect, it } from "vitest";

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, unlink, writeFile, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const FREEZE = join(HERE, "freeze.sh");

const ENGINES = ["ffmpeg", "ffprobe", "qpdf", "vips", "gs"];
const MAC_TRIPLE = "aarch64-apple-darwin";

function runScript(script, args, options = {}) {
  return new Promise((resolvePromise) => {
    execFile("bash", [script, ...args], { encoding: "utf8", timeout: 60_000, ...options }, (error, stdout, stderr) => {
      const code = error?.code ?? (error?.signal ? 255 : 0);
      resolvePromise({ code, stdout, stderr, signal: error?.signal ?? null });
    });
  });
}

function runTool(tool, args) {
  return new Promise((resolvePromise, reject) => {
    execFile(tool, args, { encoding: "utf8" }, (error, stdout, stderr) => {
      if (error) {
        error.stdout = stdout;
        error.stderr = stderr;
        reject(error);
        return;
      }
      resolvePromise({ stdout, stderr });
    });
  });
}

async function withRoot(body) {
  const root = await mkdtemp(join(tmpdir(), "freeze-test-"));
  try {
    return await body(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function payloadFor(engine, triple) {
  return `payload for ${engine} on ${triple}\n`;
}

async function stageTree(root, triple) {
  const bin = join(root, "src-tauri", "binaries");
  await mkdir(bin, { recursive: true });
  for (const engine of ENGINES) {
    await writeFile(join(bin, `${engine}-${triple}`), payloadFor(engine, triple));
  }
  const frameworks = join(root, "src-tauri", "frameworks");
  await mkdir(frameworks, { recursive: true });
  await writeFile(join(frameworks, "libvips-test.42.dylib"), "libvips dylib payload\n");
  const init = join(root, "src-tauri", "gs-resources", "Resource", "Init");
  await mkdir(init, { recursive: true });
  await writeFile(join(init, "gs_init.ps"), "ghostscript init payload\n");
}

function bundlePath(root, triple) {
  return join(root, "src-tauri", ".freeze", `sidecar-bundle-${triple}.tar.gz`);
}

const WINDOWS_TRIPLE = "x86_64-pc-windows-msvc";

async function stageWindowsTree(root, triple) {
  const bin = join(root, "src-tauri", "binaries");
  await mkdir(bin, { recursive: true });
  await writeFile(join(bin, `ffmpeg-${triple}.exe`), `ffmpeg payload for ${triple}\n`);
  await writeFile(join(bin, `ffprobe-${triple}.exe`), `ffprobe payload for ${triple}\n`);
  for (const engine of ["vips", "qpdf", "gs"]) {
    const enginesDir = join(bin, "engines", engine);
    await mkdir(enginesDir, { recursive: true });
    await writeFile(join(enginesDir, `${engine}.exe`), `${engine} engine payload\n`);
    await writeFile(join(enginesDir, `${engine}-support.dll`), `${engine} dll payload\n`);
  }
  const init = join(root, "src-tauri", "gs-resources", "Resource", "Init");
  await mkdir(init, { recursive: true });
  await writeFile(join(init, "gs_init.ps"), "ghostscript init payload\n");
}

async function readSha(root, bundle) {
  return readFile(`${bundle}.sha256`, "utf8");
}

describe("freeze.sh", () => {
  it("packages_the_five_engines_frameworks_and_gs_resources_with_paths_rooted_for_src_tauri", async () => {
    await withRoot(async (root) => {
      await stageTree(root, MAC_TRIPLE);

      const result = await runScript(FREEZE, ["--triple", MAC_TRIPLE, "--root", root]);

      expect(result.code, `stdout: ${result.stdout}\nstderr: ${result.stderr}`).toBe(0);
      expect(existsSync(bundlePath(root, MAC_TRIPLE)), result.stderr).toBe(true);

      const listed = await runTool("tar", ["-tzf", bundlePath(root, MAC_TRIPLE)]);
      const entries = listed.stdout.split("\n").filter(Boolean);
      for (const engine of ENGINES) {
        expect(entries).toContain(`binaries/${engine}-${MAC_TRIPLE}`);
      }
      expect(
        entries.every((entry) => /^(binaries|frameworks|gs-resources)\//.test(entry)),
        `every entry must extract directly into src-tauri, got:\n${entries.join("\n")}`,
      ).toBe(true);
      expect(entries.some((entry) => /^frameworks\/.+/.test(entry)), "frozen dylibs are inside the bundle").toBe(true);
      expect(entries).toContain("gs-resources/Resource/Init/gs_init.ps");

      const shaFile = `${bundlePath(root, MAC_TRIPLE)}.sha256`;
      expect(existsSync(shaFile)).toBe(true);
      const shaLine = (await readFile(shaFile, "utf8")).trim();
      expect(shaLine, "the sibling .sha256 artifact is '<digest>  <filename>'").toMatch(/^[0-9a-f]{64}  /);
      const digest = createHash("sha256").update(await readFile(bundlePath(root, MAC_TRIPLE))).digest("hex");
      expect(
        shaLine.startsWith(digest),
        "freeze.sh computes the digest with shasum -a 256 over the written tarball",
      ).toBe(true);
    });
  });

  it("republishes_a_bundle_over_an_existing_one_without_temp_litter", async () => {
    await withRoot(async (root) => {
      await stageTree(root, MAC_TRIPLE);
      const first = await runScript(FREEZE, ["--triple", MAC_TRIPLE, "--root", root]);
      expect(first.code, first.stderr).toBe(0);

      await writeFile(join(root, "src-tauri", "frameworks", "libvips-test.42.dylib"), "libvips dylib payload v2\n");
      const second = await runScript(FREEZE, ["--triple", MAC_TRIPLE, "--root", root]);
      expect(second.code, second.stderr).toBe(0);

      const bundle = bundlePath(root, MAC_TRIPLE);
      const extract = join(root, "extract");
      await mkdir(extract, { recursive: true });
      await runTool("tar", ["-xzf", bundle, "-C", extract]);
      expect(await readFile(join(extract, "frameworks", "libvips-test.42.dylib"), "utf8")).toBe("libvips dylib payload v2\n");
      const shaLine = await readSha(root, bundle);
      expect(
        shaLine.split(/\s+/)[0],
        "the sibling .sha256 must describe the newly published bundle",
      ).toBe(createHash("sha256").update(await readFile(bundle)).digest("hex"));
      expect(
        (await readdir(join(root, "src-tauri", ".freeze"))).length,
        "only the bundle and its .sha256 remain",
      ).toBe(2);
    });
  });

  it("keeps_the_previous_bundle_and_sha_when_the_tar_step_fails", async () => {
    await withRoot(async (root) => {
      await stageTree(root, MAC_TRIPLE);
      const first = await runScript(FREEZE, ["--triple", MAC_TRIPLE, "--root", root]);
      expect(first.code, first.stderr).toBe(0);

      const bundle = bundlePath(root, MAC_TRIPLE);
      const bundleBefore = await readFile(bundle);
      const shaBefore = await readFile(`${bundle}.sha256`, "utf8");
      await chmod(join(root, "src-tauri", "binaries", `vips-${MAC_TRIPLE}`), 0o000);
      try {
        const result = await runScript(FREEZE, ["--triple", MAC_TRIPLE, "--root", root]);

        expect(result.code).toBe(1);
        expect(
          await readFile(bundle),
          "a failed freeze must not clobber the previous good bundle",
        ).toEqual(bundleBefore);
        expect(
          await readFile(`${bundle}.sha256`, "utf8"),
          "the stale .sha256 must stay paired with the surviving bundle",
        ).toBe(shaBefore);
        expect(
          (await readdir(join(root, "src-tauri", ".freeze"))).length,
          "temp artifacts from the failed run must not linger",
        ).toBe(2);
      } finally {
        await chmod(join(root, "src-tauri", "binaries", `vips-${MAC_TRIPLE}`), 0o644);
      }
    });
  });

  it("refuses_linux_triples_before_touching_the_tree", async () => {
    await withRoot(async (root) => {
      await stageTree(root, MAC_TRIPLE);

      const result = await runScript(FREEZE, [
        "--triple",
        "x86_64-unknown-linux-gnu",
        "--root",
        root,
      ]);

      expect(result.code).toBe(1);
      expect(result.stderr).toContain("x86_64-unknown-linux-gnu");
      expect(existsSync(join(root, "src-tauri", ".freeze")), "a refused freeze must not even create the output dir").toBe(
        false,
      );
    });
  });

  it("packages_the_windows_engines_dirs_external_exes_and_gs_resources", async () => {
    await withRoot(async (root) => {
      await stageWindowsTree(root, WINDOWS_TRIPLE);

      const result = await runScript(FREEZE, ["--triple", WINDOWS_TRIPLE, "--root", root]);

      expect(result.code, `stdout: ${result.stdout}\nstderr: ${result.stderr}`).toBe(0);
      const listed = await runTool("tar", ["-tzf", bundlePath(root, WINDOWS_TRIPLE)]);
      const entries = listed.stdout.split("\n").filter(Boolean);
      for (const engine of ["vips", "qpdf", "gs"]) {
        expect(entries).toContain(`binaries/engines/${engine}/${engine}.exe`);
      }
      expect(entries).toContain(`binaries/ffmpeg-${WINDOWS_TRIPLE}.exe`);
      expect(entries).toContain(`binaries/ffprobe-${WINDOWS_TRIPLE}.exe`);
      expect(entries).toContain("gs-resources/Resource/Init/gs_init.ps");
      expect(
        entries.every((entry) => /^(binaries|gs-resources)\//.test(entry)),
        `every entry must extract directly into src-tauri, got:\n${entries.join("\n")}`,
      ).toBe(true);
      expect(
        entries.some((entry) => /^frameworks\//.test(entry)),
        "windows bundles never carry the mac-only frameworks dir",
      ).toBe(false);

      const shaLine = (await readFile(`${bundlePath(root, WINDOWS_TRIPLE)}.sha256`, "utf8")).trim();
      expect(shaLine, "the sibling .sha256 artifact is '<digest>  <filename>'").toMatch(/^[0-9a-f]{64}  /);
      const digest = createHash("sha256").update(await readFile(bundlePath(root, WINDOWS_TRIPLE))).digest("hex");
      expect(shaLine.startsWith(digest)).toBe(true);
    });
  });

  it("refuses_a_windows_freeze_when_an_engines_dir_is_empty", async () => {
    await withRoot(async (root) => {
      await stageWindowsTree(root, WINDOWS_TRIPLE);
      await rm(join(root, "src-tauri", "binaries", "engines", "qpdf", "qpdf.exe"));
      await rm(join(root, "src-tauri", "binaries", "engines", "qpdf", "qpdf-support.dll"));

      const result = await runScript(FREEZE, ["--triple", WINDOWS_TRIPLE, "--root", root]);

      expect(result.code).toBe(1);
      expect(result.stderr).toContain("binaries/engines/qpdf");
      expect(existsSync(bundlePath(root, WINDOWS_TRIPLE))).toBe(false);
    });
  });

  it("refuses_a_windows_freeze_when_the_external_ffmpeg_exe_is_missing", async () => {
    await withRoot(async (root) => {
      await stageWindowsTree(root, WINDOWS_TRIPLE);
      await unlink(join(root, "src-tauri", "binaries", `ffmpeg-${WINDOWS_TRIPLE}.exe`));

      const result = await runScript(FREEZE, ["--triple", WINDOWS_TRIPLE, "--root", root]);

      expect(result.code).toBe(1);
      expect(result.stderr).toContain(`ffmpeg-${WINDOWS_TRIPLE}.exe`);
      expect(existsSync(bundlePath(root, WINDOWS_TRIPLE))).toBe(false);
    });
  });

  it("refuses_a_windows_freeze_when_the_gs_init_marker_is_missing", async () => {
    await withRoot(async (root) => {
      await stageWindowsTree(root, WINDOWS_TRIPLE);
      await unlink(join(root, "src-tauri", "gs-resources", "Resource", "Init", "gs_init.ps"));

      const result = await runScript(FREEZE, ["--triple", WINDOWS_TRIPLE, "--root", root]);

      expect(result.code).toBe(1);
      expect(result.stderr).toContain("gs_init.ps");
      expect(existsSync(bundlePath(root, WINDOWS_TRIPLE))).toBe(false);
    });
  });

  it("refuses_when_an_engine_binary_is_missing_from_the_staged_tree", async () => {
    await withRoot(async (root) => {
      await stageTree(root, MAC_TRIPLE);
      await unlink(join(root, "src-tauri", "binaries", `vips-${MAC_TRIPLE}`));

      const result = await runScript(FREEZE, ["--triple", MAC_TRIPLE, "--root", root]);

      expect(result.code).toBe(1);
      expect(result.stderr).toContain(`binaries/vips-${MAC_TRIPLE}`);
      expect(existsSync(bundlePath(root, MAC_TRIPLE)), "refuse without writing a partial bundle").toBe(false);
    });
  });

  it("refuses_when_frameworks_is_empty", async () => {
    await withRoot(async (root) => {
      await stageTree(root, MAC_TRIPLE);
      await rm(join(root, "src-tauri", "frameworks", "libvips-test.42.dylib"));

      const result = await runScript(FREEZE, ["--triple", MAC_TRIPLE, "--root", root]);

      expect(result.code).toBe(1);
      expect(result.stderr).toContain("frameworks");
      expect(existsSync(bundlePath(root, MAC_TRIPLE))).toBe(false);
    });
  });

  it("refuses_when_the_gs_init_marker_is_missing", async () => {
    await withRoot(async (root) => {
      await stageTree(root, MAC_TRIPLE);
      await unlink(join(root, "src-tauri", "gs-resources", "Resource", "Init", "gs_init.ps"));

      const result = await runScript(FREEZE, ["--triple", MAC_TRIPLE, "--root", root]);

      expect(result.code).toBe(1);
      expect(result.stderr).toContain("gs_init.ps");
      expect(existsSync(bundlePath(root, MAC_TRIPLE))).toBe(false);
    });
  });

  it("refuses_loudly_when_the_output_dir_cannot_be_created", async () => {
    await withRoot(async (root) => {
      await stageTree(root, MAC_TRIPLE);
      await chmod(join(root, "src-tauri"), 0o555);
      try {
        const result = await runScript(FREEZE, ["--triple", MAC_TRIPLE, "--root", root]);

        expect(result.code).toBe(1);
        expect(result.stderr).toMatch(/cannot create .*src-tauri\/\.freeze/);
        expect(existsSync(bundlePath(root, MAC_TRIPLE))).toBe(false);
      } finally {
        await chmod(join(root, "src-tauri"), 0o755);
      }
    });
  });

  it("refuses_while_another_freeze_or_unfreeze_holds_the_shared_lock", async () => {
    await withRoot(async (root) => {
      await stageTree(root, MAC_TRIPLE);
      const lockDir = join(root, "src-tauri", ".freeze", "freeze.lock");
      await mkdir(lockDir, { recursive: true });
      try {
        const result = await runScript(FREEZE, ["--triple", MAC_TRIPLE, "--root", root]);

        expect(result.code).toBe(1);
        expect(result.stderr).toMatch(/lock/);
        expect(existsSync(bundlePath(root, MAC_TRIPLE))).toBe(false);
      } finally {
        await rm(lockDir, { recursive: true, force: true });
      }
    });
  });
});
