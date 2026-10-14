// @vitest-environment node
import { describe, expect, it } from "vitest";

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, utimes, writeFile, chmod } from "node:fs/promises";
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
const freezeLockDir = (root) => join(freezeDir(root), "freeze.lock");
const restoredBinary = (root, engine) =>
  readFile(join(root, "src-tauri", "binaries", `${engine}-${MAC_TRIPLE}`), "utf8");
const restoredInit = (root) => readFile(join(root, "src-tauri", "gs-resources", "Resource", "Init", "gs_init.ps"), "utf8");
const restoredDylib = (root) => readFile(join(root, "src-tauri", "frameworks", "libvips-test.42.dylib"), "utf8");

async function expectCleanFreezeDir(destRoot) {
  const dir = join(destRoot, "src-tauri", ".freeze");
  const entries = existsSync(dir) ? await readdir(dir) : [];
  expect(entries, "work and lock dirs must be cleaned up after the run").toEqual([]);
}

const STALE_PAYLOADS = Object.fromEntries(
  ENGINES.map((engine) => [engine, `stale payload for ${engine} from the pre-swap tree\n`]),
);
const STALE_DYLIB = "stale dylib bytes\n";
const STALE_INIT = "stale gs init bytes\n";

async function stageStaleTree(destRoot) {
  const base = join(destRoot, "src-tauri");
  await mkdir(base, { recursive: true });
  await stageSidecarTree(base, STALE_PAYLOADS);
  await writeFile(join(base, "frameworks", "libvips-test.42.dylib"), STALE_DYLIB);
  await writeFile(join(base, "gs-resources", "Resource", "Init", "gs_init.ps"), STALE_INIT);
}

async function expectStalePreSwapTree(destRoot) {
  for (const engine of ENGINES) {
    expect(
      await readFile(join(destRoot, "src-tauri", "binaries", `${engine}-${MAC_TRIPLE}`), "utf8"),
      `the pre-swap ${engine} binary must survive byte-for-byte`,
    ).toBe(STALE_PAYLOADS[engine]);
  }
  expect(await readFile(join(destRoot, "src-tauri", "frameworks", "libvips-test.42.dylib"), "utf8")).toBe(STALE_DYLIB);
  expect(await readFile(join(destRoot, "src-tauri", "gs-resources", "Resource", "Init", "gs_init.ps"), "utf8")).toBe(
    STALE_INIT,
  );
  const entries = await readdir(join(destRoot, "src-tauri"));
  expect(new Set(entries), "no swapped-in payload or temp litter may remain in src-tauri").toEqual(
    new Set(["binaries", "frameworks", "gs-resources", ".freeze"]),
  );
}

const FAIL_DEST_MV_SHIM = [
  "#!/bin/sh",
  "set -eu",
  'if [ -n "${FAIL_MV_STATE_FILE:-}" ] && [ -n "${FAIL_MV_DEST:-}" ] && [ "$2" = "$FAIL_MV_DEST" ] && [ ! -e "$FAIL_MV_STATE_FILE" ]; then',
  '  echo once > "$FAIL_MV_STATE_FILE"',
  '  echo "shim mv: refusing to move into $2" >&2',
  "  exit 1",
  "fi",
  'exec /bin/mv "$@"',
].join("\n");

const BACKUP_FAIL_MV_SHIM = [
  "#!/bin/sh",
  "set -eu",
  'prefix="${FAIL_BACKUP_DEST_PREFIX-}"',
  'if [ -n "$prefix" ]; then',
  '  case "$2" in',
  '    "$prefix"*)',
  '      base="${2##*/}"',
  '      case " ${FAIL_BACKUP_NAMES-} " in',
  '        *" $base "*)',
  '          echo "shim mv: refusing to move $base into the backup" >&2',
  "          exit 1",
  "          ;;",
  "      esac",
  "      ;;",
  "  esac",
  "fi",
  'exec /bin/mv "$@"',
].join("\n");

const TERM_MV_SHIM = [
  "#!/bin/sh",
  "set -eu",
  'kill -TERM "$PPID" 2>/dev/null || true',
  'exec /bin/mv "$@"',
].join("\n");

const ROLLBACK_TERM_MV_SHIM = [
  "#!/bin/sh",
  "set -eu",
  'if [ -n "${INSTALL_FAIL_DEST:-}" ] && [ -n "${INSTALL_FAIL_STATE:-}" ] && [ "$2" = "$INSTALL_FAIL_DEST" ] && [ ! -e "$INSTALL_FAIL_STATE" ]; then',
  '  echo staged > "$INSTALL_FAIL_STATE"',
  '  echo "shim mv: refusing to move into $2" >&2',
  "  exit 1",
  "fi",
  'case "$1" in',
  '  */unfreeze-backup.*)',
  '    if [ -n "${RESTORE_TERM_STATE:-}" ] && [ ! -e "$RESTORE_TERM_STATE" ]; then',
  '      echo staged > "$RESTORE_TERM_STATE"',
  '      kill -TERM "$PPID" 2>/dev/null || true',
  "      exit 1",
  "    fi",
  "    ;;",
  "esac",
  'exec /bin/mv "$@"',
].join("\n");

async function withMvShim(shimSource, extraEnv, body) {
  const shimDir = await mkdtemp(join(tmpdir(), "mv-shim-"));
  await writeFile(join(shimDir, "mv"), shimSource, { mode: 0o755 });
  const env = { ...process.env, PATH: `${shimDir}:${process.env.PATH ?? ""}`, ...extraEnv };
  try {
    return await body(env);
  } finally {
    await rm(shimDir, { recursive: true, force: true });
  }
}

const GH_LIST = `[{"tagName":"v1.2.3"},{"tagName":"sidecars-20260101"},{"tagName":"sidecars-20261010"}]`;

async function stubEnv(destRoot, { mode, ghList, repo } = {}) {
  const payload = await mkdtemp(join(tmpdir(), "gh-stub-payload-"));
  await stageSidecarTree(payload, GH_STUB_PAYLOADS);
  const stubDir = await mkdtemp(join(tmpdir(), "gh-stub-"));
  const stub = join(stubDir, "gh");
  const script = [
    "#!/bin/sh",
    "set -eu",
    "record_args() {",
    '  marker="$1"',
    "  shift",
    '  : > "$marker"',
    '  for a in "$@"; do',
    '    printf \'%s\\n\' "$a" >> "$marker"',
    "  done",
    "}",
    'case "$1 $2" in',
    '  "release list")',
    '    record_args "$GH_STUB_LIST_MARKER" "$@"',
    '    printf \'%s\' "$GH_STUB_LIST"',
    "    ;;",
    '  "release download")',
    '    record_args "$GH_STUB_DOWNLOAD_MARKER" "$@"',
    "    shift 2",
    '    tag=""',
    '    prev=""',
    '    for arg in "$@"; do',
    '      if [ "$prev" = "--repo" ]; then prev=""; continue; fi',
    '      case "$arg" in',
    '        --*) prev="$arg" ;;',
    '        *) if [ -z "$tag" ]; then tag="$arg"; fi ;;',
    '      esac',
    '    done',
    '    printf \'%s\' "$tag" > "$GH_STUB_TAG_MARKER"',
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
    GH_STUB_LIST: ghList ?? GH_LIST,
    GH_STUB_LIST_MARKER: markerList,
    GH_STUB_DOWNLOAD_MARKER: markerDownload,
    GH_STUB_TAG_MARKER: join(destRoot, "stub-tag.txt"),
    GH_STUB_PAYLOAD: payload,
    GH_STUB_TRIPLE: MAC_TRIPLE,
    ...(repo ? { GITHUB_REPOSITORY: repo } : {}),
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

  it("refuses_to_run_while_another_freeze_or_unfreeze_holds_the_lock", async () => {
    await withFrozenSource(async (srcRoot) => {
      await withRoot(async (destRoot) => {
        await mkdir(join(destRoot, "src-tauri"));
        await stageSidecarTree(join(destRoot, "src-tauri"), ENGINE_PAYLOADS);
        await writeFile(join(destRoot, "src-tauri", "binaries", `ffmpeg-${MAC_TRIPLE}`), "stale ffmpeg\n");
        await mkdir(freezeLockDir(destRoot), { recursive: true });

        const result = await runScript(UNFREEZE, ["--triple", MAC_TRIPLE, "--archive", frozenBundle(srcRoot), "--root", destRoot]);

        expect(result.code).toBe(1);
        expect(result.stderr).toMatch(/lock/);
        expect(
          result.stderr,
          "the refusal must include the stale-lock remediation",
        ).toContain(`remove ${freezeLockDir(destRoot)} and retry`);
        expect(
          await readFile(join(destRoot, "src-tauri", "binaries", `ffmpeg-${MAC_TRIPLE}`), "utf8"),
          "a locked run must not touch the destination tree",
        ).toBe("stale ffmpeg\n");
        await rm(freezeLockDir(destRoot), { recursive: true });
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
        const ghListArgs = (await readFile(stubbed.markers.list, "utf8")).split("\n").filter(Boolean);
        expect(ghListArgs, "the tag list is requested with a bounded JSON query").toContain("--json");
        expect(ghListArgs[ghListArgs.indexOf("--json") + 1]).toBe("tagName");
        const ghDownloadArgs = (await readFile(stubbed.markers.download, "utf8")).split("\n").filter(Boolean);
        expect(
          ghDownloadArgs,
          "the claimed tag must be the newest sidecars-*, decoy v1.2.3 ignored",
        ).toContain("sidecars-20261010");
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

  it.each(["binaries", "frameworks", "gs-resources"])(
    "rolls_back_to_the_pre_swap_tree_when_the_install_fails_moving_%s",
    async (failDest) => {
      await withFrozenSource(async (srcRoot) => {
        await withRoot(async (destRoot) => {
          await stageStaleTree(destRoot);
          const result = await withMvShim(
            FAIL_DEST_MV_SHIM,
            {
              FAIL_MV_DEST: join(destRoot, "src-tauri", failDest),
              FAIL_MV_STATE_FILE: join(destRoot, "stub-mv-state"),
            },
            (env) =>
              runScript(UNFREEZE, ["--triple", MAC_TRIPLE, "--archive", frozenBundle(srcRoot), "--root", destRoot], {
                env,
              }),
          );

          expect(result.code, `stdout: ${result.stdout}\nstderr: ${result.stderr}`).toBe(1);
          expect(result.stderr).toMatch(/failed to install the new sidecar tree/);
          expect(
            result.stderr,
            "the rollback must not claim success over un-rolled-back names",
          ).toMatch(/restored byte-for-byte to its pre-swap state/);
          await expectStalePreSwapTree(destRoot);
          await expectCleanFreezeDir(destRoot);
        });
      });
    },
  );

  it("restores_the_pre_swap_tree_when_a_backup_set_aside_move_fails_midway", async () => {
    await withFrozenSource(async (srcRoot) => {
      await withRoot(async (destRoot) => {
        await stageStaleTree(destRoot);
        const result = await withMvShim(
          BACKUP_FAIL_MV_SHIM,
          {
            FAIL_BACKUP_DEST_PREFIX: join(destRoot, "src-tauri", ".freeze", "unfreeze-backup."),
            FAIL_BACKUP_NAMES: "frameworks",
          },
          (env) =>
            runScript(UNFREEZE, ["--triple", MAC_TRIPLE, "--archive", frozenBundle(srcRoot), "--root", destRoot], {
              env,
            }),
        );

        expect(result.code, `stdout: ${result.stdout}\nstderr: ${result.stderr}`).toBe(1);
        expect(result.stderr).toMatch(/failed to swap in the new sidecar tree/);
        expect(result.stderr).toMatch(/restored byte-for-byte to its pre-swap state/);
        await expectStalePreSwapTree(destRoot);
        await expectCleanFreezeDir(destRoot);
      });
    });
  });

  it("preserves_the_named_backup_and_the_pre_swap_tree_when_a_signal_interrupts_the_swap", async () => {
    await withFrozenSource(async (srcRoot) => {
      await withRoot(async (destRoot) => {
        await stageStaleTree(destRoot);
        const result = await withMvShim(TERM_MV_SHIM, {}, (env) =>
          runScript(UNFREEZE, ["--triple", MAC_TRIPLE, "--archive", frozenBundle(srcRoot), "--root", destRoot], {
            env,
          }),
        );

        expect(result.code, `stdout: ${result.stdout}\nstderr: ${result.stderr}`).toBe(143);
        await expectStalePreSwapTree(destRoot);
        const leftovers = await readdir(freezeDir(destRoot));
        expect(leftovers.length).toBe(1);
        expect(leftovers[0]).toMatch(/^unfreeze-backup\./);
        expect(existsSync(join(freezeDir(destRoot), "freeze.lock")), "no lock may survive the interrupted run").toBe(
          false,
        );
        expect(result.stderr).toContain(leftovers[0]);
      });
    });
  });

  it("keeps_recovery_and_named_backup_messaging_when_a_signal_lands_mid_rollback", async () => {
    await withFrozenSource(async (srcRoot) => {
      await withRoot(async (destRoot) => {
        await stageStaleTree(destRoot);
        const result = await withMvShim(
          ROLLBACK_TERM_MV_SHIM,
          {
            INSTALL_FAIL_DEST: join(destRoot, "src-tauri", "binaries"),
            INSTALL_FAIL_STATE: join(destRoot, "stub-install-state"),
            RESTORE_TERM_STATE: join(destRoot, "stub-restore-state"),
          },
          (env) =>
            runScript(UNFREEZE, ["--triple", MAC_TRIPLE, "--archive", frozenBundle(srcRoot), "--root", destRoot], {
              env,
            }),
        );

        expect(result.code, `stdout: ${result.stdout}\nstderr: ${result.stderr}`).toBe(143);
        expect(result.stderr, "the interrupted rollback must be named, not silent").toMatch(/interrupted mid-swap/);
        const leftovers = await readdir(freezeDir(destRoot));
        expect(leftovers.length).toBe(1);
        expect(leftovers[0]).toMatch(/^unfreeze-backup\./);
        expect(
          result.stderr,
          "the named backup path must appear in the failure messaging",
        ).toContain(join(destRoot, "src-tauri", ".freeze", leftovers[0]));
        expect(
          result.stderr,
          "the restore continuation must finish with the full byte-for-byte message",
        ).toMatch(/restored byte-for-byte to its pre-swap state/);
        expect(
          existsSync(join(freezeDir(destRoot), "freeze.lock")),
          "no lock may survive a signal fired during the rollback itself",
        ).toBe(false);
        await expectStalePreSwapTree(destRoot);
      });
    });
  });

  it("recovers_a_stale_lock_left_by_a_dead_predecessor_older_than_an_hour", async () => {
    await withFrozenSource(async (srcRoot) => {
      await withRoot(async (destRoot) => {
        await mkdir(join(destRoot, "src-tauri"));
        const lockDir = freezeLockDir(destRoot);
        await mkdir(lockDir, { recursive: true });
        await writeFile(join(lockDir, "pid"), "999999\n");
        const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
        await utimes(lockDir, twoHoursAgo, twoHoursAgo);

        const result = await runScript(UNFREEZE, ["--triple", MAC_TRIPLE, "--archive", frozenBundle(srcRoot), "--root", destRoot]);

        expect(result.code, `stdout: ${result.stdout}\nstderr: ${result.stderr}`).toBe(0);
        expect(result.stdout).toMatch(/removed stale lock from dead pid/);
        for (const engine of ENGINES) {
          expect(await restoredBinary(destRoot, engine)).toBe(ENGINE_PAYLOADS[engine]);
        }
        await expectCleanFreezeDir(destRoot);
      });
    });
  });

  it("refuses_a_lock_held_by_a_live_pid_even_when_the_stamp_is_old", async () => {
    await withFrozenSource(async (srcRoot) => {
      await withRoot(async (destRoot) => {
        await mkdir(join(destRoot, "src-tauri"));
        await stageSidecarTree(join(destRoot, "src-tauri"), ENGINE_PAYLOADS);
        await writeFile(join(destRoot, "src-tauri", "binaries", `ffmpeg-${MAC_TRIPLE}`), "stale ffmpeg\n");
        const lockDir = freezeLockDir(destRoot);
        await mkdir(lockDir, { recursive: true });
        await writeFile(join(lockDir, "pid"), `${process.pid}\n`);
        const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
        await utimes(lockDir, twoHoursAgo, twoHoursAgo);

        const result = await runScript(UNFREEZE, ["--triple", MAC_TRIPLE, "--archive", frozenBundle(srcRoot), "--root", destRoot]);

        expect(result.code).toBe(1);
        expect(result.stderr).toMatch(/holds the lock/);
        expect(
          await readFile(join(destRoot, "src-tauri", "binaries", `ffmpeg-${MAC_TRIPLE}`), "utf8"),
          "a live-pid lock holds the run off no matter the stamp",
        ).toBe("stale ffmpeg\n");
      });
    });
  });

  it("refuses_a_fresh_dead_pid_lock_and_advises_the_stale_lock_remediation", async () => {
    await withFrozenSource(async (srcRoot) => {
      await withRoot(async (destRoot) => {
        await mkdir(join(destRoot, "src-tauri"));
        await stageSidecarTree(join(destRoot, "src-tauri"), ENGINE_PAYLOADS);
        await writeFile(join(destRoot, "src-tauri", "binaries", `ffmpeg-${MAC_TRIPLE}`), "stale ffmpeg\n");
        const lockDir = freezeLockDir(destRoot);
        await mkdir(lockDir, { recursive: true });
        await writeFile(join(lockDir, "pid"), "999999\n");

        const result = await runScript(UNFREEZE, ["--triple", MAC_TRIPLE, "--archive", frozenBundle(srcRoot), "--root", destRoot]);

        expect(result.code).toBe(1);
        expect(result.stderr).toMatch(/holds the lock/);
        expect(result.stderr, "the refusal must include the stale-lock remediation").toContain(
          `remove ${lockDir} and retry`,
        );
        expect(
          await readFile(join(destRoot, "src-tauri", "binaries", `ffmpeg-${MAC_TRIPLE}`), "utf8"),
          "the pre-swap tree must survive a refused restore",
        ).toBe("stale ffmpeg\n");
      });
    });
  });

  it("fails_loudly_when_the_gh_list_output_is_unparseable", async () => {
    await withBareDest(async (destRoot) => {
      const stubbed = await stubEnv(destRoot, { ghList: "fatal: quota exceeded while listing releases" });
      try {
        const result = await runScript(UNFREEZE, ["--triple", MAC_TRIPLE, "--root", destRoot], { env: stubbed.env });

        expect(result.code).toBe(1);
        expect(result.stderr).toMatch(/gh release list returned unparseable output/);
        expect(result.stderr).toContain("fatal: quota exceeded while listing releases".slice(0, 120));
        expect(existsSync(join(destRoot, "src-tauri", "binaries"))).toBe(false);
        await expectCleanFreezeDir(destRoot);
      } finally {
        await stubbed.cleanup();
      }
    });
  });

  it("keeps_the_adr_message_when_the_repo_has_zero_releases", async () => {
    await withBareDest(async (destRoot) => {
      const stubbed = await stubEnv(destRoot, { ghList: "[]" });
      try {
        const result = await runScript(UNFREEZE, ["--triple", MAC_TRIPLE, "--root", destRoot], { env: stubbed.env });

        expect(result.code).toBe(1);
        expect(result.stderr).toMatch(/no sidecars-.* release found — run freeze\.yml before the release build/);
        expect(result.stderr).not.toMatch(/unparseable/);
        expect(existsSync(join(destRoot, "src-tauri", "binaries"))).toBe(false);
      } finally {
        await stubbed.cleanup();
      }
    });
  });

  it("keeps_the_adr_message_when_releases_exist_but_no_sidecars_tag", async () => {
    await withBareDest(async (destRoot) => {
      const stubbed = await stubEnv(destRoot, { ghList: '[{"tagName":"v1.2.3"}]' });
      try {
        const result = await runScript(UNFREEZE, ["--triple", MAC_TRIPLE, "--root", destRoot], { env: stubbed.env });

        expect(result.code).toBe(1);
        expect(result.stderr).toMatch(/no sidecars-.* release found — run freeze\.yml before the release build/);
        expect(
          result.stderr,
          "real releases with no sidecars tag are a freeze-gap, not an unparseable-output bug",
        ).not.toMatch(/unparseable/);
        expect(existsSync(join(destRoot, "src-tauri", "binaries"))).toBe(false);
      } finally {
        await stubbed.cleanup();
      }
    });
  });

  it("records_the_gh_arg_contract_including_the_ci_repo_flag", async () => {
    await withBareDest(async (destRoot) => {
      const stubbed = await stubEnv(destRoot, { repo: "initgrep-apps/filecompressor" });
      try {
        const result = await runScript(UNFREEZE, ["--triple", MAC_TRIPLE, "--root", destRoot], { env: stubbed.env });

        expect(result.code, `stdout: ${result.stdout}\nstderr: ${result.stderr}`).toBe(0);
        for (const engine of ENGINES) {
          expect(await restoredBinary(destRoot, engine)).toBe(GH_STUB_PAYLOADS[engine]);
        }
        const listArgs = (await readFile(stubbed.markers.list, "utf8")).split("\n").filter(Boolean);
        expect(listArgs.slice(0, 2), "the gh stub records full argument vectors").toEqual(["release", "list"]);
        expect(listArgs).toContain("--repo");
        expect(listArgs).toContain("initgrep-apps/filecompressor");
        expect(listArgs).toContain("--limit");
        expect(listArgs[listArgs.indexOf("--limit") + 1]).toBe("200");
        expect(listArgs).toContain("--json");
        expect(listArgs[listArgs.indexOf("--json") + 1]).toBe("tagName");
        const downloadArgs = (await readFile(stubbed.markers.download, "utf8")).split("\n").filter(Boolean);
        expect(downloadArgs.slice(0, 2)).toEqual(["release", "download"]);
        expect(downloadArgs).toContain("--repo");
        expect(downloadArgs).toContain("initgrep-apps/filecompressor");
        expect(
          downloadArgs.filter((arg) => arg === "--pattern").length,
          "both the bundle and its .sha256 are requested",
        ).toBe(2);
        expect(downloadArgs).toContain(`sidecar-bundle-${MAC_TRIPLE}.tar.gz`);
        expect(downloadArgs).toContain(`sidecar-bundle-${MAC_TRIPLE}.tar.gz.sha256`);
        expect(downloadArgs).toContain("--clobber");
        expect(downloadArgs).toContain("sidecars-20261010");
      } finally {
        await stubbed.cleanup();
      }
    });
  });
});
