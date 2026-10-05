#!/usr/bin/env node
import { UnverifiablePinError } from "./lib.mjs";
import { getUrl } from "./net.mjs";
import {
  exists,
  githubRepoFor,
  isMain,
  knownTriples,
  lockPath,
  manifestPath,
  parseArgs,
  readJson,
  resolverKindFor,
  resolveGithubRelease,
  resolveRiedlRelease,
  run,
  validateManifest,
  writeJson,
} from "./lib.mjs";

const ARCHIVE_EXTENSION = /\.(zip|tar\.zst|tar\.gz|tar\.xz)$/;
const REFRESH_FLAGS = ["--dry-run", "--target", "--root"];

export class RefreshError extends Error {
  constructor(message) {
    super(message);
    this.name = "RefreshError";
  }
}

export function parseRefreshArgs(argv) {
  const dryRunOnly = argv.filter((argument) => argument === "--dry-run");
  for (const argument of argv) {
    if (argument.startsWith("--dry-run=")) {
      throw new RefreshError(
        `flag --dry-run is a switch and takes no value (got '${argument}') —  \`yarn binaries:refresh --dry-run\` is the whole spelling`,
      );
    }
  }
  const rest = argv.filter((argument) => !dryRunOnly.includes(argument));
  const unknown = rest.filter((argument) => argument.startsWith("--") && !REFRESH_FLAGS.includes(argument));
  if (unknown.length > 0) {
    throw new RefreshError(
      `unknown flag ${unknown.join(", ")} — supported flags: ${REFRESH_FLAGS.join(", ")}`,
    );
  }
  return { ...parseArgs(rest), dryRun: dryRunOnly.length > 0 };
}

export function riedlArchFromUrl(url) {
  const segments = new URL(url).pathname.split("/").filter((part) => part.length > 0);
  const at = segments.indexOf("macos");
  if (at === -1 || !segments[at + 1]) {
    throw new RefreshError(
      `'${url}' is not a Riedl macOS download path (/download/macos/<arch>/<version>/<file>) — \
       the arch cannot be derived, so the latest-release redirect cannot be built`,
    );
  }
  return segments[at + 1];
}

function archiveBase(url) {
  const file = new URL(url).pathname.split("/").filter((part) => part.length > 0).pop();
  return file.replace(ARCHIVE_EXTENSION, "");
}

export function rebaseMember(member, oldUrl, newUrl) {
  if (typeof member !== "string" || member.length === 0) {
    return member;
  }
  const oldBase = archiveBase(oldUrl);
  const newBase = archiveBase(newUrl);
  if (oldBase === newBase) {
    return member;
  }
  if (member === oldBase) {
    return newBase;
  }
  if (member.startsWith(`${oldBase}/`)) {
    return `${newBase}${member.slice(oldBase.length)}`;
  }
  return member;
}

async function brewVersionOf(formula) {
  try {
    const { stdout } = await run("brew", ["list", "--versions", formula]);
    const fields = stdout.trim().split(/\s+/).filter((field) => field.length > 0);
    const last = fields[fields.length - 1];
    if (fields.length < 2 || last === formula) {
      return null;
    }
    return last;
  } catch (error) {
    if (error?.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

async function resolveEntry(entry, name, triple, deps) {
  const kind = resolverKindFor(entry);
  if (kind === "manual") {
    return {
      name,
      triple,
      kind,
      status: "manual",
      pinned: entry.expectVersion,
      action: "manual pin — check vendor for a newer build, then update expectVersion/url/sha256 by hand",
    };
  }
  if (kind === "brew") {
    const found = await deps.brewVersion(entry.formula);
    if (found === null) {
      return {
        name,
        triple,
        kind,
        status: "absent",
        pinned: entry.expectVersion,
        action: `brew formula '${entry.formula}' is not installed — run 'brew install ${entry.formula}'`,
      };
    }
    if (found === entry.expectVersion) {
      return { name, triple, kind, status: "unchanged", found, pinned: entry.expectVersion };
    }
    return {
      name,
      triple,
      kind,
      status: "drift",
      found,
      pinned: entry.expectVersion,
      action:
        `installed ${entry.formula} is ${found} but the manifest pins ${entry.expectVersion} — ` +
        `bump expectVersion in scripts/binaries.manifest.json by hand after confirming the ` +
        `new build, then re-run 'yarn binaries:all'`,
    };
  }

  if (kind === "riedl-latest") {
    const arch = riedlArchFromUrl(entry.url);
    const resolved = await resolveRiedlRelease({
      arch,
      binary: name,
      get: deps.get,
      redirectBase: deps.redirectBase,
    });
    return {
      name,
      triple,
      kind,
      status:
        resolved.url === entry.url && resolved.sha256 === entry.sha256 ? "unchanged" : "update",
      found: resolved.version,
      pinned: entry.expectVersion,
      url: resolved.url,
      sha256: resolved.sha256,
      versionDerivable: resolved.version !== null,
    };
  }

  const resolved = await resolveGithubRelease({
    repo: githubRepoFor(entry.url),
    assetPattern: entry.assetPattern,
    get: deps.get,
  });
  return {
    name,
    triple,
    kind,
    status: resolved.asset.url === entry.url && resolved.sha256 === entry.sha256 ? "unchanged" : "update",
    found: resolved.version,
    pinned: entry.expectVersion,
    url: resolved.asset.url,
    sha256: resolved.sha256,
    versionDerivable: resolved.version !== null,
  };
}

function applyFinding(finding, manifestEntry) {
  const previousUrl = manifestEntry.url;
  manifestEntry.url = finding.url;
  manifestEntry.sha256 = finding.sha256;
  if (finding.found !== null && finding.found !== undefined) {
    manifestEntry.expectVersion = finding.found;
  }
  const rebased = rebaseMember(manifestEntry.member, previousUrl, finding.url);
  if (rebased !== manifestEntry.member) {
    manifestEntry.member = rebased;
  }
}

export async function refresh({ root, target, dryRun = false, get = getUrl, brewVersion = brewVersionOf, runFetch, redirectBase, log = console.log } = {}) {
  const resolvedRoot = root ?? process.cwd();
  const manifest = readJson(manifestPath(resolvedRoot));
  validateManifest(manifest);
  const lockFile = lockPath(resolvedRoot);
  const lock = (await exists(lockFile)) ? readJson(lockFile) : { generated: null, targets: {} };

  const triples = target ? [target] : knownTriples();
  for (const triple of triples) {
    if (!manifest.targets[triple]) {
      throw new RefreshError(`manifest has no entry for target '${triple}'`);
    }
  }

  const findings = [];
  const pending = [];
  const emitted = [];
  const emit = (line) => {
    log(line);
    emitted.push(line);
  };

  for (const triple of triples) {
    for (const [name, entry] of Object.entries(manifest.targets[triple])) {
      let finding;
      try {
        finding = await resolveEntry(entry, name, triple, { get, brewVersion, redirectBase });
      } catch (error) {
        finding = {
          name,
          triple,
          kind: resolverKindFor(entry),
          status: error instanceof UnverifiablePinError ? "manual" : "error",
          pinned: entry.expectVersion,
          action: error.message ?? String(error),
        };
      }
      findings.push(finding);
      if (finding.status === "update") {
        pending.push({ triple, name, finding, entry });
      }
    }
  }

  const errors = findings.filter((finding) => finding.status === "error");
  const drift = findings.filter((finding) => finding.status === "drift");

  for (const finding of findings) {
    const line = [
      `${finding.triple}/${finding.name}`,
      finding.status,
      finding.found !== undefined && finding.found !== null ? `found ${finding.found}` : "",
      finding.status === "update" || finding.status === "drift" || finding.status === "absent" || finding.status === "error" || finding.status === "manual"
        ? `pinned ${finding.pinned}`
        : "",
      finding.status === "update" ? `url ${finding.url}` : "",
      finding.status === "update" && finding.versionDerivable === false
        ? `expectVersion stays ${finding.pinned} (the vendor's release tag carries no version)`
        : "",
      finding.action ? `— ${finding.action}` : "",
    ]
      .filter((part) => part.length > 0)
      .join(" ");
    emit(line);
  }

  if (errors.length > 0) {
    emit(
      `refresh: ${errors.length} source(s) could not be resolved — nothing written. Fix the reported problem and re-run.`,
    );
    return { findings, drift, errors, wrote: false, dryRun, updates: [], lines: emitted };
  }

  const updates = pending.map(({ triple, name, finding, entry }) => ({
    triple,
    name,
    from: { url: entry.url, sha256: entry.sha256, expectVersion: entry.expectVersion },
    to: {
      url: finding.url,
      sha256: finding.sha256,
      expectVersion:
        finding.found !== null && finding.found !== undefined ? finding.found : entry.expectVersion,
    },
  }));

  if (dryRun) {
    emit(
      `refresh: dry run — ${pending.length} pin(s) would change${
        drift.length > 0 ? `, ${drift.length} brew drift(s) reported` : ""
      }. Nothing written.`,
    );
    return { findings, drift, errors: [], wrote: false, dryRun: true, updates, lines: emitted };
  }

  for (const { finding, entry } of pending) {
    applyFinding(finding, entry);
  }

  if (pending.length > 0) {
    validateManifest(manifest);
    await writeJson(manifestPath(resolvedRoot), manifest);
    for (const { triple, name, finding } of pending) {
      const row = lock.targets?.[triple]?.[name];
      if (row) {
        if (finding.found !== null && finding.found !== undefined) {
          row.version = finding.found;
        }
        row.url = finding.url;
        row.sha256 = finding.sha256;
        delete row.stagedSha256;
        delete row.libStagedSha256;
      }
    }
    await writeJson(lockFile, lock);
    for (const update of updates) {
      emit(
        `refresh: ${update.triple}/${update.name} ${update.from.expectVersion} -> ${update.to.expectVersion}\n         ${update.from.url}\n      -> ${update.to.url}\n         sha256 ${update.to.sha256}`,
      );
    }
    emit(`refresh: updated ${pending.length} pin(s) in the manifest and lock`);
  } else {
    emit("refresh: no pins changed");
  }

  if (runFetch) {
    await runFetch({ target, root: resolvedRoot });
  }

  return { findings, drift, errors: [], wrote: pending.length > 0, dryRun: false, updates, lines: emitted };
}

async function main() {
  const args = parseRefreshArgs(process.argv.slice(2));
  const root = args.root ?? process.cwd();
  try {
    const result = await refresh({
      root,
      target: args.target,
      dryRun: args.dryRun,
      runFetch: args.target
        ? async ({ target, root: fetchRoot }) => {
            const { fetchTarget } = await import("./fetch.mjs");
            await fetchTarget(target, fetchRoot);
          }
        : undefined,
    });
    if (!args.target && result.wrote) {
      console.log(
        "refresh: pins updated for every target. Re-run fetch per target, since staging is platform-specific: 'yarn binaries:all --target <triple>' for each of " +
         knownTriples().join(", "),
      );
    }
    if (result.errors.length > 0) {
      process.exit(1);
    }
  } catch (error) {
    console.error(`FAIL ${error.message ?? error}`);
    process.exit(1);
  }
}

if (isMain(import.meta.url)) {
  await main();
}