import { appendFileSync, readFileSync } from "node:fs";
import { basename, join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = join(HERE, "..", "..");
const DEFAULT_CONF = join(REPO_ROOT, "src-tauri", "tauri.conf.json");
const TAG_PATTERN = /^v(\d+\.\d+\.\d+)(-rc\d+)?$/;

export function resolveVersion(tag, confVersion) {
  const match = TAG_PATTERN.exec(tag ?? "");
  if (!match) {
    throw new Error(`tag '${tag}' is not a v-prefixed semver release tag (expected '^v<semver>[-rcN]$')`);
  }
  if (confVersion !== match[1]) {
    throw new Error(`tag '${tag}' does not match src-tauri/tauri.conf.json version '${confVersion}' — move the tag (or bump the manifest to '${match[1]}') before building the release`);
  }
  return { version: confVersion, prerelease: match[2] !== undefined };
}

export async function main(argv, { confPath = DEFAULT_CONF, envFile = process.env.GITHUB_ENV } = {}) {
  if (!envFile) {
    throw new Error("GITHUB_ENV is not set — run this script from a workflow step");
  }
  const [tag = ""] = argv;
  const confVersion = JSON.parse(readFileSync(confPath, "utf8")).version;
  const resolved = resolveVersion(tag, confVersion);
  appendFileSync(envFile, `RELEASE_TAG=${tag}\nAPP_VERSION=${resolved.version}\nPRERELEASE=${resolved.prerelease}\n`);
  console.log(`release-version-check: tag=${tag} version=${resolved.version} prerelease=${resolved.prerelease}`);
  return resolved;
}

if (isMain(import.meta.url)) {
  try {
    await main(process.argv.slice(2));
  } catch (error) {
    console.error(`::error::release-version-check: ${error.message}`);
    process.exit(1);
  }
}

function isMain(importMetaUrl) {
  return Boolean(process.argv[1]) && import.meta.url.endsWith(basename(process.argv[1]));
}
