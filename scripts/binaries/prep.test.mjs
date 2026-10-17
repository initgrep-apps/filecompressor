// @vitest-environment node
import { vi, afterAll, afterEach, describe, expect, it } from "vitest";

vi.setConfig({ testTimeout: 30_000 });
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm, chmod, stat } from "node:fs/promises";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildPe } from "./fixtures/pe-fixture.mjs";
import { sha256File } from "./lib.mjs";
import {
  assertAllEnginesStaged,
  assertBrewVersionsPinned,
  assertFetchedEntriesUntouched,
  assertGsResourcesStaged,
  assertStagedArch,
  brewVersion,
  GS_ACCEPTANCE_SENTINELS,
  parseBrewVersion,
  PipelinesError,
  prepTarget,
  refreshBundledStagedShas,
  stageBrewBinary,
  writeBrewLockEntries,
} from "./prep.mjs";
import { describeDarwin, itDarwin } from "../test-platform.mjs";

const cleanupRoots = [];
const originalPath = process.env.PATH;

const KERNEL32 = { dll: "KERNEL32.dll", functions: [{ name: "LoadLibraryExW" }] };
const REAL_VIPS_EXE = () =>
  buildPe({ importSpecs: [KERNEL32, { dll: "libglib-2.0-0.dll", functions: [] }] });
const REAL_LEAF_DLL = () => buildPe({ importSpecs: [KERNEL32] });
const REAL_GS_EXE = () => buildPe({ importSpecs: [KERNEL32, { dll: "libgs-10.dll", functions: [] }] });
const REAL_GS_DLL = () => buildPe({ importSpecs: [KERNEL32, { dll: "zlib1.dll", functions: [] }] });

function withPath(value, body) {
  const previous = process.env.PATH;
  process.env.PATH = value;
  const restore = () => {
    process.env.PATH = previous;
  };
  let result;
  try {
    result = body();
  } catch (error) {
    restore();
    throw error;
  }
  if (result && typeof result.then === "function") {
    return result.then(
      (value_) => {
        restore();
        return value_;
      },
      (error) => {
        restore();
        throw error;
      },
    );
  }
  restore();
  return result;
}

async function makeRoot(manifest) {
  const root = await mkdtemp(`${tmpdir()}/prep-test-`);
  cleanupRoots.push(root);
  await mkdir(`${root}/scripts`, { recursive: true });
  if (manifest !== null) {
    await writeFile(`${root}/scripts/binaries.manifest.json`, JSON.stringify(manifest));
  }
  return root;
}

async function makeStubBrew(script) {
  const dir = await mkdtemp(`${tmpdir()}/prep-stub-brew-`);
  cleanupRoots.push(dir);
  const path = join(dir, "brew");
  await writeFile(path, script, { mode: 0o755 });
  return dir;
}

async function makeEmptyBinDir() {
  const dir = await mkdtemp(`${tmpdir()}/prep-empty-bin-`);
  cleanupRoots.push(dir);
  return dir;
}

function useStubBrew(dir) {
  process.env.PATH = `${dir}:${originalPath}`;
}

async function stubBundleScripts(root, script) {
  for (const name of ["bundle-vips-macos.sh", "bundle-pdf-macos.sh"]) {
    await writeFile(join(root, "scripts", name), script, { mode: 0o755 });
  }
}

function compileFixture(arch, outPath) {
  const source = join(tmpdir(), `prep-fixture-${arch}-${process.pid}-${Math.random().toString(36).slice(2)}.c`);
  execFileSync("sh", ["-c", `cat > '${source}' <<'EOF'
int main(void) { return 0; }
EOF`]);
  execFileSync("clang", ["-arch", arch, source, "-o", outPath]);
}

async function makeFormulaPrefix(binaryName, arch = "arm64") {
  const prefix = await mkdtemp(`${tmpdir()}/prep-formula-`);
  cleanupRoots.push(prefix);
  await mkdir(join(prefix, "bin"), { recursive: true });
  compileFixture(arch, join(prefix, "bin", binaryName));
  return prefix;
}

function stubBrewScript(prefix, version = "8.18.7") {
  return `#!/bin/sh
case "$1" in
  --prefix) printf '%s\\n' '${prefix}' ;;
  list) printf '%s %s\\n' "$2" "${version}" ;;
  *) exit 1 ;;
esac
`;
}

const VIPS_ENTRY = { source: "brew", formula: "vips", dest: "vips", expectVersion: "8.18.7" };
const GS_ENTRY = {
  source: "brew",
  formula: "ghostscript",
  binary: "gs",
  dest: "gs",
  expectVersion: "10.08.0",
  resources: ["Resource", "lib", "iccprofiles", "fonts"],
};

const URL_ONLY = {
  targets: {
    "aarch64-apple-darwin": {
      ffmpeg: {
        source: "url",
        url: "https://x/ffmpeg.zip",
        sha256: "c8ed4c4e6978a03c485edbfe4e0a5dc2380f8a30bba5150531b31b094492d924",
        expectVersion: "9.0.2",
        dest: "ffmpeg",
      },
    },
  },
};

const WITH_BREW = {
  targets: {
    "aarch64-apple-darwin": {
      ...URL_ONLY.targets["aarch64-apple-darwin"],
      vips: VIPS_ENTRY,
    },
  },
};

afterEach(() => {
  process.env.PATH = originalPath;
});

afterAll(async () => {
  process.env.PATH = originalPath;
  await Promise.all(cleanupRoots.map((root) => rm(root, { recursive: true, force: true })));
});

describe("parseBrewVersion", () => {
  it("takes the ACTIVE version token from brew list --versions output", () => {
    expect(parseBrewVersion("ghostscript 10.08.0\n", "ghostscript")).toBe("10.08.0");
    expect(
      parseBrewVersion("vips 8.18.7 8.17.2", "vips"),
      "brew lists every installed keg and the linked/active one is LAST — taking field 1",
    ).toBe("8.17.2");
  });

  it("fails loudly on output without a version", () => {
    expect(() => parseBrewVersion("vips\n", "vips")).toThrow(
      /brew list --versions vips printed 'vips'/,
    );
    expect(() => parseBrewVersion("", "vips")).toThrow(/printed ''/);
  });
});

describe("brewVersion", () => {
  itDarwin("reads the installed version from brew", async () => {
    useStubBrew(await makeStubBrew(stubBrewScript("/opt/homebrew/opt/ghostscript", "10.08.0")));
    await expect(brewVersion("ghostscript")).resolves.toBe("10.08.0");
  });

  itDarwin("names the install command when the formula is absent", async () => {
    useStubBrew(await makeStubBrew("#!/bin/sh\nexit 1\n"));
    const error = await brewVersion("ghostscript").catch((thrown) => thrown);
    expect(error.message).toMatch(/brew list --versions ghostscript failed/);
    expect(error.remedy).toMatch(/brew install ghostscript/);
  });

  itDarwin("reads the installed version for a brew formula that matches its pin", async () => {
    const prefix = await makeFormulaPrefix("vips");
    useStubBrew(await makeStubBrew(stubBrewScript(prefix)));
    await expect(brewVersion("vips")).resolves.toBe("8.18.7");
  });

  itDarwin("exposes a structured remedy instead of embedding it in the message", async () => {
    useStubBrew(await makeStubBrew("#!/bin/sh\nexit 1\n"));
    await expect(brewVersion("ghostscript")).rejects.toMatchObject({
      name: "PipelinesError",
      remedy: expect.stringContaining("brew install ghostscript"),
    });
  });

  it("names the Homebrew install when brew itself is missing", async () => {
    const emptyBin = await makeEmptyBinDir();
    await withPath(emptyBin, () => brewVersion("ghostscript")).then(
      () => {
        throw new Error("expected brewVersion to reject with no brew on PATH");
      },
      (error) => {
        expect(error).toBeInstanceOf(PipelinesError);
        expect(error.message).toMatch(/brew not found/);
        expect(process.env.PATH, "withPath must restore the process PATH").toBe(originalPath);
      },
    );
  });
});

describeDarwin("assertBrewVersionsPinned", () => {
  it("passes when every formula matches its pin", async () => {
    useStubBrew(await makeStubBrew(stubBrewScript("/opt/homebrew/opt/vips", "8.18.7")));
    await expect(assertBrewVersionsPinned([["vips", VIPS_ENTRY]])).resolves.toBeUndefined();
  });

  it("names every drifted formula and pins the remedy", async () => {
    useStubBrew(await makeStubBrew(stubBrewScript("/opt/homebrew/opt/vips", "8.19.0")));
    const error = await assertBrewVersionsPinned([["vips", VIPS_ENTRY]]).catch((thrown) => thrown);
    expect(error.message).toMatch(/brew version drift/);
    expect(error.message).toMatch(/vips: brew vips is 8\.19\.0, the manifest pins 8\.18\.7/);
    expect(error.remedy).toMatch(/expectVersion/);
  });
});

describeDarwin("stageBrewBinary", () => {
  it("copies the formula binary to the triple-suffixed staged path", async () => {
    const root = await makeRoot(WITH_BREW);
    const prefix = await makeFormulaPrefix("vips");
    useStubBrew(await makeStubBrew(stubBrewScript(prefix)));

    const staged = await stageBrewBinary(root, "aarch64-apple-darwin", "vips", VIPS_ENTRY);

    expect(staged.dest).toBe("vips-aarch64-apple-darwin");
    expect(staged.destPath).toBe(join(root, "src-tauri/binaries/vips-aarch64-apple-darwin"));
    expect((await readFile(staged.destPath)).length).toBeGreaterThan(0);
    await expect(statMode(staged.destPath)).resolves.toBe(0o755);
  });

  it("uses the manifest binary name when it differs from the formula", async () => {
    const root = await makeRoot(WITH_BREW);
    const prefix = await makeFormulaPrefix("gs");
    useStubBrew(await makeStubBrew(stubBrewScript(prefix)));

    const staged = await stageBrewBinary(root, "aarch64-apple-darwin", "gs", GS_ENTRY);

    expect(staged.source).toBe(join(prefix, "bin", "gs"));
    expect(staged.dest).toBe("gs-aarch64-apple-darwin");
  });

  it("names the reinstall command when the formula has no such binary", async () => {
    const root = await makeRoot(WITH_BREW);
    const prefix = await makeFormulaPrefix("something-else");
    useStubBrew(await makeStubBrew(stubBrewScript(prefix)));

    const error = await stageBrewBinary(root, "aarch64-apple-darwin", "vips", VIPS_ENTRY).catch(
      (thrown) => thrown,
    );
    expect(error).toBeInstanceOf(PipelinesError);
    expect(error.message).toMatch(/brew formula vips has no vips at /);
    expect(error.remedy).toMatch(/brew reinstall vips/);
  });
});

describeDarwin("assertStagedArch", () => {
  it("accepts the host arch and rejects a foreign-arch formula build", async () => {
    const root = await makeRoot(WITH_BREW);
    const armPrefix = await makeFormulaPrefix("vips", "arm64");
    useStubBrew(await makeStubBrew(stubBrewScript(armPrefix)));
    const arm = await stageBrewBinary(root, "aarch64-apple-darwin", "vips", VIPS_ENTRY);
    await expect(assertStagedArch(arm, "arm64")).resolves.toEqual(["arm64"]);

    const intelPrefix = await makeFormulaPrefix("vips", "x86_64");
    useStubBrew(await makeStubBrew(stubBrewScript(intelPrefix)));
    const intel = await stageBrewBinary(root, "aarch64-apple-darwin", "vips", VIPS_ENTRY);
    await expect(assertStagedArch(intel, "arm64")).rejects.toThrow(
      /staged from brew formula vips is x86_64, expected arm64/,
    );
  });
});

describeDarwin("writeBrewLockEntries", () => {
  it("records the brew version and the staged sha for each brew engine", async () => {
    const root = await makeRoot(WITH_BREW);
    const prefix = await makeFormulaPrefix("vips");
    useStubBrew(await makeStubBrew(stubBrewScript(prefix)));
    const staged = await stageBrewBinary(root, "aarch64-apple-darwin", "vips", VIPS_ENTRY);

    const lock = { generated: null, targets: { "aarch64-apple-darwin": {} } };
    await writeBrewLockEntries(lock, "aarch64-apple-darwin", root, [["vips", VIPS_ENTRY]]);

    const entry = lock.targets["aarch64-apple-darwin"].vips;
    expect(entry.source).toBe("brew");
    expect(entry.formula).toBe("vips");
    expect(entry.version).toBe("8.18.7");
    expect(entry.stagedSha256).toBe(await sha256File(staged.destPath));
    expect(Date.parse(entry.date)).not.toBeNaN();
  });

  it("fails on brew version drift instead of recording the drifted version", async () => {
    const root = await makeRoot(WITH_BREW);
    const prefix = await makeFormulaPrefix("vips");
    useStubBrew(await makeStubBrew(stubBrewScript(prefix, "8.19.0")));
    await stageBrewBinary(root, "aarch64-apple-darwin", "vips", VIPS_ENTRY);

    const lock = { generated: null, targets: { "aarch64-apple-darwin": {} } };
    const error = await writeBrewLockEntries(lock, "aarch64-apple-darwin", root, [
      ["vips", VIPS_ENTRY],
    ]).catch((thrown) => thrown);

    expect(error).toBeInstanceOf(PipelinesError);
    expect(error.message).toMatch(/brew version drift/);
    expect(error.message).toMatch(/vips: brew vips is 8\.19\.0, the manifest pins 8\.18\.7/);
    expect(error.remedy).toMatch(/expectVersion/);
    expect(
      lock.targets["aarch64-apple-darwin"].vips,
      "a drifted version must never be written to the lock",
    ).toBeUndefined();
  });

  it("fails when the engine was never staged", async () => {
    const root = await makeRoot(WITH_BREW);
    useStubBrew(await makeStubBrew(stubBrewScript("/opt/homebrew/opt/vips")));
    const lock = { generated: null, targets: { "aarch64-apple-darwin": {} } };
    await expect(
      writeBrewLockEntries(lock, "aarch64-apple-darwin", root, [["vips", VIPS_ENTRY]]),
    ).rejects.toThrow(/vips-aarch64-apple-darwin was not staged/);
  });
});

describe("fetched vs bundled staged shas", () => {
  const qpdfEntry = {
    source: "url",
    url: "https://x/qpdf.zip",
    sha256: "a".repeat(64),
    member: "bin/qpdf",
    lib: "lib",
    dest: "qpdf",
    expectVersion: "12.4.2",
  };
  const ffmpegEntry = {
    source: "url",
    url: "https://x/ffmpeg.zip",
    sha256: "b".repeat(64),
    member: "ffmpeg",
    dest: "ffmpeg",
    expectVersion: "9.0.2",
  };

  async function stageFakeBinary(root, dest, content) {
    const path = join(root, "src-tauri", "binaries", dest);
    await mkdir(join(root, "src-tauri", "binaries"), { recursive: true });
    await writeFile(path, content);
    return path;
  }

  it("passes when every fetched binary still matches the lock", async () => {
    const root = await makeRoot(WITH_BREW);
    const path = await stageFakeBinary(root, "qpdf-aarch64-apple-darwin", "fetched-qpdf");
    const lock = {
      generated: null,
      targets: {
        "aarch64-apple-darwin": {
          qpdf: { source: "url", version: "12.4.2", stagedSha256: await sha256File(path), date: "x" },
        },
      },
    };
    await expect(
      assertFetchedEntriesUntouched(lock, "aarch64-apple-darwin", root, [["qpdf", qpdfEntry]]),
    ).resolves.toBeUndefined();
  });

  it("fails when a fetched binary was swapped after fetch", async () => {
    const root = await makeRoot(WITH_BREW);
    await stageFakeBinary(root, "qpdf-aarch64-apple-darwin", "swapped-qpdf");
    const lock = {
      generated: null,
      targets: {
        "aarch64-apple-darwin": {
          qpdf: { source: "url", version: "12.4.2", stagedSha256: "c".repeat(64), date: "x" },
        },
      },
    };
    await expect(
      assertFetchedEntriesUntouched(lock, "aarch64-apple-darwin", root, [["qpdf", qpdfEntry]]),
    ).rejects.toThrow(/it was swapped or modified outside this pipeline/);
  });

  it("refreshes only the shas the bundle scripts rewrite", async () => {
    const root = await makeRoot(WITH_BREW);
    const qpdfPath = await stageFakeBinary(root, "qpdf-aarch64-apple-darwin", "bundled-qpdf");
    const ffmpegPath = await stageFakeBinary(root, "ffmpeg-aarch64-apple-darwin", "fetched-ffmpeg");
    const lock = {
      generated: null,
      targets: {
        "aarch64-apple-darwin": {
          qpdf: { source: "url", version: "12.4.2", stagedSha256: "c".repeat(64), date: "x" },
          ffmpeg: {
            source: "url",
            version: "9.0.2",
            stagedSha256: await sha256File(ffmpegPath),
            date: "x",
          },
        },
      },
    };

    await refreshBundledStagedShas(
      lock,
      "aarch64-apple-darwin",
      root,
      [
        ["qpdf", qpdfEntry],
        ["ffmpeg", ffmpegEntry],
      ],
    );

    expect(lock.targets["aarch64-apple-darwin"].qpdf.stagedSha256).toBe(await sha256File(qpdfPath));
    expect(lock.targets["aarch64-apple-darwin"].ffmpeg.stagedSha256).toBe(
      await sha256File(ffmpegPath),
    );
  });
});

describe("assertGsResourcesStaged", () => {
  const entry = { ...GS_ENTRY };

  async function stageResources(root, { icc = true, fonts = true, sentinels = true } = {}) {
    const base = join(root, "src-tauri", "gs-resources");
    for (const dir of ["Resource/Init", "Resource/Font", "Resource/CMap", "lib", "iccprofiles", "fonts"]) {
      await mkdir(join(base, dir), { recursive: true });
    }
    await writeFile(join(base, "Resource", "Init", "gs_init.ps"), "%!PS\n");
    await writeFile(join(base, "Resource", "Font", "NimbusRoman-Regular"), "font");
    await writeFile(join(base, "Resource", "CMap", "Identity-H"), "cmap");
    await writeFile(join(base, "lib", "gs_init.ps"), "%!PS\n");
    if (icc) {
      await writeFile(join(base, "iccprofiles", "srgb.icc"), "profile");
    }
    if (fonts) {
      await writeFile(join(base, "fonts", "Helvetica"), "font");
    }
    if (sentinels) {
      for (const relative of GS_ACCEPTANCE_SENTINELS) {
        const sentinel = join(base, relative);
        await mkdir(join(sentinel, ".."), { recursive: true });
        await writeFile(sentinel, "%!\n");
      }
    }
    return base;
  }

  it("resolves nothing when the entry declares no resources", async () => {
    const root = await makeRoot(WITH_BREW);
    await expect(assertGsResourcesStaged(root, { source: "brew", formula: "vips" })).resolves.toBe(
      false,
    );
  });

  it("passes for a complete staged tree", async () => {
    const root = await makeRoot(WITH_BREW);
    await stageResources(root);
    await expect(assertGsResourcesStaged(root, entry)).resolves.toBe(true);
  });

  it("fails when the gs-resources dir is absent entirely", async () => {
    const root = await makeRoot(WITH_BREW);
    await expect(assertGsResourcesStaged(root, entry)).rejects.toThrow(
      /gs resources dir missing/,
    );
  });

  it("fails when the Resource/Init marker is absent", async () => {
    const root = await makeRoot(WITH_BREW);
    const base = await stageResources(root);
    await rm(join(base, "Resource", "Init", "gs_init.ps"));
    await expect(assertGsResourcesStaged(root, entry)).rejects.toThrow(/gs_init\.ps/);
  });

  it("fails when iccprofiles or fonts has no files anywhere under it", async () => {
    const root = await makeRoot(WITH_BREW);
    await stageResources(root, { fonts: false });
    await expect(assertGsResourcesStaged(root, entry)).rejects.toThrow(
      /has no files anywhere under it: .*[\\/]fonts/,
    );
    const other = await makeRoot(WITH_BREW);
    await stageResources(other, { icc: false });
    await expect(assertGsResourcesStaged(other, entry)).rejects.toThrow(
      /has no files anywhere under it: .*[\\/]iccprofiles/,
    );
  });

  it("fails when a resource dir holds only empty subdirectories", async () => {
    const root = await makeRoot(WITH_BREW);
    const base = await stageResources(root);
    await rm(join(base, "fonts"), { recursive: true, force: true });
    await mkdir(join(base, "fonts", "default"), { recursive: true });
    await expect(assertGsResourcesStaged(root, entry)).rejects.toThrow(
      /has no files anywhere under it: .*[\\/]fonts/,
    );
  });

  it("fails when an acceptance sentinel is missing, naming prep as the remedy", async () => {
    for (const relative of GS_ACCEPTANCE_SENTINELS) {
      const root = await makeRoot(WITH_BREW);
      const base = await stageResources(root);
      await rm(join(base, relative));
      const error = await assertGsResourcesStaged(root, GS_ENTRY, "gs").catch((thrown) => thrown);
      expect(error, relative).toBeInstanceOf(PipelinesError);
      expect(error.message).toMatch(/gs acceptance sentinel missing/);
      expect(error.message).toContain(join("gs-resources", relative));
      expect(error.remedy).toMatch(/yarn binaries:prep/);
      expect(error.remedy).toMatch(/before the acceptance sentinel existed/);
    }
  });

  it("validates a url-sourced gs entry too, not only brew rows", async () => {
    const urlGs = {
      source: "url",
      url: "https://x/gs.zip",
      sha256: "c".repeat(64),
      member: "gs.exe",
      dest: "gs",
      expectVersion: "10.08.0",
      resources: ["Resource", "lib", "iccprofiles", "fonts"],
    };
    const root = await makeRoot({
      targets: { "aarch64-apple-darwin": { gs: urlGs } },
    });
    await expect(assertGsResourcesStaged(root, urlGs, "gs")).rejects.toThrow(
      /gs resources dir missing/,
    );
    await stageResources(root);
    await expect(assertGsResourcesStaged(root, urlGs, "gs")).resolves.toBe(true);
  });
});

describe("prepTarget", () => {
  it("fails on a target that is not in the manifest", async () => {
    const root = await makeRoot(URL_ONLY);
    await expect(prepTarget("x86_64-apple-darwin", root)).rejects.toThrow(
      /target 'x86_64-apple-darwin' not in manifest \(known: aarch64-apple-darwin\)/,
    );
  });

  it("fails when the manifest is missing", async () => {
    const root = await makeRoot(null);
    await expect(prepTarget("aarch64-apple-darwin", root)).rejects.toThrow(/manifest missing/);
  });

  it("dispatches a Windows target to prep-windows.mjs instead of the macOS bundle scripts", async () => {
    const { mkdtemp, mkdir, writeFile } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const dir = await mkdtemp(join(tmpdir(), "prep-win-dispatch-"));
    const root = await makeRoot({
      targets: {
        "x86_64-pc-windows-msvc": {
          vips: {
            source: "url",
            url: "https://example.invalid/vips.zip",
            sha256: "a".repeat(64),
            member: "vips-dev-8.18/bin/vips.exe",
            dest: "vips",
            expectVersion: "8.18.7",
          },
        },
      },
    });
    const staging = join(root, "src-tauri", ".staging", "vips-x86_64-pc-windows-msvc", "vips-dev-8.18", "bin");
    await mkdir(staging, { recursive: true });
    await writeFile(join(staging, "vips.exe"), REAL_VIPS_EXE());
    await writeFile(join(staging, "libglib-2.0-0.dll"), REAL_LEAF_DLL());

    await prepTarget("x86_64-pc-windows-msvc", root);

    expect(existsSync(join(root, "src-tauri", "binaries", "engines", "vips", "vips.exe"))).toBe(true);
    expect(existsSync(join(root, "src-tauri", "binaries", "engines", "vips", "libglib-2.0-0.dll"))).toBe(true);
    expect(
      existsSync(join(root, "src-tauri", "frameworks")),
      "the macOS bundle scripts must not run for a Windows target",
    ).toBe(false);
  });

  it("refuses a windows engine whose staged DLLs leave a non-system import dangling", async () => {
    const { mkdir, mkdtemp, writeFile } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const dir = await mkdtemp(join(tmpdir(), "prep-win-dangling-"));
    const root = await makeRoot({
      targets: {
        "x86_64-pc-windows-msvc": {
          gs: {
            source: "url",
            url: "https://example.invalid/gs.pkg.tar.zst",
            sha256: "a".repeat(64),
            member: "ucrt64/bin/gswin64c.exe",
            dest: "gs",
            expectVersion: "10.08.0",
          },
        },
      },
    });
    const staging = join(root, "src-tauri", ".staging", "gs-x86_64-pc-windows-msvc", "ucrt64", "bin");
    await mkdir(staging, { recursive: true });
    await writeFile(join(staging, "gswin64c.exe"), REAL_GS_EXE());
    await writeFile(join(staging, "libgs-10.dll"), REAL_GS_DLL());

    await expect(prepTarget("x86_64-pc-windows-msvc", root)).rejects.toThrow(/zlib1\.dll/);
  });

  describe("windows prepTarget extraPackages lock gate", () => {
    const extraGsEntry = () => ({
      source: "url",
      url: "https://example.invalid/gs.pkg.tar.zst",
      sha256: "a".repeat(64),
      member: "ucrt64/bin/gswin64c.exe",
      dest: "gs",
      expectVersion: "10.08.0",
      extraPackages: [
        {
          name: "zlib",
          source: "url",
          url: "https://example.invalid/zlib.pkg.tar.zst",
          sha256: "b".repeat(64),
          member: "ucrt64/bin/zlib1.dll",
        },
      ],
    });

    async function stageWholeGsTreeWithExtras(root, { zlibBytes = null } = {}) {
      const gsStaging = join(root, "src-tauri", ".staging", "gs-x86_64-pc-windows-msvc", "ucrt64", "bin");
      await mkdir(gsStaging, { recursive: true });
      await writeFile(join(gsStaging, "gswin64c.exe"), REAL_GS_EXE());
      await writeFile(join(gsStaging, "libgs-10.dll"), REAL_GS_DLL());
      const zlibStaging = join(root, "src-tauri", ".staging", "zlib-x86_64-pc-windows-msvc", "ucrt64", "bin");
      await mkdir(zlibStaging, { recursive: true });
      await writeFile(join(zlibStaging, "zlib1.dll"), zlibBytes ?? REAL_LEAF_DLL());
    }

    async function lockFor(root, options = {}) {
      const zlibStaging = join(root, "src-tauri", ".staging", "zlib-x86_64-pc-windows-msvc", "ucrt64", "bin");
      const { sha256File } = await import("./lib.mjs");
      if (options.stagedMain) {
        const binaryDir = join(root, "src-tauri", "binaries");
        await mkdir(binaryDir, { recursive: true });
        await writeFile(join(binaryDir, "gs-x86_64-pc-windows-msvc.exe"), "staged-main");
      }
      const zlibSha = options.zlibSha ?? (await sha256File(join(zlibStaging, "zlib1.dll")));
      const gsEntry = extraGsEntry();
      const lock = {
        generated: "2026-01-01T00:00:00.000Z",
        targets: {
          "x86_64-pc-windows-msvc": {
            gs: {
              source: "url",
              version: "10.08.0",
              url: gsEntry.url,
              sha256: gsEntry.sha256,
              stagedSha256: options.stagedMain
                ? await sha256File(`${root}/src-tauri/binaries/gs-x86_64-pc-windows-msvc.exe`)
                : undefined,
              extra: [
                {
                  name: "zlib",
                  url: gsEntry.extraPackages[0].url,
                  sha256: gsEntry.extraPackages[0].sha256,
                  stagedSha256s: { "ucrt64/bin/zlib1.dll": zlibSha },
                  date: "2026-01-01T00:00:00.000Z",
                },
              ],
              date: "2026-01-01T00:00:00.000Z",
            },
          },
        },
      };
      await writeFile(`${root}/scripts/binaries.lock.json`, JSON.stringify(lock));
      return lock;
    }

    it("stages the extras beside the engine when lock rows and staged sha agree", async () => {
      const { mkdtemp, mkdir, writeFile } = await import("node:fs/promises");
      const { tmpdir } = await import("node:os");
      const dir = await mkdtemp(join(tmpdir(), "prep-win-extras-ok-"));
      const root = await makeRoot({ targets: { "x86_64-pc-windows-msvc": { gs: extraGsEntry() } } });
      await stageWholeGsTreeWithExtras(root);
      const manifest = JSON.parse(await readFile(`${root}/scripts/binaries.manifest.json`, "utf8"));
      manifest.targets["x86_64-pc-windows-msvc"].gs.extraPackages[0].member = "ucrt64/bin/zlib1.dll";
      await writeFile(`${root}/scripts/binaries.manifest.json`, JSON.stringify(manifest));
      await lockFor(root, { stagedMain: true });

      await prepTarget("x86_64-pc-windows-msvc", root);

      const engine = join(root, "src-tauri", "binaries", "engines", "gs");
      expect(existsSync(join(engine, "gs.exe"))).toBe(true);
      expect(existsSync(join(engine, "libgs-10.dll"))).toBe(true);
      expect(existsSync(join(engine, "zlib1.dll"))).toBe(true);
    });

    it("requires a lock row for every declared extra", async () => {
      const { mkdtemp, mkdir, writeFile, readFile } = await import("node:fs/promises");
      const { tmpdir } = await import("node:os");
      const dir = await mkdtemp(join(tmpdir(), "prep-win-extras-nolock-"));
      const root = await makeRoot({ targets: { "x86_64-pc-windows-msvc": { gs: extraGsEntry() } } });
      await stageWholeGsTreeWithExtras(root);
      const manifest = JSON.parse(await readFile(`${root}/scripts/binaries.manifest.json`, "utf8"));
      manifest.targets["x86_64-pc-windows-msvc"].gs.extraPackages[0].member = "ucrt64/bin/zlib1.dll";
      await writeFile(`${root}/scripts/binaries.manifest.json`, JSON.stringify(manifest));
      await writeFile(`${root}/scripts/binaries.lock.json`, JSON.stringify({ generated: null, targets: {} }));

      await expect(prepTarget("x86_64-pc-windows-msvc", root)).rejects.toThrow(
        /extraPackages: zlib has no lock row/,
      );
    });

    it("refuses a staged extra whose bytes drift from its lock digest", async () => {
      const { mkdtemp, mkdir, writeFile, readFile } = await import("node:fs/promises");
      const { createHash } = await import("node:crypto");
      const { tmpdir } = await import("node:os");
      const dir = await mkdtemp(join(tmpdir(), "prep-win-extras-drift-"));
      const root = await makeRoot({ targets: { "x86_64-pc-windows-msvc": { gs: extraGsEntry() } } });
      await stageWholeGsTreeWithExtras(root, { zlibBytes: "drifted" });
      const manifest = JSON.parse(await readFile(`${root}/scripts/binaries.manifest.json`, "utf8"));
      manifest.targets["x86_64-pc-windows-msvc"].gs.extraPackages[0].member = "ucrt64/bin/zlib1.dll";
      await writeFile(`${root}/scripts/binaries.manifest.json`, JSON.stringify(manifest));
      await lockFor(root, {
        stagedMain: true,
        zlibSha: createHash("sha256").update("real-zlib").digest("hex"),
      });

      await expect(prepTarget("x86_64-pc-windows-msvc", root)).rejects.toThrow(
        /extraPackages: zlib staged ucrt64\/bin\/zlib1\.dll sha256/,
      );
    });
  });

  it("still refuses an unknown target before doing any work", async () => {
    const root = await makeRoot({ targets: URL_ONLY.targets });
    const error = await prepTarget("mips-unknown-linux-gnu", root).catch((thrown) => thrown);
    expect(error).toBeInstanceOf(PipelinesError);
    expect(error.message).toMatch(/not in manifest/);
  });

  it("refuses to report PASS when a manifest row was never staged", async () => {
    const root = await makeRoot(WITH_BREW);
    await expect(assertAllEnginesStaged(root, "aarch64-apple-darwin", WITH_BREW.targets["aarch64-apple-darwin"]))
      .rejects.toThrow(/ffmpeg-aarch64-apple-darwin/);
    await expect(
      assertAllEnginesStaged(root, "aarch64-apple-darwin", {
        vips: VIPS_ENTRY,
      }),
    ).rejects.toThrow(/not staged and executable/);
  });

  itDarwin("accepts a fully staged and executable engine set", async () => {
    const root = await makeRoot(WITH_BREW);
    const prefix = await makeFormulaPrefix("vips");
    useStubBrew(await makeStubBrew(stubBrewScript(prefix)));
    await stageBrewBinary(root, "aarch64-apple-darwin", "vips", VIPS_ENTRY);
    await expect(
      assertAllEnginesStaged(root, "aarch64-apple-darwin", { vips: VIPS_ENTRY }),
    ).resolves.toBeUndefined();
  });

  itDarwin("rejects a staged engine that lost its executable bit", async () => {
    const root = await makeRoot(WITH_BREW);
    const prefix = await makeFormulaPrefix("vips");
    useStubBrew(await makeStubBrew(stubBrewScript(prefix)));
    const staged = await stageBrewBinary(root, "aarch64-apple-darwin", "vips", VIPS_ENTRY);
    await chmod(staged.destPath, 0o644);

    const error = await assertAllEnginesStaged(root, "aarch64-apple-darwin", { vips: VIPS_ENTRY })
      .then(() => null)
      .catch((thrown) => thrown);
    expect(error, "a 0644 engine must be refused").toBeInstanceOf(PipelinesError);
    expect(error.message).toMatch(/vips-aarch64-apple-darwin \(not executable\)/);

    await chmod(staged.destPath, 0o000);
    await expect(
      assertAllEnginesStaged(root, "aarch64-apple-darwin", { vips: VIPS_ENTRY }),
    ).rejects.toThrow(/not executable/);

    await chmod(staged.destPath, 0o755);
    await expect(
      assertAllEnginesStaged(root, "aarch64-apple-darwin", { vips: VIPS_ENTRY }),
    ).resolves.toBeUndefined();
  });

  itDarwin("accepts any mode with at least one execute bit", async () => {
    const root = await makeRoot(WITH_BREW);
    const prefix = await makeFormulaPrefix("vips");
    useStubBrew(await makeStubBrew(stubBrewScript(prefix)));
    const staged = await stageBrewBinary(root, "aarch64-apple-darwin", "vips", VIPS_ENTRY);
    for (const mode of [0o744, 0o711, 0o111]) {
      await chmod(staged.destPath, mode);
      await expect(
        assertAllEnginesStaged(root, "aarch64-apple-darwin", { vips: VIPS_ENTRY }),
        `mode ${mode.toString(8)} is executable`,
      ).resolves.toBeUndefined();
    }
  });

  it("names the Homebrew install when brew is absent, before touching staged files", async () => {
    const root = await makeRoot(WITH_BREW);
    const emptyBin = await makeEmptyBinDir();
    await withPath(emptyBin, () => prepTarget("aarch64-apple-darwin", root)).then(
      () => {
        throw new Error("expected prepTarget to reject with no brew on PATH");
      },
      (error) => {
        expect(error.message).toMatch(/brew not found/);
      },
    );
    await expect(readdir(join(root, "src-tauri"))).rejects.toThrow();
    expect(process.env.PATH, "withPath must restore the process PATH").toBe(originalPath);
  });

  itDarwin("leaves the staged tree untouched when brew has drifted", async () => {
    const root = await makeRoot(WITH_BREW);
    const prefix = await makeFormulaPrefix("vips");
    useStubBrew(await makeStubBrew(stubBrewScript(prefix, "8.19.0")));
    await mkdir(join(root, "src-tauri", "binaries"), { recursive: true });
    const destPath = join(root, "src-tauri", "binaries", "vips-aarch64-apple-darwin");
    await writeFile(destPath, "previously staged bytes");
    const before = await sha256File(destPath);

    const error = await prepTarget("aarch64-apple-darwin", root).catch((thrown) => thrown);

    expect(error).toBeInstanceOf(PipelinesError);
    expect(error.message).toMatch(/brew version drift/);
    expect(await sha256File(destPath)).toBe(
      before,
      "the drift gate must run before stageBrewBinary, so an aborted prep leaves no drifted, unpinned binary behind",
    );
    expect(await readFile(destPath, "utf8")).toBe("previously staged bytes");
  });

  itDarwin("reports the drift without creating binaries/ at all", async () => {
    const root = await makeRoot(WITH_BREW);
    const prefix = await makeFormulaPrefix("vips");
    useStubBrew(await makeStubBrew(stubBrewScript(prefix, "8.19.0")));

    const error = await prepTarget("aarch64-apple-darwin", root).catch((thrown) => thrown);

    expect(error).toBeInstanceOf(PipelinesError);
    await expect(readdir(join(root, "src-tauri"))).rejects.toThrow();
  });

  it("removes the restore marker after a windows prep re-stages the engines", async () => {
    const { mkdtemp, mkdir, writeFile } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const dir = await mkdtemp(join(tmpdir(), "prep-win-marker-"));
    const root = await makeRoot({
      targets: {
        "x86_64-pc-windows-msvc": {
          vips: {
            source: "url",
            url: "https://example.invalid/vips.zip",
            sha256: "a".repeat(64),
            member: "vips-dev-8.18/bin/vips.exe",
            dest: "vips",
            expectVersion: "8.18.7",
          },
        },
      },
    });
    const staging = join(root, "src-tauri", ".staging", "vips-x86_64-pc-windows-msvc", "vips-dev-8.18", "bin");
    await mkdir(staging, { recursive: true });
    await writeFile(join(staging, "vips.exe"), REAL_VIPS_EXE());
    await writeFile(join(staging, "libglib-2.0-0.dll"), REAL_LEAF_DLL());
    const marker = join(root, "src-tauri", ".sidecars-restored.json");
    await writeFile(
      marker,
      JSON.stringify({
        triple: "x86_64-pc-windows-msvc",
        bundleSha256: "a".repeat(64),
        restoredAt: "2026-01-01T00:00:00Z",
      }),
    );

    const logs = [];
    const logSpy = vi.spyOn(console, "log").mockImplementation((line) => logs.push(String(line)));
    await prepTarget("x86_64-pc-windows-msvc", root);
    logSpy.mockRestore();

    expect(
      logs.some((line) =>
        /removed stale restore marker — staged binaries override restore provenance for x86_64-pc-windows-msvc/.test(
          line,
        ),
      ),
    ).toBe(true);
    expect(existsSync(marker)).toBe(false);
  });

  itDarwin("removes the restore marker after a macOS prep re-stages the brew engines", async () => {
    const root = await makeRoot(WITH_BREW);
    const prefix = await makeFormulaPrefix("vips");
    const stubDir = await makeStubBrew(stubBrewScript(prefix));
    await mkdir(join(root, "src-tauri", "binaries"), { recursive: true });
    await writeFile(join(root, "src-tauri", "binaries", "ffmpeg-aarch64-apple-darwin"), "fake", {
      mode: 0o755,
    });
    await stubBundleScripts(root, "#!/bin/sh\nexit 0\n");
    const marker = join(root, "src-tauri", ".sidecars-restored.json");
    await writeFile(
      marker,
      JSON.stringify({
        triple: "aarch64-apple-darwin",
        bundleSha256: "a".repeat(64),
        restoredAt: "2026-01-01T00:00:00Z",
      }),
    );

    const logs = [];
    const logSpy = vi.spyOn(console, "log").mockImplementation((line) => logs.push(String(line)));
    await withPath(`${stubDir}:${originalPath}`, () => prepTarget("aarch64-apple-darwin", root));
    logSpy.mockRestore();

    expect(
      logs.some((line) =>
        /removed stale restore marker — staged binaries override restore provenance for aarch64-apple-darwin/.test(
          line,
        ),
      ),
    ).toBe(true);
    expect(existsSync(marker)).toBe(false);

    const lock = JSON.parse(await readFile(join(root, "scripts", "binaries.lock.json"), "utf8"));
    expect(lock.targets["aarch64-apple-darwin"].vips.stagedSha256).toBe(
      await sha256File(join(root, "src-tauri", "binaries", "vips-aarch64-apple-darwin")),
    );
  });
});

describe("prepTarget guard wiring", () => {
  const URL_GS = {
    source: "url",
    url: "https://x/gs.zip",
    sha256: "c".repeat(64),
    member: "bin/gs",
    dest: "gs",
    expectVersion: "10.08.0",
    resources: ["Resource", "lib", "iccprofiles", "fonts"],
  };

  it("aborts when a url-sourced entry declares resources that were never staged", async () => {
    const root = await makeRoot({ targets: { "aarch64-apple-darwin": { gs: URL_GS } } });
    await stubBundleScripts(root, "#!/bin/sh\nexit 0\n");

    const error = await prepTarget("aarch64-apple-darwin", root).catch((thrown) => thrown);
    expect(error).toBeInstanceOf(PipelinesError);
    expect(error.message).toMatch(/^gs: gs resources dir missing/);
  });

  itDarwin("aborts when the bundle step leaves a staged engine non-executable", async () => {
    const root = await makeRoot(WITH_BREW);
    const prefix = await makeFormulaPrefix("vips");
    useStubBrew(await makeStubBrew(stubBrewScript(prefix)));
    await mkdir(join(root, "src-tauri", "binaries"), { recursive: true });
    await writeFile(join(root, "src-tauri", "binaries", "ffmpeg-aarch64-apple-darwin"), "fake", {
      mode: 0o755,
    });
    await stubBundleScripts(
      root,
      `#!/bin/sh
chmod 644 "$PWD/src-tauri/binaries/vips-aarch64-apple-darwin"
exit 0
`,
    );

    const error = await prepTarget("aarch64-apple-darwin", root).catch((thrown) => thrown);
    expect(error).toBeInstanceOf(PipelinesError);
    expect(error.message).toMatch(/vips-aarch64-apple-darwin \(not executable\)/);
    expect((await stat(join(root, "src-tauri", "binaries", "vips-aarch64-apple-darwin"))).mode & 0o111).toBe(0);
  });

  it("aborts on a tampered staged lib before any bundle script wipes frameworks", async () => {
    const qpdfEntry = {
      source: "url",
      url: "https://x/qpdf.zip",
      sha256: "a".repeat(64),
      member: "bin/qpdf",
      lib: "lib",
      dest: "qpdf",
      expectVersion: "12.4.2",
    };
    const root = await makeRoot({
      targets: { "aarch64-apple-darwin": { qpdf: qpdfEntry } },
    });
    const libDir = join(
      root,
      "src-tauri",
      ".staging",
      "qpdf-aarch64-apple-darwin",
      "lib",
    );
    await mkdir(libDir, { recursive: true });
    await writeFile(join(libDir, "libqpdf.30.dylib"), "official");
    await writeFile(
      join(root, "scripts", "binaries.lock.json"),
      JSON.stringify({
        generated: "2026-01-01T00:00:00.000Z",
        targets: {
          "aarch64-apple-darwin": {
            qpdf: {
              source: "url",
              version: "12.4.2",
              url: qpdfEntry.url,
              sha256: qpdfEntry.sha256,
              libStagedSha256: { "libqpdf.30.dylib": await sha256File(join(libDir, "libqpdf.30.dylib")) },
              date: "2026-01-01T00:00:00.000Z",
            },
          },
        },
      }),
    );
    await writeFile(join(libDir, "libqpdf.30.dylib"), "tampered");
    const marker = join(root, "bundle-ran");
    await stubBundleScripts(root, `#!/bin/sh\ntouch "${marker}"\nexit 0\n`);

    const error = await prepTarget("aarch64-apple-darwin", root).catch((thrown) => thrown);
    expect(error).toBeInstanceOf(PipelinesError);
    expect(error.message).toMatch(/staged lib libqpdf\.30\.dylib sha256 mismatch/);
    expect(error.remedy).toMatch(/yarn binaries:fetch/);
    await expect(stat(marker)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("aborts when the lock predates libStagedSha256, before any bundle script runs", async () => {
    const qpdfEntry = {
      source: "url",
      url: "https://x/qpdf.zip",
      sha256: "a".repeat(64),
      member: "bin/qpdf",
      lib: "lib",
      dest: "qpdf",
      expectVersion: "12.4.2",
    };
    const root = await makeRoot({
      targets: { "aarch64-apple-darwin": { qpdf: qpdfEntry } },
    });
    const marker = join(root, "bundle-ran");
    await stubBundleScripts(root, `#!/bin/sh\ntouch "${marker}"\nexit 0\n`);

    const error = await prepTarget("aarch64-apple-darwin", root).catch((thrown) => thrown);
    expect(error).toBeInstanceOf(PipelinesError);
    expect(error.message).toMatch(/records no libStagedSha256/);
    expect(error.remedy).toMatch(/yarn binaries:fetch/);
    await expect(stat(marker)).rejects.toMatchObject({ code: "ENOENT" });
  });

  itDarwin("reports brew drift before any bundle script mutates frameworks", async () => {
    const root = await makeRoot(WITH_BREW);
    const prefix = await makeFormulaPrefix("vips");
    useStubBrew(await makeStubBrew(stubBrewScript(prefix, "8.19.0")));
    const marker = join(root, "bundle-ran");
    await stubBundleScripts(root, `#!/bin/sh\ntouch "${marker}"\nexit 0\n`);

    const error = await prepTarget("aarch64-apple-darwin", root).catch((thrown) => thrown);
    expect(error).toBeInstanceOf(PipelinesError);
    expect(error.message).toMatch(/brew version drift/);
    await expect(stat(marker)).rejects.toMatchObject({ code: "ENOENT" });
  });
});

async function statMode(path) {
  const { mode } = await import("node:fs/promises").then((fs) => fs.stat(path));
  return mode & 0o777;
}
describe("gs Resource subdir content gate", () => {
  const entry = { source: "brew", formula: "ghostscript", binary: "gs", dest: "gs", resources: ["Resource", "lib", "iccprofiles", "fonts"] };

  async function rootWithRealTree() {
    const root = await makeRoot({ targets: { "aarch64-apple-darwin": { gs: entry } } });
    const base = join(root, "src-tauri", "gs-resources");
    for (const dir of ["Resource/Init", "Resource/Font", "Resource/CMap", "lib", "iccprofiles", "fonts"]) {
      await mkdir(join(base, dir), { recursive: true });
    }
    await writeFile(join(base, "Resource", "Init", "gs_init.ps"), "%!PS\n");
    await writeFile(join(base, "Resource", "Font", "NimbusRoman-Regular"), "font");
    await writeFile(join(base, "Resource", "CMap", "Identity-H"), "cmap");
    await writeFile(join(base, "lib", "gs_init.ps"), "%!PS\n");
    await writeFile(join(base, "iccprofiles", "srgb.icc"), "profile");
    await writeFile(join(base, "fonts", "Helvetica"), "font");
    for (const relative of GS_ACCEPTANCE_SENTINELS) {
      const sentinel = join(base, relative);
      await mkdir(join(sentinel, ".."), { recursive: true });
      await writeFile(sentinel, "%!\n");
    }
    return { root, base };
  }

  it.each(["CMap", "Encoding", "ColorSpace", "CIDFont"])(
    "fails when Resource/%s is gutted",
    async (subdir) => {
      const { root, base } = await rootWithRealTree();
      rmSync(join(base, "Resource", subdir), { recursive: true, force: true });
      await mkdir(join(base, "Resource", subdir), { recursive: true });

      await expect(assertGsResourcesStaged(root, entry, "gs")).rejects.toThrow(
        new RegExp(`Resource subdirs hold no files: .*Resource[/\\\\]${subdir}`),
      );
    },
  );

  it("fails when a Resource subdir holds only a sentinel", async () => {
    const { root, base } = await rootWithRealTree();
    rmSync(join(base, "Resource", "CMap"), { recursive: true, force: true });
    await mkdir(join(base, "Resource", "CMap"), { recursive: true });
    await writeFile(join(base, "Resource", "CMap", "fso-sidecar-acceptance-cmap-sentinel.ps"), "%!\n");

    await expect(assertGsResourcesStaged(root, entry, "gs")).rejects.toThrow(
      /Resource subdirs hold no files/,
    );
  });

  it("passes for a complete tree", async () => {
    const { root } = await rootWithRealTree();
    await expect(assertGsResourcesStaged(root, entry, "gs")).resolves.toBe(true);
  });
});

describe("gs sentinel set agreement", () => {
  it("prep and verify derive the identical sentinel list from gs-sentinels.mjs", async () => {
    const prep = await import("./prep.mjs");
    const verify = await import("./verify.mjs");
    const shared = await import("./gs-sentinels.mjs");
    expect(prep.GS_ACCEPTANCE_SENTINELS).toEqual(verify.GS_ACCEPTANCE_SENTINELS);
    expect(prep.GS_ACCEPTANCE_SENTINELS).toEqual(
      shared.gsSentinelPaths().map((relative) => join(...relative.split("/"))),
    );
    expect(shared.gsSentinelPaths()).toHaveLength(4);
  });

  it("the shell derives every sentinel name from the shared module's rule", async () => {
    const shared = await import("./gs-sentinels.mjs");
    const scripts = join(dirname(dirname(fileURLToPath(import.meta.url))));
    const bundle = readFileSync(join(scripts, "bundle-pdf-macos.sh"), "utf8");
    const audit = readFileSync(join(scripts, "audit-sidecars.sh"), "utf8");
    for (const shell of [bundle, audit]) {
      expect(shell).toContain('GS_DIR_SENTINEL_PREFIX="fso-sidecar-acceptance-"');
      expect(shell).toContain("tr '/' '-' | tr 'A-Z' 'a-z'");
      expect(shell).not.toContain("fso-sidecar-acceptance-fonts-sentinel.ps");
      expect(shell).not.toContain("fso-sidecar-acceptance-lib-sentinel.ps");
      expect(shell).not.toContain("fso-sidecar-acceptance-resource-font-sentinel.ps");
    }
    expect(shared.gsSentinelPaths()).toEqual([
      "Resource/Init/fso-sidecar-acceptance-sentinel.ps",
      "lib/fso-sidecar-acceptance-lib-sentinel.ps",
      "Resource/Font/fso-sidecar-acceptance-resource-font-sentinel.ps",
      "fonts/fso-sidecar-acceptance-fonts-sentinel.ps",
    ]);
  });
});
