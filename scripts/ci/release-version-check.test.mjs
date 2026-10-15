// @vitest-environment node
import { describe, expect, it } from "vitest";

import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { main, resolveVersion } from "./release-version-check.mjs";

function confFile(version) {
  const dir = join(tmpdir(), `rvc-${process.pid}-${Math.random().toString(16).slice(2)}`);
  return { dir, path: join(dir, "tauri.conf.json"), version: JSON.stringify({ $schema: "x", version }) };
}

describe("release-version-check resolveVersion", () => {
  it("strips v and reports non-prerelease for plain release tags", () => {
    expect(resolveVersion("v0.2.0", "0.2.0")).toEqual({ version: "0.2.0", prerelease: false });
  });

  it("flags prerelease when the tag carries an -rc suffix", () => {
    expect(resolveVersion("v1.2.3-rc2", "1.2.3")).toEqual({ version: "1.2.3", prerelease: true });
  });

  it("rejects tags without a v prefix", () => {
    expect(() => resolveVersion("0.2.0", "0.2.0")).toThrow("not a v-prefixed semver release tag");
  });

  it("rejects tags whose version differs from the tauri.conf.json version", () => {
    expect(() => resolveVersion("v0.3.0", "0.2.0")).toThrow(/does not match .* version '0\.2\.0'/);
  });

  it("rejects rc-tags whose base version differs from the manifest", () => {
    expect(() => resolveVersion("v0.2.0-rc1", "0.2.1")).toThrow("does not match");
  });
});

describe("release-version-check main (env export)", () => {
  it("validates the resolved tag and exports RELEASE_TAG/APP_VERSION/PRERELEASE to GITHUB_ENV", async () => {
    const conf = confFile("0.2.0");
    await mkdirMaybe(conf.dir);
    await writeFile(conf.path, conf.version);
    const envFile = join(conf.dir, "github-env");

    const result = await main(["v0.2.0-rc1"], { confPath: conf.path, envFile });

    expect(result).toEqual({ version: "0.2.0", prerelease: true });
    const exported = await readFile(envFile, "utf8");
    expect(exported).toContain("RELEASE_TAG=v0.2.0-rc1\n");
    expect(exported).toContain("APP_VERSION=0.2.0\n");
    expect(exported).toContain("PRERELEASE=true\n");
  });

  it("exports PRERELEASE=false for final release tags", async () => {
    const conf = confFile("1.0.0");
    await mkdirMaybe(conf.dir);
    await writeFile(conf.path, conf.version);
    const envFile = join(conf.dir, "github-env");

    await main(["v1.0.0"], { confPath: conf.path, envFile });

    const exported = await readFile(envFile, "utf8");
    expect(exported).toContain("PRERELEASE=false\n");
  });

  it("fails and exports nothing when the tag mismatches the manifest", async () => {
    const conf = confFile("0.2.0");
    await mkdirMaybe(conf.dir);
    await writeFile(conf.path, conf.version);
    const envFile = join(conf.dir, "github-env");

    await expect(main(["v0.3.0"], { confPath: conf.path, envFile })).rejects.toThrow("does not match");
    await expect(readFile(envFile, "utf8")).rejects.toThrow();
    await rm(conf.dir, { recursive: true, force: true });
  });
});

async function mkdirMaybe(path) {
  const { mkdir } = await import("node:fs/promises");
  await mkdir(path, { recursive: true });
}
