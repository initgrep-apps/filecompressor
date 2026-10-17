import { createHash } from "node:crypto";
import { createReadStream, createWriteStream, readFileSync, writeFileSync, constants } from "node:fs";
import {
  access,
  mkdir,
  readdir,
  readlink,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { execFile } from "node:child_process";
import { basename, join, win32 as pathWin32 } from "node:path";
import https from "node:https";
import { decompress as decompressZstd } from "fzstd";

const TRIPLE_ARCH = {
  "aarch64-apple-darwin": "arm64",
  "x86_64-apple-darwin": "x86_64",
  "x86_64-pc-windows-msvc": "x86_64",
  "aarch64-pc-windows-msvc": "arm64",
};

const KNOWN_SOURCES = ["url", "brew"];
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const MANIFEST_URL_KEYS = [
  "source",
  "url",
  "sha256",
  "member",
  "lib",
  "dest",
  "expectVersion",
  "resources",
  "assetPattern",
  "static",
];
const MANIFEST_BREW_KEYS = ["source", "formula", "binary", "dest", "expectVersion", "resources", "static"];
const DOWNLOAD_TIMEOUT_MS = 120000;
const MAX_REDIRECTS = 20;
const KNOWN_FLAGS = ["--target", "--root"];
const CHECKSUM_LINE = /^([0-9a-fA-F]{64})[ \t]+\*?(.+?)\s*$/;
const VERSION_TAG = /^v?(\d[0-9A-Za-z.+-]*)$/;

export function archForTriple(triple) {
  const arch = TRIPLE_ARCH[triple];
  if (arch === undefined) {
    throw new Error(`unknown triple: ${triple}`);
  }
  return arch;
}

export function knownTriples() {
  return Object.keys(TRIPLE_ARCH);
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
      if (entry.static !== undefined && typeof entry.static !== "boolean") {
        throw new Error(
          `manifest schema invalid: ${triple}/${name} static must be a boolean when present (static engines ship as the flat '${name}-<triple>.exe' externalBin, not as an engines/ payload dir)`,
        );
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
      const destName = typeof entry.dest === "string" && entry.dest.length > 0 ? entry.dest : name;
      const dest = expectedDest(destName, triple);
      if (dests.has(dest)) {
        throw new Error(`manifest schema invalid: ${triple} has duplicate dest '${dest}'`);
      }
      dests.add(dest);
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
        if (entry.assetPattern !== undefined) {
          if (typeof entry.assetPattern !== "string" || entry.assetPattern.length === 0) {
            throw new Error(
              `manifest schema invalid: ${triple}/${name} assetPattern must be a non-empty regex when present`,
            );
          }
          try {
            new RegExp(entry.assetPattern);
          } catch (error) {
            throw new Error(
              `manifest schema invalid: ${triple}/${name} assetPattern '${entry.assetPattern}' is not a valid regex (${error.message ?? error})`,
            );
          }
        }
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
      if (entry.source === "url") {
        if (typeof entry.sha256 !== "string" || !SHA256_PATTERN.test(entry.sha256)) {
          throw new Error(`lock schema invalid: ${triple}/${name} source url requires a 64-hex sha256 pin`);
        }
        if (entry.stagedSha256 !== undefined && !SHA256_PATTERN.test(String(entry.stagedSha256))) {
          throw new Error(
            `lock schema invalid: ${triple}/${name} stagedSha256 must be 64-hex when present (delete the lock and re-run fetch to regenerate)`,
          );
        }
        if (entry.libStagedSha256 !== undefined) {
          if (
            typeof entry.libStagedSha256 !== "object" ||
            entry.libStagedSha256 === null ||
            Array.isArray(entry.libStagedSha256) ||
            Object.keys(entry.libStagedSha256).length === 0
          ) {
            throw new Error(
              `lock schema invalid: ${triple}/${name} libStagedSha256 must be a non-empty object of path -> sha256 (delete the lock and re-run fetch to regenerate)`,
            );
          }
          for (const [file, digest] of Object.entries(entry.libStagedSha256)) {
            if (typeof file !== "string" || file.length === 0 || file.startsWith("/") || file.includes("..")) {
              throw new Error(
                `lock schema invalid: ${triple}/${name} libStagedSha256 key '${file}' must be a relative path inside the staged lib dir`,
              );
            }
            if (!SHA256_PATTERN.test(String(digest))) {
              throw new Error(
                `lock schema invalid: ${triple}/${name} libStagedSha256['${file}'] must be a 64-hex sha256 (delete the lock and re-run fetch to regenerate)`,
              );
            }
          }
        }
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

export async function sha256Tree(dir) {
  const digests = {};
  const walk = async (current, prefix) => {
    const entries = await readdir(current, { withFileTypes: true });
    for (const entry of entries.sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const full = join(current, entry.name);
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        await walk(full, relative);
      } else if (entry.isFile()) {
        digests[relative] = await sha256File(full);
      } else if (entry.isSymbolicLink()) {
        digests[relative] = createHash("sha256").update(await readlink(full)).digest("hex");
      }
    }
  };
  await walk(dir, "");
  return digests;
}

export function download(url, destPath, options = {}) {
  const timeoutMs = options.timeoutMs ?? DOWNLOAD_TIMEOUT_MS;
  return new Promise((resolvePromise, reject) => {
    let settled = false;
    let file = null;
    const settle = (error) => {
      if (settled) {
        return;
      }
      settled = true;
      if (file) {
        file.destroy();
      }
      reject(error);
    };
    const get = (target, redirectsLeft) => {
      if (!target.startsWith("https://")) {
        settle(
          new Error(
            `only https urls are supported, got '${target}' — vendor artifacts must be fetched over TLS (enforced on every redirect hop)`,
          ),
        );
        return;
      }
      const request = https.get(target, { timeout: timeoutMs }, (response) => {
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
        file = createWriteStream(destPath);
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
          settled = true;
          resolvePromise();
        });
      });
      request.on("error", settle);
      request.on("timeout", () => {
        request.destroy();
        settle(new Error(`download stalled: no data received for ${timeoutMs}ms fetching ${target}`));
      });
    };
    get(url, MAX_REDIRECTS);
  });
}

export function tarToolForHost() {
  if (process.platform === "win32") {
    return pathWin32.resolve(process.env.SystemRoot ?? "C:/Windows", "System32/tar.exe");
  }
  return "tar";
}

export function tarExtractArgs(archivePath, destDir, { zstd = false, forceLocal = false } = {}) {
  const extractOption = zstd ? ["--zstd", "-xf"] : ["-xf"];
  return [...(forceLocal ? ["--force-local"] : []), ...extractOption, archivePath, "-C", destDir];
}

export async function extractTarZstFallback(archivePath, destDir, { tarTool } = {}) {
  await mkdir(destDir, { recursive: true });
  let tarBytes;
  try {
    tarBytes = decompressZstd(readFileSync(archivePath));
  } catch (error) {
    throw new Error(`pure-JS zstd decompression of ${archivePath} failed: ${error.message ?? error}`);
  }
  const tmpTar = `${archivePath}.tmp.tar`;
  try {
    writeFileSync(tmpTar, tarBytes);
    await run(tarTool ?? tarToolForHost(), tarExtractArgs(tmpTar, destDir));
  } finally {
    await rm(tmpTar, { force: true }).catch(() => {});
  }
}

export async function extract(archivePath, destDir, options = {}) {
  await mkdir(destDir, { recursive: true });
  const tarTool = options.tarTool ?? tarToolForHost();
  try {
    if (archivePath.endsWith(".zip")) {
      await run("unzip", ["-o", "-q", archivePath, "-d", destDir]);
      return;
    }
    if (archivePath.endsWith(".tar.zst")) {
      try {
        await run(tarTool, tarExtractArgs(archivePath, destDir, { zstd: true }));
        return;
      } catch (primaryError) {
        try {
          await extractTarZstFallback(archivePath, destDir, { tarTool });
        } catch (fallbackError) {
          if (fallbackError.message.startsWith("pure-JS zstd decompression")) {
            throw new Error(
              `extract failed for ${archivePath}: tar --zstd failed (${primaryError.message ?? primaryError}); pure-JS zstd fallback failed (${fallbackError.message ?? fallbackError}) — .tar.zst requires either a 'tar' with --zstd support or a valid zstd stream ('zstd' tool on PATH for faster diagnosis: brew install zstd)`,
            );
          }
          throw new Error(
            `extract failed for ${archivePath}: decompressed to ${archivePath}.tmp.tar but plain tar extraction failed (${fallbackError.message ?? fallbackError}) after tar --zstd failed (${primaryError.message ?? primaryError}) — the plain-tar step must work everywhere; check free disk space and permissions, then re-run`,
          );
        }
        return;
      }
    }
    throw new Error(`unsupported archive: ${archivePath}`);
  } catch (error) {
    if (error.message.startsWith("extract failed for")) {
      throw error;
    }
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
    const flag = argv[i];
    if (!KNOWN_FLAGS.includes(flag)) {
      throw new Error(`unknown flag '${flag}' — supported flags: ${KNOWN_FLAGS.join(", ")}`);
    }
    const value = argv[i + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new Error(`flag '${flag}' requires a value (got ${value ?? "end of arguments"})`);
    }
    args[flag === "--target" ? "target" : "root"] = value;
    i += 1;
  }
  return args;
}

export async function hostTriple() {
  try {
    const { stdout } = await run("rustc", ["-Vv"]);
    const match = /host:\s*(\S+)/.exec(stdout);
    if (match) return match[1];
    console.error("WARN host triple detection: `rustc -Vv` printed no host: line");
  } catch (error) {
    console.error(`WARN host triple detection failed: ${error.message ?? error}`);
  }
  return null;
}

export function isMain(importMetaUrl) {
  return Boolean(process.argv[1]) && importMetaUrl.endsWith(basename(process.argv[1]));
}

const GITHUB_API = "https://api.github.com";
const RIEDL_REDIRECT_BASE = "https://ffmpeg.martin-riedl.de";

export class UnverifiablePinError extends Error {
  constructor(message) {
    super(message);
    this.name = "UnverifiablePinError";
  }
}

export function parseChecksumList(text) {
  const digests = new Map();
  for (const line of String(text ?? "").split("\n")) {
    const match = CHECKSUM_LINE.exec(line);
    if (!match) {
      continue;
    }
    const [, digest, filename] = match;
    digests.set(filename.replace(/^\*/, ""), digest.toLowerCase());
  }
  return digests;
}

export function resolverKindFor(entry) {
  if (entry?.source === "brew") {
    return "brew";
  }
  if (entry?.source !== "url" || typeof entry.url !== "string") {
    return "manual";
  }
  let url;
  try {
    url = new URL(entry.url);
  } catch {
    return "manual";
  }
  if (url.hostname === "github.com") {
    return "github-latest";
  }
  if (url.hostname === "ffmpeg.martin-riedl.de") {
    return "riedl-latest";
  }
  return "manual";
}

function versionFromTag(tag) {
  if (typeof tag !== "string") {
    return null;
  }
  const match = VERSION_TAG.exec(tag.trim());
  return match ? match[1] : null;
}

function checksumAssetFor(assets) {
  const manifest = assets.find((asset) => asset.name === "checksums.sha256");
  if (manifest) {
    return manifest;
  }
  const signed = assets.filter(
    (asset) => asset.name.endsWith(".sha256") && !asset.name.endsWith(".sha256.sigstore"),
  );
  return signed.length === 1 ? signed[0] : null;
}

export function githubRepoFor(url) {
  const parsed = new URL(url);
  if (parsed.hostname !== "github.com") {
    return null;
  }
  const parts = parsed.pathname.split("/").filter((part) => part.length > 0);
  if (parts.length < 2) {
    return null;
  }
  return `${parts[0]}/${parts[1].replace(/\.git$/, "")}`;
}

export async function resolveGithubRelease({ repo, assetPattern, get }) {
  if (typeof assetPattern !== "string" || assetPattern.length === 0) {
    throw new Error(
      `github resolver for ${repo} needs an assetPattern — without one there is no way to know which of the release's assets is the build for this platform`,
    );
  }
  const response = await get(`${GITHUB_API}/repos/${repo}/releases/latest`);
  if (response.status !== 200) {
    throw new Error(
      `github release lookup for ${repo} returned HTTP ${response.status} — check the repository name and that the repo is not rate-limiting unauthenticated requests`,
    );
  }
  let release;
  try {
    release = JSON.parse(response.text);
  } catch (error) {
    throw new Error(`github release lookup for ${repo} returned unparseable JSON: ${error.message ?? error}`);
  }
  const assets = Array.isArray(release.assets) ? release.assets : [];
  const pattern = new RegExp(assetPattern);
  const matching = assets.filter((asset) => pattern.test(asset.name));

  if (matching.length === 0) {
    throw new Error(
      `no asset in ${repo} release ${release.tag_name ?? "?"} matches '${assetPattern}'(available: ${assets.map((asset) => asset.name).join(", ") || "none"})`,
    );
  }
  if (matching.length > 1) {
    throw new Error(
      `'${assetPattern}' matches ${matching.length} assets in ${repo} release ${release.tag_name ?? "?"}: ${matching.map((asset) => asset.name).join(", ")} — tighten assetPattern so exactly one build matches, otherwise a bump could silently swap platform or build variant`,
    );
  }

  const asset = matching[0];
  const checksumAsset = checksumAssetFor(assets);
  if (!checksumAsset) {
    throw new UnverifiablePinError(
      `${repo} release ${release.tag_name ?? "?"} publishes no checksum asset — a new ${asset.name} cannot be pinned automatically; download it, record the sha256 in scripts/binaries.manifest.json by hand, then re-run`,
    );
  }
  const checksumResponse = await get(checksumAsset.browser_download_url);
  if (checksumResponse.status !== 200) {
    throw new Error(
      `checksum asset ${checksumAsset.name} for ${repo} returned HTTP ${checksumResponse.status}`,
    );
  }
  const digests = parseChecksumList(checksumResponse.text);
  const sha256 = digests.get(asset.name);
  if (typeof sha256 !== "string") {
    throw new Error(
      `${checksumAsset.name} lists no digest for ${asset.name} — refusing to pin a binary whose bytes cannot be verified (available entries: ${
         [...digests.keys()].join(", ") || "none"
       })`,
    );
  }
  return {
    tag: release.tag_name ?? null,
    version: versionFromTag(release.tag_name),
    asset: { name: asset.name, url: asset.browser_download_url },
    sha256,
    checksumSource: checksumAsset.name,
  };
}

export async function resolveRiedlRelease({ arch, binary, get, redirectBase }) {
  const base = redirectBase ?? RIEDL_REDIRECT_BASE;
  const redirectUrl = `${base}/redirect/latest/macos/${arch}/release/${binary}.zip`;
  const redirect = await get(redirectUrl, { follow: false });
  if (redirect.status < 300 || redirect.status >= 400 || !redirect.headers?.location) {
    throw new Error(
      `riedl redirect ${redirectUrl} returned HTTP ${redirect.status} without a location header — the vendor may have dropped the latest-release redirect, so check whether ${binary} still ships a versioned download path`,
    );
  }
  const url = new URL(redirect.headers.location, redirectUrl).toString();
  const version = versionFromUrlPath(url);
  const shaResponse = await get(`${url}.sha256`);
  if (shaResponse.status !== 200) {
    throw new Error(
      `no sibling ${binary}.zip.sha256 next to ${url} (HTTP ${shaResponse.status}) — without the vendor's digest there is nothing to pin`,
    );
  }
  const digests = parseChecksumList(shaResponse.text);
  const sha256 = digests.get(`${binary}.zip`);
  if (typeof sha256 !== "string") {
    throw new Error(`${url}.sha256 lists no digest for ${binary}.zip`);
  }
  return { url, sha256, version };
}

function versionFromUrlPath(url) {
  const segments = new URL(url).pathname.split("/").filter((part) => part.length > 0);
  for (const segment of segments.slice().reverse()) {
    const tail = segment.split("_").pop();
    const match = VERSION_TAG.exec(tail);
    if (match) {
      return match[1];
    }
  }
  return null;
}
