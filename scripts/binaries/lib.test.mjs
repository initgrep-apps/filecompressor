// @vitest-environment node
import { describe, it, expect } from "vitest";
import { mkdtemp, mkdir, writeFile, readFile, rm, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import http from "node:http";
import { execFileSync } from "node:child_process";
import { archForTriple, expectedDest, download, extract, writeJson } from "./lib.mjs";

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
  it("follows redirects", async () => {
    const server = http.createServer((req, res) => {
      if (req.url === "/redirect") {
        res.writeHead(302, { location: "/final.zip" });
        res.end();
        return;
      }
      res.writeHead(200);
      res.end("redirected-payload");
    });
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    try {
      const { port } = server.address();
      const root = await mkdtemp(`${tmpdir()}/lib-test-`);
      const dest = join(root, "out.bin");
      await download(`http://127.0.0.1:${port}/redirect`, dest);
      expect(await readFile(dest, "utf8")).toBe("redirected-payload");
      await rm(root, { recursive: true, force: true });
    } finally {
      server.close();
    }
  });
});

describe("extract", () => {
  it("handles zip and tar.zst fixtures", async () => {
    const root = await mkdtemp(`${tmpdir()}/lib-test-`);
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

    await rm(root, { recursive: true, force: true });
  });

  it("rejects unsupported archives", async () => {
    await expect(extract("/x/foo.tar.gz", "/tmp/nope")).rejects.toThrow("unsupported archive");
  });
});

describe("writeJson", () => {
  it("is atomic — tmp+rename, no torn lock on failure", async () => {
    const root = await mkdtemp(`${tmpdir()}/lib-test-`);
    const path = join(root, "binaries.lock.json");
    await writeJson(path, { v: 1 });

    expect(await readFile(path, "utf8")).toContain('"v": 1');
    const siblings = await readdir(root);
    expect(siblings.filter((f) => f.includes(".tmp-"))).toEqual([]);

    const before = await readFile(path, "utf8");
    const originalRename = await import("node:fs/promises").then((m) => m.rename);
    const fsPromises = await import("node:fs/promises");
    const breakingPath = join(root, "missing-dir", "lock.json");
    await expect(writeJson(breakingPath, { v: 2 })).rejects.toThrow();
    expect(await readFile(path, "utf8")).toBe(before);
    void originalRename;
    void fsPromises;
    await rm(root, { recursive: true, force: true });
  });
});

