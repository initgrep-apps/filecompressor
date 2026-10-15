// @vitest-environment node
import { describe, expect, it } from "vitest";

import { existsSync, readdirSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";

const HERE = dirname(fileURLToPath(import.meta.url));
const WORKFLOWS_DIR = join(HERE, "..", "..", ".github", "workflows");

const EXPECTED_WORKFLOWS = [
  { file: "freeze.yml", status: "current" },
  { file: "release.yml", status: "planned" },
  { file: "ci.yml", status: "planned" },
];

const VALID_TRIGGERS = new Set([
  "workflow_dispatch",
  "push",
  "pull_request",
  "pull_request_target",
  "schedule",
  "release",
  "workflow_call",
]);

const ARM_ROW = { triple: "aarch64-apple-darwin", os: "macos-15" };
const X64_ROW = { triple: "x86_64-apple-darwin", os: "macos-15-intel" };

function isWorkflowFile(file) {
  return file.endsWith(".yml") || file.endsWith(".yaml");
}

function state() {
  const existing = existsSync(WORKFLOWS_DIR) ? readdirSync(WORKFLOWS_DIR) : [];
  const files = existing.filter(isWorkflowFile);
  return { existing, files };
}

async function loadWorkflow(file) {
  const text = await readFile(join(WORKFLOWS_DIR, file), "utf8");
  const doc = parse(text);
  return { text, doc };
}

function jobsOf(doc) {
  if (!doc || typeof doc !== "object") return {};
  return doc.jobs ?? {};
}

function stepsOf(job) {
  return Array.isArray(job?.steps) ? job.steps : [];
}

function stepUses(step) {
  return typeof step?.uses === "string" ? step.uses : "";
}

function stepRuns(step) {
  return typeof step?.run === "string" ? step.run : "";
}

function runIndexesByText(job, needle) {
  return stepsOf(job)
    .map((step, i) => (stepRuns(step).includes(needle) ? i : -1))
    .filter((i) => i >= 0);
}

describe("workflows validation (all files)", () => {
  it("every .github/workflows/*.{yml,yaml} parses and declares valid on: triggers", async () => {
    const { files } = state();
    expect(files.length, "at least one workflow file exists").toBeGreaterThan(0);
    for (const file of files) {
      const { doc } = await loadWorkflow(file);
      expect(doc, `${file} must parse to an object`).toBeTypeOf("object");
      expect("on" in doc, `${file} must declare an on: trigger section`).toBe(true);
      const triggers = !doc.on || typeof doc.on !== "object" ? {} : doc.on;
      for (const key of Object.keys(triggers)) {
        expect(VALID_TRIGGERS.has(key), `${file}: unknown trigger '${key}'`).toBe(true);
      }
    }
  });

  it("no workflow file anywhere contains a -latest runner label (Review Focus #5)", async () => {
    const { files } = state();
    for (const file of files) {
      const { text } = await loadWorkflow(file);
      expect(text.includes("-latest"), `${file}: found a -latest label`).toBe(false);
    }
  });

  it("every third-party action is pinned to a full commit SHA", async () => {
    const { files } = state();
    for (const file of files) {
      const { doc } = await loadWorkflow(file);
      for (const [jobName, job] of Object.entries(jobsOf(doc))) {
        for (const step of stepsOf(job)) {
          const uses = stepUses(step);
          if (!uses) continue;
          expect(
            /^[\w.-]+\/[\w.-]+@[0-9a-f]{40}$/.test(uses),
            `${file} job ${jobName}: '${uses}' must pin owner/repo@<full 40-char SHA>`,
          ).toBe(true);
        }
      }
    }
  });

  it("self-check: every workflow file is listed and every current EXPECTED_WORKFLOWS entry exists on disk", () => {
    const { files } = state();
    const known = new Set(EXPECTED_WORKFLOWS.map((wf) => wf.file));
    for (const file of files) {
      expect(known.has(file), `${file} not listed in EXPECTED_WORKFLOWS`).toBe(true);
    }
    for (const wf of EXPECTED_WORKFLOWS) {
      if (wf.status !== "current") continue;
      expect(files.includes(wf.file), `${wf.file} marked current but missing from .github/workflows`).toBe(true);
    }
    expect(EXPECTED_WORKFLOWS.find((wf) => wf.file === "freeze.yml")?.status).toBe("current");
  });
});

describe("freeze.yml freeze workflow", () => {
  const FILENAME = "freeze.yml";

  it("has workflow_dispatch as its only trigger", async () => {
    expect(existsSync(join(WORKFLOWS_DIR, FILENAME)), `${FILENAME} must exist`).toBe(true);
    const { doc } = await loadWorkflow(FILENAME);
    expect(Object.keys(doc.on ?? {})).toEqual(["workflow_dispatch"]);
  });

  it("scopes permissions: read default, freeze reads, finalize writes", async () => {
    const { doc } = await loadWorkflow(FILENAME);
    expect(doc.permissions).toEqual({ contents: "read" });
    expect(jobsOf(doc).freeze.permissions).toEqual({ contents: "read" });
    expect(jobsOf(doc).finalize.permissions).toEqual({ contents: "write" });
  });

  it("freeze job matrix includes exactly the two mac rows", async () => {
    const { doc } = await loadWorkflow(FILENAME);
    const freeze = jobsOf(doc).freeze;
    expect(freeze).toBeDefined();
    expect(freeze.strategy.matrix.include).toEqual([ARM_ROW, X64_ROW]);
  });

  it("freeze job steps follow the acceptance-criteria order", async () => {
    const { doc } = await loadWorkflow(FILENAME);
    const freeze = jobsOf(doc).freeze;
    const uses = stepsOf(freeze).map(stepUses);

    const checkoutIdx = uses.findIndex((u) => u.startsWith("actions/checkout@"));
    const setupNodeIdx = uses.findIndex((u) => u.startsWith("actions/setup-node@"));
    const toolchainIdx = uses.findIndex((u) => u.startsWith("dtolnay/rust-toolchain@"));
    const uploadIdx = uses.findIndex((u) => u.startsWith("actions/upload-artifact@"));
    const installIdx = runIndexesByText(freeze, "yarn install --frozen-lockfile")[0];
    const allIdx = runIndexesByText(freeze, "node scripts/binaries/all.mjs --target")[0];
    const freezeIdx = runIndexesByText(freeze, "bash scripts/ci/freeze.sh --triple")[0];

    const observed = [checkoutIdx, setupNodeIdx, installIdx, toolchainIdx, allIdx, freezeIdx, uploadIdx];
    for (const [i, idx] of observed.entries()) {
      expect(idx, `step group #"${i}" (checkout/setup-node/install/toolchain/binaries/freeze/upload) is present`).toBeGreaterThanOrEqual(0);
    }
    for (let i = 1; i < observed.length; i++) {
      expect(observed[i], `step group ${i} out of acceptance-criteria order`).toBeGreaterThan(observed[i - 1]);
    }
  });

  it("setup-node pins node 22 with yarn cache", async () => {
    const { doc } = await loadWorkflow(FILENAME);
    const setupNode = stepsOf(jobsOf(doc).freeze).find((s) => stepUses(s).startsWith("actions/setup-node@"));
    expect(setupNode.with["node-version"]).toBe(22);
    expect(setupNode.with.cache).toBe("yarn");
  });

  it("binaries staging step targets the matrix triple", async () => {
    const { doc } = await loadWorkflow(FILENAME);
    const staging = stepsOf(jobsOf(doc).freeze).find((s) =>
      stepRuns(s).includes("node scripts/binaries/all.mjs --target"),
    );
    expect(staging.run).toContain("${{ matrix.triple }}");
  });

  it("freeze step passes --triple from the matrix", async () => {
    const { doc } = await loadWorkflow(FILENAME);
    const freezeStep = stepsOf(jobsOf(doc).freeze).find((s) => stepRuns(s).includes("bash scripts/ci/freeze.sh --triple"));
    expect(freezeStep.run).toContain("${{ matrix.triple }}");
  });

  it("upload-artifact carries the bundle + sha256 for this matrix row and errors on no files", async () => {
    const { doc } = await loadWorkflow(FILENAME);
    const upload = stepsOf(jobsOf(doc).freeze).find((s) => stepUses(s).startsWith("actions/upload-artifact@"));
    const withBlock = JSON.stringify(upload.with ?? {});
    expect(withBlock).toContain("src-tauri/.freeze/sidecar-bundle-");
    expect(withBlock).toContain(".tar.gz");
    expect(withBlock).toContain(".sha256");
    expect(upload["with"].name).toContain("${{ matrix.triple }}");
    expect(upload["with"]["if-no-files-found"]).toBe("error");
  });

  it("every run: step pins shell: bash", async () => {
    const { doc } = await loadWorkflow(FILENAME);
    for (const [jobName, job] of Object.entries(jobsOf(doc))) {
      for (const step of stepsOf(job)) {
        if (!stepRuns(step)) continue;
        expect(step.shell, `job ${jobName} step "${step.name}": run steps must set shell: bash`).toBe("bash");
      }
    }
  });

  it("finalize job needs freeze and publishes the sidecars release with every artifact", async () => {
    const { doc } = await loadWorkflow(FILENAME);
    const finalize = jobsOf(doc).finalize;
    expect(finalize).toBeDefined();
    expect(finalize.needs).toEqual(["freeze"]);

    const steps = stepsOf(finalize);
    const downloadIdx = steps.findIndex((s) => stepUses(s).startsWith("actions/download-artifact@"));
    expect(downloadIdx, "finalize must download artifacts").toBeGreaterThanOrEqual(0);
    const createStep = steps.find((s) => stepRuns(s).includes('gh release create "sidecars-$(date -u +%Y%m%d)"'));
    expect(createStep).toBeDefined();
    expect(JSON.stringify(createStep?.env ?? {})).toContain("github.token");
  });

  it("finalize downloads artifacts with the sidecar-bundle pattern, merged into release-assets", async () => {
    const { doc } = await loadWorkflow(FILENAME);
    const download = stepsOf(jobsOf(doc).finalize).find((s) =>
      stepUses(s).startsWith("actions/download-artifact@"),
    );
    expect(download.with.pattern).toBe("sidecar-bundle-*");
    expect(download.with["merge-multiple"]).toBe(true);
    expect(download.with.path).toBe("release-assets");
  });

  it("finalize preflight requires exactly 4 assets and fails loudly on a same-day tag collision", async () => {
    const { doc } = await loadWorkflow(FILENAME);
    const steps = stepsOf(jobsOf(doc).finalize);

    const downloadIdx = steps.findIndex((s) => stepUses(s).startsWith("actions/download-artifact@"));
    const countIdx = steps.findIndex((s) => stepRuns(s).includes("expected 4 bundle assets (2 tarballs + 2 .sha256)"));
    const collisionIdx = steps.findIndex((s) => stepRuns(s).includes('gh release view "sidecars-$(date -u +%Y%m%d)"'));
    const createIdx = steps.findIndex((s) => stepRuns(s).includes('gh release create "sidecars-$(date -u +%Y%m%d)"'));

    expect(countIdx, "asset-count preflight step must exist").toBeGreaterThanOrEqual(0);
    expect(collisionIdx, "tag-collision preflight step must exist").toBeGreaterThanOrEqual(0);
    expect(countIdx, "count preflight must run after download").toBeGreaterThan(downloadIdx);
    expect(createIdx, "release must only be created after both preflights").toBeGreaterThan(countIdx);
    expect(createIdx).toBeGreaterThan(collisionIdx);

    const countStep = steps[countIdx];
    expect(countStep.run).toContain("set -euo pipefail");
    expect(countStep.shell).toBe("bash");

    const collisionStep = steps[collisionIdx];
    expect(collisionStep.run).toContain("set -euo pipefail");
    expect(collisionStep.run).toContain("gh release delete");
    expect(collisionStep.run).toContain("--cleanup-tag");
    expect(collisionStep.run).toContain("re-run");
    expect(collisionStep.env?.GH_REPO).toBe("${{ github.repository }}");
    expect(collisionStep.env?.GH_TOKEN).toBe("${{ github.token }}");
  });

  it("finalize creates the release pinned to the exact frozen commit", async () => {
    const { doc } = await loadWorkflow(FILENAME);
    const createStep = stepsOf(jobsOf(doc).finalize).find((s) =>
      stepRuns(s).includes('gh release create "sidecars-$(date -u +%Y%m%d)"'),
    );
    expect(createStep.run).toContain("release-assets/*");
    expect(createStep.run).toContain('--target "$GITHUB_SHA"');
    expect(createStep.env?.GH_REPO).toBe("${{ github.repository }}");
    expect(createStep.env?.GH_TOKEN).toBe("${{ github.token }}");
  });
});
