// @vitest-environment node
import { describe, expect, it } from "vitest";

import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { main, resolveTagFromEnv, resolveVersion } from "./release-version-check.mjs";

async function versionFixture(packageVersion, confVersion) {
  const dir = await mkdtemp(join(tmpdir(), "rvc-"));
  const packagePath = join(dir, "package.json");
  const confPath = join(dir, "tauri.conf.json");
  return {
    dir,
    packagePath,
    confPath,
    write: async () => {
      await writeFile(packagePath, JSON.stringify({ version: packageVersion }));
      await writeFile(confPath, JSON.stringify({ $schema: "x", version: confVersion }));
    },
  };
}

describe("release-version-check resolveVersion", () => {
  it("strips v and reports non-prerelease for plain release tags", () => {
    expect(resolveVersion("v0.2.0", "0.2.0", "0.2.0")).toEqual({ version: "0.2.0", prerelease: false });
  });

  it("flags prerelease and keeps the full version when the tag carries an -rc suffix", () => {
    expect(resolveVersion("v1.2.3-rc2", "1.2.3-rc2", "1.2.3")).toEqual({ version: "1.2.3-rc2", prerelease: true });
  });

  it("keeps the full alpha version while the manifest stays numeric", () => {
    expect(resolveVersion("v0.1.0-alpha.1", "0.1.0-alpha.1", "0.1.0")).toEqual({ version: "0.1.0-alpha.1", prerelease: true });
  });

  it("accepts beta.n prerelease tags the same way", () => {
    expect(resolveVersion("v0.1.0-beta.2", "0.1.0-beta.2", "0.1.0")).toEqual({ version: "0.1.0-beta.2", prerelease: true });
  });

  it("accepts a single-identifier prerelease without a numeric component", () => {
    expect(resolveVersion("v0.1.0-alpha", "0.1.0-alpha", "0.1.0")).toEqual({ version: "0.1.0-alpha", prerelease: true });
  });

  it("rejects a tag that package.json does not carry", () => {
    expect(() => resolveVersion("v0.2.0-alpha.1", "0.1.0-alpha.1", "0.1.0")).toThrow(
      /does not match package\.json version '0\.1\.0-alpha\.1'/,
    );
  });

  it("rejects an alpha tag when tauri.conf.json drifted from the numeric core", () => {
    expect(() => resolveVersion("v0.2.0-alpha.1", "0.2.0-alpha.1", "0.1.0")).toThrow(
      /tauri\.conf\.json at '0\.2\.0'/,
    );
  });

  it("rejects an alpha tag when tauri.conf.json carries the prerelease suffix", () => {
    expect(() => resolveVersion("v0.1.0-alpha.1", "0.1.0-alpha.1", "0.1.0-alpha.1")).toThrow(
      /tauri\.conf\.json at '0\.1\.0'/,
    );
  });

  it("rejects nonsense prerelease suffixes like an empty identifier", () => {
    expect(() => resolveVersion("v0.1.0--", "0.1.0--", "0.1.0")).toThrow("not a v-prefixed semver release tag");
  });

  it("accepts uppercase prerelease identifiers case-sensitively as alnum words", () => {
    expect(resolveVersion("v0.1.0-RC", "0.1.0-RC", "0.1.0")).toEqual({ version: "0.1.0-RC", prerelease: true });
  });

  it("rejects tags without a v prefix", () => {
    expect(() => resolveVersion("0.2.0", "0.2.0", "0.2.0")).toThrow("not a v-prefixed semver release tag");
  });

  it("rejects tags whose version differs from the tauri.conf.json version", () => {
    expect(() => resolveVersion("v0.3.0", "0.3.0", "0.2.0")).toThrow(/tauri\.conf\.json at '0\.3\.0' .* found '0\.2\.0'/);
  });

  it("rejects rc-tags whose base version differs from the manifest", () => {
    expect(() => resolveVersion("v0.2.0-rc1", "0.2.0-rc1", "0.2.1")).toThrow("tauri.conf.json");
  });
});

describe("resolveTagFromEnv (workflow trigger context)", () => {
  it("uses the dispatch tag input verbatim when the event is workflow_dispatch", () => {
    expect(resolveTagFromEnv({ GITHUB_EVENT_NAME: "workflow_dispatch", DISPATCH_TAG: "v0.2.0-rc1" })).toBe("v0.2.0-rc1");
  });

  it("rejects a workflow_dispatch without an explicit tag input", () => {
    expect(() =>
      resolveTagFromEnv({ GITHUB_EVENT_NAME: "workflow_dispatch", DISPATCH_TAG: "" }),
    ).toThrow("workflow_dispatch requires the 'tag' input (e.g. v0.1.0)");
  });

  it("uses GITHUB_REF_NAME for tag pushes", () => {
    expect(resolveTagFromEnv({ GITHUB_EVENT_NAME: "push", GITHUB_REF_NAME: "v0.2.0" })).toBe("v0.2.0");
  });

  it("rejects a push whose ref is not a v-prefixed release tag", () => {
    const tag = resolveTagFromEnv({ GITHUB_EVENT_NAME: "push", GITHUB_REF_NAME: "main" });
    expect(
      () => resolveVersion(tag, "0.2.0", "0.2.0"),
      "the push trigger only fires for v* refs, but a non-tag ref (e.g. a branch named like a release) that reaches the helper must die on the same resolveVersion gate",
    ).toThrow("not a v-prefixed semver release tag");
  });

  it("rejects an unresolvable event context", () => {
    expect(() => resolveTagFromEnv({ GITHUB_EVENT_NAME: "pull_request" })).toThrow(
      "cannot resolve a release tag",
    );
  });
});

describe("release-version-check main (env export)", () => {
  it("validates the resolved tag and exports RELEASE_TAG/APP_VERSION/PRERELEASE to GITHUB_ENV", async () => {
    const fixture = await versionFixture("0.2.0-rc1", "0.2.0");
    let result;
    try {
      await fixture.write();
      const envFile = join(fixture.dir, "github-env");

      result = await main(["v0.2.0-rc1"], { packagePath: fixture.packagePath, confPath: fixture.confPath, envFile });

      expect(result).toEqual({ version: "0.2.0-rc1", prerelease: true });
      const exported = await readFile(envFile, "utf8");
      expect(exported).toContain("RELEASE_TAG=v0.2.0-rc1\n");
      expect(exported).toContain("APP_VERSION=0.2.0-rc1\n");
      expect(exported).toContain("PRERELEASE=true\n");
    } finally {
      await rm(fixture.dir, { recursive: true, force: true });
    }
  });

  it("exports PRERELEASE=false for final release tags", async () => {
    const fixture = await versionFixture("1.0.0", "1.0.0");
    try {
      await fixture.write();
      const envFile = join(fixture.dir, "github-env");

      await main(["v1.0.0"], { packagePath: fixture.packagePath, confPath: fixture.confPath, envFile });

      const exported = await readFile(envFile, "utf8");
      expect(exported).toContain("PRERELEASE=false\n");
    } finally {
      await rm(fixture.dir, { recursive: true, force: true });
    }
  });

  it("exports the full alpha version end-to-end", async () => {
    const fixture = await versionFixture("0.1.0-alpha.1", "0.1.0");
    let result;
    try {
      await fixture.write();
      const envFile = join(fixture.dir, "github-env");

      result = await main(["v0.1.0-alpha.1"], { packagePath: fixture.packagePath, confPath: fixture.confPath, envFile });

      expect(result).toEqual({ version: "0.1.0-alpha.1", prerelease: true });
      const exported = await readFile(envFile, "utf8");
      expect(exported).toContain("RELEASE_TAG=v0.1.0-alpha.1\n");
      expect(exported).toContain("APP_VERSION=0.1.0-alpha.1\n");
      expect(exported).toContain("PRERELEASE=true\n");
    } finally {
      await rm(fixture.dir, { recursive: true, force: true });
    }
  });

  it("fails and exports nothing when the tag mismatches package.json", async () => {
    const fixture = await versionFixture("0.2.0", "0.2.0");
    try {
      await fixture.write();
      const envFile = join(fixture.dir, "github-env");

      await expect(
        main(["v0.3.0"], { packagePath: fixture.packagePath, confPath: fixture.confPath, envFile }),
      ).rejects.toThrow("does not match package.json");
      await expect(readFile(envFile, "utf8")).rejects.toThrow();
    } finally {
      await rm(fixture.dir, { recursive: true, force: true });
    }
  });

  it("fails and exports nothing when tauri.conf.json drifted from the tag core", async () => {
    const fixture = await versionFixture("0.3.0", "0.2.0");
    try {
      await fixture.write();
      const envFile = join(fixture.dir, "github-env");

      await expect(
        main(["v0.3.0"], { packagePath: fixture.packagePath, confPath: fixture.confPath, envFile }),
      ).rejects.toThrow("tauri.conf.json");
      await expect(readFile(envFile, "utf8")).rejects.toThrow();
    } finally {
      await rm(fixture.dir, { recursive: true, force: true });
    }
  });

  it("resolves the tag from workflow env when no positional tag is given", async () => {
    const fixture = await versionFixture("0.2.0", "0.2.0");
    try {
      await fixture.write();
      const envFile = join(fixture.dir, "github-env");

      const result = await main([], {
        packagePath: fixture.packagePath,
        confPath: fixture.confPath,
        envFile,
        env: { GITHUB_EVENT_NAME: "push", GITHUB_REF_NAME: "v0.2.0" },
      });

      expect(result).toEqual({ version: "0.2.0", prerelease: false });
      const exported = await readFile(envFile, "utf8");
      expect(exported).toContain("RELEASE_TAG=v0.2.0\n");
    } finally {
      await rm(fixture.dir, { recursive: true, force: true });
    }
  });

  it("rejects an empty dispatch tag from workflow env even with an env file", async () => {
    const fixture = await versionFixture("0.2.0", "0.2.0");
    try {
      await fixture.write();
      const envFile = join(fixture.dir, "github-env");

      await expect(
        main([], {
          packagePath: fixture.packagePath,
          confPath: fixture.confPath,
          envFile,
          env: { GITHUB_EVENT_NAME: "workflow_dispatch", DISPATCH_TAG: "" },
        }),
      ).rejects.toThrow("workflow_dispatch requires the 'tag' input (e.g. v0.1.0)");
      await expect(readFile(envFile, "utf8")).rejects.toThrow();
    } finally {
      await rm(fixture.dir, { recursive: true, force: true });
    }
  });

  it("refuses to write GITHUB_ENV and validates only when envFile is absent", async () => {
    const fixture = await versionFixture("0.2.0", "0.2.0");
    try {
      await fixture.write();

      const result = await main([], {
        packagePath: fixture.packagePath,
        confPath: fixture.confPath,
        envFile: null,
        env: { GITHUB_EVENT_NAME: "push", GITHUB_REF_NAME: "v0.2.0" },
      });

      expect(result).toEqual({ version: "0.2.0", prerelease: false });
    } finally {
      await rm(fixture.dir, { recursive: true, force: true });
    }
  });

  it("validate-only mode still fails on a bad tag instead of passing quietly", async () => {
    const fixture = await versionFixture("0.2.0", "0.2.0");
    try {
      await fixture.write();

      await expect(
        main([], {
          packagePath: fixture.packagePath,
          confPath: fixture.confPath,
          envFile: null,
          env: { GITHUB_EVENT_NAME: "workflow_dispatch", DISPATCH_TAG: "v1.0.0" },
        }),
      ).rejects.toThrow("does not match");
    } finally {
      await rm(fixture.dir, { recursive: true, force: true });
    }
  });
});
