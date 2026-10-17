// @vitest-environment node
import { vi, afterAll, describe, expect, it } from "vitest";

vi.setConfig({ testTimeout: 30_000 });
import { mkdtemp, mkdir, writeFile, readFile, rm, readdir, copyFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { createHash } from "node:crypto";
import https from "node:https";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  archForTriple,
  expectedDest,
  download,
  extract,
  extractTarZstFallback,
  parseArgs,
  tarExtractArgs,
  validateLock,
  writeJson,
} from "./lib.mjs";
import { itDarwin } from "../test-platform.mjs";

process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "fixtures");
const CERT = join(FIXTURES, "test-cert.pem");
const KEY = join(FIXTURES, "test-key.pem");

function httpsServer(handler) {
  return https.createServer({ cert: execFileSync("cat", [CERT]), key: execFileSync("cat", [KEY]) }, handler);
}

async function listen(server) {
  await new Promise((resolvePromise) => server.listen(0, "127.0.0.1", resolvePromise));
  const { port } = server.address();
  return `https://127.0.0.1:${port}`;
}

const cleanupRoots = [];
async function tempRoot(prefix) {
  const root = await mkdtemp(`${tmpdir()}/${prefix}`);
  cleanupRoots.push(root);
  return root;
}

afterAll(async () => {
  await Promise.all(cleanupRoots.map((root) => rm(root, { recursive: true, force: true })));
});

describe("archForTriple", () => {
  it("maps apple triples", () => {
    expect(archForTriple("aarch64-apple-darwin")).toBe("arm64");
    expect(archForTriple("x86_64-apple-darwin")).toBe("x86_64");
  });
  it("maps windows triples", () => {
    expect(archForTriple("x86_64-pc-windows-msvc")).toBe("x86_64");
    expect(archForTriple("aarch64-pc-windows-msvc")).toBe("arm64");
  });
  it("throws on unknown triple", () => {
    expect(() => archForTriple("mips-unknown-linux-gnu")).toThrow("unknown triple");
  });
});

describe("expectedDest", () => {
  it("appends triple and .exe only on windows", () => {
    expect(expectedDest("ffmpeg", "aarch64-apple-darwin")).toBe("ffmpeg-aarch64-apple-darwin");
    expect(expectedDest("ffmpeg", "aarch64-pc-windows-msvc")).toBe("ffmpeg-aarch64-pc-windows-msvc.exe");
  });
});

describe("download", () => {
  itDarwin("follows https redirects", async () => {
    const server = httpsServer((req, res) => {
      if (req.url === "/redirect") {
        res.writeHead(302, { location: "/final.zip" });
        res.end();
        return;
      }
      res.writeHead(200);
      res.end("redirected-payload");
    });
    const base = await listen(server);
    try {
      const root = await tempRoot("lib-test-");
      const dest = join(root, "out.bin");
      await download(`${base}/redirect`, dest);
      expect(await readFile(dest, "utf8")).toBe("redirected-payload");
    } finally {
      server.close();
    }
  });

  it("rejects non-https urls with a clear error", async () => {
    const root = await tempRoot("lib-test-");
    await expect(download("http://127.0.0.1:9/x.zip", join(root, "out.bin"))).rejects.toThrow(
      /only https urls are supported/,
    );
  });

  itDarwin("rejects a redirect that downgrades to http instead of crashing", async () => {
    const server = httpsServer((req, res) => {
      res.writeHead(302, { location: "http://127.0.0.1:9/plain.zip" });
      res.end();
    });
    const base = await listen(server);
    try {
      const root = await tempRoot("lib-test-");
      await expect(download(`${base}/redirect`, join(root, "out.bin"))).rejects.toThrow(
        /only https urls are supported, got 'http:\/\/127\.0\.0\.1:9\/plain\.zip'/,
      );
    } finally {
      server.close();
    }
  });

  itDarwin("rejects a stalled transfer with the real idle budget", async () => {
    const sockets = [];
    const server = httpsServer((req, res) => {
      res.writeHead(200, { "content-length": "100000" });
      res.write("partial");
      sockets.push(res.socket);
    });
    const base = await listen(server);
    try {
      const root = await tempRoot("lib-test-");
      await expect(
        download(`${base}/stall.zip`, join(root, "out.bin"), { timeoutMs: 300 }),
      ).rejects.toThrow(/download stalled: no data received for 300ms/);
    } finally {
      for (const socket of sockets) socket.destroy();
      server.close();
    }
  });

  itDarwin("rejects when the connection closes before the body completes", async () => {
    const server = httpsServer((req, res) => {
      res.writeHead(200, { "content-length": "1000" });
      res.write("partial");
      setTimeout(() => res.destroy(), 10);
    });
    const base = await listen(server);
    try {
      const root = await tempRoot("lib-test-");
      const dest = join(root, "out.bin");
      await expect(download(`${base}/partial.zip`, dest)).rejects.toThrow(
        /aborted before completion|closed before download completed/,
      );
    } finally {
      server.close();
    }
  });
});

describe("extract", () => {
  itDarwin("handles zip and tar.zst fixtures", async () => {
    const root = await tempRoot("lib-test-");
    const zipSrc = join(root, "zipsrc");
    const zipPath = join(root, "a.zip");
    await mkdir(join(zipSrc, "inner"), { recursive: true });
    await writeFile(join(zipSrc, "inner", "tool"), "zip-extracted");
    execFileSync("sh", ["-c", `cd '${zipSrc}' && zip -q -r '${zipPath}' inner`]);

    const zipDir = join(root, "zip-out");
    await extract(zipPath, zipDir);
    expect(await readFile(join(zipDir, "inner", "tool"), "utf8")).toBe("zip-extracted");

    const tarSrc = join(root, "tarsrc");
    const tarPath = join(root, "b.tar.zst");
    await mkdir(join(tarSrc, "pkg", "bin"), { recursive: true });
    await writeFile(join(tarSrc, "pkg", "bin", "tool.exe"), "tarzst-extracted");
    execFileSync("sh", ["-c", `cd '${tarSrc}' && tar --zstd -cf '${tarPath}' pkg`]);

    const tarDir = join(root, "tar-out");
    await extract(tarPath, tarDir);
    expect(await readFile(join(tarDir, "pkg", "bin", "tool.exe"), "utf8")).toBe("tarzst-extracted");
  });

  it("rejects unsupported archives", async () => {
    await expect(extract("/x/foo.tar.gz", "/tmp/nope")).rejects.toThrow("unsupported archive");
  });

  itDarwin("names zstd as the missing tool when tar.zst extraction fails", async () => {
    const root = await tempRoot("lib-test-");
    const fake = join(root, "not-an-archive.tar.zst");
    await writeFile(fake, "garbage");
    await expect(extract(fake, join(root, "out"))).rejects.toThrow(/'zstd' tool/);
  });

  it("extracts .tar.zst through the pure-JS fallback when the primary tar --zstd cannot run (portable: nonexistent tarTool fails with ENOENT)", async () => {
    const root = await tempRoot("lib-test-");
    const archive = join(root, "engine.pkg.tar.zst");
    const fixture = join(FIXTURES, "gs-fixture.pkg.tar.zst");
    await copyFile(fixture, archive);
    const out = join(root, "fallback-out");
    await extract(archive, out, { tarTool: join(root, "definitely-not-a-real-tar-binary") });
    expect((await readFile(join(out, "pkg", "inner", "tool.exe"), "utf8")).trim()).toBe("fallback-extracted");
    const siblings = await readdir(root);
    expect(siblings.filter((name) => name.includes(".tmp.tar"))).toEqual([]);
  });

  it("extractTarZstFallback decompresses with fzstd and untars the temporary plain archive", async () => {
    const root = await tempRoot("lib-test-");
    const archive = join(root, "direct.pkg.tar.zst");
    await copyFile(join(FIXTURES, "gs-fixture.pkg.tar.zst"), archive);
    const out = join(root, "direct-out");
    await extractTarZstFallback(archive, out);
    expect((await readFile(join(out, "pkg", "inner", "tool.exe"), "utf8")).trim()).toBe("fallback-extracted");
  });

  it("classifies a failing fallback loudly: both the tar --zstd attempt and the pure-JS decompression name their root failure", async () => {
    const root = await tempRoot("lib-test-");
    const bogus = join(root, "bogus.pkg.tar.zst");
    await writeFile(bogus, "this-is-not-zstd-nor-tar");
    await expect(
      extract(bogus, join(root, "out"), { tarTool: join(root, "definitely-not-a-real-tar-binary") }),
    ).rejects.toThrow(/tar --zstd failed .*pure-JS zstd fallback .*'zstd' tool/s);
  });

  it("the committed fixture archive stays byte-stable so the fallback test exercises a known-good zstd stream", async () => {
    const fixture = join(FIXTURES, "gs-fixture.pkg.tar.zst");
    const bytes = await readFile(fixture);
    expect(
      createHash("sha256").update(bytes).digest("hex"),
      "regenerate via: mkdir -p pkg/inner && echo fallback-extracted > pkg/inner/tool.exe && tar -cf - --format=ustar pkg | zstd -q -3 > fixtures/gs-fixture.pkg.tar.zst",
    ).toBe("fa3112e3a5b785efbeff6d5186c327cf74c31f19235b733f36cac94ad0dfa6e5");
  });
});

describe("tarExtractArgs", () => {
  it("prepends --force-local ahead of --zstd -xf for the windows primary extraction", () => {
    expect(tarExtractArgs("D:\\a\\engine.tar.zst", "D:\\a\\out", { zstd: true, forceLocal: true })).toEqual([
      "--force-local",
      "--zstd",
      "-xf",
      "D:\\a\\engine.tar.zst",
      "-C",
      "D:\\a\\out",
    ]);
  });

  it("prepends --force-local ahead of plain -xf for the windows fallback extraction", () => {
    expect(
      tarExtractArgs("D:\\a\\engine.pkg.tar.zst.tmp.tar", "D:\\a\\out", { forceLocal: true }),
    ).toEqual(["--force-local", "-xf", "D:\\a\\engine.pkg.tar.zst.tmp.tar", "-C", "D:\\a\\out"]);
  });

  it("never emits --force-local for mac bsdtar", () => {
    expect(tarExtractArgs("/a/engine.tar.zst", "/a/out", { zstd: true })).toEqual([
      "--zstd",
      "-xf",
      "/a/engine.tar.zst",
      "-C",
      "/a/out",
    ]);
    expect(tarExtractArgs("/a/engine.tar.zst", "/a/out", { forceLocal: false })).toEqual([
      "-xf",
      "/a/engine.tar.zst",
      "-C",
      "/a/out",
    ]);
  });

  it("defaults to plain -xf with no options object", () => {
    expect(tarExtractArgs("/a/x.tar", "/a/out")).toEqual(["-xf", "/a/x.tar", "-C", "/a/out"]);
  });
});

describe("parseArgs", () => {
  it("reads --target and --root", () => {
    expect(parseArgs(["--target", "aarch64-apple-darwin", "--root", "/tmp/x"])).toEqual({
      target: "aarch64-apple-darwin",
      root: "/tmp/x",
    });
  });

  it("rejects an unknown flag instead of silently falling back to host detection", () => {
    expect(() => parseArgs(["--targt", "aarch64-apple-darwin"])).toThrow(
      "unknown flag '--targt' — supported flags: --target, --root",
    );
  });

  it("rejects a flag with no value", () => {
    expect(() => parseArgs(["--target"])).toThrow("flag '--target' requires a value");
    expect(() => parseArgs(["--target", "--root"])).toThrow("flag '--target' requires a value");
  });
});

describe("validateLock libStagedSha256", () => {
  const urlEntry = (extra) => ({
    source: "url",
    version: "12.4.2",
    url: "https://x/qpdf.zip",
    sha256: "a".repeat(64),
    date: "2026-01-01T00:00:00.000Z",
    ...extra,
  });

  it("accepts a path -> sha256 map and its absence", () => {
    expect(() =>
      validateLock({
        targets: {
          "aarch64-apple-darwin": {
            qpdf: urlEntry({
              libStagedSha256: { "lib/libqpdf.30.dylib": "b".repeat(64) },
            }),
          },
        },
      }),
    ).not.toThrow();
    expect(() =>
      validateLock({ targets: { "aarch64-apple-darwin": { qpdf: urlEntry() } } }),
    ).not.toThrow();
  });

  it("rejects an empty, non-object, escaping-key or non-hex libStagedSha256", () => {
    const wrap = (libStagedSha256) =>
      validateLock({
        targets: { "aarch64-apple-darwin": { qpdf: urlEntry({ libStagedSha256 }) } },
      });
    expect(() => wrap({})).toThrow(/non-empty object/);
    expect(() => wrap([])).toThrow(/non-empty object/);
    expect(() => wrap(null)).toThrow(/non-empty object/);
    expect(() => wrap({ "/abs/libqpdf.dylib": "b".repeat(64) })).toThrow(/relative path/);
    expect(() => wrap({ "../escape.dylib": "b".repeat(64) })).toThrow(/relative path/);
    expect(() => wrap({ "lib/libqpdf.dylib": "nothex" })).toThrow(/64-hex sha256/);
  });
});

describe("writeJson", () => {
  it("is atomic — tmp+rename, no torn lock on failure", async () => {
    const root = await tempRoot("lib-test-");
    const path = join(root, "binaries.lock.json");
    await writeJson(path, { v: 1 });

    expect(await readFile(path, "utf8")).toContain('"v": 1');
    const siblings = await readdir(root);
    expect(siblings.filter((f) => f.includes(".tmp-"))).toEqual([]);

    const before = await readFile(path, "utf8");
    await expect(writeJson(join(root, "missing-dir", "lock.json"), { v: 2 })).rejects.toThrow();
    expect(await readFile(path, "utf8")).toBe(before);
  });
});
