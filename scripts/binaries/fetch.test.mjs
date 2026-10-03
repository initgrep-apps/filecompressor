// @vitest-environment node
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, writeFile, readFile, rm, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import http from "node:http";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { sha256File } from "./lib.mjs";
import { validateManifest } from "./fetch.mjs";

const SCRIPTS = dirname(fileURLToPath(import.meta.url));
const FETCH = join(SCRIPTS, "fetch.mjs");

function makeZip(zipPath, memberName, content) {
  const staging = `${zipPath}.zsrc`;
  execFileSync("mkdir", ["-p", staging]);
  execFileSync("sh", ["-c", `printf '%s' '${content}' > '${staging}/${memberName}'`]);
  execFileSync("sh", ["-c", `cd '${staging}' && zip -q -r '${zipPath}' '${memberName}'`]);
}

function runFetch(args, env = {}) {
  return new Promise((resolvePromise) => {
    const child = spawn(process.execPath, [FETCH, ...args], {
      env: { ...process.env, ...env },
      cwd: SCRIPTS,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("close", (code) => resolvePromise({ code, stdout, stderr }));
  });
}

describe("manifest schema", () => {
  it("rejects missing expectVersion and unknown source", () => {
    expect(() =>
      validateManifest({
        targets: {
          "aarch64-apple-darwin": {
            ffmpeg: { source: "url", url: "https://x/y.zip", member: "ffmpeg", dest: "ffmpeg" },
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

    expect(() =>
      validateManifest({
        targets: {
          "aarch64-apple-darwin": {
            ffmpeg: { source: "url", url: "https://x/y.zip", expectVersion: "9.0.2" },
          },
        },
      }),
    ).not.toThrow();
  });

  it("rejects unknown triples and non-object targets", () => {
    expect(() => validateManifest({ targets: { "mips-unknown-linux-gnu": {} } })).toThrow(
      /unknown triple/,
    );
    expect(() => validateManifest({})).toThrow(/schema invalid/);
  });
});

describe("fetch.mjs", () => {
  let server;
  let port;
  let servedPath;
  let base;

  beforeAll(async () => {
    await mkdir(`${tmpdir()}/fetch-test-roots`, { recursive: true });
    await mkdir(`${tmpdir()}/fetch-test-zips`, { recursive: true });
    server = http.createServer((req, res) => {
      if (req.url === "/missing.zip") {
        res.writeHead(404, { "content-type": "text/plain" });
        res.end("not found");
        return;
      }
      try {
        const data = readFile(servedPath);
        data.then(
          (buf) => {
            res.writeHead(200);
            res.end(buf);
          },
          () => {
            res.writeHead(404);
            res.end();
          },
        );
      } catch {
        res.writeHead(404);
        res.end();
      }
    });
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    port = server.address().port;
    base = `http://127.0.0.1:${port}`;
  });

  afterAll(async () => {
    server?.close();
    await rm(`${tmpdir()}/fetch-test-roots`, { recursive: true, force: true });
    await rm(`${tmpdir()}/fetch-test-zips`, { recursive: true, force: true });
  });

  it("stages binary and writes lock entry", async () => {
    const root = await mkdtemp(`${tmpdir()}/fetch-test-roots/r`);
    servedPath = `${tmpdir()}/fetch-test-zips/ffmpeg.zip`;
    await mkdir(dirname(servedPath), { recursive: true });
    makeZip(servedPath, "ffmpeg", "fake-ffmpeg-macho-arm64");
    const sha = await sha256File(servedPath);
    const manifest = {
      targets: {
        "aarch64-apple-darwin": {
          ffmpeg: {
            source: "url",
            url: `${base}/ffmpeg.zip`,
            sha256: sha,
            member: "ffmpeg",
            dest: "ffmpeg",
            expectVersion: "9.0.2",
          },
        },
      },
    };
    await mkdir(`${root}/scripts`, { recursive: true });
    await writeFile(`${root}/scripts/binaries.manifest.json`, JSON.stringify(manifest));

    const result = await runFetch(["--target", "aarch64-apple-darwin", "--root", root]);
    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");

    const staged = await readFile(`${root}/src-tauri/binaries/ffmpeg-aarch64-apple-darwin`, "utf8");
    expect(staged).toBe("fake-ffmpeg-macho-arm64");

    const lock = JSON.parse(await readFile(`${root}/scripts/binaries.lock.json`, "utf8"));
    const entry = lock.targets["aarch64-apple-darwin"].ffmpeg;
    expect(entry).toBeTruthy();
    expect(entry.version).toBe("9.0.2");
    expect(entry.url).toBe(`${base}/ffmpeg.zip`);
    expect(entry.sha256).toBe(sha);

    const mode = (await readFile(`${root}/src-tauri/binaries/ffmpeg-aarch64-apple-darwin`)).mode
      ? undefined
      : undefined;
    expect(mode).toBeUndefined();
  });

  it("aborts when staged file disagrees with lock", async () => {
    const root = await mkdtemp(`${tmpdir()}/fetch-test-roots/r`);
    servedPath = `${tmpdir()}/fetch-test-zips/ffmpeg.zip`;
    const lock = {
      generated: "2026-01-01T00:00:00.000Z",
      targets: {
        "aarch64-apple-darwin": {
          ffmpeg: { source: "url", version: "9.0.2", url: `${base}/ffmpeg.zip`, sha256: "deadbeef".repeat(8), stagedSha256: "deadbeef".repeat(8), date: "2026-01-01T00:00:00.000Z" },
        },
      },
    };
    await mkdir(`${root}/scripts`, { recursive: true });
    await writeFile(`${root}/scripts/binaries.lock.json`, JSON.stringify(lock));
    await mkdir(`${root}/src-tauri/binaries`, { recursive: true });
    await writeFile(`${root}/src-tauri/binaries/ffmpeg-aarch64-apple-darwin`, "tampered-staged-content");
    servedPath = `${tmpdir()}/fetch-test-zips/ffmpeg.zip`;
    await mkdir(dirname(servedPath), { recursive: true });
    makeZip(servedPath, "ffmpeg", "new-content-different-sha");
    const manifest = {
      targets: {
        "aarch64-apple-darwin": {
          ffmpeg: {
            source: "url",
            url: `${base}/ffmpeg.zip`,
            sha256: await sha256File(servedPath),
            member: "ffmpeg",
            dest: "ffmpeg",
            expectVersion: "9.0.2",
          },
        },
      },
    };
    await mkdir(`${root}/scripts`, { recursive: true });
    await writeFile(`${root}/scripts/binaries.manifest.json`, JSON.stringify(manifest));

    const result = await runFetch(["--target", "aarch64-apple-darwin", "--root", root]);
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("sha256 mismatch");
    expect(result.stderr).toContain("ffmpeg");
  });

  it("aborts on sha mismatch between manifest and download", async () => {
    const root = await mkdtemp(`${tmpdir()}/fetch-test-roots/r`);
    servedPath = `${tmpdir()}/fetch-test-zips/ffmpeg.zip`;
    await mkdir(dirname(servedPath), { recursive: true });
    makeZip(servedPath, "ffmpeg", "corrupt-or-interrupted");
    const manifest = {
      targets: {
        "aarch64-apple-darwin": {
          ffmpeg: {
            source: "url",
            url: `${base}/ffmpeg.zip`,
            sha256: "c8ed4c4e6978a03c485edbfe4e0a5dc2380f8a30bba5150531b31b094492d924",
            member: "ffmpeg",
            dest: "ffmpeg",
            expectVersion: "9.0.2",
          },
        },
      },
    };
    await mkdir(`${root}/scripts`, { recursive: true });
    await writeFile(`${root}/scripts/binaries.manifest.json`, JSON.stringify(manifest));

    const result = await runFetch(["--target", "aarch64-apple-darwin", "--root", root]);
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("sha256 mismatch");
  });

  it("fails loudly when vendor artifact unavailable", async () => {
    const root = await mkdtemp(`${tmpdir()}/fetch-test-roots/r`);
    const manifest = {
      targets: {
        "aarch64-apple-darwin": {
          ffmpeg: {
            source: "url",
            url: `${base}/missing.zip`,
            sha256: "c8ed4c4e6978a03c485edbfe4e0a5dc2380f8a30bba5150531b31b094492d924",
            member: "ffmpeg",
            dest: "ffmpeg",
            expectVersion: "9.0.2",
          },
        },
      },
    };
    await mkdir(`${root}/scripts`, { recursive: true });
    await writeFile(`${root}/scripts/binaries.manifest.json`, JSON.stringify(manifest));

    const result = await runFetch(["--target", "aarch64-apple-darwin", "--root", root]);
    expect(result.code).not.toBe(0);
    expect(`${result.stdout}${result.stderr}`).toContain(
      "artifact unavailable (vendor may have pruned it)",
    );
    expect(`${result.stdout}${result.stderr}`).toContain("yarn binaries:refresh");
  });

  it("fails with actionable error when archive member missing", async () => {
    const root = await mkdtemp(`${tmpdir()}/fetch-test-roots/r`);
    servedPath = `${tmpdir()}/fetch-test-zips/wrong.zip`;
    await mkdir(dirname(servedPath), { recursive: true });
    makeZip(servedPath, "not-the-member", "surprise");
    const manifest = {
      targets: {
        "aarch64-apple-darwin": {
          ffmpeg: {
            source: "url",
            url: `${base}/wrong.zip`,
            sha256: await sha256File(servedPath),
            member: "ffmpeg",
            dest: "ffmpeg",
            expectVersion: "9.0.2",
          },
        },
      },
    };
    await mkdir(`${root}/scripts`, { recursive: true });
    await writeFile(`${root}/scripts/binaries.manifest.json`, JSON.stringify(manifest));

    const result = await runFetch(["--target", "aarch64-apple-darwin", "--root", root]);
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("member");
    expect(result.stderr).toContain("ffmpeg");
  });

  it("skips brew entries without side effects", async () => {
    const root = await mkdtemp(`${tmpdir()}/fetch-test-roots/r`);
    const manifest = {
      targets: {
        "aarch64-apple-darwin": {
          vips: { source: "brew", formula: "vips", dest: "vips", expectVersion: "8.18.7" },
        },
      },
    };
    await mkdir(`${root}/scripts`, { recursive: true });
    await writeFile(`${root}/scripts/binaries.manifest.json`, JSON.stringify(manifest));

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
    const root = await mkdtemp(`${tmpdir()}/fetch-test-roots/r`);
    servedPath = `${tmpdir()}/fetch-test-zips/ffmpeg.zip`;
    await mkdir(dirname(servedPath), { recursive: true });
    makeZip(servedPath, "ffmpeg", "fake-ffmpeg-macho-arm64");
    const sha = await sha256File(servedPath);
    const manifest = {
      targets: {
        "aarch64-apple-darwin": {
          ffmpeg: {
            source: "url",
            url: `${base}/ffmpeg.zip`,
            sha256: sha,
            member: "ffmpeg",
            dest: "ffmpeg",
            expectVersion: "9.0.2",
          },
        },
      },
    };
    const manifestFile = `${root}/scripts/binaries.manifest.json`;
    await mkdir(`${root}/scripts`, { recursive: true });
    await writeFile(manifestFile, JSON.stringify(manifest));

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
