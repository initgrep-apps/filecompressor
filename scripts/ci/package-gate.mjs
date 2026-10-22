import { existsSync, mkdirSync, mkdtempSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { exists, isMain, isWindowsTriple, knownTriples, manifestPath, readJson, run } from "../binaries/lib.mjs";
import { checkVersion } from "../binaries/verify.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = join(HERE, "..", "..");

const ENGINES = ["vips", "qpdf", "gs", "ffmpeg", "ffprobe"];
const GS_RESOURCE_SEARCH_DIRS = ["Resource/Init", "lib", "Resource/Font", "fonts"];
const PRUNED_TARGET_DIRS = new Set(["deps", "build", "incremental", ".fingerprint", "obj", "examples", "tmp"]);
const SEVEN_ZIP = "C:\\Program Files\\7-Zip\\7z.exe";
const ENGINE_TIMEOUT_MS = 60_000;
const RESOLVER_TIMEOUT_MS = 900_000;

export class SevenZipMissingError extends Error {
  constructor(message) {
    super(message);
    this.name = "SevenZipMissingError";
  }
}

export function parseGateArgs(argv) {
  const args = { triple: null, bundleDir: null };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (flag !== "--triple" && flag !== "--bundle-dir") {
      throw new Error(`unknown flag '${flag}' — supported flags: --triple, --bundle-dir`);
    }
    const value = argv[i + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new Error(`flag '${flag}' requires a value (got ${value ?? "end of arguments"})`);
    }
    args[flag === "--triple" ? "triple" : "bundleDir"] = value;
    i += 1;
  }
  if (args.triple === null) {
    throw new Error(`--triple is required (e.g. --triple aarch64-apple-darwin) — supported: ${knownTriples().join(", ")}`);
  }
  if (!knownTriples().includes(args.triple)) {
    throw new Error(`unsupported triple '${args.triple}' — supported: ${knownTriples().join(", ")}`);
  }
  return args;
}

function assertEveryEngineGated(names, where) {
  const listed = new Set(names);
  for (const name of ENGINES) {
    if (!listed.has(name)) {
      throw new Error(
        `${where} does not list the ${name} engine — the package gate would skip it silently; add it to ENGINES, expectedEnginePaths and enginePlan()`,
      );
    }
  }
  const extra = [...listed].filter((name) => !ENGINES.includes(name));
  if (extra.length > 0) {
    throw new Error(
      `${where} lists ${extra.join(", ")} but the package gate only exercises ${ENGINES.join(", ")} — add each new engine to ENGINES and enginePlan(), or it ships ungated`,
    );
  }
}

export function expectedEnginePaths({ triple, exeDir, manifest, baseConf, windowsConf }) {
  const paths = new Map();
  if (!isWindowsTriple(triple)) {
    for (const entry of baseConf.bundle.externalBin ?? []) {
      const name = basename(entry);
      paths.set(name, join(exeDir, name));
    }
    assertEveryEngineGated([...paths.keys()], "src-tauri/tauri.conf.json bundle.externalBin");
    return paths;
  }
  const external = new Set((windowsConf.bundle.externalBin ?? []).map((entry) => basename(entry)));
  assertEveryEngineGated(
    [...ENGINES, ...external],
    "src-tauri/tauri.windows.conf.json bundle.externalBin (plus its engine payloads)",
  );
  const enginesTarget = windowsConf.bundle.resources?.["binaries/engines/"];
  if (typeof enginesTarget !== "string" || enginesTarget.length === 0) {
    throw new Error(
      "src-tauri/tauri.windows.conf.json must map bundle.resources['binaries/engines/'] to the install folder the app probes",
    );
  }
  const targetEntries = manifest.targets?.[triple] ?? {};
  for (const name of ENGINES) {
    if (external.has(name)) {
      paths.set(name, join(exeDir, `${name}.exe`));
      continue;
    }
    const dest = targetEntries[name]?.dest ?? name;
    paths.set(name, join(exeDir, ...enginesTarget.split("/").filter(Boolean), dest, `${dest}.exe`));
  }
  if (paths.size !== ENGINES.length) {
    throw new Error(
      `internal gate error: built ${paths.size} engine paths for ${ENGINES.length} engines — an engine would be skipped`,
    );
  }
  return paths;
}

export function expectedVersions({ triple, manifest }) {
  if (!knownTriples().includes(triple)) {
    throw new Error(`unsupported triple '${triple}' — supported: ${knownTriples().join(", ")}`);
  }
  const targetEntries = manifest.targets?.[triple];
  if (!targetEntries) {
    throw new Error(`missing manifest target '${triple}' — scripts/binaries.manifest.json is the single source of truth`);
  }
  const versions = new Map();
  for (const name of ENGINES) {
    const version = targetEntries[name]?.expectVersion;
    if (typeof version !== "string" || version.length === 0) {
      throw new Error(
        `missing expectVersion for ${name} on ${triple} — scripts/binaries.manifest.json is the single source of truth`,
      );
    }
    versions.set(name, version);
  }
  return versions;
}

export function enginePlan() {
  return new Map([
    [
      "vips",
      {
        fixtures: [],
        steps: [
          { args: ["black", "in.v", "64", "64"], produces: "in.v" },
          { args: ["thumbnail", "in.v", "out.jpg", "32"], produces: "out.jpg" },
        ],
      },
    ],
    [
      "qpdf",
      {
        fixtures: [],
        steps: [
          { args: ["--empty", "out.pdf"], produces: "out.pdf" },
          { args: ["out.pdf", "out-rewritten.pdf"], produces: "out-rewritten.pdf" },
        ],
      },
    ],
    [
      "gs",
      {
        fixtures: [
          {
            name: "in.ps",
            content: "%!PS\n/Helvetica findfont 16 scalefont setfont\n72 700 moveto (gate) show\nshowpage\n",
          },
        ],
        steps: [
          {
            args: ["-q", "-dNOPAUSE", "-dBATCH", "-sDEVICE=pdfwrite", "-sOutputFile=out.pdf", "in.ps"],
            produces: "out.pdf",
          },
        ],
      },
    ],
    [
      "ffmpeg",
      {
        fixtures: [],
        steps: [
          {
            args: ["-y", "-f", "lavfi", "-i", "color=c=red:s=64x64:d=1", "-frames:v", "1", "out.png"],
            produces: "out.png",
          },
        ],
      },
    ],
    [
      "ffprobe",
      {
        fixtures: [],
        steps: [
          {
            args: ["-v", "error", "-show_entries", "stream=width,height", "-of", "csv", "out.png"],
            expectStdout: "64,64",
          },
        ],
      },
    ],
  ]);
}

export function gsRunArgs({ exeDir, triple, stepArgs }) {
  if (isWindowsTriple(triple)) {
    return [...stepArgs];
  }
  const tree = join(exeDir, "..", "Resources", "gs-resources");
  const args = GS_RESOURCE_SEARCH_DIRS.flatMap((dir) => ["-I", join(tree, ...dir.split("/"))]);
  const iccProfiles = join(tree, "iccprofiles");
  if (existsSync(iccProfiles)) {
    args.push(`-uICCProfilesDir=${iccProfiles}`);
  }
  return [...args, ...stepArgs];
}

function statOrNull(path) {
  try {
    return statSync(path);
  } catch {
    return null;
  }
}

export function gsResourcesCheck({ exeDir, triple }) {
  if (isWindowsTriple(triple)) {
    return { ok: true, detail: "windows ROM model — the gs build carries its own resources in the executable" };
  }
  const tree = join(exeDir, "..", "Resources", "gs-resources");
  const missing = [];
  for (const dir of GS_RESOURCE_SEARCH_DIRS) {
    const info = statOrNull(join(tree, ...dir.split("/")));
    if (!info || !info.isDirectory()) {
      missing.push(`${dir} (directory)`);
    }
  }
  const init = statOrNull(join(tree, "Resource", "Init", "gs_init.ps"));
  if (!init || !init.isFile()) {
    missing.push("Resource/Init/gs_init.ps (file)");
  }
  if (missing.length > 0) {
    return {
      ok: false,
      detail: `gs resource tree incomplete under ${tree} — missing ${missing.join(", ")}; gs silently falls back to a compiled-in prefix, so a clean machine cannot compress PDFs (run freeze.yml to restage the bundle)`,
    };
  }
  const icc = statOrNull(join(tree, "iccprofiles"));
  const iccDetail = icc?.isDirectory()
    ? "iccprofiles present (-uICCProfilesDir applied)"
    : "iccprofiles absent (gs uses its compiled-in ICC profiles)";
  return {
    ok: true,
    detail: `${GS_RESOURCE_SEARCH_DIRS.join(", ")} and Resource/Init/gs_init.ps present; ${iccDetail}`,
  };
}

function packageIn(bundleDir, extension) {
  const dir = join(bundleDir, extension === ".app" ? "macos" : "nsis");
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT" || error.code === "ENOTDIR") {
      return null;
    }
    throw new Error(`cannot scan ${dir} for a ${extension} package: ${error.code ?? error.message ?? error}`);
  }
  const match = entries.find((entry) => entry.name.endsWith(extension));
  return match ? join(dir, match.name) : null;
}

function bundleDirsUnder(dir, depth = 0) {
  if (depth > 4) {
    return [];
  }
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT" || error.code === "ENOTDIR") {
      return [];
    }
    throw new Error(`cannot scan ${dir} for bundle directories: ${error.code ?? error.message ?? error}`);
  }
  const found = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }
    const full = join(dir, entry.name);
    if (entry.name === "bundle") {
      found.push(full);
      continue;
    }
    if (PRUNED_TARGET_DIRS.has(entry.name)) {
      continue;
    }
    found.push(...bundleDirsUnder(full, depth + 1));
  }
  return found;
}

export function locateBundle({ root, triple }) {
  const targetDir = join(root, "src-tauri", "target");
  const extension = isWindowsTriple(triple) ? ".exe" : ".app";
  const expected = join(targetDir, triple, "release", "bundle");
  const exact = packageIn(expected, extension);
  if (exact) {
    return { kind: extension === ".app" ? "app" : "nsis", path: exact };
  }
  if (process.env.GITHUB_ACTIONS) {
    console.error(
      `FAIL package — no ${extension} package under ${expected} for ${triple}; the fallback search is disabled in CI so a stale or wrong-triple bundle cannot masquerade as this row's build`,
    );
    return null;
  }
  const preferred = join(targetDir, "release", "bundle");
  const bundleDirs = [preferred, ...bundleDirsUnder(targetDir).filter((dir) => dir !== preferred)];
  for (const dir of bundleDirs) {
    const found = packageIn(dir, extension);
    if (found) {
      console.log(
        `package gate: WARN no package under ${expected}; falling back to a local build at ${found} (CI refuses this fallback)`,
      );
      return { kind: extension === ".app" ? "app" : "nsis", path: found };
    }
  }
  return null;
}

export async function extractNsisInstaller({ setupExe, destDir }) {
  const tool = process.env.SEVEN_ZIP || (existsSync(SEVEN_ZIP) ? SEVEN_ZIP : null);
  if (!tool) {
    throw new SevenZipMissingError(
      `7z not found at "${SEVEN_ZIP}" — the windows release runner image ships 7-Zip there; install it in the row or set SEVEN_ZIP to its executable`,
    );
  }
  mkdirSync(destDir, { recursive: true });
  await run(tool, ["x", "-y", setupExe, `-o${destDir}`]);
  return destDir;
}

export function checkStepOutput({ step, workDir, stdout }) {
  if (step.produces) {
    const path = join(workDir, step.produces);
    const info = statOrNull(path);
    if (!info) {
      return { ok: false, detail: `${step.produces} was not produced` };
    }
    if (!info.isFile()) {
      return { ok: false, detail: `${step.produces} exists but is not a regular file` };
    }
    if (info.size === 0) {
      return { ok: false, detail: `${step.produces} is empty — the engine exited successfully but wrote 0 bytes` };
    }
  }
  if (step.expectStdout !== undefined && !String(stdout ?? "").includes(step.expectStdout)) {
    const got = String(stdout ?? "").trim().slice(0, 200) || "(empty)";
    return { ok: false, detail: `stdout does not contain '${step.expectStdout}', got: ${got}` };
  }
  if (step.produces) {
    return { ok: true, detail: `${step.produces} produced` };
  }
  if (step.expectStdout !== undefined) {
    return { ok: true, detail: `stdout contains ${step.expectStdout}` };
  }
  return {
    ok: false,
    detail: "step declares neither produces nor expectStdout — exit 0 alone would pass a step that did nothing",
  };
}

export function resolverCheck({ code, stdout, stderr }) {
  const output = `${stdout ?? ""}${stderr ?? ""}`;
  if (code !== 0) {
    const tail = output.trim().split("\n").slice(-3).join(" | ") || "(no output)";
    return { ok: false, detail: `resolver test exited ${code}: ${tail}` };
  }
  const marker = /^fso-bundle-resolver-ok:.*$/m.exec(output);
  if (!marker) {
    return {
      ok: false,
      detail:
        "resolver test printed no 'fso-bundle-resolver-ok:' marker — a skipped or filtered-out test also exits 0, so exit 0 alone proves nothing",
    };
  }
  return { ok: true, detail: marker[0] };
}

export function resolverCommand({ root, exeDir }) {
  return {
    tool: "cargo",
    args: ["test", "--lib", "resolve_for_finds_every_engine_in_a_bundled_package", "--", "--nocapture"],
    options: {
      cwd: join(root, "src-tauri"),
      timeout: RESOLVER_TIMEOUT_MS,
      env: { ...process.env, FSO_BUNDLE_EXE_DIR: exeDir, FSO_BUNDLE_GATE: "1" },
    },
  };
}

export function validateBundleDir({ bundleDir, triple }) {
  const extension = isWindowsTriple(triple) ? ".exe" : ".app";
  if (!bundleDir.endsWith(extension)) {
    throw new Error(`--bundle-dir '${bundleDir}' must point at a ${extension} package for ${triple}`);
  }
  const info = statOrNull(bundleDir);
  if (!info) {
    throw new Error(`--bundle-dir '${bundleDir}' does not exist — pass the built ${extension} package path`);
  }
  if (extension === ".app" && !info.isDirectory()) {
    throw new Error(`--bundle-dir '${bundleDir}' is not a directory — pass the built .app package`);
  }
  if (extension === ".exe" && !info.isFile()) {
    throw new Error(`--bundle-dir '${bundleDir}' is not a file — pass the built setup .exe`);
  }
  return bundleDir;
}

export async function checkEngine({
  name,
  binPath,
  expectVersion,
  triple,
  root,
  exeDir,
  plan,
  workDir,
  run: runFn = run,
  checkVersion: checkVersionFn = checkVersion,
  exists: existsFn = exists,
}) {
  const details = [];
  const record = (ok, detail) => details.push({ ok, label: name, detail });
  if (!binPath || !(await existsFn(binPath))) {
    record(
      false,
      `file not found at ${binPath ?? "(no expected path)"} — the app would report 'Engine error: ${name} not available'`,
    );
    return { ok: false, details };
  }
  record(true, `file found at ${binPath}`);

  const version = await checkVersionFn(binPath, expectVersion, triple, root, { env: process.env });
  if (version.ok) {
    record(true, `version ${version.detail}`);
  } else {
    record(false, `expected version ${expectVersion}, got: ${version.detail}`);
  }

  for (const fixture of plan.fixtures) {
    writeFileSync(join(workDir, fixture.name), fixture.content);
  }
  for (const step of plan.steps) {
    const stepArgs = name === "gs" ? gsRunArgs({ exeDir, triple, stepArgs: step.args }) : step.args;
    try {
      const { stdout, stderr } = await runFn(binPath, stepArgs, {
        cwd: workDir,
        timeout: ENGINE_TIMEOUT_MS,
        env: { ...process.env, DYLD_LIBRARY_PATH: undefined },
      });
      if (stderr && stderr.trim()) {
        console.log(`${name}: stderr — ${stderr.trim().slice(0, 300)}`);
      }
      const checked = checkStepOutput({ step, workDir, stdout });
      record(checked.ok, `${step.args.join(" ")} — ${checked.detail}`);
    } catch (error) {
      const output = `${error.stderr ?? ""}${error.stdout ?? ""}`.trim() || `${error.message ?? error}`;
      record(false, `${step.args.join(" ")} — ${output.slice(0, 300)}`);
    }
  }
  return { ok: details.every((detail) => detail.ok), details };
}

export async function main(argv = []) {
  const args = parseGateArgs(argv);
  const root = REPO_ROOT;
  const manifest = readJson(manifestPath(root));
  const baseConf = readJson(join(root, "src-tauri", "tauri.conf.json"));
  const windowsConf = readJson(join(root, "src-tauri", "tauri.windows.conf.json"));
  const located = args.bundleDir
    ? {
        kind: isWindowsTriple(args.triple) ? "nsis" : "app",
        path: validateBundleDir({ bundleDir: args.bundleDir, triple: args.triple }),
      }
    : locateBundle({ root, triple: args.triple });
  if (!located) {
    console.error(
      `FAIL package — cannot find the built package for ${args.triple} under src-tauri/target — this gate must run after tauri-action builds`,
    );
    return 1;
  }
  console.log(`package gate: ${located.path} (${args.triple})`);

  let exeDir;
  if (located.kind === "nsis") {
    try {
      exeDir = await extractNsisInstaller({
        setupExe: located.path,
        destDir: mkdtempSync(join(tmpdir(), "fso-nsis-")),
      });
    } catch (error) {
      console.error(`FAIL package — ${error.message ?? error}`);
      return 1;
    }
  } else {
    exeDir = join(located.path, "Contents", "MacOS");
  }

  let passed = 0;
  let failed = 0;
  const record = (ok, label, detail) => {
    console.log(`${ok ? "PASS" : "FAIL"} ${label} — ${detail}`);
    if (ok) {
      passed += 1;
    } else {
      failed += 1;
    }
  };

  const paths = expectedEnginePaths({ triple: args.triple, exeDir, manifest, baseConf, windowsConf });
  const versions = expectedVersions({ triple: args.triple, manifest });
  const plan = enginePlan();
  const workRoot = mkdtempSync(join(tmpdir(), "fso-package-gate-"));
  const workDirs = new Map();
  const workDirFor = (name) => {
    const key = name === "ffprobe" ? "ffmpeg" : name;
    if (!workDirs.has(key)) {
      const dir = join(workRoot, key);
      mkdirSync(dir, { recursive: true });
      workDirs.set(key, dir);
    }
    return workDirs.get(key);
  };

  const gsResources = gsResourcesCheck({ exeDir, triple: args.triple });
  record(gsResources.ok, "gs-resources", gsResources.detail);

  for (const name of ENGINES) {
    const checked = await checkEngine({
      name,
      binPath: paths.get(name),
      expectVersion: versions.get(name),
      triple: args.triple,
      root,
      exeDir,
      plan: plan.get(name),
      workDir: workDirFor(name),
    });
    for (const detail of checked.details) {
      record(detail.ok, detail.label, detail.detail);
    }
  }

  const command = resolverCommand({ root, exeDir });
  try {
    const { stdout, stderr } = await run(command.tool, command.args, command.options);
    if (stderr && stderr.trim()) {
      console.log(`resolver: stderr — ${stderr.trim().slice(0, 300)}`);
    }
    const checked = resolverCheck({ code: 0, stdout, stderr });
    record(checked.ok, "resolver", checked.detail);
  } catch (error) {
    const checked = resolverCheck({
      code: error.code ?? 1,
      stdout: error.stdout ?? "",
      stderr: error.stderr ?? error.message ?? "",
    });
    record(false, "resolver", checked.detail);
  }

  if (failed === 0) {
    console.log(`package gate: PASS (${passed} checks for ${args.triple})`);
    return 0;
  }
  console.log(`package gate: FAIL (${failed}/${passed + failed} checks failed for ${args.triple})`);
  return 1;
}

if (isMain(import.meta.url)) {
  try {
    process.exitCode = await main(process.argv.slice(2));
  } catch (error) {
    console.error(`::error::package-gate: ${error.message ?? error}`);
    process.exitCode = 1;
  }
}
