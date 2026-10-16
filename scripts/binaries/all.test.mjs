// @vitest-environment node
import { describe, expect, it, vi } from "vitest";

vi.mock("node:child_process", () => ({
  execFile: vi.fn((_tool, _args, _options, callback) => {
    callback(null, "sidecar audit: PASS\n", "");
  }),
}));
vi.mock("./fetch.mjs", () => ({ fetchTarget: vi.fn(async () => {}) }));
vi.mock("./prep.mjs", () => ({ prepTarget: vi.fn(async () => {}) }));

import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { allTarget } from "./all.mjs";

describe("all.mjs", () => {
  it("passes_the_staging_target_through_to_the_embedded_audit_via_AUDIT_TARGET", async () => {
    const root = await mkdtemp(join(tmpdir(), "all-audit-target-"));
    try {
      await allTarget("x86_64-pc-windows-msvc", root);

      expect(execFile).toHaveBeenCalledTimes(1);
      const [tool, args, options] = execFile.mock.calls[0];
      expect(tool).toBe("bash");
      expect(args[0]).toMatch(/audit-sidecars\.sh$/);
      expect(options.cwd).toBe(root);
      expect(
        options.env.AUDIT_TARGET,
        "the embedded audit must audit the staged target, not the host triple — freeze.yml windows rows have no matching host",
      ).toBe("x86_64-pc-windows-msvc");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
