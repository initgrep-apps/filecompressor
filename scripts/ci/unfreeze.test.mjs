// @vitest-environment node
import { describe, expect, it } from "vitest";

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile, chmod } from "node:fs/promises";
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
const GH_STUB_PAYLOADS = Object.fromEntries(
  ENGINES.map((engine) => [engine, `gh-path payload for ${engine} on ${MAC_TRIPLE}\n`]),
);

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

function shaOf(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

async function stageSidecarTree(base, payloads) {
  const bin = join(base, "binaries");
  await mkdir(bin, { recursive: true });
  for (const [engine, payload] of Object.entries(payloads)) {
    await writeFile(join(bin, `${engine}-${MAC_TRIPLE}`), payload);
  }
  const frameworks = join(base, "frameworks");
  await mkdir(frameworks, { recursive: true });
  await writeFile(join(frameworks, "libvips-test.42.dylib"), "libvips dylib payload\n");
  const init = join(base, "gs-resources", "Resource", "Init");
  await mkdir(init, { recursive: true });
  await writeFile(join(init, "gs_init.ps"), "ghostscript init payload\n");
}

async function tarTree(base, bundlePath) {
  await new Promise((resolvePromise, reject) => {
    execFile("tar", ["-czf", bundlePath, "-C", base, "binaries", "frameworks", "gs-resources"], (error) =>
      error ? reject(error) : resolvePromise(),
    );
  });
  const digest = shaOf(await readFile(bundlePath));
  await writeFile(`${bundlePath}.sha256`, `${digest}  ${bundlePath.split("/").pop()}\n`);
  return bundlePath;
}

async function freezeFixture() {
  const root = await mkdtemp(join(tmpdir(), "unfreeze-src-"));
  let ok = false;
  try {
    await mkdir(join(root, "src-tauri"), { recursive: true });
    await stageSidecarTree(join(root, "src-tauri"), ENGINE_PAYLOADS);
    const result = await runScript(FREEZE, ["--triple", MAC_TRIPLE, "--root", root]);
    if (result.code !== 0) {
      throw new Error(`fixture freeze failed: ${result.stderr}`);
    }
    ok = true;
    return root;
  } finally {
    if (!ok) {
      await rm(root, { recursive: true, force: true });
    }
  }
}

async function withRoot(body) {
  const root = await mkdtemp(join(tmpdir(), "unfreeze-dest-"));
  try {
    return await body(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function withFrozenSource(body) {
  const srcRoot = await freezeFixture();
  try {
    return await body(srcRoot);
  } finally {
    await rm(srcRoot, { recursive: true, force: true });
  }
}

async function withBareDest(body) {
  return withRoot(async (destRoot) => {
    await mkdir(join(destRoot, "src-tauri"));
    return body(destRoot);
  });
}

const freezeDir = (root) => join(root, "src-tauri", ".freeze");
const frozenBundle = (root) => join(freezeDir(root), `sidecar-bundle-${MAC_TRIPLE}.tar.gz`);
const restoredBinary = (root, engine) =>
  readFile(join(root, "src-tauri", "binaries", `${engine}-${MAC_TRIPLE}`), "utf8");
const restoredInit = (root) => readFile(join(root, "src-tauri", "gs-resources", "Resource", "Init", "gs_init.ps"), "utf8");
const restoredDylib = (root) => readFile(join(root, "src-tauri", "frameworks", "libvips-test.42.dylib"), "utf8");

async function expectCleanFreezeDir(destRoot) {
  const entries = await readdir(join(destRoot, "src-tauri", ".freeze"));
  expect(entries, "work and lock dirs must be cleaned up after the run").toEqual([]);
}

const GH_LIST = `[{"tagName":"v1.2.3"},{"tagName":"sidecars-20260101"},{"tagName":"sidecars-20261010"}]`;

async function stubEnv(destRoot, { mode } = {}) {
  const payload = await mkdtemp(join(tmpdir(), "gh-stub-payload-"));
  await stageSidecarTree(payload, GH_STUB_PAYLOADS);
  const stubDir = await mkdtemp(join(tmpdir(), "gh-stub-"));
  const stub = join(stubDir, "gh");
  const script = [
    "#!/bin/sh",
    "set -eu",
    'case "$1 $2" in',
    '  "release list")',
    '    printf \'%s\' "$GH_STUB_LIST"',
    '    printf \'%s\' "$GH_STUB_LIST" > "$GH_STUB_LIST_MARKER"',
    "    ;;",
    '  "release download")',
    '    shift 2',
    '    tag=""',
    '    prev=""',
    '    for arg in "$@"; do',
    '      if [ "$prev" = "--repo" ]; then prev=""; continue; fi',
    '      case "$arg" in',
    '        --*) prev="$arg" ;;',
    '        *) if [ -z "$tag" ]; then tag="$arg"; fi ;;',
    '      esac',
    '    done',
    '    printf \'%s\' "$tag" > "$GH_STUB_DOWNLOAD_MARKER"',
    '    if [ "${GH_STUB_MODE-}" = "no-assets" ]; then',
    "      exit 0",
    "    fi",
    '    dir=""',
    '    prev=""',
    '    for arg in "$@"; do',
    '      if [ "$prev" = "--dir" ]; then dir="$arg"; fi',
    '      prev="$arg"',
    "    done",
    '    tar -czf "$dir/sidecar-bundle-$GH_STUB_TRIPLE.tar.gz" -C "$GH_STUB_PAYLOAD" binaries frameworks gs-resources',
    '    (cd "$dir" && shasum -a 256 "sidecar-bundle-$GH_STUB_TRIPLE.tar.gz" > "sidecar-bundle-$GH_STUB_TRIPLE.tar.gz.sha256")',
    "    ;;",
    "esac",
  ].join("\n");
  await writeFile(stub, script, { mode: 0o755 });
  const markerList = join(destRoot, "stub-list.txt");
  const markerDownload = join(destRoot, "stub-download.txt");
  const env = {
    ...process.env,
    PATH: `${stubDir}:${process.env.PATH ?? ""}`,
    GH_TOKEN: "stub-token",
    GH_STUB_LIST: GH_LIST,
    GH_STUB_LIST_MARKER: markerList,
    GH_STUB_DOWNLOAD_MARKER: markerDownload,
    GH_STUB_PAYLOAD: payload,
    GH_STUB_TRIPLE: MAC_TRIPLE,
    ...(mode ? { GH_STUB_MODE: mode } : {}),
  };
  return {
    env,
    markers: { list: markerList, download: markerDownload },
    async cleanup() {
      await rm(stubDir, { recursive: true, force: true });
      await rm(payload, { recursive: true, force: true });
    },
  };
}

describe("unfreeze.sh", () => {
  it("restores_the_frozen_tree_into_a_clean_src_tauri_with_no_extraction_litter", async () => {
    await withFrozenSource(async (srcRoot) => {
      await withBareDest(async (destRoot) => {
        const result = await runScript(UNFREEZE, ["--triple", MAC_TRIPLE, "--archive", frozenBundle(srcRoot), "--root", destRoot]);

        expect(result.code, `stdout: ${result.stdout}\nstderr: ${result.stderr}`).toBe(0);
        for (const engine of ENGINES) {
          expect(
            await restoredBinary(destRoot, engine),
            "each frozen engine comes back byte-for-byte",
          ).toBe(ENGINE_PAYLOADS[engine]);
        }
        expect(await restoredDylib(destRoot)).toBe("libvips dylib payload\n");
        expect(await restoredInit(destRoot)).toBe("ghostscript init payload\n");
        await expectCleanFreezeDir(destRoot);
      });
    });
  });

  it("fails_closed_on_a_sha_mismatch_without_extracting_anything", async () => {
    await withFrozenSource(async (srcRoot) => {
      await withBareDest(async (destRoot) => {
        const bundle = join(destRoot, "tampered.tar.gz");
        await copyFile(frozenBundle(srcRoot), bundle);
        await copyFile(`${frozenBundle(srcRoot)}.sha256`, `${bundle}.sha256`);
        await writeFile(bundle, "\0", { flag: "a" });

        const result = await runScript(UNFREEZE, ["--triple", MAC_TRIPLE, "--archive", bundle, "--root", destRoot]);

        expect(result.code).toBe(1);
        expect(result.stderr).toMatch(/sha256 mismatch/i);
        expect(
          existsSync(join(destRoot, "src-tauri", "binaries")),
          "a tampered bundle must not reach the destination tree",
        ).toBe(false);
        await expectCleanFreezeDir(destRoot);
      });
    });
  });

  it("fails_closed_when_the_archive_does_not_exist", async () => {
    await withBareDest(async (destRoot) => {
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
      expect(existsSync(join(destRoot, "src-tauri", "binaries"))).toBe(false);
      expect(existsSync(join(destRoot, "src-tauri", ".freeze")), "nothing is staged for a missing archive").toBe(false);
    });
  });

  it("fails_closed_when_the_sha256_sibling_is_missing", async () => {
    await withFrozenSource(async (srcRoot) => {
      await withBareDest(async (destRoot) => {
        const bundle = join(destRoot, "unverified.tar.gz");
        await copyFile(frozenBundle(srcRoot), bundle);

        const result = await runScript(UNFREEZE, ["--triple", MAC_TRIPLE, "--archive", bundle, "--root", destRoot]);

        expect(result.code).toBe(1);
        expect(result.stderr).toMatch(/\.sha256/);
        expect(existsSync(join(destRoot, "src-tauri", "binaries"))).toBe(false);
      });
    });
  });

  it("fails_closed_when_the_extracted_bundle_is_missing_the_gs_init_marker", async () => {
    await withRoot(async (destRoot) => {
      await mkdir(join(destRoot, "src-tauri"));
      const payload = join(destRoot, "payload");
      await stageSidecarTree(payload, ENGINE_PAYLOADS);
      await rm(join(payload, "gs-resources"), { recursive: true });
      const bundle = join(destRoot, "handmade.tar.gz");
      await new Promise((resolvePromise, reject) => {
        execFile("tar", ["-czf", bundle, "-C", payload, "binaries", "frameworks"], (error) =>
          error ? reject(error) : resolvePromise(),
        );
      });
      await writeFile(`${bundle}.sha256`, `${shaOf(await readFile(bundle))}  handmade.tar.gz\n`);

      const result = await runScript(UNFREEZE, ["--triple", MAC_TRIPLE, "--archive", bundle, "--root", destRoot]);

      expect(result.code).toBe(1);
      expect(result.stderr).toMatch(/gs_init\.ps/);
      expect(existsSync(join(destRoot, "src-tauri", "binaries")), "the swap happens only after the whole payload validates").toBe(false);
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

  it("refuses_the_download_path_without_GH_TOKEN_with_a_stubbed_gh_on_path", async () => {
    await withBareDest(async (destRoot) => {
      const stubbed = await stubEnv(destRoot);
      try {
        const env = { ...stubbed.env };
        delete env.GH_TOKEN;

        const result = await runScript(UNFREEZE, ["--triple", MAC_TRIPLE, "--root", destRoot], { env });

        expect(result.code).toBe(1);
        expect(result.stderr).toContain("GH_TOKEN");
        expect(existsSync(join(destRoot, "src-tauri", "binaries"))).toBe(false);
      } finally {
        await stubbed.cleanup();
      }
    });
  });

  it("refuses_a_nonexistent_root_instead_of_creating_the_hierarchy", async () => {
    await withRoot(async (outer) => {
      const missingRoot = join(outer, "not-a-repo");

      const result = await runScript(UNFREEZE, [
        "--triple",
        MAC_TRIPLE,
        "--archive",
        join(outer, "irrelevant.tar.gz"),
        "--root",
        missingRoot,
      ]);

      expect(result.code).toBe(1);
      expect(result.stderr).toContain("no src-tauri directory");
      expect(existsSync(missingRoot), "the root hierarchy must not be created by a refused run").toBe(false);
    });
  });

  it("refuses_to_run_while_another_unfreeze_holds_the_lock", async () => {
    await withFrozenSource(async (srcRoot) => {
      await withRoot(async (destRoot) => {
        await mkdir(join(destRoot, "src-tauri"));
        await stageSidecarTree(join(destRoot, "src-tauri"), ENGINE_PAYLOADS);
        await writeFile(join(destRoot, "src-tauri", "binaries", `ffmpeg-${MAC_TRIPLE}`), "stale ffmpeg\n");
        await mkdir(join(destRoot, "src-tauri", ".freeze", "unfreeze.lock"), { recursive: true });

        const result = await runScript(UNFREEZE, ["--triple", MAC_TRIPLE, "--archive", frozenBundle(srcRoot), "--root", destRoot]);

        expect(result.code).toBe(1);
        expect(result.stderr).toMatch(/lock/);
        expect(
          await readFile(join(destRoot, "src-tauri", "binaries", `ffmpeg-${MAC_TRIPLE}`), "utf8"),
          "a locked run must not touch the destination tree",
        ).toBe("stale ffmpeg\n");
        await rm(join(destRoot, "src-tauri", ".freeze", "unfreeze.lock"), { recursive: true });
      });
    });
  });

  it("swaps_out_a_stale_tree_and_restores_every_file_byte_for_byte_without_nesting", async () => {
    await withFrozenSource(async (srcRoot) => {
      await withRoot(async (destRoot) => {
        await mkdir(join(destRoot, "src-tauri"));
        await stageSidecarTree(join(destRoot, "src-tauri"), ENGINE_PAYLOADS);
        await writeFile(join(destRoot, "src-tauri", "binaries", `ffmpeg-${MAC_TRIPLE}`), "stale ffmpeg bytes\n");
        await mkdir(join(destRoot, "src-tauri", "frameworks", "frameworks"), { recursive: true });
        await writeFile(
          join(destRoot, "src-tauri", "frameworks", "frameworks", "libvips-test.42.dylib"),
          "nested stale dylib\n",
        );
        await mkdir(join(destRoot, "src-tauri", "gs-resources", "gs-resources", "Resource", "Init"), { recursive: true });
        await writeFile(
          join(destRoot, "src-tauri", "gs-resources", "gs-resources", "Resource", "Init", "gs_init.ps"),
          "nested stale init\n",
        );

        const result = await runScript(UNFREEZE, ["--triple", MAC_TRIPLE, "--archive", frozenBundle(srcRoot), "--root", destRoot]);

        expect(result.code, `stderr: ${result.stderr}`).toBe(0);
        for (const engine of ENGINES) {
          expect(await restoredBinary(destRoot, engine), "every restored engine equals the frozen payload").toBe(
            ENGINE_PAYLOADS[engine],
          );
        }
        expect(await restoredDylib(destRoot), "restored dylib matches the frozen payload").toBe("libvips dylib payload\n");
        expect(await restoredInit(destRoot), "restored init matches the frozen payload").toBe("ghostscript init payload\n");
        expect(existsSync(join(destRoot, "src-tauri", "frameworks", "frameworks")), "no frameworks/frameworks nesting survives").toBe(false);
        expect(existsSync(join(destRoot, "src-tauri", "gs-resources", "gs-resources")), "no gs-resources/gs-resources nesting survives").toBe(false);
      });
    });
  });

  it("restores_the_gh_path_bundle_selected_from_the_newest_sidecars_tag", async () => {
    await withBareDest(async (destRoot) => {
      const stubbed = await stubEnv(destRoot);
      try {
        const result = await runScript(UNFREEZE, ["--triple", MAC_TRIPLE, "--root", destRoot], { env: stubbed.env });

        expect(result.code, `stdout: ${result.stdout}\nstderr: ${result.stderr}`).toBe(0);
        expect(await readFile(stubbed.markers.list, "utf8"), "the stub gh publishes the tag list JSON").toBe(GH_LIST);
        expect(
          await readFile(stubbed.markers.download, "utf8"),
          "the claimed tag must be the newest sidecars-*, decoy v1.2.3 ignored",
        ).toBe("sidecars-20261010");
        for (const engine of ENGINES) {
          expect(await restoredBinary(destRoot, engine), "the gh-path payload lands byte-for-byte").toBe(GH_STUB_PAYLOADS[engine]);
        }
        expect(await restoredDylib(destRoot)).toBe("libvips dylib payload\n");
        expect(await restoredInit(destRoot)).toBe("ghostscript init payload\n");
        await expectCleanFreezeDir(destRoot);
      } finally {
        await stubbed.cleanup();
      }
    });
  });

  it("fails_closed_when_the_selected_release_has_no_matching_asset", async () => {
    await withBareDest(async (destRoot) => {
      const stubbed = await stubEnv(destRoot, { mode: "no-assets" });
      try {
        const result = await runScript(UNFREEZE, ["--triple", MAC_TRIPLE, "--root", destRoot], { env: stubbed.env });

        expect(result.code).toBe(1);
        expect(result.stderr).toMatch(/publishes no sidecar-bundle/i);
        expect(existsSync(join(destRoot, "src-tauri", "binaries")), "no swap happens without an asset").toBe(false);
        await expectCleanFreezeDir(destRoot);
      } finally {
        await stubbed.cleanup();
      }
    });
  });

  it("fails_closed_on_a_garbage_sha256_sibling", async () => {
    await withFrozenSource(async (srcRoot) => {
      await withBareDest(async (destRoot) => {
        const bundle = join(destRoot, "trash-sha.tar.gz");
        await copyFile(frozenBundle(srcRoot), bundle);
        await writeFile(`${bundle}.sha256`, "zzz  trash-sha.tar.gz\n");

        const result = await runScript(UNFREEZE, ["--triple", MAC_TRIPLE, "--archive", bundle, "--root", destRoot]);

        expect(result.code).toBe(1);
        expect(result.stderr).toMatch(/unreadable sha256 list/);
        expect(existsSync(join(destRoot, "src-tauri", "binaries")), "the destination tree stays untouched").toBe(false);
      });
    });
  });

  it("fails_closed_when_the_digest_sibling_is_unreadable", async () => {
    await withFrozenSource(async (srcRoot) => {
      await withBareDest(async (destRoot) => {
        const bundle = join(destRoot, "sneaky-sha.tar.gz");
        await copyFile(frozenBundle(srcRoot), bundle);
        await copyFile(`${frozenBundle(srcRoot)}.sha256`, `${bundle}.sha256`);
        await chmod(`${bundle}.sha256`, 0o000);

        const result = await runScript(UNFREEZE, ["--triple", MAC_TRIPLE, "--archive", bundle, "--root", destRoot]);

        expect(result.code).toBe(1);
        expect(result.stderr).toMatch(/could not read the expected digest|unreadable sha256 list/);
        expect(existsSync(join(destRoot, "src-tauri", "binaries"))).toBe(false);
      });
    });
  });

  it("fails_closed_on_a_truncated_gzip_whose_sha_matches_itself", async () => {
    await withFrozenSource(async (srcRoot) => {
      await withBareDest(async (destRoot) => {
        const whole = await readFile(frozenBundle(srcRoot));
        const truncated = whole.subarray(0, Math.floor(whole.length / 2));
        const bundle = join(destRoot, "truncated.tar.gz");
        await writeFile(bundle, truncated);
        await writeFile(`${bundle}.sha256`, `${shaOf(truncated)}  truncated.tar.gz\n`);

        const result = await runScript(UNFREEZE, ["--triple", MAC_TRIPLE, "--archive", bundle, "--root", destRoot]);

        expect(result.code).toBe(1);
        expect(result.stderr).toMatch(/tar extraction failed/);
        expect(existsSync(join(destRoot, "src-tauri", "binaries")), "a corrupt bundle must not reach the destination tree").toBe(false);
        await expectCleanFreezeDir(destRoot);
      });
    });
  });

  it("fails_closed_when_the_bundle_carries_only_four_of_the_five_engines", async () => {
    await withRoot(async (destRoot) => {
      await mkdir(join(destRoot, "src-tauri"));
      const payload = join(destRoot, "payload");
      await stageSidecarTree(payload, ENGINE_PAYLOADS);
      await rm(join(payload, "binaries", `gs-${MAC_TRIPLE}`));
      const bundle = await tarTree(payload, join(destRoot, "few-engines.tar.gz"));

      const result = await runScript(UNFREEZE, ["--triple", MAC_TRIPLE, "--archive", bundle, "--root", destRoot]);

      expect(result.code).toBe(1);
      expect(result.stderr).toMatch(/missing binaries\/gs-/);
      expect(existsSync(join(destRoot, "src-tauri", "binaries")), "a partial bundle must never swap").toBe(false);
      await expectCleanFreezeDir(destRoot);
    });
  });

  it("fails_closed_when_the_bundle_has_an_empty_frameworks_dir", async () => {
    await withRoot(async (destRoot) => {
      await mkdir(join(destRoot, "src-tauri"));
      const payload = join(destRoot, "payload");
      await stageSidecarTree(payload, ENGINE_PAYLOADS);
      await rm(join(payload, "frameworks", "libvips-test.42.dylib"));
      const bundle = await tarTree(payload, join(destRoot, "no-frameworks.tar.gz"));

      const result = await runScript(UNFREEZE, ["--triple", MAC_TRIPLE, "--archive", bundle, "--root", destRoot]);

      expect(result.code).toBe(1);
      expect(result.stderr).toMatch(/frameworks/);
      expect(existsSync(join(destRoot, "src-tauri", "binaries"))).toBe(false);
      await expectCleanFreezeDir(destRoot);
    });
  });

  it("fails_closed_when_the_destination_dir_is_unwritable", async () => {
    await withFrozenSource(async (srcRoot) => {
      await withRoot(async (destRoot) => {
        await mkdir(join(destRoot, "src-tauri"));
        await stageSidecarTree(join(destRoot, "src-tauri"), ENGINE_PAYLOADS);
        await writeFile(join(destRoot, "src-tauri", "binaries", `ffmpeg-${MAC_TRIPLE}`), "stale and protected\n");
        await mkdir(join(destRoot, "src-tauri", ".freeze"));
        await chmod(join(destRoot, "src-tauri"), 0o555);
        try {
          const result = await runScript(UNFREEZE, ["--triple", MAC_TRIPLE, "--archive", frozenBundle(srcRoot), "--root", destRoot]);

          expect(result.code).toBe(1);
          expect(result.stderr).toMatch(/set aside|not writable|untouched/);
          expect(
            await readFile(join(destRoot, "src-tauri", "binaries", `ffmpeg-${MAC_TRIPLE}`), "utf8"),
            "the pre-swap tree must survive a refused restore",
          ).toBe("stale and protected\n");
        } finally {
          await chmod(join(destRoot, "src-tauri"), 0o755);
        }
      });
    });
  });
});
