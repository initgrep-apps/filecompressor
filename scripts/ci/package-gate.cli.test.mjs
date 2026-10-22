// @vitest-environment node
import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SCRIPT = join(import.meta.dirname, "package-gate.mjs");

describe("package-gate CLI process exit code", () => {
  it("exits 1 and prints FAIL when the package has no engines", () => {
    const appDir = join(mkdtempSync(join(tmpdir(), "gate-cli-")), "empty.app");
    mkdirSync(appDir, { recursive: true });
    const result = spawnSync(
      process.execPath,
      [SCRIPT, "--triple", "aarch64-apple-darwin", "--bundle-dir", appDir],
      {
        encoding: "utf8",
        env: { ...process.env, PATH: "/nonexistent" },
        timeout: 120_000,
      },
    );
    expect(result.status, result.stderr).toBe(1);
    expect(result.stdout).toContain("package gate: FAIL");
  });
});
