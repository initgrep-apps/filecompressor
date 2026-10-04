// @vitest-environment node
import { describe, it, expect, afterAll } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
  cpSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPTS = dirname(dirname(fileURLToPath(import.meta.url)));
const BUNDLE_PDF = join(SCRIPTS, "bundle-pdf-macos.sh");
const TRIPLE = "aarch64-apple-darwin";

const SENTINELS = [
  ["Resource/Init", "fso-sidecar-acceptance-sentinel.ps"],
  ["Resource/Font", "fso-sidecar-acceptance-resource-font-sentinel.ps"],
  ["lib", "fso-sidecar-acceptance-lib-sentinel.ps"],
  ["fonts", "fso-sidecar-acceptance-fonts-sentinel.ps"],
];

const cleanupRoots = [];

function makeRoot() {
  const root = mkdtempSync(`${tmpdir()}/bundle-pdf-test-`);
  cleanupRoots.push(root);
  mkdirSync(join(root, "scripts"), { recursive: true });
  cpSync(BUNDLE_PDF, join(root, "scripts", "bundle-pdf-macos.sh"));
  cpSync(join(SCRIPTS, "sidecar-bundle.common.sh"), join(root, "scripts", "sidecar-bundle.common.sh"));
  return root;
}

function sh(command, cwd, extraEnv = {}) {
  const result = spawnSync("bash", ["-c", command], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, ...extraEnv },
  });
  return { code: result.status, out: result.stdout ?? "", err: result.stderr ?? "" };
}

function arm64Fixture(outPath, marker) {
  const source = join(dirname(outPath), `${marker}.c`);
  writeFileSync(source, `#include <stdio.h>\nint main(void){return 0;}\n`);
  execFileSync("clang", [
    "-arch",
    "arm64",
    "-Wl,-headerpad_max_install_names",
    source,
    "-o",
    outPath,
  ]);
  rmSync(source, { force: true });
}

function dylibFixture(outPath, symbol, { installName = null } = {}) {
  const source = join(dirname(outPath), `${symbol}.c`);
  writeFileSync(source, `int ${symbol}(void){return 0;}\n`);
  const args = ["-dynamiclib", "-Wl,-headerpad_max_install_names", source, "-o", outPath];
  if (installName) {
    args.push(`-Wl,-dylib_install_name,${installName}`);
  }
  execFileSync("clang", args);
  rmSync(source, { force: true });
}

function qpdfFixture(outPath, dylibPath, { extraRpaths = [], symbol = "fso_qpdf_marker" } = {}) {
  const dir = dirname(outPath);
  const source = join(dir, "qpdfbin.c");
  writeFileSync(
    source,
    `extern int ${symbol}(void);\nint main(void){return ${symbol}();}\n`,
  );
  execFileSync("clang", [
    "-arch",
    "arm64",
    "-Wl,-headerpad_max_install_names",
    source,
    dylibPath,
    "-Wl,-rpath,@loader_path/../lib",
    ...extraRpaths.map((rpath) => `-Wl,-rpath,${rpath}`),
    "-o",
    outPath,
  ]);
  rmSync(source, { force: true });
}

function sha256(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function fingerprint(path) {
  const id = execFileSync("otool", ["-D", path], { encoding: "utf8" })
    .split("\n")
    .slice(1)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((entry) => entry.split("/").pop())
    .filter(Boolean);
  const deps = execFileSync("otool", ["-L", path], { encoding: "utf8" })
    .split("\n")
    .slice(1)
    .map((line) => line.trim().split(/\s+/)[0])
    .filter(Boolean)
    .map((entry) => entry.split("/").pop());
  return [...new Set([...id, ...deps])].sort();
}

function stagedLibDir(root) {
  return join(root, "src-tauri", ".staging", `qpdf-${TRIPLE}`, "lib");
}

function stageStagedLib(root, { name = "libqpdf.30.dylib", realName = null, symbol = "fso_qpdf_marker" } = {}) {
  const libDir = stagedLibDir(root);
  mkdirSync(libDir, { recursive: true });
  dylibFixture(join(libDir, realName ?? name), symbol);
  if (realName) {
    symlinkSync(realName, join(libDir, name));
  }
  return { libDir, member: join(libDir, name), real: join(libDir, realName ?? name) };
}

function lockDigest(path) {
  const digests = {};
  const walk = (current, prefix) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = join(current, entry.name);
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        walk(full, relative);
      } else if (entry.isSymbolicLink()) {
        digests[relative] = createHash("sha256")
          .update(readlinkSync(full))
          .digest("hex");
      } else {
        digests[relative] = sha256(full);
      }
    }
  };
  walk(path, "");
  return digests;
}

function writeLock(root, libStagedSha256) {
  writeFileSync(
    join(root, "scripts", "binaries.lock.json"),
    JSON.stringify({
      generated: "2026-01-01T00:00:00.000Z",
      targets: {
        [TRIPLE]: {
          qpdf: {
            source: "url",
            version: "12.4.2",
            url: "https://x/qpdf.zip",
            sha256: "a".repeat(64),
            stagedSha256: "b".repeat(64),
            date: "2026-01-01T00:00:00.000Z",
            ...(libStagedSha256 ? { libStagedSha256 } : {}),
          },
        },
      },
    }),
  );
}

function makeGsFixture(root, { symlinkSource = false } = {}) {
  const realShare = join(root, "real-share");
  for (const dir of ["Resource/Init", "Resource/Font", "lib", "iccprofiles", "fonts"]) {
    mkdirSync(join(realShare, "ghostscript", "share", "ghostscript", dir), { recursive: true });
    writeFileSync(join(realShare, "ghostscript", "share", "ghostscript", dir, "file.txt"), dir);
  }
  writeFileSync(
    join(realShare, "ghostscript", "share", "ghostscript", "Resource", "Init", "gs_init.ps"),
    "%!\n",
  );
  const prefix = join(realShare, "ghostscript");
  let brewPrefix = prefix;
  if (symlinkSource) {
    const linkParent = join(root, "linked");
    mkdirSync(linkParent, { recursive: true });
    symlinkSync(prefix, join(linkParent, "ghostscript"));
    brewPrefix = join(linkParent, "ghostscript");
  }

  const stubBin = join(root, "stub-bin");
  mkdirSync(stubBin, { recursive: true });
  writeFileSync(
    join(stubBin, "brew"),
    `#!/bin/sh\ncase "$1" in\n  --prefix) printf '%s\\n' '${brewPrefix}' ;;\n  *) exit 1 ;;\nesac\n`,
    { mode: 0o755 },
  );
  writeFileSync(join(stubBin, "rustc"), `#!/bin/sh\necho 'host: ${TRIPLE}'\n`, {
    mode: 0o755,
  });
  return { stubBin, brewPrefix };
}

function runBundle(root, { stubBin, env = {} } = {}) {
  return sh(`bash scripts/bundle-pdf-macos.sh 2>&1; echo "EXIT:$?"`, root, {
    PATH: `${stubBin}:${process.env.PATH}`,
    ...env,
  });
}

function basenameOf(path) {
  return path.split("/").pop();
}

afterAll(() => {
  for (const root of cleanupRoots) {
    rmSync(root, { recursive: true, force: true });
    rmSync(join(root, "..", `${basenameOf(root)}-link`), { recursive: true, force: true });
  }
});

describe("bundle-pdf-macos.sh qpdf lib staging gate", () => {
  it("refuses to bundle when the fetch staging lib dir is absent", () => {
    const root = makeRoot();
    const binDir = join(root, "src-tauri", "binaries");
    mkdirSync(binDir, { recursive: true });
    arm64Fixture(join(binDir, `qpdf-${TRIPLE}`), "qpdf");
    arm64Fixture(join(binDir, `gs-${TRIPLE}`), "gs");

    const result = sh(`bash scripts/bundle-pdf-macos.sh 2>&1; echo "EXIT:$?"`, root);
    expect(result.out).toMatch(/qpdf lib staging dir missing/);
    expect(result.out).toMatch(/yarn binaries:fetch --target/);
  });

  it("refuses when the staging dir exists but carries no libqpdf", () => {
    const root = makeRoot();
    const binDir = join(root, "src-tauri", "binaries");
    mkdirSync(binDir, { recursive: true });
    arm64Fixture(join(binDir, `qpdf-${TRIPLE}`), "qpdf");
    arm64Fixture(join(binDir, `gs-${TRIPLE}`), "gs");
    mkdirSync(stagedLibDir(root), { recursive: true });
    writeFileSync(join(stagedLibDir(root), "unrelated.txt"), "not a dylib");

    const result = sh(`bash scripts/bundle-pdf-macos.sh 2>&1; echo "EXIT:$?"`, root);
    expect(result.out).toMatch(/no libqpdf\*\.dylib in/);
    expect(result.out).toMatch(/yarn binaries:fetch --target/);
  });
});

describe("bundle-pdf-macos.sh staged lib digest gate", () => {
  function happyRoot({ symlinkLib = false } = {}) {
    const root = makeRoot();
    const binDir = join(root, "src-tauri", "binaries");
    mkdirSync(binDir, { recursive: true });
    const staged = stageStagedLib(root, {
      realName: symlinkLib ? "libqpdf.30.4.2.dylib" : null,
    });
    qpdfFixture(join(binDir, `qpdf-${TRIPLE}`), staged.real);
    arm64Fixture(join(binDir, `gs-${TRIPLE}`), "gs");
    const { stubBin } = makeGsFixture(root);
    return { root, stubBin, staged };
  }

  it("refuses when the lock pins no lib digest, naming fetch as the remedy", () => {
    const { root, stubBin } = happyRoot();
    writeLock(root, undefined);

    const result = runBundle(root, { stubBin });
    expect(result.out).toMatch(/the lock records no libStagedSha256 for qpdf/);
    expect(result.out).toMatch(/yarn binaries:fetch --target/);
    expect(result.out).not.toContain("bundled: qpdf + gs sidecars self-contained");
  });

  it("refuses a staged lib whose bytes were tampered with", () => {
    const { root, stubBin, staged } = happyRoot();
    writeLock(root, lockDigest(staged.libDir));
    const bytes = readFileSync(staged.member);
    bytes[0x400] ^= 0xff;
    writeFileSync(staged.member, bytes);

    const result = runBundle(root, { stubBin });
    expect(result.out).toMatch(/staged qpdf lib libqpdf\.30\.dylib: sha256 mismatch/);
    expect(result.out).toMatch(/yarn binaries:fetch --target/);
    expect(result.out).not.toContain("bundled: qpdf + gs sidecars self-contained");
  });

  it("refuses a staged lib member the lock does not pin", () => {
    const { root, stubBin, staged } = happyRoot();
    writeLock(root, lockDigest(staged.libDir));
    writeFileSync(join(staged.libDir, "libqpdf.extra.dylib"), "sneaky");

    const result = runBundle(root, { stubBin });
    expect(result.out).toMatch(/staged qpdf lib dir holds files the lock does not pin/);
    expect(result.out).toContain("libqpdf.extra.dylib");
    expect(result.out).not.toContain("bundled: qpdf + gs sidecars self-contained");
  });

  it("accepts a symlinked lib member pinned by its target", () => {
    const { root, stubBin, staged } = happyRoot({ symlinkLib: true });
    writeLock(root, lockDigest(staged.libDir));

    const result = runBundle(root, { stubBin });
    expect(result.out).toContain("bundled: qpdf + gs sidecars self-contained");
  });
});

describe("bundle-pdf-macos.sh qpdf lib provenance guards", () => {
  function rootWithStagedLib() {
    const root = makeRoot();
    const binDir = join(root, "src-tauri", "binaries");
    mkdirSync(binDir, { recursive: true });
    const staged = stageStagedLib(root);
    arm64Fixture(join(binDir, `gs-${TRIPLE}`), "gs");
    const { stubBin } = makeGsFixture(root);
    writeLock(root, lockDigest(staged.libDir));
    return { root, stubBin, staged, binDir };
  }

  it("replaces a stale frameworks libqpdf with the staged official one", () => {
    const { root, stubBin, staged, binDir } = rootWithStagedLib();
    mkdirSync(join(root, "src-tauri", "frameworks"), { recursive: true });
    dylibFixture(join(root, "src-tauri", "frameworks", "libqpdf.30.dylib"), "fso_stale_marker");
    qpdfFixture(join(binDir, `qpdf-${TRIPLE}`), staged.member);

    const result = runBundle(root, { stubBin });
    expect(result.out).toContain("replacing frameworks/libqpdf.30.dylib with official qpdf lib");
    expect(result.out).toContain("bundled: qpdf + gs sidecars self-contained");
    expect(
      fingerprint(join(root, "src-tauri", "frameworks", "libqpdf.30.dylib")),
      "the collected dylib must be the staged official one, not the stale copy",
    ).toEqual(fingerprint(staged.member));
  });

  it("refuses a libqpdf collected from outside the staged lib dir", () => {
    const { root, stubBin, binDir } = rootWithStagedLib();
    const decoyDir = join(root, "src-tauri", "lib");
    mkdirSync(decoyDir, { recursive: true });
    dylibFixture(join(decoyDir, "libqpdf.30.dylib"), "fso_decoy_marker");
    qpdfFixture(join(binDir, `qpdf-${TRIPLE}`), join(decoyDir, "libqpdf.30.dylib"), {
      symbol: "fso_decoy_marker",
    });

    const result = runBundle(root, { stubBin });
    expect(result.out).toMatch(/outside the staged official lib dir/);
    expect(result.out).toMatch(/only the official archive's lib may land in frameworks\//);
    expect(result.out).not.toContain("bundled: qpdf + gs sidecars self-contained");
  });

  it("prefers the staged lib over a resolvable rpath decoy", () => {
    const { root, stubBin, staged, binDir } = rootWithStagedLib();
    const decoyDir = join(root, "src-tauri", "lib");
    mkdirSync(decoyDir, { recursive: true });
    dylibFixture(join(decoyDir, "libqpdf.30.dylib"), "fso_decoy_marker", {
      installName: "@loader_path/../lib/libqpdf.30.dylib",
    });
    dylibFixture(staged.member, "fso_qpdf_marker", {
      installName: "@rpath/libqpdf.30.dylib",
    });
    writeLock(root, lockDigest(staged.libDir));
    qpdfFixture(join(binDir, `qpdf-${TRIPLE}`), staged.member, { extraRpaths: ["@rpath"] });

    const result = runBundle(root, { stubBin });
    expect(result.out).toContain("bundled: qpdf + gs sidecars self-contained");
    expect(fingerprint(join(root, "src-tauri", "frameworks", "libqpdf.30.dylib"))).toEqual(
      fingerprint(staged.member),
    );
  });

  it("refuses an @rpath dep the staged lib dir cannot account for", () => {
    const { root, stubBin, binDir } = rootWithStagedLib();
    const extraDir = join(root, "src-tauri", "lib");
    mkdirSync(extraDir, { recursive: true });
    dylibFixture(join(extraDir, "libextra.dylib"), "fso_extra_marker");
    qpdfFixture(join(binDir, `qpdf-${TRIPLE}`), join(extraDir, "libextra.dylib"), {
      symbol: "fso_extra_marker",
    });

    const result = runBundle(root, { stubBin });
    expect(result.out).toMatch(
      /qpdf links @rpath\/libextra\.dylib but the staged official lib dir has no such file/,
    );
    expect(result.out).not.toContain("bundled: qpdf + gs sidecars self-contained");
  });
});

function treeFiles(root) {
  const walk = (current, prefix) => {
    const files = {};
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = join(current, entry.name);
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        Object.assign(files, walk(full, relative));
      } else if (entry.isFile()) {
        files[relative] = readFileSync(full, "utf8");
      }
    }
    return files;
  };
  return walk(root, "");
}

const SENTINEL_PATHS = SENTINELS.map(([dir, name]) => `${dir}/${name}`);

function expectedSentinelsFor(dir) {
  const expected = {};
  for (const sentinelPath of SENTINEL_PATHS) {
    if (sentinelPath.startsWith(`${dir}/`)) {
      expected[sentinelPath.slice(dir.length + 1)] = expect.stringContaining(
        "% Staged-only sentinel",
      );
    }
  }
  return expected;
}

function expectStagedCopyMatches(stagedResources, brewPrefix, dir) {
  const from = treeFiles(join(brewPrefix, "share", "ghostscript", dir));
  const to = treeFiles(join(stagedResources, dir));
  expect(to, "a partial or failed copy would leave the staged tree incomplete").toEqual({
    ...from,
    ...expectedSentinelsFor(dir),
  });
}

describe("bundle-pdf-macos.sh gs resource staging", () => {
  it("stages gs resources and every acceptance sentinel when brew is reached through a symlink", () => {
    const root = makeRoot();
    const binDir = join(root, "src-tauri", "binaries");
    mkdirSync(binDir, { recursive: true });
    const staged = stageStagedLib(root);
    qpdfFixture(join(binDir, `qpdf-${TRIPLE}`), staged.member);
    arm64Fixture(join(binDir, `gs-${TRIPLE}`), "gs");
    writeLock(root, lockDigest(staged.libDir));
    const { stubBin, brewPrefix } = makeGsFixture(root, { symlinkSource: true });

    const result = runBundle(root, { stubBin });
    expect(result.out).toMatch(/staged: gs resources/);
    const stagedResources = join(root, "src-tauri", "gs-resources");
    expect(readFileSync(join(stagedResources, "Resource", "Init", "gs_init.ps"), "utf8")).toBe("%!\n");
    for (const dir of ["lib", "iccprofiles", "fonts"]) {
      expect(readFileSync(join(stagedResources, dir, "file.txt"), "utf8")).toBe(dir);
      expectStagedCopyMatches(stagedResources, realpathSync(brewPrefix), dir);
    }
    expectStagedCopyMatches(stagedResources, realpathSync(brewPrefix), "Resource");
    for (const [dir, name] of SENTINELS) {
      expect(result.out).toContain(
        `staged: gs acceptance sentinel -> ${realpathSync(stagedResources)}/${dir}/${name}`,
      );
      expect(readFileSync(join(stagedResources, dir, name), "utf8")).toMatch(
        /^%!\n% Staged-only sentinel: gs resolves it through the -I search paths/,
      );
    }
  });

  it("stages an identical tree when the worktree root is reached through a symlink", () => {
    const root = makeRoot();
    const binDir = join(root, "src-tauri", "binaries");
    mkdirSync(binDir, { recursive: true });
    const staged = stageStagedLib(root);
    qpdfFixture(join(binDir, `qpdf-${TRIPLE}`), staged.member);
    arm64Fixture(join(binDir, `gs-${TRIPLE}`), "gs");
    writeLock(root, lockDigest(staged.libDir));
    const { stubBin, brewPrefix } = makeGsFixture(root);

    const linkRoot = join(root, "..", `${basenameOf(root)}-link`);
    rmSync(linkRoot, { recursive: true, force: true });
    symlinkSync(realpathSync(root), linkRoot);

    const result = sh(
      `cd "${linkRoot}" && bash "scripts/bundle-pdf-macos.sh" 2>&1; echo "EXIT:$?"`,
      tmpdir(),
      { PATH: `${stubBin}:${process.env.PATH}` },
    );
    expect(result.out).toMatch(/staged: gs resources/);
    expect(result.out).toContain("bundled: qpdf + gs sidecars self-contained");
    const stagedResources = join(root, "src-tauri", "gs-resources");
    for (const dir of ["Resource", "lib", "iccprofiles", "fonts"]) {
      expectStagedCopyMatches(stagedResources, brewPrefix, dir);
    }
    expectStagedCopyMatches(stagedResources, brewPrefix, "Resource/Font");
    for (const [dir, name] of SENTINELS) {
      expect(readFileSync(join(stagedResources, dir, name), "utf8")).toMatch(/^%!\n% Staged-only/);
    }
  }, 30000);

  it("stages the dirs prep declares in the manifest, not a hardcoded list", () => {
    const root = makeRoot();
    const binDir = join(root, "src-tauri", "binaries");
    mkdirSync(binDir, { recursive: true });
    const staged = stageStagedLib(root);
    qpdfFixture(join(binDir, `qpdf-${TRIPLE}`), staged.member);
    arm64Fixture(join(binDir, `gs-${TRIPLE}`), "gs");
    writeLock(root, lockDigest(staged.libDir));
    const { stubBin, brewPrefix } = makeGsFixture(root);
    mkdirSync(join(brewPrefix, "share", "ghostscript", "extra-stuff"), { recursive: true });
    writeFileSync(join(brewPrefix, "share", "ghostscript", "extra-stuff", "only.txt"), "x");

    const result = runBundle(root, {
      stubBin,
      env: { FSO_GS_RESOURCE_DIRS: "Resource lib extra-stuff" },
    });
    expect(result.out).toContain("bundled: qpdf + gs sidecars self-contained");
    const stagedResources = join(root, "src-tauri", "gs-resources");
    expect(readFileSync(join(stagedResources, "extra-stuff", "only.txt"), "utf8")).toBe("x");
    for (const dropped of ["iccprofiles", "fonts"]) {
      expect(
        readdirSync(stagedResources).includes(dropped),
        `${dropped} was dropped from the declared list and must not be staged — an undeclared dir must never reappear just because a sentinel targets it`,
      ).toBe(false);
    }
    expect(readFileSync(join(stagedResources, "lib", "fso-sidecar-acceptance-lib-sentinel.ps"), "utf8")).toMatch(
      /^%!\n% Staged-only/,
    );
  });

  it("refuses a ghostscript install missing a declared resource dir", () => {
    const root = makeRoot();
    const binDir = join(root, "src-tauri", "binaries");
    mkdirSync(binDir, { recursive: true });
    const staged = stageStagedLib(root);
    qpdfFixture(join(binDir, `qpdf-${TRIPLE}`), staged.member);
    arm64Fixture(join(binDir, `gs-${TRIPLE}`), "gs");
    writeLock(root, lockDigest(staged.libDir));
    const { stubBin, brewPrefix } = makeGsFixture(root);
    rmSync(join(brewPrefix, "share", "ghostscript", "iccprofiles"), {
      recursive: true,
      force: true,
    });

    const result = runBundle(root, { stubBin });
    expect(result.out).toMatch(/ghostscript resource dir iccprofiles missing/);
    expect(result.out).not.toContain("bundled: qpdf + gs sidecars self-contained");
  });
});
describe("bundle-pdf-macos.sh rejects hollow gs resource sources", () => {
  function prepare(root) {
    const binDir = join(root, "src-tauri", "binaries");
    mkdirSync(binDir, { recursive: true });
    const staged = stageStagedLib(root);
    qpdfFixture(join(binDir, `qpdf-${TRIPLE}`), staged.member);
    arm64Fixture(join(binDir, `gs-${TRIPLE}`), "gs");
    writeLock(root, lockDigest(staged.libDir));
    return makeGsFixture(root);
  }

  function gutSourceDir(brewPrefix, dir, { sentinelJunk = false } = {}) {
    const target = join(brewPrefix, "share", "ghostscript", dir);
    rmSync(target, { recursive: true, force: true });
    mkdirSync(target, { recursive: true });
    if (sentinelJunk) {
      writeFileSync(join(target, "fso-sidecar-acceptance-fonts-sentinel.ps"), "%!\n");
      writeFileSync(join(target, "fso-sidecar-acceptance-sentinel.ps"), "%!\n");
    }
  }

  it.each(["fonts", "Resource/Font", "iccprofiles", "lib"])(
    "refuses to stage when the brew %s dir has no real files",
    (dir) => {
      const root = makeRoot();
      const { stubBin, brewPrefix } = prepare(root);
      gutSourceDir(brewPrefix, dir);

      const result = runBundle(root, { stubBin });

      expect(result.out).toMatch(
        new RegExp(`ghostscript resource dir ${dir.replace("/", "\\/")} at .* has no usable files`),
      );
      expect(result.out).toMatch(/brew reinstall ghostscript/);
      expect(result.out).not.toContain("staged: gs resources");
    },
  );

  it("refuses when a source dir holds only sentinel-shaped junk", () => {
    const root = makeRoot();
    const { stubBin, brewPrefix } = prepare(root);
    gutSourceDir(brewPrefix, "fonts", { sentinelJunk: true });

    const result = runBundle(root, { stubBin });

    expect(result.out).toMatch(/resource dir fonts .* has no usable files/);
    expect(result.out).toMatch(/brew reinstall ghostscript/);
  });

  it("stages a complete source tree, proving the gate is not vacuous", () => {
    const root = makeRoot();
    const { stubBin, brewPrefix } = prepare(root);

    const result = runBundle(root, { stubBin });

    expect(result.out).toContain("staged: gs resources");
    for (const [dir, name] of SENTINELS) {
      expect(readFileSync(join(root, "src-tauri", "gs-resources", dir, name), "utf8")).toMatch(
        /^%!\n% Staged-only/,
      );
    }
  });

  it("leaves an existing gs-resources tree intact when the source is rejected", () => {
    const root = makeRoot();
    const { stubBin, brewPrefix } = prepare(root);
    const stagedResources = join(root, "src-tauri", "gs-resources");
    const first = runBundle(root, { stubBin });
    expect(first.out).toContain("staged: gs resources");
    const before = treeFiles(stagedResources);
    expect(Object.keys(before).length).toBeGreaterThan(0);
    gutSourceDir(brewPrefix, "iccprofiles");

    const result = runBundle(root, { stubBin });

    expect(result.out).toMatch(/has no usable files/);
    expect(
      treeFiles(stagedResources),
      "a rejected source must not wipe a previously working local tree",
    ).toEqual(before);
  }, 30000);
});

describe("bundle-pdf-macos.sh staging dirs never leak", () => {
  it("removes the gs-resources staging dir after a rejected run", () => {
    const root = makeRoot();
    const binDir = join(root, "src-tauri", "binaries");
    mkdirSync(binDir, { recursive: true });
    const staged = stageStagedLib(root);
    qpdfFixture(join(binDir, `qpdf-${TRIPLE}`), staged.member);
    arm64Fixture(join(binDir, `gs-${TRIPLE}`), "gs");
    writeLock(root, lockDigest(staged.libDir));
    const { stubBin, brewPrefix } = makeGsFixture(root);
    const init = join(brewPrefix, "share", "ghostscript", "Resource", "Init");
    rmSync(join(init, "gs_init.ps"));
    writeFileSync(join(init, "other.ps"), "%!PS\n");

    const result = runBundle(root, { stubBin });

    expect(result.out).toMatch(/lacks Resource\/Init\/gs_init\.ps/);
    expect(
      readdirSync(join(root, "src-tauri")).filter((entry) =>
        entry.startsWith("gs-resources.staging"),
      ),
      "a rejected run must not leave a gs-resources staging tree behind",
    ).toEqual([]);
  }, 30000);
});

describe("bundle-pdf-macos.sh rejects hollow gs Resource subdirs", () => {
  it.each(["CMap", "Encoding", "ColorSpace"])(
    "refuses to stage when the brew Resource/%s subdir has no real files",
    (subdir) => {
      const root = makeRoot();
      const binDir = join(root, "src-tauri", "binaries");
      mkdirSync(binDir, { recursive: true });
      const staged = stageStagedLib(root);
      qpdfFixture(join(binDir, `qpdf-${TRIPLE}`), staged.member);
      arm64Fixture(join(binDir, `gs-${TRIPLE}`), "gs");
      writeLock(root, lockDigest(staged.libDir));
      const { stubBin, brewPrefix } = makeGsFixture(root);
      const target = join(brewPrefix, "share", "ghostscript", "Resource", subdir);
      rmSync(target, { recursive: true, force: true });
      mkdirSync(target, { recursive: true });

      const result = runBundle(root, { stubBin });

      expect(result.out).toMatch(
        new RegExp(`ghostscript resource subdir .*Resource/${subdir} has no usable files`),
      );
      expect(result.out).toMatch(/brew reinstall ghostscript/);
      expect(result.out).not.toContain("staged: gs resources");
    },
  );

  it("stages a complete Resource tree, proving the subdir gate is not vacuous", () => {
    const root = makeRoot();
    const binDir = join(root, "src-tauri", "binaries");
    mkdirSync(binDir, { recursive: true });
    const staged = stageStagedLib(root);
    qpdfFixture(join(binDir, `qpdf-${TRIPLE}`), staged.member);
    arm64Fixture(join(binDir, `gs-${TRIPLE}`), "gs");
    writeLock(root, lockDigest(staged.libDir));
    const { stubBin, brewPrefix } = makeGsFixture(root);
    mkdirSync(join(brewPrefix, "share", "ghostscript", "Resource", "CMap"), { recursive: true });
    writeFileSync(join(brewPrefix, "share", "ghostscript", "Resource", "CMap", "Identity-H"), "x");

    const result = runBundle(root, { stubBin });

    expect(result.out).toContain("staged: gs resources");
  });
});

describe("the staged sentinel dirs match gs-sentinels.mjs exactly", () => {
  it("stages a sentinel in every dir the shared module names, and no others", async () => {
    const shared = await import("./gs-sentinels.mjs");
    const root = makeRoot();
    const binDir = join(root, "src-tauri", "binaries");
    mkdirSync(binDir, { recursive: true });
    const staged = stageStagedLib(root);
    qpdfFixture(join(binDir, `qpdf-${TRIPLE}`), staged.member);
    arm64Fixture(join(binDir, `gs-${TRIPLE}`), "gs");
    writeLock(root, lockDigest(staged.libDir));
    const { stubBin } = makeGsFixture(root);

    const result = runBundle(root, { stubBin });

    expect(result.out).toContain("staged: gs resources");
    const base = join(root, "src-tauri", "gs-resources");
    const sentinelDirs = new Set();
    const walk = (dir, relative) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const child = join(dir, entry.name);
        const childRelative = relative ? `${relative}/${entry.name}` : entry.name;
        if (entry.isDirectory()) {
          walk(child, childRelative);
        } else if (shared.isGsSentinel(entry.name)) {
          sentinelDirs.add(relative);
        }
      }
    };
    walk(base, "");
    expect(
      [...sentinelDirs].sort(),
      "the shell derives its sentinel dirs from the manifest; they must equal the shared module's",
    ).toEqual(shared.gsSentinelPairs().map(([dir]) => dir).sort());
  });
});
