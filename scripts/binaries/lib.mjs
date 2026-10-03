import { createHash } from "node:crypto";
import { createReadStream, createWriteStream, readFileSync } from "node:fs";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import http from "node:http";
import https from "node:https";

const TRIPLE_ARCH = {
  "aarch64-apple-darwin": "arm64",
  "x86_64-apple-darwin": "x86_64",
  "x86_64-pc-windows-msvc": "x86_64",
  "aarch64-pc-windows-msvc": "arm64",
};

export function archForTriple(triple) {
  const arch = TRIPLE_ARCH[triple];
  if (arch === undefined) {
    throw new Error(`unknown triple: ${triple}`);
  }
  return arch;
}

export function isWindowsTriple(triple) {
  return triple.includes("-windows-");
}

export function expectedDest(name, triple) {
  const suffix = isWindowsTriple(triple) ? ".exe" : "";
  return `${name}-${triple}${suffix}`;
}

export function repoRoot() {
  const here = decodeURIComponent(new URL(import.meta.url).pathname);
  return resolve(dirname(here), "..", "..");
}

export function binaryDir(root) {
  return join(root, "src-tauri", "binaries");
}

export function stagingDir(root, name, triple) {
  return join(root, "src-tauri", ".staging", `${name}-${triple}`);
}

export function lockPath(root) {
  return join(root, "scripts", "binaries.lock.json");
}

export function manifestPath(root) {
  return join(root, "scripts", "binaries.manifest.json");
}

export function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

export async function writeJson(path, obj) {
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(tmp, `${JSON.stringify(obj, null, 2)}\n`, "utf8");
  try {
    await rename(tmp, path);
  } catch (error) {
    await rm(tmp, { force: true });
    throw error;
  }
}

export function sha256File(path) {
  return new Promise((resolvePromise, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(path);
    stream.on("error", reject);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolvePromise(hash.digest("hex")));
  });
}

export function download(url, destPath) {
  return new Promise((resolvePromise, reject) => {
    const get = (target, redirectsLeft) => {
      const requester = target.startsWith("http://") ? http : https;
      requester
        .get(target, (response) => {
          if (
            response.statusCode &&
            response.statusCode >= 300 &&
            response.statusCode < 400 &&
            response.headers.location
          ) {
            if (redirectsLeft <= 0) {
              response.resume();
              reject(new Error(`too many redirects fetching ${target}`));
              return;
            }
            response.resume();
            get(new URL(response.headers.location, target).toString(), redirectsLeft - 1);
            return;
          }
          if (response.statusCode !== 200) {
            response.resume();
            reject(new Error(`HTTP ${response.statusCode} for ${target}`));
            return;
          }
          const file = createWriteStream(destPath);
          response.pipe(file);
          file.on("error", reject);
          file.on("finish", () => file.close(() => resolvePromise()));
        })
        .on("error", reject);
    };
    get(url, 20);
  });
}

export async function extract(archivePath, destDir) {
  await mkdir(destDir, { recursive: true });
  if (archivePath.endsWith(".zip")) {
    await run("unzip", ["-o", "-q", archivePath, "-d", destDir]);
    return;
  }
  if (archivePath.endsWith(".tar.zst")) {
    await run("tar", ["--zstd", "-xf", archivePath, "-C", destDir]);
    return;
  }
  throw new Error(`unsupported archive: ${archivePath}`);
}

export function run(tool, args, options = {}) {
  return new Promise((resolvePromise, reject) => {
    execFile(tool, args, { encoding: "utf8", ...options }, (error, stdout, stderr) => {
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
