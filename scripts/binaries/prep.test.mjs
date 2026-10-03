// @vitest-environment node
import { describe, it, expect, afterAll, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sha256File } from "./lib.mjs";
import {
  assertFetchedEntriesUntouched,
  assertGsResourcesStaged,
  assertStagedArch,
  brewVersion,
  parseBrewVersion,
  prepTarget,
  refreshBundledStagedShas,
  stageBrewBinary,
  writeBrewLockEntries,
} from "./prep.mjs";

const cleanupRoots = [];
const originalPath = process.env.PATH;

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

function useStubBrew(dir) {
  process.env.PATH = `${dir}:${originalPath}`;
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

function stubBrewScript(prefix) {
  return `#!/bin/sh
case "$1" in
  --prefix) printf '%s\\n' '${prefix}' ;;
  list) printf '%s %s\\n' "$2" "10.08.0" ;;
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
  it("takes the version token from brew list --versions output", () => {
    expect(parseBrewVersion("ghostscript 10.08.0\n", "ghostscript")).toBe("10.08.0");
    expect(parseBrewVersion("vips 8.18.7 8.17.2", "vips")).toBe("8.18.7");
  });

  it("fails loudly on output without a version", () => {
    expect(() => parseBrewVersion("vips\n", "vips")).toThrow(
      /brew list --versions vips printed 'vips'/,
    );
    expect(() => parseBrewVersion("", "vips")).toThrow(/printed ''/);
  });
});

describe("brewVersion", () => {
  it("reads the installed version from brew", async () => {
    useStubBrew(await makeStubBrew(stubBrewScript("/opt/homebrew/opt/ghostscript")));
    await expect(brewVersion("ghostscript")).resolves.toBe("10.08.0");
  });

  it("names the install command when the formula is absent", async () => {
    useStubBrew(await makeStubBrew("#!/bin/sh\nexit 1\n"));
    await expect(brewVersion("ghostscript")).rejects.toThrow(/brew install ghostscript/);
  });

  it("names the Homebrew install when brew itself is missing", async () => {
    process.env.PATH = await makeStubBrew("#!/bin/sh\nexit 0\n");
    process.env.PATH = "/nonexistent-bin";
    await expect(brewVersion("ghostscript")).rejects.toThrow(/brew not found/);
  });
});

describe("stageBrewBinary", () => {
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

    await expect(stageBrewBinary(root, "aarch64-apple-darwin", "vips", VIPS_ENTRY)).rejects.toThrow(
      /brew formula vips has no vips at .* — run 'brew reinstall vips'/,
    );
  });
});

describe("assertStagedArch", () => {
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

describe("writeBrewLockEntries", () => {
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
    expect(entry.version).toBe("10.08.0");
    expect(entry.stagedSha256).toBe(await sha256File(staged.destPath));
    expect(Date.parse(entry.date)).not.toBeNaN();
  });

  it("warns but records truth when brew drifted from the manifest pin", async () => {
    const root = await makeRoot(WITH_BREW);
    const prefix = await makeFormulaPrefix("vips");
    useStubBrew(await makeStubBrew(stubBrewScript(prefix)));
    await stageBrewBinary(root, "aarch64-apple-darwin", "vips", VIPS_ENTRY);

    const warn = [];
    const originalWarn = console.warn;
    console.warn = (message) => warn.push(message);
    try {
      const lock = { generated: null, targets: { "aarch64-apple-darwin": {} } };
      await writeBrewLockEntries(lock, "aarch64-apple-darwin", root, [["vips", VIPS_ENTRY]]);
      expect(lock.targets["aarch64-apple-darwin"].vips.version).toBe("10.08.0");
    } finally {
      console.warn = originalWarn;
    }
    expect(warn.join("\n")).toContain("manifest pins 8.18.7");
    expect(warn.join("\n")).toContain("yarn binaries:verify");
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

  async function stageResources(root, { icc = true, fonts = true } = {}) {
    const base = join(root, "src-tauri", "gs-resources");
    await mkdir(join(base, "Resource", "Init"), { recursive: true });
    await writeFile(join(base, "Resource", "Init", "gs_init.ps"), "%!PS\n");
    await mkdir(join(base, "lib"), { recursive: true });
    await writeFile(join(base, "lib", "gs_init.ps"), "%!PS\n");
    await mkdir(join(base, "iccprofiles"), { recursive: true });
    if (icc) {
      await writeFile(join(base, "iccprofiles", "srgb.icc"), "profile");
    }
    await mkdir(join(base, "fonts"), { recursive: true });
    if (fonts) {
      await writeFile(join(base, "fonts", "Helvetica"), "font");
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

  it("fails when iccprofiles or fonts is empty", async () => {
    const root = await makeRoot(WITH_BREW);
    const base = await stageResources(root, { fonts: false });
    await expect(assertGsResourcesStaged(root, entry)).rejects.toThrow(
      /gs resources dir empty: .*\/fonts/,
    );
    const other = await makeRoot(WITH_BREW);
    await stageResources(other, { icc: false });
    await expect(assertGsResourcesStaged(other, entry)).rejects.toThrow(/gs resources dir empty/);
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

  it("points at Task 3 for a Windows target instead of pretending to succeed", async () => {
    const root = await makeRoot({
      targets: {
        ...URL_ONLY.targets,
        "x86_64-pc-windows-msvc": URL_ONLY.targets["aarch64-apple-darwin"],
      },
    });
    await expect(prepTarget("x86_64-pc-windows-msvc", root)).rejects.toThrow(
      /not implemented yet .* Task 3/s,
    );
  });

  it("names the Homebrew install when brew is absent, before touching staged files", async () => {
    const root = await makeRoot(WITH_BREW);
    process.env.PATH = "/nonexistent-bin";
    await expect(prepTarget("aarch64-apple-darwin", root)).rejects.toThrow(/brew not found/);
    await expect(readdir(join(root, "src-tauri"))).rejects.toThrow();
  });
});

async function statMode(path) {
  const { mode } = await import("node:fs/promises").then((fs) => fs.stat(path));
  return mode & 0o777;
}