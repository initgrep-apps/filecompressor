// @vitest-environment node
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, writeFile, readFile, rm, readdir, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { createHash } from "node:crypto";
import https from "node:https";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { sha256File } from "./lib.mjs";
import { validateManifest } from "./lib.mjs";

process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

const SCRIPTS = dirname(fileURLToPath(import.meta.url));
const FETCH = join(SCRIPTS, "fetch.mjs");
const CERT = join(SCRIPTS, "fixtures", "test-cert.pem");
const KEY = join(SCRIPTS, "fixtures", "test-key.pem");
const ZIPS = `${tmpdir()}/fetch-test-zips`;

function makeZip(zipPath, memberName, content) {
  const staging = `${zipPath}.zsrc`;
  execFileSync("mkdir", ["-p", staging]);
  execFileSync("sh", ["-c", `printf '%s' '${content}' > '${staging}/${memberName}'`]);
  execFileSync("sh", ["-c", `cd '${staging}' && zip -q -r '${zipPath}' '${memberName}'`]);
}

function makeTreeZip(zipPath, files) {
  const staging = `${zipPath}.zsrc`;
  execFileSync("rm", ["-rf", staging]);
  for (const [memberName, content] of Object.entries(files)) {
    execFileSync("mkdir", ["-p", `${staging}/${dirname(memberName)}`]);
    execFileSync("sh", ["-c", `printf '%s' '${content}' > '${staging}/${memberName}'`]);
  }
  execFileSync("sh", ["-c", `cd '${staging}' && zip -q -r '${zipPath}' .`]);
  execFileSync("rm", ["-rf", staging]);
}

function makeSymlinkTreeZip(zipPath, files, links) {
  const staging = `${zipPath}.zsrc`;
  execFileSync("rm", ["-rf", staging]);
  for (const [memberName, content] of Object.entries(files)) {
    execFileSync("mkdir", ["-p", `${staging}/${dirname(memberName)}`]);
    execFileSync("sh", ["-c", `printf '%s' '${content}' > '${staging}/${memberName}'`]);
  }
  for (const [memberName, target] of Object.entries(links)) {
    execFileSync("mkdir", ["-p", `${staging}/${dirname(memberName)}`]);
    execFileSync("ln", ["-s", target, `${staging}/${memberName}`]);
  }
  execFileSync("sh", ["-c", `cd '${staging}' && zip -q -r -y '${zipPath}' .`]);
  execFileSync("rm", ["-rf", staging]);
}

function runFetch(args) {
  return new Promise((resolvePromise) => {
    const child = spawn(process.execPath, ["--no-warnings", FETCH, ...args], {
      env: { ...process.env, NODE_TLS_REJECT_UNAUTHORIZED: "0" },
      cwd: SCRIPTS,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("close", (code) => resolvePromise({ code, stdout, stderr }));
  });
}

async function writeManifest(root, manifest) {
  await mkdir(`${root}/scripts`, { recursive: true });
  await writeFile(`${root}/scripts/binaries.manifest.json`, JSON.stringify(manifest));
}

function ffmpegEntry(url, sha) {
  return { source: "url", url, sha256: sha, member: "ffmpeg", dest: "ffmpeg", expectVersion: "9.0.2" };
}

const cleanupRoots = [];
async function makeRoot() {
  await mkdir(`${tmpdir()}/fetch-test-roots`, { recursive: true });
  const root = await mkdtemp(`${tmpdir()}/fetch-test-roots/r`);
  cleanupRoots.push(root);
  await mkdir(`${root}/src-tauri/binaries`, { recursive: true });
  return root;
}

describe("manifest schema", () => {
  it("rejects missing expectVersion and unknown source", () => {
    expect(() =>
      validateManifest({
        targets: {
          "aarch64-apple-darwin": {
            ffmpeg: { source: "url", url: "https://x/y.zip", sha256: "a".repeat(64), member: "ffmpeg", dest: "ffmpeg" },
          },
        },
      }),
    ).toThrow(/expectVersion/);

    expect(() =>
      validateManifest({
        targets: {
          "aarch64-apple-darwin": {
            ffmpeg: { source: "gnome-mirror", url: "https://x/y.zip", expectVersion: "9.0.2" },
          },
        },
      }),
    ).toThrow(/unknown source/);
  });

  it("requires a 64-hex sha256 pin and a parseable url for url entries", () => {
    expect(() =>
      validateManifest({
        targets: {
          "aarch64-apple-darwin": {
            ffmpeg: { source: "url", url: "https://x/y.zip", expectVersion: "9.0.2", dest: "ffmpeg" },
          },
        },
      }),
    ).toThrow(/sha256 pin/);

    expect(() =>
      validateManifest({
        targets: {
          "aarch64-apple-darwin": {
            ffmpeg: { source: "url", url: "https://x/y.zip", sha256: "nothex", expectVersion: "9.0.2", dest: "ffmpeg" },
          },
        },
      }),
    ).toThrow(/sha256 pin/);

    expect(() =>
      validateManifest({
        targets: {
          "aarch64-apple-darwin": {
            ffmpeg: { source: "url", url: "not a url", sha256: "a".repeat(64), expectVersion: "9.0.2", dest: "ffmpeg" },
          },
        },
      }),
    ).toThrow(/unparseable url/);
  });

  it("rejects unknown keys, missing dest, duplicate dest and unknown triples", () => {
    expect(() =>
      validateManifest({
        targets: {
          "aarch64-apple-darwin": {
            ffmpeg: { source: "url", url: "https://x/y.zip", sha256: "a".repeat(64), sha356: "b".repeat(64), expectVersion: "9.0.2", dest: "ffmpeg" },
          },
        },
      }),
    ).toThrow(/unknown key/);

    expect(() =>
      validateManifest({
        targets: {
          "aarch64-apple-darwin": {
            ffmpeg: { source: "url", url: "https://x/y.zip", sha256: "a".repeat(64), expectVersion: "9.0.2" },
          },
        },
      }),
    ).toThrow(/requires a dest/);

    expect(() =>
      validateManifest({
        targets: {
          "aarch64-apple-darwin": {
            ffmpeg: { source: "url", url: "https://x/y.zip", sha256: "a".repeat(64), expectVersion: "9.0.2", dest: "ffmpeg", member: 42 },
          },
        },
      }),
    ).toThrow(/member must be a non-empty string/);

    expect(() =>
      validateManifest({
        targets: {
          "aarch64-apple-darwin": {
            ffmpeg: { source: "url", url: "https://x/y.zip", sha256: "a".repeat(64), expectVersion: "9.0.2", dest: "ffmpeg", lib: "" },
          },
        },
      }),
    ).toThrow(/lib must be a non-empty string/);

    expect(() =>
      validateManifest({
        targets: {
          "aarch64-apple-darwin": {
            ffmpeg: { source: "url", url: "https://x/y.zip", sha256: "a".repeat(64), expectVersion: "9.0.2", dest: "tool" },
            ffprobe: { source: "url", url: "https://x/z.zip", sha256: "b".repeat(64), expectVersion: "9.0.2", dest: "tool" },
          },
        },
      }),
    ).toThrow(/duplicate dest/);

    expect(() => validateManifest({ targets: { "mips-unknown-linux-gnu": {} } })).toThrow(
      /unknown triple/,
    );
    expect(() => validateManifest({})).toThrow(/schema invalid/);
  });

  it("accepts the shipping mac arm64 manifest", () => {
    const shipping = JSON.parse(
      execFileSync("cat", [join(SCRIPTS, "..", "binaries.manifest.json")]).toString(),
    );
    expect(() => validateManifest(shipping)).not.toThrow();
  });
});

describe("fetch.mjs", () => {
  let server;
  let base;
  let servedPath;

  beforeEach(async () => {
    server = https.createServer(
      { cert: execFileSync("cat", [CERT]), key: execFileSync("cat", [KEY]) },
      (req, res) => {
        if (req.url === "/missing.zip") {
          res.writeHead(404, { "content-type": "text/plain" });
          res.end("not found");
          return;
        }
        readFile(servedPath)
          .then(
            (buf) => {
              res.writeHead(200);
              res.end(buf);
            },
            () => {
              res.writeHead(404);
              res.end();
            },
          );
      },
    );
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    base = `https://127.0.0.1:${server.address().port}`;
    await mkdir(ZIPS, { recursive: true });
  });

  afterEach(async () => {
    server?.close();
    servedPath = undefined;
  });

  afterAll(async () => {
    await rm(`${tmpdir()}/fetch-test-roots`, { recursive: true, force: true });
    await rm(ZIPS, { recursive: true, force: true });
  });

  it("stages binary and writes lock entry", async () => {
    const root = await makeRoot();
    servedPath = `${ZIPS}/ffmpeg.zip`;
    makeZip(servedPath, "ffmpeg", "fake-ffmpeg-macho-arm64");
    const sha = await sha256File(servedPath);
    await writeManifest(root, {
      targets: { "aarch64-apple-darwin": { ffmpeg: ffmpegEntry(`${base}/ffmpeg.zip`, sha) } },
    });

    const result = await runFetch(["--target", "aarch64-apple-darwin", "--root", root]);
    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");

    const staged = `${root}/src-tauri/binaries/ffmpeg-aarch64-apple-darwin`;
    expect(await readFile(staged, "utf8")).toBe("fake-ffmpeg-macho-arm64");
    expect((await stat(staged)).mode & 0o777).toBe(0o755);

    const lock = JSON.parse(await readFile(`${root}/scripts/binaries.lock.json`, "utf8"));
    const entry = lock.targets["aarch64-apple-darwin"].ffmpeg;
    expect(entry.version).toBe("9.0.2");
    expect(entry.url).toBe(`${base}/ffmpeg.zip`);
    expect(entry.sha256).toBe(sha);
    expect(entry.stagedSha256).toBe(await sha256File(staged));
  });

  it("fetch_stages_qpdf_full_bin_and_lib_dir", async () => {
    const root = await makeRoot();
    servedPath = `${ZIPS}/qpdf.zip`;
    makeTreeZip(servedPath, {
      "qpdf-12.4.2-bin-macos-arm64/bin/qpdf": "fake-qpdf-macho-arm64",
      "qpdf-12.4.2-bin-macos-arm64/lib/libqpdf.30.dylib": "fake-libqpdf-arm64",
      "qpdf-12.4.2-bin-macos-arm64/lib/libqpdf.30.4.2.dylib": "fake-libqpdf-real-arm64",
    });
    const sha = await sha256File(servedPath);
    await writeManifest(root, {
      targets: {
        "aarch64-apple-darwin": {
          qpdf: {
            source: "url",
            url: `${base}/qpdf.zip`,
            sha256: sha,
            member: "qpdf-12.4.2-bin-macos-arm64/bin/qpdf",
            lib: "qpdf-12.4.2-bin-macos-arm64/lib",
            dest: "qpdf",
            expectVersion: "12.4.2",
          },
        },
      },
    });

    const result = await runFetch(["--target", "aarch64-apple-darwin", "--root", root]);
    expect(result.stderr).toBe("");
    expect(result.code).toBe(0);

    const staged = `${root}/src-tauri/binaries/qpdf-aarch64-apple-darwin`;
    expect(await readFile(staged, "utf8")).toBe("fake-qpdf-macho-arm64");
    expect((await stat(staged)).mode & 0o777).toBe(0o755);

    const stagedLib = `${root}/src-tauri/.staging/qpdf-aarch64-apple-darwin/lib`;
    expect((await readdir(stagedLib)).sort()).toEqual([
      "libqpdf.30.4.2.dylib",
      "libqpdf.30.dylib",
    ]);
    expect(await readFile(`${stagedLib}/libqpdf.30.dylib`, "utf8")).toBe("fake-libqpdf-arm64");

    const lock = JSON.parse(await readFile(`${root}/scripts/binaries.lock.json`, "utf8"));
    const entry = lock.targets["aarch64-apple-darwin"].qpdf;
    expect(entry.version).toBe("12.4.2");
    expect(entry.sha256).toBe(sha);
    expect(entry.stagedSha256).toBe(await sha256File(staged));
    expect(Object.keys(entry.libStagedSha256).sort()).toEqual([
      "libqpdf.30.4.2.dylib",
      "libqpdf.30.dylib",
    ]);
  });

  it("pins every staged lib member in the lock, symlinks included", async () => {
    const root = await makeRoot();
    servedPath = `${ZIPS}/qpdf-pin.zip`;
    makeSymlinkTreeZip(
      servedPath,
      {
        "bin/qpdf": "fake-qpdf-macho-arm64",
        "lib/libqpdf.30.4.2.dylib": "fake-libqpdf-real-arm64",
      },
      { "lib/libqpdf.30.dylib": "libqpdf.30.4.2.dylib" },
    );
    const sha = await sha256File(servedPath);
    await writeManifest(root, {
      targets: {
        "aarch64-apple-darwin": {
          qpdf: {
            source: "url",
            url: `${base}/qpdf-pin.zip`,
            sha256: sha,
            member: "bin/qpdf",
            lib: "lib",
            dest: "qpdf",
            expectVersion: "12.4.2",
          },
        },
      },
    });

    const result = await runFetch(["--target", "aarch64-apple-darwin", "--root", root]);
    expect(result.code).toBe(0);

    const libDir = `${root}/src-tauri/.staging/qpdf-aarch64-apple-darwin/lib`;
    const entry = JSON.parse(
      await readFile(`${root}/scripts/binaries.lock.json`, "utf8"),
    ).targets["aarch64-apple-darwin"].qpdf;
    expect(Object.keys(entry.libStagedSha256).sort()).toEqual([
      "libqpdf.30.4.2.dylib",
      "libqpdf.30.dylib",
    ]);
    expect(entry.libStagedSha256["libqpdf.30.4.2.dylib"]).toBe(
      await sha256File(join(libDir, "libqpdf.30.4.2.dylib")),
    );
    expect(entry.libStagedSha256["libqpdf.30.dylib"]).toBe(
      createHash("sha256").update("libqpdf.30.4.2.dylib").digest("hex"),
      "a symlink is pinned by its target, not the bytes it resolves to",
    );
  });

  it("re-materialises a deleted staged lib dir instead of reporting unchanged", async () => {
    const root = await makeRoot();
    servedPath = `${ZIPS}/qpdf-relib.zip`;
    makeTreeZip(servedPath, {
      "bin/qpdf": "fake-qpdf-macho-arm64",
      "lib/libqpdf.30.dylib": "fake-libqpdf-arm64",
    });
    const sha = await sha256File(servedPath);
    await writeManifest(root, {
      targets: {
        "aarch64-apple-darwin": {
          qpdf: {
            source: "url",
            url: `${base}/qpdf-relib.zip`,
            sha256: sha,
            member: "bin/qpdf",
            lib: "lib",
            dest: "qpdf",
            expectVersion: "12.4.2",
          },
        },
      },
    });
    const staged = `${root}/src-tauri/binaries/qpdf-aarch64-apple-darwin`;
    const libMember = `${root}/src-tauri/.staging/qpdf-aarch64-apple-darwin/lib/libqpdf.30.dylib`;
    expect((await runFetch(["--target", "aarch64-apple-darwin", "--root", root])).code).toBe(0);
    expect(await readFile(libMember, "utf8")).toBe("fake-libqpdf-arm64");
    const stagedSha = await sha256File(staged);
    const lockBefore = await readFile(`${root}/scripts/binaries.lock.json`, "utf8");

    await rm(`${root}/src-tauri/.staging`, { recursive: true, force: true });

    const second = await runFetch(["--target", "aarch64-apple-darwin", "--root", root]);
    expect(
      second.stdout,
      "the unchanged fast path must not swallow a missing staged lib dir: following the \
       require_staged_qpdf_lib remedy would otherwise loop forever",
    ).not.toContain("unchanged (lock + staged sha256 match)");
    expect(second.code).toBe(0);
    expect(
      second.stdout,
      "the re-stage must be visible, or a user cannot tell whether the remedy worked",
    ).toContain("fetch: qpdf-aarch64-apple-darwin staged from");
    expect(await readFile(libMember, "utf8"), "the lib dir must come back").toBe(
      "fake-libqpdf-arm64",
    );
    expect(await sha256File(staged)).toBe(stagedSha);

    const lockAfter = JSON.parse(await readFile(`${root}/scripts/binaries.lock.json`, "utf8"));
    expect(lockAfter.targets["aarch64-apple-darwin"].qpdf.libStagedSha256).toEqual({
      "libqpdf.30.dylib": await sha256File(libMember),
    });
    expect(lockAfter.targets["aarch64-apple-darwin"].qpdf.stagedSha256).toBe(stagedSha);
    expect(lockBefore).not.toBe(undefined);
  });

  it("re-downloads when the lock predates libStagedSha256, so the lib is pinned", async () => {
    const root = await makeRoot();
    servedPath = `${ZIPS}/qpdf-nopin.zip`;
    makeTreeZip(servedPath, {
      "bin/qpdf": "fake-qpdf-macho-arm64",
      "lib/libqpdf.30.dylib": "fake-libqpdf-arm64",
    });
    const sha = await sha256File(servedPath);
    const entry = {
      source: "url",
      url: `${base}/qpdf-nopin.zip`,
      sha256: sha,
      member: "bin/qpdf",
      lib: "lib",
      dest: "qpdf",
      expectVersion: "12.4.2",
    };
    await writeManifest(root, { targets: { "aarch64-apple-darwin": { qpdf: entry } } });
    const staged = `${root}/src-tauri/binaries/qpdf-aarch64-apple-darwin`;
    const libMember = `${root}/src-tauri/.staging/qpdf-aarch64-apple-darwin/lib/libqpdf.30.dylib`;
    expect((await runFetch(["--target", "aarch64-apple-darwin", "--root", root])).code).toBe(0);

    await writeFile(
      `${root}/scripts/binaries.lock.json`,
      JSON.stringify({
        generated: "2026-01-01T00:00:00.000Z",
        targets: {
          "aarch64-apple-darwin": {
            qpdf: {
              source: "url",
              version: "12.4.2",
              url: entry.url,
              sha256: sha,
              stagedSha256: await sha256File(staged),
              date: "2026-01-01T00:00:00.000Z",
            },
          },
        },
      }),
    );

    const second = await runFetch(["--target", "aarch64-apple-darwin", "--root", root]);
    expect(second.stdout).not.toContain("unchanged (lock + staged sha256 match)");
    expect(second.code).toBe(0);
    const updated = JSON.parse(await readFile(`${root}/scripts/binaries.lock.json`, "utf8"));
    expect(updated.targets["aarch64-apple-darwin"].qpdf.libStagedSha256).toEqual({
      "libqpdf.30.dylib": await sha256File(libMember),
    });
  });

  it("stages the lib dir when the archive root is already the lib parent", async () => {
    const root = await makeRoot();
    servedPath = `${ZIPS}/qpdf-flat.zip`;
    makeTreeZip(servedPath, {
      "bin/qpdf": "fake-qpdf-flat-macho-arm64",
      "lib/libqpdf.30.dylib": "fake-libqpdf-arm64",
    });
    const sha = await sha256File(servedPath);
    await writeManifest(root, {
      targets: {
        "aarch64-apple-darwin": {
          qpdf: {
            source: "url",
            url: `${base}/qpdf-flat.zip`,
            sha256: sha,
            member: "bin/qpdf",
            lib: "lib",
            dest: "qpdf",
            expectVersion: "12.4.2",
          },
        },
      },
    });

    const result = await runFetch(["--target", "aarch64-apple-darwin", "--root", root]);
    expect(result.stderr).toBe("");
    expect(result.code).toBe(0);
    expect(await readFile(`${root}/src-tauri/binaries/qpdf-aarch64-apple-darwin`, "utf8")).toBe(
      "fake-qpdf-flat-macho-arm64",
    );
    expect(
      await readFile(`${root}/src-tauri/.staging/qpdf-aarch64-apple-darwin/lib/libqpdf.30.dylib`, "utf8"),
    ).toBe("fake-libqpdf-arm64");
  });

  it("fails loudly when a declared lib dir is missing from the archive", async () => {
    const root = await makeRoot();
    servedPath = `${ZIPS}/qpdf-nolib.zip`;
    makeTreeZip(servedPath, { "bin/qpdf": "fake-qpdf-macho-arm64" });
    const sha = await sha256File(servedPath);
    await writeManifest(root, {
      targets: {
        "aarch64-apple-darwin": {
          qpdf: {
            source: "url",
            url: `${base}/qpdf-nolib.zip`,
            sha256: sha,
            member: "bin/qpdf",
            lib: "lib",
            dest: "qpdf",
            expectVersion: "12.4.2",
          },
        },
      },
    });

    const result = await runFetch(["--target", "aarch64-apple-darwin", "--root", root]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("lib dir 'lib' missing in qpdf artifact");
    expect(
      await stat(`${root}/src-tauri/binaries/qpdf-aarch64-apple-darwin`).catch(() => null),
    ).toBe(null);
  });

  it("aborts when staged file disagrees with lock (tamper guard)", async () => {
    const root = await makeRoot();
    servedPath = `${ZIPS}/ffmpeg.zip`;
    makeZip(servedPath, "ffmpeg", "new-content-different-sha");
    const sha = await sha256File(servedPath);
    await mkdir(`${root}/scripts`, { recursive: true });
    await writeFile(
      `${root}/scripts/binaries.lock.json`,
      JSON.stringify({
        generated: "2026-01-01T00:00:00.000Z",
        targets: {
          "aarch64-apple-darwin": {
            ffmpeg: { source: "url", version: "9.0.2", url: `${base}/ffmpeg.zip`, sha256: sha, stagedSha256: "deadbeef".repeat(8), date: "2026-01-01T00:00:00.000Z" },
          },
        },
      }),
    );
    await writeFile(`${root}/src-tauri/binaries/ffmpeg-aarch64-apple-darwin`, "tampered-staged-content");
    await writeManifest(root, {
      targets: { "aarch64-apple-darwin": { ffmpeg: ffmpegEntry(`${base}/ffmpeg.zip`, sha) } },
    });

    const result = await runFetch(["--target", "aarch64-apple-darwin", "--root", root]);
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("sha256 mismatch");
    expect(result.stderr).toContain("ffmpeg-aarch64-apple-darwin");
    expect(result.stderr).toContain("delete the staged file");
    expect(await readFile(`${root}/src-tauri/binaries/ffmpeg-aarch64-apple-darwin`, "utf8")).toBe(
      "tampered-staged-content",
    );
  });

  it("re-downloads when a pre-stagedSha256 lock entry has no staged hash", async () => {
    const root = await makeRoot();
    servedPath = `${ZIPS}/ffmpeg.zip`;
    makeZip(servedPath, "ffmpeg", "fake-ffmpeg-macho-arm64");
    const sha = await sha256File(servedPath);
    await mkdir(`${root}/scripts`, { recursive: true });
    await writeFile(
      `${root}/scripts/binaries.lock.json`,
      JSON.stringify({
        generated: "2026-01-01T00:00:00.000Z",
        targets: {
          "aarch64-apple-darwin": {
            ffmpeg: { source: "url", version: "9.0.2", url: `${base}/ffmpeg.zip`, sha256: sha, date: "2026-01-01T00:00:00.000Z" },
          },
        },
      }),
    );
    await writeFile(`${root}/src-tauri/binaries/ffmpeg-aarch64-apple-darwin`, "stale-unhashed-content");
    await writeManifest(root, {
      targets: { "aarch64-apple-darwin": { ffmpeg: ffmpegEntry(`${base}/ffmpeg.zip`, sha) } },
    });

    const result = await runFetch(["--target", "aarch64-apple-darwin", "--root", root]);
    expect(result.code).toBe(0);
    expect(await readFile(`${root}/src-tauri/binaries/ffmpeg-aarch64-apple-darwin`, "utf8")).toBe(
      "fake-ffmpeg-macho-arm64",
    );
  });

  it("aborts on sha mismatch between manifest and download", async () => {
    const root = await makeRoot();
    servedPath = `${ZIPS}/ffmpeg.zip`;
    await mkdir(dirname(servedPath), { recursive: true });
    makeZip(servedPath, "ffmpeg", "corrupt-or-interrupted");
    await writeManifest(root, {
      targets: {
        "aarch64-apple-darwin": {
          ffmpeg: ffmpegEntry(`${base}/ffmpeg.zip`, "c8ed4c4e6978a03c485edbfe4e0a5dc2380f8a30bba5150531b31b094492d924"),
        },
      },
    });

    const result = await runFetch(["--target", "aarch64-apple-darwin", "--root", root]);
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("sha256 mismatch");
  });

  it("fails loudly when vendor artifact unavailable, naming the url", async () => {
    const root = await makeRoot();
    await writeManifest(root, {
      targets: {
        "aarch64-apple-darwin": {
          ffmpeg: ffmpegEntry(`${base}/missing.zip`, "c8ed4c4e6978a03c485edbfe4e0a5dc2380f8a30bba5150531b31b094492d924"),
        },
      },
    });

    const result = await runFetch(["--target", "aarch64-apple-darwin", "--root", root]);
    expect(result.code).not.toBe(0);
    expect(`${result.stdout}${result.stderr}`).toContain(
      "artifact unavailable (vendor may have pruned it)",
    );
    expect(`${result.stdout}${result.stderr}`).toContain("/missing.zip");
    expect(`${result.stdout}${result.stderr}`).toContain("yarn binaries:refresh");
  });

  it("fails with actionable error when archive member missing and cleans staging", async () => {
    const root = await makeRoot();
    servedPath = `${ZIPS}/wrong.zip`;
    makeZip(servedPath, "not-the-member", "surprise");
    await writeManifest(root, {
      targets: {
        "aarch64-apple-darwin": {
          ffmpeg: ffmpegEntry(`${base}/wrong.zip`, await sha256File(servedPath)),
        },
      },
    });

    const result = await runFetch(["--target", "aarch64-apple-darwin", "--root", root]);
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("member");
    expect(result.stderr).toContain("ffmpeg");
    await expect(stat(`${root}/src-tauri/.staging/ffmpeg-aarch64-apple-darwin`)).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("wipes stale staging before extracting a new artifact", async () => {
    const root = await makeRoot();
    servedPath = `${ZIPS}/ffmpeg.zip`;
    const staleMarker = `${root}/src-tauri/.staging/ffmpeg-aarch64-apple-darwin/ffmpeg`;
    await mkdir(dirname(staleMarker), { recursive: true });
    await writeFile(staleMarker, "stale-from-previous-artifact");
    makeZip(servedPath, "ffmpeg", "fresh-content");
    await writeManifest(root, {
      targets: {
        "aarch64-apple-darwin": {
          ffmpeg: ffmpegEntry(`${base}/ffmpeg.zip`, await sha256File(servedPath)),
        },
      },
    });

    const result = await runFetch(["--target", "aarch64-apple-darwin", "--root", root]);
    expect(result.code).toBe(0);
    expect(await readFile(`${root}/src-tauri/binaries/ffmpeg-aarch64-apple-darwin`, "utf8")).toBe(
      "fresh-content",
    );
  });

  it("skips brew entries without side effects", async () => {
    const root = await makeRoot();
    await writeManifest(root, {
      targets: {
        "aarch64-apple-darwin": {
          vips: { source: "brew", formula: "vips", dest: "vips", expectVersion: "8.18.7" },
        },
      },
    });

    const result = await runFetch(["--target", "aarch64-apple-darwin", "--root", root]);
    expect(result.code).toBe(0);
    let entries = [];
    try {
      entries = await readdir(`${root}/src-tauri/binaries`);
    } catch {}
    expect(entries).toEqual([]);
    let lockRaw = null;
    try {
      lockRaw = await readFile(`${root}/scripts/binaries.lock.json`, "utf8");
    } catch {}
    expect(lockRaw).toBeNull();
  });

  it("is idempotent when lock and staged file match", async () => {
    const root = await makeRoot();
    servedPath = `${ZIPS}/ffmpeg.zip`;
    makeZip(servedPath, "ffmpeg", "fake-ffmpeg-macho-arm64");
    const sha = await sha256File(servedPath);
    await writeManifest(root, {
      targets: { "aarch64-apple-darwin": { ffmpeg: ffmpegEntry(`${base}/ffmpeg.zip`, sha) } },
    });

    const first = await runFetch(["--target", "aarch64-apple-darwin", "--root", root]);
    expect(first.code).toBe(0);

    const staged = `${root}/src-tauri/binaries/ffmpeg-aarch64-apple-darwin`;
    const before = await readFile(staged, "utf8");
    const lockBefore = await readFile(`${root}/scripts/binaries.lock.json`, "utf8");

    const second = await runFetch(["--target", "aarch64-apple-darwin", "--root", root]);
    expect(second.code).toBe(0);
    expect(await readFile(staged, "utf8")).toBe(before);
    expect(await readFile(`${root}/scripts/binaries.lock.json`, "utf8")).toBe(lockBefore);
  });
});
