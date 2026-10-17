// @vitest-environment node
import { describe, expect, it, vi } from "vitest";

vi.setConfig({ testTimeout: 30_000 });

import { execFile, execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, utimes, writeFile, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const FREEZE = join(HERE, "freeze.sh");
const UNFREEZE = join(HERE, "unfreeze.sh");

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
const WIN_TRIPLE = "x86_64-pc-windows-msvc";
const WIN_ENGINES = ["vips", "qpdf", "gs"];
const ENGINE_PAYLOADS = Object.fromEntries(
  ENGINES.map((engine) => [engine, `payload for ${engine} on ${MAC_TRIPLE}\n`]),
);
const GH_STUB_PAYLOADS = Object.fromEntries(
  ENGINES.map((engine) => [engine, `gh-path payload for ${engine} on ${MAC_TRIPLE}\n`]),
);

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
    execFile("tar", ["-czf", toBashPath(bundlePath), "-C", toBashPath(base), "binaries", "frameworks", "gs-resources"], (error) =>
      error ? reject(error) : resolvePromise(),
    );
  });
  const digest = shaOf(await readFile(bundlePath));
  await writeFile(`${bundlePath}.sha256`, `${digest}  ${bundlePath.split("/").pop()}\n`);
  return bundlePath;
}

async function stageWindowsTree(base, triple, exePayloads = {}) {
  const bin = join(base, "binaries");
  await mkdir(bin, { recursive: true });
  for (const flat of ["ffmpeg", "ffprobe", "vips", "qpdf", "gs"]) {
    await writeFile(
      join(bin, `${flat}-${triple}.exe`),
      exePayloads[flat] ?? `${flat} flat payload for ${triple}\n`,
    );
  }
  for (const engine of WIN_ENGINES) {
    const enginesDir = join(bin, "engines", engine);
    await mkdir(enginesDir, { recursive: true });
    await writeFile(join(enginesDir, `${engine}.exe`), exePayloads[engine] ?? `${engine} engine payload\n`);
    await writeFile(join(enginesDir, `${engine}-support.dll`), `${engine} dll payload\n`);
  }
}

async function tarWindowsTree(base, bundlePath, roots = ["binaries"]) {
  await new Promise((resolvePromise, reject) => {
    execFile("tar", ["-czf", toBashPath(bundlePath), "-C", toBashPath(base), ...roots], (error) =>
      error ? reject(error) : resolvePromise(),
    );
  });
  const digest = shaOf(await readFile(bundlePath));
  await writeFile(`${bundlePath}.sha256`, `${digest}  ${bundlePath.split("/").pop()}\n`);
  return bundlePath;
}

const ustarDirEntry = (name, mode = 0o755) => ustarHeader(name, { mode, type: "5" });

function ustarHeader(name, { mode, type, size = 0 }) {
  const b = Buffer.alloc(512, 0);
  b.write(name, 0, "utf8");
  b.write(`${mode.toString(8).padStart(7, "0")} `, 100, "ascii");
  b.write("0000000 ", 108, "ascii");
  b.write("0000000 ", 116, "ascii");
  b.write(`${size.toString(8).padStart(11, "0")} `, 124, "ascii");
  b.write("0 ".padEnd(12, " "), 136, "ascii");
  b.write("        ", 148, "ascii");
  b.write(type, 156, "ascii");
  b.write("ustar", 257, "ascii");
  b.write("00", 263, "ascii");
  let sum = 0;
  for (const byte of b) sum += byte;
  b.write(`${sum.toString(8).padStart(7, "0")}\0`, 148, "ascii");
  return b;
}

function ustarFileEntry(name, mode, body) {
  const header = ustarHeader(name, { mode, type: "0", size: Buffer.byteLength(body) });
  const content = Buffer.from(body, "utf8");
  const padding = Buffer.alloc((512 - (content.length % 512)) % 512, 0);
  return Buffer.concat([header, content, padding]);
}

async function craftWindowsBundleWithSealedVipsSubdir(destRoot) {
  const ini = "%! crafted gs init\n";
  const exeBody = "crafted vips engine payload\n";
  const tar = Buffer.concat(
    [
      ustarDirEntry("binaries/"),
      ustarDirEntry("binaries/engines/"),
      ustarDirEntry("binaries/engines/vips/"),
      ustarFileEntry("binaries/engines/vips/vips.exe", 0o755, exeBody),
      ustarDirEntry("binaries/engines/vips/sub/", 0o000),
      ustarDirEntry("gs-resources/Resource/"),
      ustarDirEntry("gs-resources/Resource/Init/"),
      ustarFileEntry("gs-resources/Resource/Init/gs_init.ps", 0o644, ini),
      Buffer.alloc(1024, 0),
    ],
  );
  const { gzipSync } = await import("node:zlib");
  const bundle = join(destRoot, "win-sealed-vips-sub.tar.gz");
  await writeFile(bundle, gzipSync(tar));
  await writeFile(`${bundle}.sha256`, `${shaOf(await readFile(bundle))}  win-sealed-vips-sub.tar.gz\n`);
  return bundle;
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

async function withWindowsFrozenSource(body) {
  const srcRoot = await mkdtemp(join(tmpdir(), "unfreeze-win-src-"));
  try {
    await mkdir(join(srcRoot, "src-tauri"), { recursive: true });
    await stageWindowsTree(join(srcRoot, "src-tauri"), WIN_TRIPLE);
    const result = await runScript(FREEZE, ["--triple", WIN_TRIPLE, "--root", srcRoot]);
    if (result.code !== 0) {
      throw new Error(`windows fixture freeze failed: ${result.stderr}`);
    }
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
const frozenWindowsBundle = (root) => join(freezeDir(root), `sidecar-bundle-${WIN_TRIPLE}.tar.gz`);
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

const STALE_WIN_PAYLOADS = {
  ffmpeg: "stale flat ffmpeg for windows\n",
  ffprobe: "stale flat ffprobe for windows\n",
  vips: "stale flat vips for windows\n",
  qpdf: "stale flat qpdf for windows\n",
  gs: "stale flat gs for windows\n",
};
const STALE_WIN_ENGINES = Object.fromEntries(
  WIN_ENGINES.map((engine) => [engine, `stale ${engine} engine payload\n`]),
);
const STALE_WIN_DLL = "stale dll bytes\n";
const STALE_WIN_INIT = "stale gs init bytes\n";

async function stageStaleWindowsTree(destRoot) {
  await stageWindowsTree(join(destRoot, "src-tauri"), WIN_TRIPLE, STALE_WIN_PAYLOADS);
  const base = join(destRoot, "src-tauri");
  for (const engine of WIN_ENGINES) {
    await writeFile(join(base, "binaries", "engines", engine, `${engine}.exe`), STALE_WIN_ENGINES[engine]);
    await writeFile(join(base, "binaries", "engines", engine, `${engine}-support.dll`), STALE_WIN_DLL);
  }
  const staleInit = join(base, "gs-resources", "Resource", "Init");
  await mkdir(staleInit, { recursive: true });
  await writeFile(join(staleInit, "gs_init.ps"), STALE_WIN_INIT);
}

async function expectStaleWindowsPreSwapTree(destRoot) {
  const base = join(destRoot, "src-tauri");
  for (const [flat, payload] of Object.entries(STALE_WIN_PAYLOADS)) {
    expect(
      await readFile(join(base, "binaries", `${flat}-${WIN_TRIPLE}.exe`), "utf8"),
      `the pre-swap ${flat} flat exe must survive byte-for-byte`,
    ).toBe(payload);
  }
  for (const engine of WIN_ENGINES) {
    expect(
      await readFile(join(base, "binaries", "engines", engine, `${engine}.exe`), "utf8"),
    ).toBe(STALE_WIN_ENGINES[engine]);
    expect(
      await readFile(join(base, "binaries", "engines", engine, `${engine}-support.dll`), "utf8"),
    ).toBe(STALE_WIN_DLL);
  }
  expect(await readFile(join(base, "gs-resources", "Resource", "Init", "gs_init.ps"), "utf8")).toBe(STALE_WIN_INIT);
  const entries = await readdir(join(destRoot, "src-tauri"));
  expect(new Set(entries), "no swapped-in payload or temp litter may remain in src-tauri").toEqual(
    new Set(["binaries", "gs-resources", ".freeze"]),
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

async function stubEnv(destRoot, { mode, ghList, repo, triple, roots } = {}) {
  const payload = await mkdtemp(join(tmpdir(), "gh-stub-payload-"));
  const stubTriple = triple ?? MAC_TRIPLE;
  if (triple && triple.includes("pc-windows")) {
    await stageWindowsTree(payload, stubTriple, GH_STUB_PAYLOADS);
  } else {
    await stageSidecarTree(payload, GH_STUB_PAYLOADS);
  }
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
    '    tar -czf "$dir/sidecar-bundle-$GH_STUB_TRIPLE.tar.gz" -C "$GH_STUB_PAYLOAD" $GH_STUB_ROOTS',
    '    (cd "$dir" && { if command -v shasum >/dev/null 2>&1; then shasum -a 256 "sidecar-bundle-$GH_STUB_TRIPLE.tar.gz"; else sha256sum "sidecar-bundle-$GH_STUB_TRIPLE.tar.gz"; fi; } > "sidecar-bundle-$GH_STUB_TRIPLE.tar.gz.sha256")',
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
    GH_STUB_LIST_MARKER: toBashPath(markerList),
    GH_STUB_DOWNLOAD_MARKER: toBashPath(markerDownload),
    GH_STUB_TAG_MARKER: toBashPath(join(destRoot, "stub-tag.txt")),
    GH_STUB_PAYLOAD: toBashPath(payload),
    GH_STUB_TRIPLE: stubTriple,
    GH_STUB_ROOTS: roots ?? "binaries frameworks gs-resources",
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
  it("resolves_windows_backslash_script_paths_for_the_sibling_manifest_lists_and_root", () => {
    const source = readFileSync(join(HERE, "unfreeze.sh"), "utf8");
    expect(
      source.includes("${0//\\\\//}"),
      "the sibling windows-manifest-lists.sh lookup and the fallback repo-root derivation must normalize Windows backslash argv[0] (execFile passes D:\\... so ${0%/*} never sees a slash and every fixture freeze/unfreeze dies with 'cannot load ./windows-manifest-lists.sh')",
    ).toBe(true);
  });

  it("survives_gnu_mktemp_semantics_when_scanning_window_engine_dirs_for_dlls", async () => {
    await withWindowsFrozenSource(async (srcRoot) => {
      await withBareDest(async (destRoot) => {
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

        const result = await runScript(
          UNFREEZE,
          ["--triple", WIN_TRIPLE, "--archive", frozenWindowsBundle(srcRoot), "--root", destRoot],
          { env: { ...process.env, PATH: `${stubDir}:${process.env.PATH ?? ""}` } },
        );

        expect(
          result.code,
          `git-bash mktemp rejects X-less templates, so every unfreeze mktemp template must carry trailing X's: stdout: ${result.stdout}\nstderr: ${result.stderr}`,
        ).toBe(0);
        expect(result.stdout).toContain(`restored ${WIN_TRIPLE} sidecars into src-tauri/`);
        expect(result.stdout + result.stderr).not.toContain("too few X's");
        await expectCleanFreezeDir(destRoot);
      });
    });
  });

  it("writes_a_provenance_marker_with_triple_bundle_sha_and_iso_timestamp_after_a_successful_restore", async () => {
    await withFrozenSource(async (srcRoot) => {
      await withBareDest(async (destRoot) => {
        const result = await runScript(UNFREEZE, ["--triple", MAC_TRIPLE, "--archive", frozenBundle(srcRoot), "--root", destRoot]);

        expect(result.code, `stdout: ${result.stdout}\nstderr: ${result.stderr}`).toBe(0);
        const markerPath = join(destRoot, "src-tauri", ".sidecars-restored.json");
        expect(existsSync(markerPath), "the consumer audit needs the provenance marker to govern the stagedSha256 lock comparison — without it the restored-vs-lock hash drift fails the row").toBe(true);
        const marker = JSON.parse(await readFile(markerPath, "utf8"));
        expect(marker.triple).toBe(MAC_TRIPLE);
        expect(marker.bundleSha256, "the marker pins the sha256 of the bundle that was actually restored").toBe(shaOf(await readFile(frozenBundle(srcRoot))));
        expect(marker.restoredAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
        expect(new Date(marker.restoredAt).getTime(), "restoredAt must parse as ISO-8601 UTC on every host").not.toBeNaN();
        await expectCleanFreezeDir(destRoot);
      });
    });
  });

  it("writes_the_provenance_marker_for_windows_restores_too", async () => {
    await withWindowsFrozenSource(async (srcRoot) => {
      await withBareDest(async (destRoot) => {
        const result = await runScript(UNFREEZE, ["--triple", WIN_TRIPLE, "--archive", frozenWindowsBundle(srcRoot), "--root", destRoot]);

        expect(result.code, `stdout: ${result.stdout}\nstderr: ${result.stderr}`).toBe(0);
        const marker = JSON.parse(await readFile(join(destRoot, "src-tauri", ".sidecars-restored.json"), "utf8"));
        expect(marker.triple).toBe(WIN_TRIPLE);
        expect(marker.bundleSha256).toBe(shaOf(await readFile(frozenWindowsBundle(srcRoot))));
      });
    });
  });

  it("leaves_no_provenance_marker_when_the_restore_fails", async () => {
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
          existsSync(join(destRoot, "src-tauri", ".sidecars-restored.json")),
          "a failed restore must not leave a provenance marker — the marker would disable the stagedSha256 gate for a tree it never restored",
        ).toBe(false);
      });
    });
  });

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

  it("fails_closed_when_tar_is_absent_from_the_path", async () => {
    await withFrozenSource(async (srcRoot) => {
      await withBareDest(async (destRoot) => {
        const tarless = await mkdtemp(join(tmpdir(), "tarless-path-"));
        try {
          const env = { ...process.env, PATH: tarless };
          const bashToken =
            process.platform === "win32"
              ? execFileSync("where", ["bash"], { encoding: "utf8" }).split(/\r?\n/)[0].trim()
              : "/bin/bash";
          const result = await new Promise((resolvePromise) => {
            execFile(
              bashToken,
              [UNFREEZE, "--triple", MAC_TRIPLE, "--archive", frozenBundle(srcRoot), "--root", destRoot],
              { encoding: "utf8", timeout: 60_000, env },
              (error, stdout, stderr) => {
                resolvePromise({ code: error?.code ?? (error?.signal ? 255 : 0), stdout, stderr, signal: error?.signal ?? null });
              },
            );
          });

          expect(result.code).toBe(1);
          expect(result.stderr).toMatch(/tar is not on PATH/i);
          expect(existsSync(join(destRoot, "src-tauri", "binaries"))).toBe(false);
          await expectCleanFreezeDir(destRoot);
        } finally {
          await rm(tarless, { recursive: true, force: true });
        }
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
        execFile("tar", ["-czf", toBashPath(bundle), "-C", toBashPath(payload), "binaries", "frameworks"], (error) =>
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

  it("restores_the_windows_frozen_tree_into_a_clean_src_tauri_as_binaries_only", async () => {
    const srcRoot = await mkdtemp(join(tmpdir(), "unfreeze-win-src-"));
    let ok = false;
    try {
      await mkdir(join(srcRoot, "src-tauri"), { recursive: true });
      await stageWindowsTree(join(srcRoot, "src-tauri"), WIN_TRIPLE);
      const frozen = await runScript(FREEZE, ["--triple", WIN_TRIPLE, "--root", srcRoot]);
      expect(frozen.code, frozen.stderr).toBe(0);

      await withBareDest(async (destRoot) => {
        const bundle = join(srcRoot, "src-tauri", ".freeze", `sidecar-bundle-${WIN_TRIPLE}.tar.gz`);
        const result = await runScript(UNFREEZE, ["--triple", WIN_TRIPLE, "--archive", bundle, "--root", destRoot]);

        expect(result.code, `stdout: ${result.stdout}\nstderr: ${result.stderr}`).toBe(0);
        for (const engine of WIN_ENGINES) {
          expect(
            await readFile(join(destRoot, "src-tauri", "binaries", "engines", engine, `${engine}.exe`), "utf8"),
            `the frozen ${engine} engine lands byte-for-byte`,
          ).toBe(`${engine} engine payload\n`);
          expect(
            await readFile(join(destRoot, "src-tauri", "binaries", "engines", engine, `${engine}-support.dll`), "utf8"),
          ).toBe(`${engine} dll payload\n`);
        }
        for (const flat of ["ffmpeg", "ffprobe", "vips", "qpdf", "gs"]) {
          expect(
            await readFile(join(destRoot, "src-tauri", "binaries", `${flat}-${WIN_TRIPLE}.exe`), "utf8"),
            `${flat}-<triple>.exe must be restored so verify.mjs and the tauri externalBin/validation contract hold post-unfreeze`,
          ).toBe(`${flat} flat payload for ${WIN_TRIPLE}\n`);
        }
        expect(
          new Set(await readdir(join(destRoot, "src-tauri"))),
          "a windows restore swaps binaries only: no gs-resources dir, no frameworks dir — the restore provenance marker records the bundle sha",
        ).toEqual(new Set(["binaries", ".freeze", ".sidecars-restored.json"]));
        expect(existsSync(join(destRoot, "src-tauri", "frameworks")), "windows restore never creates frameworks/").toBe(false);
        await expectCleanFreezeDir(destRoot);
      });
      ok = true;
    } finally {
      if (!ok) {
        await rm(srcRoot, { recursive: true, force: true });
      } else {
        await rm(srcRoot, { recursive: true, force: true });
      }
    }
  });

  it("refuses_linux_triples", async () => {
    await withRoot(async (destRoot) => {
      const result = await runScript(UNFREEZE, [
        "--triple",
        "x86_64-unknown-linux-gnu",
        "--archive",
        join(destRoot, "anything.tar.gz"),
        "--root",
        destRoot,
      ]);

      expect(result.code).toBe(1);
      expect(result.stderr).toContain("x86_64-unknown-linux-gnu");
      expect(existsSync(join(destRoot, "src-tauri"))).toBe(false);
    });
  });

  it("fails_closed_when_the_windows_bundle_is_missing_an_engines_dir", async () => {
    await withRoot(async (destRoot) => {
      await mkdir(join(destRoot, "src-tauri"));
      const payload = join(destRoot, "payload");
      await stageWindowsTree(payload, WIN_TRIPLE);
      await rm(join(payload, "binaries", "engines", "vips"), { recursive: true });
      const bundle = await tarWindowsTree(payload, join(destRoot, "no-vips.tar.gz"));

      const result = await runScript(UNFREEZE, ["--triple", WIN_TRIPLE, "--archive", bundle, "--root", destRoot]);

      expect(result.code).toBe(1);
      expect(result.stderr).toMatch(/binaries\/engines\/vips/);
      expect(existsSync(join(destRoot, "src-tauri", "binaries")), "a partial windows bundle must never swap").toBe(false);
      await expectCleanFreezeDir(destRoot);
    });
  });

  it("fails_closed_when_the_windows_bundle_is_missing_the_external_ffmpeg_exe", async () => {
    await withRoot(async (destRoot) => {
      await mkdir(join(destRoot, "src-tauri"));
      const payload = join(destRoot, "payload");
      await stageWindowsTree(payload, WIN_TRIPLE);
      await rm(join(payload, "binaries", `ffmpeg-${WIN_TRIPLE}.exe`));
      const bundle = await tarWindowsTree(payload, join(destRoot, "no-ffmpeg.tar.gz"));

      const result = await runScript(UNFREEZE, ["--triple", WIN_TRIPLE, "--archive", bundle, "--root", destRoot]);

      expect(result.code).toBe(1);
      expect(result.stderr).toContain(`binaries/ffmpeg-${WIN_TRIPLE}.exe`);
      expect(existsSync(join(destRoot, "src-tauri", "binaries"))).toBe(false);
      await expectCleanFreezeDir(destRoot);
    });
  });

  it("fails_closed_when_the_windows_bundle_is_missing_a_flat_engine_exe", async () => {
    await withRoot(async (destRoot) => {
      await mkdir(join(destRoot, "src-tauri"));
      const payload = join(destRoot, "payload");
      await stageWindowsTree(payload, WIN_TRIPLE);
      await rm(join(payload, "binaries", `qpdf-${WIN_TRIPLE}.exe`));
      const bundle = await tarWindowsTree(payload, join(destRoot, "no-flat-qpdf.tar.gz"));

      const result = await runScript(UNFREEZE, ["--triple", WIN_TRIPLE, "--archive", bundle, "--root", destRoot]);

      expect(result.code).toBe(1);
      expect(result.stderr).toContain(`binaries/qpdf-${WIN_TRIPLE}.exe`);
      expect(existsSync(join(destRoot, "src-tauri", "binaries")), "a partial windows bundle must never swap").toBe(false);
      await expectCleanFreezeDir(destRoot);
    });
  });

  const WIN_MANIFEST_TRIPLE = "x86_64-pc-windows-msvc";
  const UNFREEZE_WIN_MANIFEST = {
    targets: {
      [WIN_MANIFEST_TRIPLE]: {
        ffmpeg: {
          source: "url",
          url: "https://fixtures.invalid/ffmpeg.zip",
          sha256: "0".repeat(64),
          member: "ffmpeg-n9.0-latest-win64-gpl-9.0/bin/ffmpeg.exe",
          dest: "ffmpeg",
          expectVersion: "9.0.2",
          static: true,
        },
        vips: {
          source: "url",
          url: "https://fixtures.invalid/vips.zip",
          sha256: "0".repeat(64),
          member: "vips-dev-8.18/bin/vips.exe",
          dest: "vips",
          expectVersion: "8.18.7",
        },
      },
    },
  };

  async function writeDestManifest(root, manifest = UNFREEZE_WIN_MANIFEST) {
    await mkdir(join(root, "scripts"), { recursive: true });
    await writeFile(join(root, "scripts", "binaries.manifest.json"), JSON.stringify(manifest, null, 2));
  }

  async function stageManifestShapeBundle(destRoot, { dropEnginesDir = null, dropFlatExe = null } = {}) {
    const payload = join(destRoot, "payload");
    const bin = join(payload, "binaries");
    await mkdir(bin, { recursive: true });
    for (const exe of ["ffmpeg", "vips"]) {
      await writeFile(join(bin, `${exe}-${WIN_MANIFEST_TRIPLE}.exe`), `${exe} flat payload\n`);
    }
    for (const engine of ["vips"]) {
      const enginesDir = join(bin, "engines", engine);
      if (dropEnginesDir === engine) {
        await rm(enginesDir, { recursive: true, force: true });
        continue;
      }
      await mkdir(enginesDir, { recursive: true });
      await writeFile(join(enginesDir, `${engine}.exe`), `${engine} engine payload\n`);
      await writeFile(join(enginesDir, `${engine}-support.dll`), `${engine} dll payload\n`);
    }
    if (dropFlatExe) {
      await rm(join(bin, `${dropFlatExe}-${WIN_MANIFEST_TRIPLE}.exe`));
    }
    const name = dropEnginesDir ?? dropFlatExe ?? "full";
    return tarWindowsTree(payload, join(destRoot, `${name}-bundle.tar.gz`));
  }

  it("fails_closed_when_a_non_static_manifest_engine_dir_is_absent_from_the_bundle", async () => {
    await withRoot(async (destRoot) => {
      await mkdir(join(destRoot, "src-tauri"));
      await writeDestManifest(destRoot);
      const bundle = await stageManifestShapeBundle(destRoot, { dropEnginesDir: "vips" });

      const result = await runScript(UNFREEZE, [
        "--triple",
        WIN_MANIFEST_TRIPLE,
        "--archive",
        bundle,
        "--root",
        destRoot,
      ]);

      expect(result.code).toBe(1);
      expect(result.stderr).toMatch(/binaries\/engines\/vips/);
      expect(
        existsSync(join(destRoot, "src-tauri", "binaries")),
        "a bundle missing a required engines dir must never swap",
      ).toBe(false);
      await expectCleanFreezeDir(destRoot);
    });
  });

  it("restores_a_static_only_manifest_bundle_without_requiring_engines_dirs", async () => {
    await withRoot(async (destRoot) => {
      await mkdir(join(destRoot, "src-tauri"));
      await writeDestManifest(destRoot);
      const bundle = await stageManifestShapeBundle(destRoot);

      const result = await runScript(UNFREEZE, [
        "--triple",
        WIN_MANIFEST_TRIPLE,
        "--archive",
        bundle,
        "--root",
        destRoot,
      ]);

      expect(result.code, `stdout: ${result.stdout}\nstderr: ${result.stderr}`).toBe(0);
      expect(
        await readFile(join(destRoot, "src-tauri", "binaries", `ffmpeg-${WIN_MANIFEST_TRIPLE}.exe`), "utf8"),
      ).toBe("ffmpeg flat payload\n");
      expect(
        await readFile(join(destRoot, "src-tauri", "binaries", "engines", "vips", "vips.exe"), "utf8"),
      ).toBe("vips engine payload\n");
      expect(existsSync(join(destRoot, "src-tauri", "binaries", "engines", "ffmpeg"))).toBe(false);
      await expectCleanFreezeDir(destRoot);
    });
  });

  it("refuses_a_windows_bundle_when_the_dest_manifest_has_no_row_for_the_triple", async () => {
    await withRoot(async (destRoot) => {
      await mkdir(join(destRoot, "src-tauri"));
      await writeDestManifest(destRoot, { targets: { "aarch64-pc-windows-msvc": {} } });
      const bundle = await stageManifestShapeBundle(destRoot);

      const result = await runScript(UNFREEZE, [
        "--triple",
        WIN_MANIFEST_TRIPLE,
        "--archive",
        bundle,
        "--root",
        destRoot,
      ]);

      expect(result.code).toBe(1);
      expect(result.stderr).toContain("binaries.manifest.json");
      expect(result.stderr).toContain(WIN_MANIFEST_TRIPLE);
      expect(existsSync(join(destRoot, "src-tauri", "binaries"))).toBe(false);
      await expectCleanFreezeDir(destRoot);
    });
  });

  it("refuses_a_windows_bundle_when_the_dest_manifest_is_unreadable", async () => {
    await withRoot(async (destRoot) => {
      await mkdir(join(destRoot, "src-tauri"));
      await mkdir(join(destRoot, "scripts"), { recursive: true });
      await writeFile(join(destRoot, "scripts", "binaries.manifest.json"), "{nope");
      const bundle = await stageManifestShapeBundle(destRoot);

      const result = await runScript(UNFREEZE, [
        "--triple",
        WIN_MANIFEST_TRIPLE,
        "--archive",
        bundle,
        "--root",
        destRoot,
      ]);

      expect(result.code).toBe(1);
      expect(result.stderr).toContain("binaries.manifest.json");
      expect(existsSync(join(destRoot, "src-tauri", "binaries"))).toBe(false);
      await expectCleanFreezeDir(destRoot);
    });
  });

  it("fails_closed_when_the_windows_bundle_has_no_dll_anywhere_under_an_engines_dir", async () => {
    await withRoot(async (destRoot) => {
      await mkdir(join(destRoot, "src-tauri"));
      const payload = join(destRoot, "payload");
      await stageWindowsTree(payload, WIN_TRIPLE);
      await rm(join(payload, "binaries", "engines", "vips", "vips-support.dll"));
      const bundle = await tarWindowsTree(payload, join(destRoot, "dll-less-vips.tar.gz"));

      const result = await runScript(UNFREEZE, ["--triple", WIN_TRIPLE, "--archive", bundle, "--root", destRoot]);

      expect(result.code).toBe(1);
      expect(result.stderr).toMatch(/no DLL anywhere under binaries\/engines\/vips/);
      expect(result.stderr).toContain("yarn binaries:all --target");
      expect(existsSync(join(destRoot, "src-tauri", "binaries")), "a DLL-less windows bundle must never swap").toBe(false);
      await expectCleanFreezeDir(destRoot);
    });
  });

  it.skipIf(process.platform === "win32")("classifies_an_unreadable_extracted_engines_tree_as_a_permissions_problem_not_a_dll_less_bundle_win32_skips_acl_semantics_differ", async () => {
    await withRoot(async (destRoot) => {
      await mkdir(join(destRoot, "src-tauri"));
      const bundle = await craftWindowsBundleWithSealedVipsSubdir(destRoot);

      const result = await runScript(UNFREEZE, ["--triple", WIN_TRIPLE, "--archive", bundle, "--root", destRoot]);

      expect(result.code, `stdout: ${result.stdout}\nstderr: ${result.stderr}`).toBe(1);
      expect(
        result.stderr,
        "a find read error on the extracted tree must be classified distinctly from a DLL-less bundle",
      ).toMatch(/could not read .*engines\/vips.*read error/i);
      expect(
        result.stderr,
        "the read-error classification must rule out restaging as a fix",
      ).toContain("restaging will not fix a permissions problem");
      expect(
        result.stderr,
        "the DLL-less remediation must not fire for a read error",
      ).not.toMatch(/no DLL anywhere under/i);
      expect(existsSync(join(destRoot, "src-tauri", "binaries")), "an unreadable extracted tree must never swap").toBe(false);
      const leftovers = await readdir(freezeDir(destRoot));
      expect(
        leftovers,
        "the blocked run must release its lock; nothing besides the temp workspace may linger",
      ).toHaveLength(1);
      expect(
        leftovers[0],
        "the temp workspace itself stays when rm cannot enter the mode-0000 dir — that residue must be WARNed about",
      ).toMatch(/^unfreeze\./);
      expect(
        result.stderr,
        "the cleanup failure must be loud, not silent",
      ).toContain("could not remove temp dir");
      const chmodHeal = async (p) => {
        await chmod(p, 0o755).catch(() => {});
        const entries = await readdir(p).catch(() => []);
        for (const e of entries) {
          await chmodHeal(join(p, e));
        }
      };
      await chmodHeal(freezeDir(destRoot));
    });
  });

  it("restores_a_windows_bundle_without_gs_resources_as_binaries_only", async () => {
    await withRoot(async (destRoot) => {
      await mkdir(join(destRoot, "src-tauri"));
      const payload = join(destRoot, "payload");
      await stageWindowsTree(payload, WIN_TRIPLE);
      const bundle = await tarWindowsTree(payload, join(destRoot, "no-gs.tar.gz"), ["binaries"]);

      const result = await runScript(UNFREEZE, ["--triple", WIN_TRIPLE, "--archive", bundle, "--root", destRoot]);

      expect(result.code, `stdout: ${result.stdout}\nstderr: ${result.stderr}`).toBe(0);
      expect(
        await readFile(join(destRoot, "src-tauri", "binaries", "engines", "gs", "gs.exe"), "utf8"),
        "the binaries payload restores even when the bundle carries no gs-resources",
      ).toBe("gs engine payload\n");
      expect(
        existsSync(join(destRoot, "src-tauri", "gs-resources")),
        "the restore must not demand or fabricate a gs-resources tree on windows",
      ).toBe(false);
      await expectCleanFreezeDir(destRoot);
    });
  });

  it("restores_the_gh_path_windows_bundle_selected_from_the_newest_sidecars_tag", async () => {
    await withBareDest(async (destRoot) => {
      const stubbed = await stubEnv(destRoot, {
        triple: WIN_TRIPLE,
        roots: "binaries",
      });
      try {
        const result = await runScript(UNFREEZE, ["--triple", WIN_TRIPLE, "--root", destRoot], { env: stubbed.env });

        expect(result.code, `stdout: ${result.stdout}\nstderr: ${result.stderr}`).toBe(0);
        const ghDownloadArgs = (await readFile(stubbed.markers.download, "utf8")).split("\n").filter(Boolean);
        expect(
          ghDownloadArgs,
          "the claimed tag must be the newest sidecars-* for the windows triple",
        ).toContain("sidecars-20261010");
        expect(
          ghDownloadArgs.filter((arg) => arg === `sidecar-bundle-${WIN_TRIPLE}.tar.gz`).length,
        ).toBe(1);
        for (const engine of WIN_ENGINES) {
          expect(
            await readFile(join(destRoot, "src-tauri", "binaries", "engines", engine, `${engine}.exe`), "utf8"),
          ).toBe(GH_STUB_PAYLOADS[engine]);
        }
        expect(
          await readFile(join(destRoot, "src-tauri", "binaries", `ffmpeg-${WIN_TRIPLE}.exe`), "utf8"),
        ).toBe(GH_STUB_PAYLOADS.ffmpeg);
        for (const flat of ["vips", "qpdf", "gs"]) {
          expect(
            await readFile(join(destRoot, "src-tauri", "binaries", `${flat}-${WIN_TRIPLE}.exe`), "utf8"),
            "the gh-path windows bundle also carries the flat engine exes",
          ).toBe(GH_STUB_PAYLOADS[flat]);
        }
        expect(
          new Set(await readdir(join(destRoot, "src-tauri"))),
          "the gh-path windows restore swaps binaries only plus the restore provenance marker",
        ).toEqual(new Set(["binaries", ".freeze", ".sidecars-restored.json"]));
        await expectCleanFreezeDir(destRoot);
      } finally {
        await stubbed.cleanup();
      }
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

  it.skipIf(process.platform === "win32")("refuses_to_run_while_another_freeze_or_unfreeze_holds_the_lock_win32_skips_lock_refusal_semantics_differ", async () => {
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

  it.skipIf(process.platform === "win32")("fails_closed_when_the_digest_sibling_is_unreadable_win32_skips_acl_semantics_differ", async () => {
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
        expect(
          result.stderr,
          "the tar failure message must cover the realistic failure classes, not just corruption",
        ).toMatch(/disk space|permissions|integrity/i);
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

  it.skipIf(process.platform === "win32")("fails_closed_when_the_destination_dir_is_unwritable_win32_skips_acl_semantics_differ", async () => {
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

  it.skipIf(process.platform === "win32").each(["binaries", "frameworks", "gs-resources"])(
    "rolls_back_to_the_pre_swap_tree_when_the_install_fails_moving_%s_win32_skips_mv_shim_cygpath_followup_tracked",
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

  it.skipIf(process.platform === "win32")("restores_the_pre_swap_tree_when_a_backup_set_aside_move_fails_midway_win32_skips_mv_shim_cygpath_followup_tracked", async () => {
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

  it.skipIf(process.platform === "win32")("preserves_the_named_backup_and_the_pre_swap_tree_when_a_signal_interrupts_the_swap_win32_skips_mv_shim_cygpath_followup_tracked", async () => {
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

  it.skipIf(process.platform === "win32")("keeps_recovery_and_named_backup_messaging_when_a_signal_lands_mid_rollback_win32_skips_mv_shim_cygpath_followup_tracked", async () => {
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

  it.skipIf(process.platform === "win32").each(["binaries"])(
    "rolls_back_the_windows_tree_to_the_pre_swap_state_when_the_install_fails_moving_%s_win32_skips_mv_shim_cygpath_followup_tracked",
    async (failDest) => {
      await withWindowsFrozenSource(async (srcRoot) => {
        await withRoot(async (destRoot) => {
          await stageStaleWindowsTree(destRoot);
          const result = await withMvShim(
            FAIL_DEST_MV_SHIM,
            {
              FAIL_MV_DEST: join(destRoot, "src-tauri", failDest),
              FAIL_MV_STATE_FILE: join(destRoot, "stub-mv-state"),
            },
            (env) =>
              runScript(UNFREEZE, ["--triple", WIN_TRIPLE, "--archive", frozenWindowsBundle(srcRoot), "--root", destRoot], {
                env,
              }),
          );

          expect(result.code, `stdout: ${result.stdout}\nstderr: ${result.stderr}`).toBe(1);
          expect(result.stderr).toMatch(/failed to install the new sidecar tree/);
          expect(
            result.stderr,
            "the rollback must not claim success over un-rolled-back names",
          ).toMatch(/restored byte-for-byte to its pre-swap state/);
          await expectStaleWindowsPreSwapTree(destRoot);
          await expectCleanFreezeDir(destRoot);
        });
      });
    },
  );

  it.skipIf(process.platform === "win32")("restores_the_windows_pre_swap_tree_when_a_backup_set_aside_move_fails_midway_win32_skips_mv_shim_cygpath_followup_tracked", async () => {
    await withWindowsFrozenSource(async (srcRoot) => {
      await withRoot(async (destRoot) => {
        await stageStaleWindowsTree(destRoot);
        const result = await withMvShim(
          BACKUP_FAIL_MV_SHIM,
          {
            FAIL_BACKUP_DEST_PREFIX: join(destRoot, "src-tauri", ".freeze", "unfreeze-backup."),
            FAIL_BACKUP_NAMES: "binaries",
          },
          (env) =>
            runScript(UNFREEZE, ["--triple", WIN_TRIPLE, "--archive", frozenWindowsBundle(srcRoot), "--root", destRoot], {
              env,
            }),
        );

        expect(result.code, `stdout: ${result.stdout}\nstderr: ${result.stderr}`).toBe(1);
        expect(result.stderr).toMatch(/failed to swap in the new sidecar tree/);
        expect(result.stderr).toMatch(/restored byte-for-byte to its pre-swap state/);
        await expectStaleWindowsPreSwapTree(destRoot);
        await expectCleanFreezeDir(destRoot);
      });
    });
  });

  it.skipIf(process.platform === "win32")("preserves_the_windows_named_backup_and_pre_swap_tree_when_a_signal_interrupts_the_swap_win32_skips_mv_shim_cygpath_followup_tracked", async () => {
    await withWindowsFrozenSource(async (srcRoot) => {
      await withRoot(async (destRoot) => {
        await stageStaleWindowsTree(destRoot);
        const result = await withMvShim(TERM_MV_SHIM, {}, (env) =>
          runScript(UNFREEZE, ["--triple", WIN_TRIPLE, "--archive", frozenWindowsBundle(srcRoot), "--root", destRoot], {
            env,
          }),
        );

        expect(result.code, `stdout: ${result.stdout}\nstderr: ${result.stderr}`).toBe(143);
        await expectStaleWindowsPreSwapTree(destRoot);
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

  it.skipIf(process.platform === "win32")("keeps_the_windows_recovery_and_named_backup_messaging_when_a_signal_lands_mid_rollback_win32_skips_mv_shim_cygpath_followup_tracked", async () => {
    await withWindowsFrozenSource(async (srcRoot) => {
      await withRoot(async (destRoot) => {
        await stageStaleWindowsTree(destRoot);
        const result = await withMvShim(
          ROLLBACK_TERM_MV_SHIM,
          {
            INSTALL_FAIL_DEST: join(destRoot, "src-tauri", "binaries"),
            INSTALL_FAIL_STATE: join(destRoot, "stub-install-state"),
            RESTORE_TERM_STATE: join(destRoot, "stub-restore-state"),
          },
          (env) =>
            runScript(UNFREEZE, ["--triple", WIN_TRIPLE, "--archive", frozenWindowsBundle(srcRoot), "--root", destRoot], {
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
        await expectStaleWindowsPreSwapTree(destRoot);
      });
    });
  });

  it.skipIf(process.platform === "win32")("recovers_a_stale_lock_left_by_a_dead_predecessor_older_than_an_hour_win32_skips_lock_refusal_semantics_differ", async () => {
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

  it.skipIf(process.platform === "win32")("refuses_a_lock_held_by_a_live_pid_even_when_the_stamp_is_old_win32_skips_lock_refusal_semantics_differ", async () => {
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

  it.skipIf(process.platform === "win32")("refuses_a_fresh_dead_pid_lock_and_advises_the_stale_lock_remediation_win32_skips_lock_refusal_semantics_differ", async () => {
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

  it.skipIf(process.platform !== "darwin")("rehydrates_a_windows_bundle_whose_payload_still_passes_the_verify_contract_in_a_fresh_root_mac_only_clang_fixture_portable_pe_versions_live_in_verify_test", async () => {
    const WIN_ARM_TRIPLE = "aarch64-pc-windows-msvc";
    const FLAT_EXES = ["ffmpeg", "ffprobe", "vips", "qpdf", "gs"];
    const FIXTURE_VERSION = "1.0.0-freeze-roundtrip";
    const VERIFY_MJS = join(HERE, "..", "binaries", "verify.mjs");

    function runVerify(args) {
      return new Promise((resolvePromise) => {
        execFile(
          process.execPath,
          [VERIFY_MJS, ...args],
          { encoding: "utf8", timeout: 60_000 },
          (error, stdout, stderr) => {
            resolvePromise({ code: error?.code ?? (error?.signal ? 255 : 0), stdout, stderr });
          },
        );
      });
    }

    await withRoot(async (srcRoot) => {
      await mkdir(join(srcRoot, "src-tauri"), { recursive: true });
      await mkdir(join(srcRoot, "scripts"), { recursive: true });
      const manifest = {
        targets: {
          [WIN_ARM_TRIPLE]: Object.fromEntries(
            FLAT_EXES.map((name) => [
              name,
              {
                source: "url",
                url: `https://fixtures.invalid/${name}.zip`,
                sha256: "0".repeat(64),
                dest: name,
                expectVersion: FIXTURE_VERSION,
                ...(name === "ffmpeg" || name === "ffprobe" ? { static: true } : {}),
              },
            ]),
          ),
        },
      };
      await writeFile(join(srcRoot, "scripts", "binaries.manifest.json"), JSON.stringify(manifest, null, 2));
      await stageWindowsTree(join(srcRoot, "src-tauri"), WIN_ARM_TRIPLE);

      const fixtureSource = join(tmpdir(), `freeze-roundtrip-fixture-${process.pid}-${Date.now()}.c`);
      const fixtureBinary = join(tmpdir(), `freeze-roundtrip-fixture-${process.pid}-${Date.now()}`);
      const cSource = [
        "#include <stdio.h>",
        `int main(void) { printf("${FIXTURE_VERSION}\\n"); return 0; }`,
      ].join("\n");
      try {
        await writeFile(fixtureSource, cSource);
        await new Promise((resolvePromise, reject) => {
          execFile(
            "clang",
            ["-arch", "arm64", "-arch", "x86_64", "-o", fixtureBinary, fixtureSource],
            (error) => (error ? reject(error) : resolvePromise()),
          );
        });
        execFileSync("codesign", ["--force", "--sign", "-", fixtureBinary]);

        const bin = join(srcRoot, "src-tauri", "binaries");
        for (const flat of FLAT_EXES) {
          const dest = join(bin, `${flat}-${WIN_ARM_TRIPLE}.exe`);
          await copyFile(fixtureBinary, dest);
          await chmod(dest, 0o755);
        }
        for (const engine of WIN_ENGINES) {
          const engineExe = join(bin, "engines", engine, `${engine}.exe`);
          await copyFile(fixtureBinary, engineExe);
          await chmod(engineExe, 0o755);
        }

        const frozen = await runScript(FREEZE, ["--triple", WIN_ARM_TRIPLE, "--root", srcRoot]);
        expect(frozen.code, `freeze stdout: ${frozen.stdout}\nstderr: ${frozen.stderr}`).toBe(0);

        await withRoot(async (destRoot) => {
          await mkdir(join(destRoot, "src-tauri"), { recursive: true });
          await mkdir(join(destRoot, "scripts"), { recursive: true });
          await writeFile(join(destRoot, "scripts", "binaries.manifest.json"), JSON.stringify(manifest, null, 2));

          const restored = await runScript(UNFREEZE, [
            "--triple",
            WIN_ARM_TRIPLE,
            "--archive",
            join(srcRoot, "src-tauri", ".freeze", `sidecar-bundle-${WIN_ARM_TRIPLE}.tar.gz`),
            "--root",
            destRoot,
          ]);
          expect(restored.code, `unfreeze stdout: ${restored.stdout}\nstderr: ${restored.stderr}`).toBe(0);

          for (const flat of FLAT_EXES) {
            expect(
              existsSync(join(destRoot, "src-tauri", "binaries", `${flat}-${WIN_ARM_TRIPLE}.exe`)),
              `${flat} flat exe must survive the freeze/unfreeze roundtrip`,
            ).toBe(true);
          }
          for (const engine of WIN_ENGINES) {
            expect(
              existsSync(join(destRoot, "src-tauri", "binaries", "engines", engine)),
              `engines/${engine} payload dir must survive the roundtrip`,
            ).toBe(true);
          }

          const verify = await runVerify(["--target", WIN_ARM_TRIPLE, "--root", destRoot]);
          expect(verify.code, `verify stdout: ${verify.stdout}\nstderr: ${verify.stderr}`).toBe(0);
          expect(verify.stdout).toContain("verify: PASS");
        });
      } finally {
        await rm(fixtureSource, { force: true });
        await rm(fixtureBinary, { force: true });
      }
    });
  }, 90_000);
});
