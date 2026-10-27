import { appendFileSync, readFileSync } from "node:fs";
import { basename, join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = join(HERE, "..", "..");
const DEFAULT_CONF = join(REPO_ROOT, "src-tauri", "tauri.conf.json");
const DEFAULT_PACKAGE = join(REPO_ROOT, "package.json");
const TAG_PATTERN = /^v(\d+\.\d+\.\d+)(-[A-Za-z][A-Za-z0-9.-]*)?$/;

export function resolveVersion(tag, packageVersion, confVersion) {
  const match = TAG_PATTERN.exec(tag ?? "");
  if (!match) {
    throw new Error(`tag '${tag}' is not a v-prefixed semver release tag (expected '^v<semver>[-<prerelease>]')`);
  }
  const version = match[1] + (match[2] ?? "");
  if (packageVersion !== version) {
    throw new Error(`tag '${tag}' does not match package.json version '${packageVersion}' — bump package.json to '${version}' before tagging`);
  }
  if (confVersion !== match[1]) {
    throw new Error(`tag '${tag}' needs src-tauri/tauri.conf.json at '${match[1]}' (the Windows MSI bundler rejects non-numeric prereleases), found '${confVersion}'`);
  }
  return { version, prerelease: match[2] !== undefined };
}

export function resolveTagFromEnv(env = process.env) {
  const eventName = env.GITHUB_EVENT_NAME ?? "";
  if (eventName === "workflow_dispatch") {
    const tag = env.DISPATCH_TAG ?? "";
    if (!tag) {
      throw new Error("workflow_dispatch requires the 'tag' input (e.g. v0.1.0)");
    }
    return tag;
  }
  const refName = env.GITHUB_REF_NAME ?? "";
  if (!refName) {
    throw new Error("cannot resolve a release tag — this helper expects a v* tag push or a workflow_dispatch with a 'tag' input");
  }
  return refName;
}

export async function main(argv = [], { confPath = DEFAULT_CONF, packagePath = DEFAULT_PACKAGE, envFile = process.env.GITHUB_ENV, env = process.env } = {}) {
  const tag = argv[0] ?? resolveTagFromEnv(env);
  const confVersion = JSON.parse(readFileSync(confPath, "utf8")).version;
  const packageVersion = JSON.parse(readFileSync(packagePath, "utf8")).version;
  const resolved = resolveVersion(tag, packageVersion, confVersion);
  if (!envFile) {
    console.log(`release-version-check (validate-only): tag=${tag} version=${resolved.version} prerelease=${resolved.prerelease}`);
    return resolved;
  }
  appendFileSync(envFile, `RELEASE_TAG=${tag}\nAPP_VERSION=${resolved.version}\nPRERELEASE=${resolved.prerelease}\n`);
  console.log(`release-version-check: tag=${tag} version=${resolved.version} prerelease=${resolved.prerelease}`);
  return resolved;
}

if (isMain(import.meta.url)) {
  try {
    const argv = process.argv.slice(2);
    const validateOnly = argv.includes("--validate-only");
    const positional = argv.filter((arg) => arg !== "--validate-only");
    await main(positional, { envFile: validateOnly ? null : process.env.GITHUB_ENV, env: process.env });
  } catch (error) {
    console.error(`::error::release-version-check: ${error.message}`);
    process.exit(1);
  }
}

function isMain(importMetaUrl) {
  return Boolean(process.argv[1]) && import.meta.url.endsWith(basename(process.argv[1]));
}
