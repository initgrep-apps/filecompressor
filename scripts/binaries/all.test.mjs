// @vitest-environment node
import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("node:child_process", () => ({
  execFile: vi.fn(),
}));
vi.mock("./fetch.mjs", () => ({ fetchTarget: vi.fn(async () => {}) }));
vi.mock("./prep.mjs", () => ({ prepTarget: vi.fn(async () => {}) }));

import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { allTarget } from "./all.mjs";
import { fetchTarget } from "./fetch.mjs";
import { prepTarget } from "./prep.mjs";

const PASSING_AUDIT = (_tool, _args, _options, callback) => callback(null, "sidecar audit: PASS\n", "");

describe("all.mjs", () => {
  beforeEach(() => {
    execFile.mockReset();
    execFile.mockImplementation(PASSING_AUDIT);
  });

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

  it("overrides_a_stale_inherited_AUDIT_TARGET_so_the_staged_target_is_always_audited", async () => {
    const root = await mkdtemp(join(tmpdir(), "all-audit-override-"));
    const inherited = { ...process.env };
    process.env.AUDIT_TARGET = "aarch64-apple-darwin";
    try {
      await allTarget("x86_64-pc-windows-msvc", root);

      const [, , options] = execFile.mock.calls[0];
      expect(
        options.env.AUDIT_TARGET,
        "a stale AUDIT_TARGET inherited from the environment must not steer the embedded audit — the requested target wins",
      ).toBe("x86_64-pc-windows-msvc");
    } finally {
      Object.assign(process.env, inherited);
      delete process.env.AUDIT_TARGET;
      await rm(root, { recursive: true, force: true });
    }
  });

  it("runs_fetch_prep_then_the_audit_on_the_same_target_and_root", async () => {
    const root = await mkdtemp(join(tmpdir(), "all-pipeline-order-"));
    try {
      await allTarget("aarch64-pc-windows-msvc", root);

      expect(fetchTarget).toHaveBeenCalledWith("aarch64-pc-windows-msvc", root);
      expect(prepTarget).toHaveBeenCalledWith("aarch64-pc-windows-msvc", root);
      const fetchOrder = fetchTarget.mock.invocationCallOrder[fetchTarget.mock.calls.length - 1];
      const prepOrder = prepTarget.mock.invocationCallOrder[prepTarget.mock.calls.length - 1];
      const auditOrder = execFile.mock.invocationCallOrder[execFile.mock.calls.length - 1];
      expect(
        fetchOrder,
        "fetch must stage bytes before prep consumes them",
      ).toBeLessThan(prepOrder);
      expect(
        prepOrder,
        "prep must finish before the embedded audit validates the tree",
      ).toBeLessThan(auditOrder);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects_when_the_audit_process_fails_and_names_the_underlying_error", async () => {
    const root = await mkdtemp(join(tmpdir(), "all-audit-error-"));
    execFile.mockImplementationOnce((_tool, _args, _options, callback) => {
      const error = new Error("spawn bash ENOENT");
      error.code = "ENOENT";
      callback(error, "", "");
    });
    try {
      await expect(
        allTarget("x86_64-pc-windows-msvc", root),
        "a spawn failure such as ENOENT must reject diagnosably instead of resolving",
      ).rejects.toThrow(
        "audit failed (spawn bash ENOENT) — fix the findings above, then re-run 'yarn binaries:all'",
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects_when_the_audit_process_exits_nonzero_and_names_the_underlying_error", async () => {
    const root = await mkdtemp(join(tmpdir(), "all-audit-exit-"));
    execFile.mockImplementationOnce((_tool, _args, _options, callback) => {
      const error = new Error("Command failed: bash scripts/audit-sidecars.sh\nsidecar audit: FAIL\n");
      error.code = 1;
      error.stderr = "sidecar audit: FAIL — schema drift\n";
      error.stdout = "";
      callback(error, "", "sidecar audit: FAIL — schema drift\n");
    });
    try {
      await expect(
        allTarget("x86_64-pc-windows-msvc", root),
        "an audit finding (exit 1) must reject too — the underlying failure text must survive inside the rejection message",
      ).rejects.toThrow(/audit failed \(Command failed: bash scripts\/audit-sidecars\.sh/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
