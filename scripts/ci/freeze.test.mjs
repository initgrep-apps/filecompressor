// @vitest-environment node
import { describe, expect, it, vi } from "vitest";

vi.setConfig({ testTimeout: 30_000 });

import { execFile, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, unlink, writeFile, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const FREEZE = join(HERE, "freeze.sh");

function toBashPath(p) {
  if (process.platform !== "win32") {
    return p;
  }
  return p.replace(/\\/g, "/").replace(/^([A-Za-z]):/, "/$1");
}

function asBashArgs(args) {
  return args.map((arg) =>
    typeof arg === "string" && /^[A-Za-z]:[\\/]/.test(arg) ? toBashPath(arg) : arg,
  );
}

const ENGINES = ["ffmpeg", "ffprobe", "qpdf", "vips", "gs"];
const MAC_TRIPLE = "aarch64-apple-darwin";

function runScript(script, args, options = {}) {
  return new Promise((resolvePromise) => {
    execFile("bash", [script, ...asBashArgs(args)], { encoding: "utf8", timeout: 60_000, ...options }, (error, stdout, stderr) => {
      const code = error?.code ?? (error?.signal ? 255 : 0);
      resolvePromise({ code, stdout, stderr, signal: error?.signal ?? null });
    });
  });
}

function runTool(tool, args) {
  return new Promise((resolvePromise, reject) => {
    execFile(tool, asBashArgs(args), { encoding: "utf8" }, (error, stdout, stderr) => {
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
  for (const exe of ["ffmpeg", "ffprobe", "vips", "qpdf", "gs"]) {
    await writeFile(join(bin, `${exe}-${triple}.exe`), `${exe} flat payload for ${triple}\n`);
  }
  for (const engine of ["vips", "qpdf", "gs"]) {
    const enginesDir = join(bin, "engines", engine);
    await mkdir(enginesDir, { recursive: true });
    await writeFile(join(enginesDir, `${engine}.exe`), `${engine} engine payload\n`);
    await writeFile(join(enginesDir, `${engine}-support.dll`), `${engine} dll payload\n`);
  }
}

async function readSha(root, bundle) {
  return readFile(`${bundle}.sha256`, "utf8");
}

describe("freeze.sh", () => {
  it("resolves_windows_backslash_script_paths_for_the_sibling_manifest_lists", () => {
    const source = readFileSync(join(HERE, "freeze.sh"), "utf8");
    expect(
      source.includes("${0//\\\\//}"),
      "the sibling windows-manifest-lists.sh lookup must normalize Windows backslash argv[0] (execFile passes D:\\... so ${0%/*} never sees a slash and the fixture freeze dies with 'cannot load ./windows-manifest-lists.sh')",
    ).toBe(true);
  });

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
      const digest = createHash("sha256").update(await readFile(bundlePath(root, MAC_TRIPLE))).digest("hex");
      expect(
        shaLine,
        "the sibling .sha256 names the final bundle asset, not the deleted temp file",
      ).toBe(`${digest}  sidecar-bundle-${MAC_TRIPLE}.tar.gz`);
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

  it.skipIf(process.platform === "win32")("keeps_the_previous_bundle_and_sha_when_the_tar_step_fails_win32_skips_acl_semantics_differ", async () => {
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

  it("packages_the_windows_engines_dirs_and_flat_exes_with_binaries_only_tree", async () => {
    await withRoot(async (root) => {
      await stageWindowsTree(root, WINDOWS_TRIPLE);

      const result = await runScript(FREEZE, ["--triple", WINDOWS_TRIPLE, "--root", root]);

      expect(result.code, `stdout: ${result.stdout}\nstderr: ${result.stderr}`).toBe(0);
      const listed = await runTool("tar", ["-tzf", bundlePath(root, WINDOWS_TRIPLE)]);
      const entries = listed.stdout.split("\n").filter(Boolean);
      for (const engine of ["vips", "qpdf", "gs"]) {
        expect(entries).toContain(`binaries/engines/${engine}/${engine}.exe`);
      }
      for (const exe of ["ffmpeg", "ffprobe", "vips", "qpdf", "gs"]) {
        expect(entries, `${exe}-<triple>.exe must be in the windows bundle so the verify.mjs/audit contract holds post-unfreeze`).toContain(
          `binaries/${exe}-${WINDOWS_TRIPLE}.exe`,
        );
      }
      expect(
        entries,
        "msys2 gs runs on its compiled-in resources, so windows bundles never carry gs-resources",
      ).not.toContain(expect.stringContaining("gs-resources"));
      expect(
        entries.every((entry) => /^binaries\//.test(entry)),
        `every entry must extract directly into src-tauri as binaries payload only, got:\n${entries.join("\n")}`,
      ).toBe(true);
      expect(
        entries.some((entry) => /^frameworks\//.test(entry)),
        "windows bundles never carry the mac-only frameworks dir",
      ).toBe(false);

      const digest = createHash("sha256").update(await readFile(bundlePath(root, WINDOWS_TRIPLE))).digest("hex");
      const shaLine = (await readFile(`${bundlePath(root, WINDOWS_TRIPLE)}.sha256`, "utf8")).trim();
      expect(shaLine, "the sibling .sha256 names the final windows bundle asset, not the deleted temp file").toBe(
        `${digest}  sidecar-bundle-${WINDOWS_TRIPLE}.tar.gz`,
      );
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

  it("refuses_a_windows_freeze_when_an_engines_dir_has_no_dll_anywhere_under_it", async () => {
    await withRoot(async (root) => {
      await stageWindowsTree(root, WINDOWS_TRIPLE);
      await rm(join(root, "src-tauri", "binaries", "engines", "vips", "vips-support.dll"));

      const result = await runScript(FREEZE, ["--triple", WINDOWS_TRIPLE, "--root", root]);

      expect(result.code, `stdout: ${result.stdout}\nstderr: ${result.stderr}`).toBe(1);
      expect(
        result.stderr,
        "the guard must reject a present-but-DLL-less engines dir, not just any non-empty dir",
      ).toMatch(/binaries\/engines\/vips .*no DLL/i);
      expect(result.stderr).toContain("yarn binaries:all --target");
      expect(existsSync(bundlePath(root, WINDOWS_TRIPLE))).toBe(false);
    });
  });

  it("refuses_a_windows_freeze_when_the_whole_engines_payload_dir_is_missing", async () => {
    await withRoot(async (root) => {
      await stageWindowsTree(root, WINDOWS_TRIPLE);
      await rm(join(root, "src-tauri", "binaries", "engines", "vips"), { recursive: true });

      const result = await runScript(FREEZE, ["--triple", WINDOWS_TRIPLE, "--root", root]);

      expect(result.code, `stdout: ${result.stdout}\nstderr: ${result.stderr}`).toBe(1);
      expect(
        result.stderr,
        "a wholly absent engines payload dir must be classified as missing staged payload, not confused with a DLL scan outcome",
      ).toContain("missing staged payload dir src-tauri/binaries/engines/vips");
      expect(result.stderr).toContain("yarn binaries:all --target");
      expect(existsSync(bundlePath(root, WINDOWS_TRIPLE))).toBe(false);
    });
  });

  it("isolates_the_exe_missing_guard_message_when_the_dll_is_still_present", async () => {
    await withRoot(async (root) => {
      await stageWindowsTree(root, WINDOWS_TRIPLE);
      await unlink(join(root, "src-tauri", "binaries", "engines", "qpdf", "qpdf.exe"));

      const result = await runScript(FREEZE, ["--triple", WINDOWS_TRIPLE, "--root", root]);

      expect(result.code, `stdout: ${result.stdout}\nstderr: ${result.stderr}`).toBe(1);
      expect(
        result.stderr,
        "exe missing while the engine dir still carries its DLL — the guard must name the staged engine binary, not the DLL scan",
      ).toContain("missing staged engine binary src-tauri/binaries/engines/qpdf/qpdf.exe");
      expect(result.stderr).not.toMatch(/no DLL anywhere under/i);
      expect(existsSync(bundlePath(root, WINDOWS_TRIPLE))).toBe(false);
    });
  });

  it.skipIf(process.platform === "win32")("classifies_a_find_read_error_as_a_permissions_problem_not_a_dll_less_tree_win32_skips_acl_semantics_differ", async () => {
    await withRoot(async (root) => {
      await stageWindowsTree(root, WINDOWS_TRIPLE);
      await mkdir(join(root, "src-tauri", "binaries", "engines", "vips", "sealed-subdir"));
      const sealed = join(root, "src-tauri", "binaries", "engines", "vips", "sealed-subdir");
      await chmod(sealed, 0o000);
      try {
        const result = await runScript(FREEZE, ["--triple", WINDOWS_TRIPLE, "--root", root]);

        expect(result.code, `stdout: ${result.stdout}\nstderr: ${result.stderr}`).toBe(1);
        expect(
          result.stderr,
          "a read error under the engines dir must be classified distinctly from a DLL-less tree",
        ).toMatch(/could not read .*engines\/vips.*read error/i);
        expect(
          result.stderr,
          "the read-error classification must rule out restaging as a fix",
        ).toContain("restaging will not fix a permissions problem");
        expect(
          result.stderr,
          "the DLL-less remediation must not fire for a read error",
        ).not.toMatch(/no DLL anywhere under/i);
        expect(existsSync(bundlePath(root, WINDOWS_TRIPLE))).toBe(false);
      } finally {
        await chmod(sealed, 0o755);
      }
    });
  });

  it("refuses_a_windows_freeze_when_a_flat_engine_exe_is_missing", async () => {
    await withRoot(async (root) => {
      await stageWindowsTree(root, WINDOWS_TRIPLE);
      await unlink(join(root, "src-tauri", "binaries", `qpdf-${WINDOWS_TRIPLE}.exe`));

      const result = await runScript(FREEZE, ["--triple", WINDOWS_TRIPLE, "--root", root]);

      expect(result.code).toBe(1);
      expect(result.stderr).toContain(`binaries/qpdf-${WINDOWS_TRIPLE}.exe`);
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

  it("ignores_a_leftover_gs_resources_tree_for_a_windows_freeze", async () => {
    await withRoot(async (root) => {
      await stageWindowsTree(root, WINDOWS_TRIPLE);
      const init = join(root, "src-tauri", "gs-resources", "Resource", "Init");
      await mkdir(init, { recursive: true });
      await writeFile(join(init, "stale.ps"), "stale payload\n");

      const result = await runScript(FREEZE, ["--triple", WINDOWS_TRIPLE, "--root", root]);

      expect(result.code, `stdout: ${result.stdout}\nstderr: ${result.stderr}`).toBe(0);
      const listed = await runTool("tar", ["-tzf", bundlePath(root, WINDOWS_TRIPLE)]);
      const entries = listed.stdout.split("\n").filter(Boolean);
      expect(
        entries,
        "a stale gs-resources dir must not sneak into the windows bundle it is no longer part of",
      ).not.toContain(expect.stringContaining("gs-resources"));
      expect(entries.every((entry) => /^binaries\//.test(entry)), `got:\n${entries.join("\n")}`).toBe(true);
    });
  });

  const WIN_STATIC_MANIFEST = {
    targets: {
      [WINDOWS_TRIPLE]: {
        ffmpeg: {
          source: "url",
          url: "https://fixtures.invalid/ffmpeg.zip",
          sha256: "0".repeat(64),
          member: "ffmpeg-n9.0-latest-win64-gpl-9.0/bin/ffmpeg.exe",
          dest: "ffmpeg",
          expectVersion: "9.0.2",
          static: true,
        },
        ffprobe: {
          source: "url",
          url: "https://fixtures.invalid/ffprobe.zip",
          sha256: "0".repeat(64),
          member: "ffmpeg-n9.0-latest-win64-gpl-9.0/bin/ffprobe.exe",
          dest: "ffprobe",
          expectVersion: "9.0.2",
          static: true,
        },
        qpdf: {
          source: "url",
          url: "https://fixtures.invalid/qpdf.zip",
          sha256: "0".repeat(64),
          member: "qpdf-12.4.2-msvc64/bin/qpdf.exe",
          dest: "qpdf",
          expectVersion: "12.4.2",
        },
      },
    },
  };

  async function stageManifest(root, manifest) {
    await mkdir(join(root, "scripts"), { recursive: true });
    await writeFile(
      join(root, "scripts", "binaries.manifest.json"),
      JSON.stringify(manifest, null, 2),
    );
  }

  async function stageStaticShapeTree(root) {
    const bin = join(root, "src-tauri", "binaries");
    await mkdir(bin, { recursive: true });
    for (const exe of ["ffmpeg", "ffprobe", "qpdf"]) {
      await writeFile(join(bin, `${exe}-${WINDOWS_TRIPLE}.exe`), `${exe} flat payload\n`);
    }
    for (const engine of ["qpdf"]) {
      const enginesDir = join(bin, "engines", engine);
      await mkdir(enginesDir, { recursive: true });
      await writeFile(join(enginesDir, `${engine}.exe`), `${engine} engine payload\n`);
      await writeFile(join(enginesDir, `${engine}-support.dll`), `${engine} dll payload\n`);
    }
  }

  async function stubGnuMktemp() {
    const stubDir = await mkdtemp(join(tmpdir(), "gnu-mktemp-"));
    const real = execFileSync("which", ["mktemp"]).toString().trim();
    await writeFile(
      join(stubDir, "mktemp"),
      [
        "#!/bin/sh",
        "template=",
        'for a in "$@"; do',
        '  case "$a" in',
        "    -*) continue ;;",
        '    *) template="$a" ;;',
        "  esac",
        "done",
        'case "$template" in',
        `*XXXXXX) exec ${real} "$@" ;;`,
        `*) printf "mktemp: too few X's in template '%s'\\n" "$template" >&2; exit 1 ;;`,
        "esac",
      ].join("\n"),
      { mode: 0o755 },
    );
    return stubDir;
  }

  it("requires_engines_dirs_only_for_non_static_manifest_entries_and_every_entry_as_a_flat_exe", async () => {
    await withRoot(async (root) => {
      await stageManifest(root, WIN_STATIC_MANIFEST);
      await stageStaticShapeTree(root);

      const result = await runScript(FREEZE, ["--triple", WINDOWS_TRIPLE, "--root", root]);

      expect(result.code, `stdout: ${result.stdout}\nstderr: ${result.stderr}`).toBe(0);
      const listed = await runTool("tar", ["-tzf", bundlePath(root, WINDOWS_TRIPLE)]);
      const entries = listed.stdout.split("\n").filter(Boolean);
      expect(entries).toContain("binaries/engines/qpdf/qpdf.exe");
      for (const exe of ["ffmpeg", "ffprobe", "qpdf"]) {
        expect(entries).toContain(`binaries/${exe}-${WINDOWS_TRIPLE}.exe`);
      }
      expect(
        entries.some((entry) => /^binaries\/engines\/(ffmpeg|ffprobe)\//.test(entry)),
        "static entries never stage an engines/ payload dir, so the bundle must not carry one",
      ).toBe(false);
    });
  });

  it("refuses_a_windows_freeze_when_a_non_static_manifest_engine_dir_is_missing", async () => {
    await withRoot(async (root) => {
      await stageManifest(root, WIN_STATIC_MANIFEST);
      await stageStaticShapeTree(root);
      await rm(join(root, "src-tauri", "binaries", "engines", "qpdf"), { recursive: true });

      const result = await runScript(FREEZE, ["--triple", WINDOWS_TRIPLE, "--root", root]);

      expect(result.code).toBe(1);
      expect(result.stderr).toContain("missing staged payload dir src-tauri/binaries/engines/qpdf");
      expect(existsSync(bundlePath(root, WINDOWS_TRIPLE))).toBe(false);
    });
  });

  it("still_requires_the_flat_exe_of_a_static_manifest_entry", async () => {
    await withRoot(async (root) => {
      await stageManifest(root, WIN_STATIC_MANIFEST);
      await stageStaticShapeTree(root);
      await unlink(join(root, "src-tauri", "binaries", `ffmpeg-${WINDOWS_TRIPLE}.exe`));

      const result = await runScript(FREEZE, ["--triple", WINDOWS_TRIPLE, "--root", root]);

      expect(result.code).toBe(1);
      expect(result.stderr).toContain(`binaries/ffmpeg-${WINDOWS_TRIPLE}.exe`);
      expect(existsSync(bundlePath(root, WINDOWS_TRIPLE))).toBe(false);
    });
  });

  it("does_not_run_the_dll_guard_for_a_static_entry_engines_dir", async () => {
    await withRoot(async (root) => {
      await stageManifest(root, WIN_STATIC_MANIFEST);
      await stageStaticShapeTree(root);
      const leftover = join(root, "src-tauri", "binaries", "engines", "ffmpeg");
      await mkdir(leftover, { recursive: true });
      await writeFile(join(leftover, "ffmpeg.exe"), "bare leftover");

      const result = await runScript(FREEZE, ["--triple", WINDOWS_TRIPLE, "--root", root]);

      expect(
        result.code,
        `a bare static engines dir must not trip the DLL-less guard: stdout: ${result.stdout}\nstderr: ${result.stderr}`,
      ).toBe(0);
    });
  });

  it("survives_gnu_mktemp_semantics_when_scanning_window_engine_dirs_for_dlls", async () => {
    await withRoot(async (root) => {
      await stageManifest(root, WIN_STATIC_MANIFEST);
      await stageStaticShapeTree(root);
      const stubMktemp = await stubGnuMktemp();

      const result = await runScript(FREEZE, ["--triple", WINDOWS_TRIPLE, "--root", root], {
        env: { ...process.env, PATH: `${stubMktemp}:${process.env.PATH ?? ""}` },
      });

      expect(
        result.code,
        `git-bash mktemp rejects X-less templates, so every freeze mktemp template must carry trailing X's: stdout: ${result.stdout}\nstderr: ${result.stderr}`,
      ).toBe(0);
      expect(result.stdout).toContain(
        `${WINDOWS_TRIPLE} bundle → src-tauri/.freeze/sidecar-bundle-${WINDOWS_TRIPLE}.tar.gz`,
      );
      expect(result.stdout + result.stderr).not.toContain("too few X's");
      expect(result.stdout + result.stderr).not.toContain("cannot create a temp file");
    });
  });

  it("refuses_a_windows_freeze_when_the_manifest_has_no_row_for_the_triple", async () => {
    await withRoot(async (root) => {
      await stageManifest(root, { targets: { "aarch64-pc-windows-msvc": {} } });
      await stageStaticShapeTree(root);

      const result = await runScript(FREEZE, ["--triple", WINDOWS_TRIPLE, "--root", root]);

      expect(result.code).toBe(1);
      expect(result.stderr).toContain("binaries.manifest.json");
      expect(result.stderr).toContain(WINDOWS_TRIPLE);
      expect(existsSync(bundlePath(root, WINDOWS_TRIPLE))).toBe(false);
    });
  });

  it("refuses_a_windows_freeze_when_the_manifest_is_unreadable", async () => {
    await withRoot(async (root) => {
      await stageManifest(root, WIN_STATIC_MANIFEST);
      await writeFile(join(root, "scripts", "binaries.manifest.json"), "{not json");
      await stageStaticShapeTree(root);

      const result = await runScript(FREEZE, ["--triple", WINDOWS_TRIPLE, "--root", root]);

      expect(result.code).toBe(1);
      expect(result.stderr).toContain("binaries.manifest.json");
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

  it.skipIf(process.platform === "win32")("refuses_loudly_when_the_output_dir_cannot_be_created_win32_skips_acl_semantics_differ", async () => {
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
