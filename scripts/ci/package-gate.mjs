import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { exists, isMain, isWindowsTriple, knownTriples, manifestPath, readJson, run } from "../binaries/lib.mjs";
import { checkVersion, treeHasFile } from "../binaries/verify.mjs";

export { knownTriples };

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, "..", "..");

export const ENGINES = ["vips", "qpdf", "gs", "ffmpeg", "ffprobe"];
const GS_RESOURCE_SEARCH_DIRS = ["Resource/Init", "lib", "Resource/Font", "fonts"];
const GS_FONT_DIRS = ["Resource/Font", "fonts"];
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
        `${where} does not list the ${name} engine — the package gate would skip it silently; add it to bundle.externalBin in src-tauri/tauri.conf.json and to the gate's ENGINES, expectedEnginePaths and enginePlan()`,
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
  const targetEntries = manifest.targets?.[triple] ?? {};
  assertEveryEngineGated(
    [...new Set([...external, ...Object.keys(targetEntries)])],
    "src-tauri/tauri.windows.conf.json bundle.externalBin plus the manifest's engine payloads",
  );
  const enginesTarget = windowsConf.bundle.resources?.["binaries/engines/"];
  if (typeof enginesTarget !== "string" || enginesTarget.length === 0) {
    throw new Error(
      "src-tauri/tauri.windows.conf.json must map bundle.resources['binaries/engines/'] to the install folder the app probes",
    );
  }
  if (windowsConf.bundle.resources?.["gs-resources/"] !== null) {
    throw new Error(
      "src-tauri/tauri.windows.conf.json must null-merge bundle.resources['gs-resources/'] — windows ships the ROM build, so a gs resource tree there would bypass the package gate",
    );
  }
  for (const name of ENGINES) {
    if (external.has(name)) {
      paths.set(name, join(exeDir, `${name}.exe`));
      continue;
    }
    const dest = targetEntries[name]?.dest ?? name;
    paths.set(name, join(exeDir, ...enginesTarget.split("/").filter(Boolean), dest, `${dest}.exe`));
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
          { args: ["black", "in.v", "64", "64"], produces: "in.v", magic: [0xb6, 0xa6, 0xf2, 0x08] },
          {
            args: ["thumbnail", "in.v", "out.jpg", "32"],
            produces: "out.jpg",
            magic: [0xff, 0xd8],
          },
        ],
      },
    ],
    [
      "qpdf",
      {
        fixtures: [],
        steps: [
          { args: ["--empty", "out.pdf"], produces: "out.pdf", magic: "%PDF-" },
          {
            args: ["out.pdf", "out-rewritten.pdf"],
            produces: "out-rewritten.pdf",
            magic: "%PDF-",
          },
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
            magic: "%PDF-",
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
            magic: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
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
  const present = GS_RESOURCE_SEARCH_DIRS.filter((dir) => statOrNull(join(tree, ...dir.split("/")))?.isDirectory());
  const args = present.flatMap((dir) => ["-I", join(tree, ...dir.split("/"))]);
  const iccProfiles = join(tree, "iccprofiles");
  if (statOrNull(iccProfiles)?.isDirectory()) {
    args.push(`-uICCProfilesDir=${iccProfiles}`);
  }
  return [...args, ...stepArgs];
}

function statOrNull(path) {
  try {
    return statSync(path);
  } catch (error) {
    if (error.code === "ENOENT" || error.code === "ENOTDIR") {
      return null;
    }
    throw new Error(`cannot stat ${path}: ${error.code ?? error.message ?? error}`);
  }
}

export async function gsResourcesCheck({ exeDir, triple }) {
  if (isWindowsTriple(triple)) {
    return { ok: true, detail: "windows ROM model — the gs build carries its own resources in the executable" };
  }
  const tree = join(exeDir, "..", "Resources", "gs-resources");
  const missing = [];
  const missingDirs = new Set();
  for (const dir of GS_RESOURCE_SEARCH_DIRS) {
    const info = statOrNull(join(tree, ...dir.split("/")));
    if (!info || !info.isDirectory()) {
      missing.push(`${dir} (directory)`);
      missingDirs.add(dir);
    }
  }
  const init = statOrNull(join(tree, "Resource", "Init", "gs_init.ps"));
  if (!init || !init.isFile()) {
    missing.push("Resource/Init/gs_init.ps (file)");
  }
  for (const dir of GS_FONT_DIRS) {
    if (missingDirs.has(dir)) {
      continue;
    }
    if (!(await treeHasFile(join(tree, ...dir.split("/"))))) {
      missing.push(`${dir} (real non-sentinel font files)`);
    }
  }
  if (missing.length > 0) {
    return {
      ok: false,
      detail: `gs resource tree incomplete under ${tree} — missing ${missing.join(", ")}; gs silently falls back to a compiled-in prefix, so a clean machine cannot compress PDFs (run freeze.yml to restage the bundle)`,
    };
  }
  const icc = statOrNull(join(tree, "iccprofiles"));
  const iccDetail = icc?.isDirectory()
    ? "iccprofiles is a directory (-uICCProfilesDir applied)"
    : "iccprofiles absent or not a directory (gs uses its compiled-in ICC profiles)";
  return {
    ok: true,
    detail: `Resource/Init/gs_init.ps is a file; Resource/Init, lib, Resource/Font and fonts are directories; Resource/Font and fonts each hold real (non-sentinel) files; ${iccDetail}`,
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
  const match = entries.find((entry) =>
    extension === ".exe" ? entry.name.endsWith("-setup.exe") : entry.name.endsWith(extension),
  );
  return match ? join(dir, match.name) : null;
}

export function locateBundle({ root, triple }) {
  const extension = isWindowsTriple(triple) ? ".exe" : ".app";
  const expected = join(root, "src-tauri", "target", triple, "release", "bundle");
  const found = packageIn(expected, extension);
  return found ? { kind: extension === ".app" ? "app" : "nsis", path: found } : null;
}

export async function extractNsisInstaller({
  setupExe,
  destDir,
  run: runFn = run,
  exists: existsFn = existsSync,
}) {
  const tool = process.env.SEVEN_ZIP || (existsFn(SEVEN_ZIP) ? SEVEN_ZIP : null);
  if (!tool) {
    throw new SevenZipMissingError(
      `7z not found at "${SEVEN_ZIP}" — the windows release runner image ships 7-Zip there; install it in the row or set SEVEN_ZIP to its executable`,
    );
  }
  mkdirSync(destDir, { recursive: true });
  await runFn(tool, ["x", "-y", setupExe, `-o${destDir}`]);
  return destDir;
}

function magicLabel(magic) {
  return typeof magic === "string" ? `'${magic}'` : magic.map((byte) => byte.toString(16).padStart(2, "0")).join(" ");
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
    if (step.magic !== undefined) {
      const expected = Buffer.from(step.magic);
      const head = readFileSync(path).subarray(0, expected.length);
      if (!head.equals(expected)) {
        return {
          ok: false,
          detail: `${step.produces} does not start with ${magicLabel(step.magic)} — the engine exited 0 but wrote something else (a truncated file or an HTML error page)`,
        };
      }
    }
  }
  if (step.expectStdout !== undefined && !String(stdout ?? "").includes(step.expectStdout)) {
    const got = String(stdout ?? "").trim().slice(0, 200) || "(empty)";
    return { ok: false, detail: `stdout does not contain '${step.expectStdout}', got: ${got}` };
  }
  if (step.produces) {
    return { ok: true, detail: `${step.produces} produced${step.magic === undefined ? "" : ` with ${magicLabel(step.magic)} signature`}` };
  }
  if (step.expectStdout !== undefined) {
    return { ok: true, detail: `stdout contains ${step.expectStdout}` };
  }
  return {
    ok: false,
    detail: "step declares neither produces nor expectStdout — exit 0 alone would pass a step that did nothing",
  };
}

export function resolverCheck({ code, stdout, stderr, killed, signal, errorCode }) {
  const output = `${stdout ?? ""}${stderr ?? ""}`;
  const tail = output.trim().split("\n").slice(-3).join(" | ") || "(no output)";
  if (killed || signal) {
    return {
      ok: false,
      detail: `resolver test timed out or was killed (${signal ?? "timeout"})${output.trim() ? `: ${tail}` : ""}`,
    };
  }
  if (errorCode === "ENOENT") {
    return { ok: false, detail: `could not start cargo — ${tail}` };
  }
  if (code !== 0) {
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
  const path = resolve(bundleDir);
  if (!path.endsWith(extension)) {
    throw new Error(`--bundle-dir '${bundleDir}' must point at a ${extension} package for ${triple} — resolved to ${path}`);
  }
  const info = statOrNull(path);
  if (!info) {
    throw new Error(`--bundle-dir '${bundleDir}' does not exist — pass the built ${extension} package path (resolved to ${path})`);
  }
  if (extension === ".app" && !info.isDirectory()) {
    throw new Error(`--bundle-dir '${bundleDir}' is not a directory — pass the built .app package (resolved to ${path})`);
  }
  if (extension === ".exe" && !info.isFile()) {
    throw new Error(`--bundle-dir '${bundleDir}' is not a file — pass the built setup .exe (resolved to ${path})`);
  }
  return path;
}

function packageEnv() {
  const env = { ...process.env };
  delete env.DYLD_LIBRARY_PATH;
  return env;
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
}) {
  const details = [];
  const record = (ok, detail) => details.push({ ok, label: name, detail });
  if (!binPath || !(await exists(binPath))) {
    record(
      false,
      `file not found at ${binPath ?? "(no expected path)"} — the app would report 'Engine error: ${name} not available'`,
    );
    return { ok: false, details };
  }
  record(true, `file found at ${binPath}`);

  const env = packageEnv();
  const version = await checkVersionFn(binPath, expectVersion, triple, root, { env });
  if (version.ok) {
    record(true, `version ${version.detail}`);
  } else {
    record(false, version.detail);
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
        env,
      });
      if (stderr && stderr.trim()) {
        console.log(`${name}: stderr — ${stderr.trim().slice(0, 300)}`);
      }
      const checked = checkStepOutput({ step, workDir, stdout });
      record(checked.ok, `${step.args.join(" ")} — ${checked.detail}`);
    } catch (error) {
      const captured = `${error.stderr ?? ""}${error.stdout ?? ""}`.trim();
      let failure;
      if (error.killed || error.signal) {
        failure = `timed out or was killed (${error.signal ?? "timeout"})`;
      } else if (error.code === "ENOENT") {
        failure = `could not start ${name}`;
      } else {
        failure = `exited ${error.code ?? "nonzero"}`;
      }
      record(false, `${step.args.join(" ")} — ${failure}${captured ? `: ${captured.slice(0, 300)}` : ""}`);
    }
  }
  return { ok: details.every((detail) => detail.ok), details };
}

function readJsonFile(path) {
  try {
    return readJson(path);
  } catch (error) {
    throw new Error(`cannot read ${path}: ${error.message ?? error}`);
  }
}

export async function main(argv = [], deps = {}) {
  const {
    checkEngine: checkEngineFn = checkEngine,
    gsResourcesCheck: gsResourcesFn = gsResourcesCheck,
    locateBundle: locateBundleFn = locateBundle,
    extractNsisInstaller: extractNsisFn = extractNsisInstaller,
    run: runFn = run,
  } = deps;
  const args = parseGateArgs(argv);
  const root = REPO_ROOT;
  const manifest = readJsonFile(manifestPath(root));
  const baseConf = readJsonFile(join(root, "src-tauri", "tauri.conf.json"));
  const windowsConf = readJsonFile(join(root, "src-tauri", "tauri.windows.conf.json"));
  const located = args.bundleDir
    ? {
        kind: isWindowsTriple(args.triple) ? "nsis" : "app",
        path: validateBundleDir({ bundleDir: args.bundleDir, triple: args.triple }),
      }
    : locateBundleFn({ root, triple: args.triple });
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
      exeDir = await extractNsisFn({
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

  const gsResources = await gsResourcesFn({ exeDir, triple: args.triple });
  record(gsResources.ok, "gs-resources", gsResources.detail);

  for (const name of ENGINES) {
    const checked = await checkEngineFn({
      name,
      binPath: paths.get(name),
      expectVersion: versions.get(name),
      triple: args.triple,
      root,
      exeDir,
      plan: plan.get(name),
      workDir: workDirFor(name),
    });
    if (!checked.ok && checked.details.length === 0) {
      record(false, name, "engine checks reported failure without a detail");
    }
    for (const detail of checked.details) {
      record(detail.ok, detail.label, detail.detail);
    }
  }

  const command = resolverCommand({ root, exeDir });
  try {
    const { stdout, stderr } = await runFn(command.tool, command.args, command.options);
    if (stderr && stderr.trim()) {
      console.log(`resolver: stderr — ${stderr.trim().slice(0, 300)}`);
    }
    const checked = resolverCheck({ code: 0, stdout, stderr });
    record(checked.ok, "resolver", checked.detail);
  } catch (error) {
    const checked = resolverCheck({
      code: typeof error.code === "number" ? error.code : 1,
      stdout: error.stdout ?? "",
      stderr: error.stderr ?? error.message ?? "",
      killed: error.killed,
      signal: error.signal,
      errorCode: error.code,
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
    console.error(`::error::package-gate: ${error.stack ?? error.message ?? error}`);
    process.exitCode = 1;
  }
}
