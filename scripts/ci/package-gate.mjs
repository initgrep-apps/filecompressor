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

export function expectedEnginePaths({ triple, exeDir, manifest, baseConf, windowsConf }) {
  const paths = new Map();
  if (!isWindowsTriple(triple)) {
    for (const entry of baseConf.bundle.externalBin ?? []) {
      const name = basename(entry);
      paths.set(name, join(exeDir, name));
    }
    return paths;
  }
  const external = new Set((windowsConf.bundle.externalBin ?? []).map((entry) => basename(entry)));
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
        versionArgs: ["--version"],
        fixtures: [],
        steps: [
          { args: ["black", "in.v", "64", "64"] },
          { args: ["thumbnail", "in.v", "out.jpg", "32"], produces: "out.jpg" },
        ],
      },
    ],
    [
      "qpdf",
      {
        versionArgs: ["--version"],
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
        versionArgs: ["--version"],
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
        versionArgs: ["--version"],
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
        versionArgs: ["--version"],
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

export function gsRunArgs({ exeDir, triple }) {
  const stepArgs = enginePlan().get("gs").steps[0].args;
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

function packageIn(bundleDir, extension) {
  const dir = join(bundleDir, extension === ".app" ? "macos" : "nsis");
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return null;
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
  } catch {
    return [];
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
  const exact = packageIn(join(targetDir, triple, "release", "bundle"), extension);
  if (exact) {
    return { kind: extension === ".app" ? "app" : "nsis", path: exact };
  }
  const preferred = join(targetDir, "release", "bundle");
  const bundleDirs = [preferred, ...bundleDirsUnder(targetDir).filter((dir) => dir !== preferred)];
  for (const dir of bundleDirs) {
    const found = packageIn(dir, extension);
    if (found) {
      console.log(`package gate: no ${triple}/release/bundle package; falling back to ${found}`);
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
    if (!existsSync(path)) {
      return { ok: false, detail: `${step.produces} was not produced` };
    }
    if (statSync(path).size === 0) {
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
  return { ok: true, detail: "ok" };
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
      env: { ...process.env, FSO_BUNDLE_EXE_DIR: exeDir, FSO_BUNDLE_GATE: "1" },
    },
  };
}

export async function main(argv = []) {
  const args = parseGateArgs(argv);
  const root = REPO_ROOT;
  const manifest = readJson(manifestPath(root));
  const baseConf = readJson(join(root, "src-tauri", "tauri.conf.json"));
  const windowsConf = readJson(join(root, "src-tauri", "tauri.windows.conf.json"));
  const located = args.bundleDir
    ? { kind: args.bundleDir.endsWith(".exe") ? "nsis" : "app", path: args.bundleDir }
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

  for (const name of ENGINES) {
    const binPath = paths.get(name);
    if (!binPath || !(await exists(binPath))) {
      record(false, name, `file not found at ${binPath ?? "(no expected path)"} — the app would report 'Engine error: ${name} not available'`);
      continue;
    }
    record(true, name, `file found at ${binPath}`);

    const expectVersion = versions.get(name);
    const version = await checkVersion(binPath, expectVersion, args.triple, root, { env: { ...process.env } });
    if (version.ok) {
      record(true, name, `version ${expectVersion}`);
    } else {
      record(false, name, `expected version ${expectVersion}, got: ${version.detail}`);
    }

    const engine = plan.get(name);
    const workDir = workDirFor(name);
    for (const fixture of engine.fixtures) {
      writeFileSync(join(workDir, fixture.name), fixture.content);
    }
    for (const step of engine.steps) {
      const stepArgs = name === "gs" ? gsRunArgs({ exeDir, triple: args.triple }) : step.args;
      try {
        const { stdout } = await run(binPath, stepArgs, { cwd: workDir });
        const checked = checkStepOutput({ step, workDir, stdout });
        record(checked.ok, name, `${step.args.join(" ")} — ${checked.detail}`);
      } catch (error) {
        const output = `${error.stderr ?? ""}${error.stdout ?? ""}`.trim() || `${error.message ?? error}`;
        record(false, name, `${step.args.join(" ")} — ${output.slice(0, 300)}`);
      }
    }
  }

  const command = resolverCommand({ root, exeDir });
  try {
    const { stdout, stderr } = await run(command.tool, command.args, command.options);
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
    const code = await main(process.argv.slice(2));
    process.exit(code);
  } catch (error) {
    console.error(`::error::package-gate: ${error.message ?? error}`);
    process.exit(1);
  }
}
