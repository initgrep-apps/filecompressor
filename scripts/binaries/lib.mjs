import { createHash } from "node:crypto";
import { createReadStream, createWriteStream, readFileSync, constants } from "node:fs";
import { access, mkdir, rename, rm, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { basename, dirname, join } from "node:path";
import https from "node:https";

const TRIPLE_ARCH = {
  "aarch64-apple-darwin": "arm64",
  "x86_64-apple-darwin": "x86_64",
  "x86_64-pc-windows-msvc": "x86_64",
  "aarch64-pc-windows-msvc": "arm64",
};

const KNOWN_SOURCES = ["url", "brew"];
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const MANIFEST_URL_KEYS = ["source", "url", "sha256", "member", "lib", "dest", "expectVersion", "resources"];
const MANIFEST_BREW_KEYS = ["source", "formula", "dest", "expectVersion", "resources"];
const DOWNLOAD_TIMEOUT_MS = 120000;
const MAX_REDIRECTS = 20;

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

export async function exists(path) {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch (error) {
    if (error.code === "ENOENT" || error.code === "ENOTDIR") {
      return false;
    }
    throw error;
  }
}

export async function writeJson(path, obj) {
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
  try {
    await writeFile(tmp, `${JSON.stringify(obj, null, 2)}\n`, "utf8");
    await rename(tmp, path);
  } catch (error) {
    await rm(tmp, { force: true }).catch(() => {});
    throw error;
  }
}

export function validateManifest(manifest) {
  const targets = manifest?.targets;
  if (!targets || typeof targets !== "object") {
    throw new Error(`manifest schema invalid: expected {"targets": {...}} at top level`);
  }
  for (const [triple, binaries] of Object.entries(targets)) {
    archForTriple(triple);
    if (!binaries || typeof binaries !== "object") {
      throw new Error(`manifest schema invalid: target '${triple}' must be an object of binaries`);
    }
    const dests = new Set();
    for (const [name, entry] of Object.entries(binaries)) {
      if (!entry || typeof entry !== "object") {
        throw new Error(`manifest schema invalid: ${triple}/${name} is not an object`);
      }
      if (typeof entry.expectVersion !== "string" || entry.expectVersion.length === 0) {
        throw new Error(`manifest schema invalid: ${triple}/${name} is missing expectVersion`);
      }
      if (!KNOWN_SOURCES.includes(entry.source)) {
        throw new Error(
          `manifest schema invalid: ${triple}/${name} has unknown source '${entry.source}' (expected one of ${KNOWN_SOURCES.join(", ")})`,
        );
      }
      const allowedKeys = entry.source === "url" ? MANIFEST_URL_KEYS : MANIFEST_BREW_KEYS;
      const unknownKeys = Object.keys(entry).filter((key) => !allowedKeys.includes(key));
      if (unknownKeys.length > 0) {
        throw new Error(
          `manifest schema invalid: ${triple}/${name} has unknown key(s) ${unknownKeys.join(", ")} (allowed for source '${entry.source}': ${allowedKeys.join(", ")})`,
        );
      }
      if (entry.source === "brew") {
        if (typeof entry.formula !== "string" || entry.formula.length === 0) {
          throw new Error(`manifest schema invalid: ${triple}/${name} source brew requires a formula`);
        }
      } else {
        if (typeof entry.url !== "string" || entry.url.length === 0) {
          throw new Error(`manifest schema invalid: ${triple}/${name} source url requires a url`);
        }
        try {
          new URL(entry.url);
        } catch {
          throw new Error(`manifest schema invalid: ${triple}/${name} has an unparseable url '${entry.url}'`);
        }
        if (typeof entry.sha256 !== "string" || !SHA256_PATTERN.test(entry.sha256)) {
          throw new Error(
            `manifest schema invalid: ${triple}/${name} requires a 64-hex sha256 pin (unpinned url entries would install unverified binaries)`,
          );
        }
        if (typeof entry.dest !== "string" || entry.dest.length === 0) {
          throw new Error(`manifest schema invalid: ${triple}/${name} requires a dest`);
        }
        if (entry.member !== undefined && (typeof entry.member !== "string" || entry.member.length === 0)) {
          throw new Error(`manifest schema invalid: ${triple}/${name} member must be a non-empty string when present`);
        }
        if (entry.lib !== undefined && (typeof entry.lib !== "string" || entry.lib.length === 0)) {
          throw new Error(`manifest schema invalid: ${triple}/${name} lib must be a non-empty string when present`);
        }
        const dest = expectedDest(entry.dest, triple);
        if (dests.has(dest)) {
          throw new Error(`manifest schema invalid: ${triple} has duplicate dest '${dest}'`);
        }
        dests.add(dest);
      }
    }
  }
}

export function validateLock(lock) {
  if (!lock || typeof lock !== "object" || !lock.targets || typeof lock.targets !== "object") {
    throw new Error(`lock schema invalid: expected {"generated": ..., "targets": {...}} at top level`);
  }
  for (const [triple, binaries] of Object.entries(lock.targets)) {
    if (!binaries || typeof binaries !== "object") {
      throw new Error(`lock schema invalid: target '${triple}' must be an object`);
    }
    for (const [name, entry] of Object.entries(binaries)) {
      if (!entry || typeof entry !== "object") {
        throw new Error(`lock schema invalid: ${triple}/${name} is not an object`);
      }
      if (typeof entry.version !== "string" || entry.version.length === 0) {
        throw new Error(`lock schema invalid: ${triple}/${name} is missing version`);
      }
      if (typeof entry.date !== "string" || entry.date.length === 0) {
        throw new Error(`lock schema invalid: ${triple}/${name} is missing date`);
      }
    }
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
    if (!url.startsWith("https://")) {
      reject(new Error(`only https urls are supported, got '${url}' — vendor artifacts must be fetched over TLS`));
      return;
    }
    let settled = false;
    const settle = (error) => {
      if (!settled) {
        settled = true;
        reject(error);
      }
    };
    const get = (target, redirectsLeft) => {
      const request = https.get(target, (response) => {
        response.on("aborted", () => settle(new Error(`download aborted before completion: ${target}`)));
        response.on("error", settle);
        const status = response.statusCode ?? 0;
        if (status >= 300 && status < 400 && response.headers.location) {
          if (redirectsLeft <= 0) {
            response.resume();
            settle(new Error(`too many redirects fetching ${target}`));
            return;
          }
          response.resume();
          get(new URL(response.headers.location, target).toString(), redirectsLeft - 1);
          return;
        }
        if (status !== 200) {
          response.resume();
          settle(new Error(`HTTP ${status} for ${target}`));
          return;
        }
        const file = createWriteStream(destPath);
        let responseEnded = false;
        response.on("end", () => {
          responseEnded = true;
        });
        response.pipe(file);
        file.on("error", (error) => {
          request.destroy();
          settle(error);
        });
        file.on("close", () => {
          if (settled) {
            return;
          }
          if (!responseEnded) {
            settle(new Error(`connection closed before download completed: ${target}`));
            return;
          }
          resolvePromise();
        });
      });
      request.on("error", settle);
      request.on("timeout", () => {
        request.destroy();
        settle(new Error(`download timed out after ${DOWNLOAD_TIMEOUT_MS / 1000}s: ${target}`));
      });
    };
    get(url, MAX_REDIRECTS);
  });
}

export async function extract(archivePath, destDir) {
  await mkdir(destDir, { recursive: true });
  try {
    if (archivePath.endsWith(".zip")) {
      await run("unzip", ["-o", "-q", archivePath, "-d", destDir]);
      return;
    }
    if (archivePath.endsWith(".tar.zst")) {
      await run("tar", ["--zstd", "-xf", archivePath, "-C", destDir]);
      return;
    }
    throw new Error(`unsupported archive: ${archivePath}`);
  } catch (error) {
    if (archivePath.endsWith(".tar.zst")) {
      throw new Error(
        `extract failed for ${archivePath}: ${error.message ?? error} — .tar.zst requires the 'zstd' tool on PATH (brew install zstd)`,
      );
    }
    throw new Error(`extract failed for ${archivePath}: ${error.message ?? error}`);
  }
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

export function parseArgs(argv) {
  const args = { target: null, root: null };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--target") {
      i += 1;
      args.target = argv[i];
    } else if (argv[i] === "--root") {
      i += 1;
      args.root = argv[i];
    }
  }
  return args;
}

export async function hostTriple() {
  try {
    const { stdout } = await run("rustc", ["-Vv"]);
    const match = /host:\s*(\S+)/.exec(stdout);
    if (match) return match[1];
  } catch {}
  return null;
}

export function isMain(importMetaUrl) {
  return Boolean(process.argv[1]) && importMetaUrl.endsWith(basename(process.argv[1]));
}
