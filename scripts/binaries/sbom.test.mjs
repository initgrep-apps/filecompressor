// @vitest-environment node
import { vi, describe, expect, it } from "vitest";

vi.setConfig({ testTimeout: 30_000 });
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));

const LICENSES = {
  ffmpeg: "GPL-2.0-or-later",
  ffprobe: "GPL-2.0-or-later",
  gs: "AGPL-3.0",
  vips: "LGPL-3.0",
  qpdf: "Apache-2.0",
};

const LOCK = {
  generated: "2026-10-05T00:00:00.000Z",
  targets: {
    "aarch64-apple-darwin": {
      ffmpeg: {
        source: "url",
        version: "9.0.2",
        url: "https://vendor.invalid/ffmpeg.zip",
        sha256: "a".repeat(64),
        stagedSha256: "b".repeat(64),
        date: "2026-10-05T00:00:00.000Z",
      },
      ffprobe: {
        source: "url",
        version: "9.0.2",
        url: "https://vendor.invalid/ffprobe.zip",
        sha256: "c".repeat(64),
        stagedSha256: "d".repeat(64),
        date: "2026-10-05T00:00:00.000Z",
      },
      qpdf: {
        source: "url",
        version: "12.4.2",
        url: "https://vendor.invalid/qpdf.zip",
        sha256: "e".repeat(64),
        stagedSha256: "f".repeat(64),
        date: "2026-10-05T00:00:00.000Z",
      },
      vips: {
        source: "brew",
        formula: "vips",
        version: "8.18.7",
        stagedSha256: "1".repeat(64),
        date: "2026-10-05T00:00:00.000Z",
      },
      gs: {
        source: "brew",
        formula: "ghostscript",
        version: "10.08.0",
        stagedSha256: "2".repeat(64),
        date: "2026-10-05T00:00:00.000Z",
      },
    },
    "x86_64-apple-darwin": {
      ffmpeg: {
        source: "url",
        version: "9.0.2",
        url: "https://vendor.invalid/ffmpeg-intel.zip",
        sha256: "3".repeat(64),
        stagedSha256: "0".repeat(64),
        date: "2026-10-05T00:00:00.000Z",
      },
      ffprobe: {
        source: "url",
        version: "9.0.2",
        url: "https://vendor.invalid/ffprobe-intel.zip",
        sha256: "c".repeat(64),
        stagedSha256: "8".repeat(64),
        date: "2026-10-05T00:00:00.000Z",
      },
      qpdf: {
        source: "url",
        version: "12.4.2",
        url: "https://vendor.invalid/qpdf-intel.zip",
        sha256: "4".repeat(64),
        stagedSha256: "4".repeat(64),
        date: "2026-10-05T00:00:00.000Z",
      },
      vips: {
        source: "brew",
        formula: "vips",
        version: "8.18.7",
        stagedSha256: "5".repeat(64),
        date: "2026-10-05T00:00:00.000Z",
      },
      gs: {
        source: "brew",
        formula: "ghostscript",
        version: "10.08.0",
        stagedSha256: "6".repeat(64),
        date: "2026-10-05T00:00:00.000Z",
      },
    },
    "x86_64-pc-windows-msvc": {
      ffmpeg: {
        source: "url",
        version: "9.1.0",
        url: "https://vendor.invalid/ffmpeg-win.zip",
        sha256: "9".repeat(64),
        stagedSha256: "7".repeat(64),
        date: "2026-10-05T00:00:00.000Z",
      },
    },
  },
};

async function load() {
  return import("./sbom.mjs");
}

describe("licenseFor", () => {
  it("license_for_maps_all_four_engines_and_rejects_unknown", async () => {
    const { licenseFor } = await load();

    for (const [name, expected] of Object.entries(LICENSES)) {
      expect(licenseFor(name), `${name} must map to its real SPDX id`).toBe(expected);
    }

    expect(() => licenseFor("imagemagick")).toThrow(/imagemagick/);
    expect(
      () => licenseFor("imagemagick"),
      "an unknown engine must fail loudly: silently emitting UNKNOWN would ship a component \
       with no license notice, which is the one outcome a license file exists to prevent",
    ).toThrow(/license/i);
  });
});

describe("buildComponents", () => {
  it("components_dedupe_by_name_version_with_merged_targets", async () => {
    const { buildComponents } = await load();

    const components = buildComponents(LOCK);

    expect(
      components.map((component) => `${component.name}@${component.version}`).sort(),
      "ffmpeg 9.0.2 ships for two macOS triples but is one component with two targets, while \
       ffmpeg 9.1.0 for Windows is a separate component",
    ).toEqual([
      "ffmpeg@9.0.2",
      "ffmpeg@9.1.0",
      "ffprobe@9.0.2",
      "gs@10.08.0",
      "qpdf@12.4.2",
      "vips@8.18.7",
    ]);

    const ffmpeg = components.find((component) => component.name === "ffmpeg");
    expect(ffmpeg.version).toBe("9.0.2");
    expect(
      ffmpeg.targets.sort(),
      "the same component shipped for two triples must list both",
    ).toEqual(["aarch64-apple-darwin", "x86_64-apple-darwin"]);

    const winFfmpeg = components.find(
      (component) => component.name === "ffmpeg" && component.version === "9.1.0",
    );
    expect(
      winFfmpeg,
      "a different version of the same engine is a different component, not a merge",
    ).toBeDefined();
    expect(winFfmpeg.targets).toEqual(["x86_64-pc-windows-msvc"]);
  });

  it("sbom_handles_brew_rows_without_sha256", async () => {
    const { buildComponents } = await load();

    const components = buildComponents(LOCK);
    const vips = components.find((component) => component.name === "vips");

    expect(
      vips.sha256,
      "a brew row has no upstream digest, so it must be null rather than a machine-local \
       staged hash that no other machine could reproduce",
    ).toBeNull();
    expect(
      vips.source,
      "a brew component must say so, and name the formula so a reader can find the source",
    ).toMatch(/^brew/);
    expect(vips.source).toContain("vips");
    const gs = components.find((component) => component.name === "gs");
    expect(gs.sha256).toBeNull();

    const ffprobe = components.find((component) => component.name === "ffprobe");
    expect(
      ffprobe.sha256,
      "both targets ship the same ffprobe artifact, so the digest applies to the whole component",
    ).toBe("c".repeat(64));
  });

  it("every_component_links_its_license_text", async () => {
    const { buildComponents, renderMarkdown } = await load();

    const markdown = renderMarkdown(buildComponents(LOCK), LOCK);

    for (const line of markdown.split("\n").filter((line) => line.startsWith("- License text:"))) {
      expect(
        line,
        "a notice must point at the full license text; an unresolved or missing pointer is \
         not a notice",
      ).toMatch(/^- License text: https?:\/\/\S+$/);
    }
  });

  it("targets_and_artifacts_stay_in_step", async () => {
    const { buildComponents } = await load();

    for (const component of buildComponents(LOCK)) {
      expect(
        component.targets,
        "targets and the per-target artifacts must describe the same set, in the same order, \
         or a reader cannot tell which digest belongs to which build",
      ).toEqual(component.artifacts.map((artifact) => artifact.triple));
    }
  });

  it("components_never_mislabel_one_targets_digest_as_the_components", async () => {
    const { buildComponents, renderMarkdown } = await load();

    const components = buildComponents(LOCK);
    const ffmpeg = components.find((component) => component.name === "ffmpeg");

    expect(
      ffmpeg.sha256,
      "ffmpeg 9.0.2 ships a different vendor zip per target, so a single digest would be a lie: \
       reporting one target's hash as the component's hash lets a verifier 'confirm' a \
       download that was never verified",
    ).toBeNull();

    expect(
      ffmpeg.artifacts.map((artifact) => [artifact.triple, artifact.sha256]).sort(),
      "every target's digest must still be recorded",
    ).toEqual(
      [
        ["aarch64-apple-darwin", "a".repeat(64)],
        ["x86_64-apple-darwin", "3".repeat(64)],
      ].sort(),
    );
    expect(ffmpeg.source, "the differing per-target URLs must both survive the merge").toContain(
      "|",
    );

    const markdown = renderMarkdown(components, LOCK);
    expect(markdown).toContain("differs per target");
    expect(markdown).toContain("a".repeat(64));
    expect(markdown).toContain("3".repeat(64));
  });

  it("every component carries a license", async () => {
    const { buildComponents } = await load();

    for (const component of buildComponents(LOCK)) {
      expect(component.license, `${component.name} must have a license`).toBe(
        LICENSES[component.name],
      );
      expect(typeof component.version).toBe("string");
      expect(Array.isArray(component.targets)).toBe(true);
      expect(component.targets.length).toBeGreaterThan(0);
    }
  });
});

describe("renderMarkdown", () => {
  it("markdown_contains_one_heading_per_component_and_all_four_license_ids", async () => {
    const { buildComponents, renderMarkdown } = await load();

    const components = buildComponents(LOCK);
    const markdown = renderMarkdown(components, LOCK);

    const headings = markdown
      .split("\n")
      .filter((line) => line.startsWith("## "))
      .map((line) => line.slice(3).trim());
    const appSection = headings.filter((heading) => heading === "Application license");
    expect(appSection, "the notices also state the application's own license").toHaveLength(1);
    const componentHeadings = headings.filter((heading) => heading !== "Application license");
    expect(
      componentHeadings,
      "exactly one section per component, so a reader can find any engine's license",
    ).toHaveLength(components.length);
    for (const component of components) {
      const matching = componentHeadings.filter(
        (heading) => heading === `${component.name} ${component.version}`,
      );
      expect(
        matching,
        `one heading per component (${component.name}@${component.version}), and the heading \
         must carry the version so two versions of one engine are distinguishable`,
      ).toHaveLength(1);
    }

    for (const id of new Set(Object.values(LICENSES))) {
      expect(markdown, `the notice must state ${id}`).toContain(id);
    }

    const ffmpegSection = markdown.slice(markdown.indexOf("## ffmpeg 9.0.2"));
    expect(ffmpegSection).toContain("9.0.2");
    expect(ffmpegSection).toContain("https://vendor.invalid/ffmpeg.zip");
    expect(
      ffmpegSection,
      "a license notice that does not say where the full text lives is not a notice",
    ).toMatch(/license/i);

    const vipsSection = markdown.slice(markdown.indexOf("## vips 8.18.7"));
    expect(vipsSection).toContain("brew");
    expect(vipsSection).toContain("8.18.7");
  });
});

describe("lock handling", () => {
  it("sbom_fails_clearly_when_lock_missing_or_empty", async () => {
    const { generate } = await load();

    const missing = await mkdtemp(join(tmpdir(), "sbom-missing-"));
    await expect(
      generate({ root: missing, lockPath: join(missing, "binaries.lock.json") }),
      "a missing lock must not produce an empty SBOM that looks like a clean bill of materials",
    ).rejects.toThrow(/lock/i);
    await expect(
      generate({ root: missing, lockPath: join(missing, "x.json") }),
      "an explicit lock path must be named in the error, or the user cannot tell which file \
       was read",
    ).rejects.toThrow(/x\.json/);

    const empty = await mkdtemp(join(tmpdir(), "sbom-empty-"));
    await writeFile(join(empty, "binaries.lock.json"), JSON.stringify({ targets: {} }));
    await expect(
      generate({ root: empty, lockPath: join(empty, "binaries.lock.json") }),
    ).rejects.toThrow(/no components|empty/i);

    const garbage = await mkdtemp(join(tmpdir(), "sbom-garbage-"));
    await writeFile(join(garbage, "binaries.lock.json"), "{not json");
    await expect(
      generate({ root: garbage, lockPath: join(garbage, "binaries.lock.json") }),
    ).rejects.toThrow(/binaries\.lock\.json/);

    for (const dir of [missing, empty, garbage]) {
      await expect(
        readFile(join(dir, "sbom.json"), "utf8"),
        "a failed run must not leave an sbom.json behind that downstream tooling would trust",
      ).rejects.toThrow();
    }
    await rm(missing, { recursive: true, force: true });
    await rm(empty, { recursive: true, force: true });
    await rm(garbage, { recursive: true, force: true });
  });

  it("generation_is_deterministic_so_a_stale_notice_is_detectable", async () => {
    const { generate } = await load();
    const root = await mkdtemp(join(tmpdir(), "sbom-det-"));
    await mkdir(join(root, "scripts"), { recursive: true });
    await writeFile(join(root, "scripts", "binaries.lock.json"), JSON.stringify(LOCK));

    await generate({ root });
    const firstSbom = await readFile(join(root, "sbom.json"), "utf8");
    const firstNotices = await readFile(join(root, "THIRD_PARTY_LICENSES.md"), "utf8");

    await new Promise((resolve) => setTimeout(resolve, 1100));
    await generate({ root });

    expect(
      await readFile(join(root, "sbom.json"), "utf8"),
      "re-running on an unchanged lock must reproduce the SBOM byte for byte, otherwise a \
       release job can never tell whether the committed SBOM is stale",
    ).toBe(firstSbom);
    expect(await readFile(join(root, "THIRD_PARTY_LICENSES.md"), "utf8")).toBe(firstNotices);
    expect(firstSbom).toContain(LOCK.generated);
    await rm(root, { recursive: true, force: true });
  });

  it("fails_when_the_lock_carries_no_verification_timestamp", async () => {
    const { generate } = await load();
    const root = await mkdtemp(join(tmpdir(), "sbom-nogen-"));
    const { generated, ...withoutTimestamp } = LOCK;
    void generated;
    await writeFile(join(root, "binaries.lock.json"), JSON.stringify(withoutTimestamp));
    await expect(
      generate({ root, lockPath: join(root, "binaries.lock.json") }),
      "an SBOM must record when its artifacts were verified; a missing timestamp is not \
       something to paper over with the current clock",
    ).rejects.toThrow(/generated/i);
    await rm(root, { recursive: true, force: true });
  });

  it("writes both artifacts for a real lock", async () => {
    const { generate } = await load();
    const root = await mkdtemp(join(tmpdir(), "sbom-write-"));
    await mkdir(join(root, "scripts"), { recursive: true });
    await writeFile(join(root, "scripts", "binaries.lock.json"), JSON.stringify(LOCK));

    const result = await generate({ root });

    const sbom = JSON.parse(await readFile(join(root, "sbom.json"), "utf8"));
    expect(sbom.components.length).toBe(result.components.length);
    expect(typeof sbom.generated).toBe("string");
    const notices = await readFile(join(root, "THIRD_PARTY_LICENSES.md"), "utf8");
    expect(notices).toContain("AGPL-3.0");
    await rm(root, { recursive: true, force: true });
  });
});

describe("the shipped lock", () => {
  it("produces a license for every engine actually locked", async () => {
    const { buildComponents } = await load();
    const repoRoot = join(HERE, "..", "..");
    const lock = JSON.parse(
      await readFile(join(repoRoot, "scripts", "binaries.lock.json"), "utf8"),
    );

    const components = buildComponents(lock);

    expect(components.length).toBeGreaterThan(0);
    for (const component of components) {
      expect(
        component.license,
        `${component.name} is locked but has no license mapping — add it to sbom.mjs rather \
         than shipping it unnoticed`,
      ).toBeTruthy();
    }
    const names = components.map((component) => component.name).sort();
    expect(names).toContain("ffmpeg");
    expect(names).toContain("gs");
    expect(names).toContain("vips");
    expect(names).toContain("qpdf");
  });
});