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
  { file: "release.yml", status: "current" },
  { file: "ci.yml", status: "planned" },
];

const RELEASE_MATRIX_ROWS = [
  { triple: "aarch64-apple-darwin", os: "macos-15", stage: "freeze" },
  { triple: "x86_64-apple-darwin", os: "macos-15-intel", stage: "freeze" },
  { triple: "x86_64-pc-windows-msvc", os: "windows-2025", stage: "manifest" },
  { triple: "aarch64-pc-windows-msvc", os: "windows-11-arm", stage: "manifest" },
];

const GATE_COMMAND = "yarn build && yarn test && cd src-tauri && cargo test";

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

  it("scopes permissions: read default, gate reads, freeze reads, finalize writes", async () => {
    const { doc } = await loadWorkflow(FILENAME);
    expect(doc.permissions).toEqual({ contents: "read" });
    expect(jobsOf(doc).gate.permissions).toEqual({ contents: "read" });
    expect(jobsOf(doc).freeze.permissions).toEqual({ contents: "read" });
    expect(jobsOf(doc).finalize.permissions).toEqual({ contents: "write" });
  });

  it("queues concurrent dispatches (workflow-level concurrency, cancel-in-progress: false)", async () => {
    const { doc } = await loadWorkflow(FILENAME);
    expect(doc.concurrency.group).toBe("freeze-${{ github.repository }}");
    expect(doc.concurrency["cancel-in-progress"]).toBe(false);
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
    const brewIdx = runIndexesByText(freeze, "brew install vips ghostscript")[0];
    const allIdx = runIndexesByText(freeze, "node scripts/binaries/all.mjs --target")[0];
    const freezeIdx = runIndexesByText(freeze, "bash scripts/ci/freeze.sh --triple")[0];

    const observed = [checkoutIdx, setupNodeIdx, installIdx, brewIdx, toolchainIdx, allIdx, freezeIdx, uploadIdx];
    for (const [i, idx] of observed.entries()) {
      expect(idx, `step group #"${i}" (checkout/setup-node/install/brew/toolchain/binaries/freeze/upload) is present`).toBeGreaterThanOrEqual(0);
    }
    for (let i = 1; i < observed.length; i++) {
      expect(observed[i], `step group ${i} out of acceptance-criteria order`).toBeGreaterThan(observed[i - 1]);
    }
  });

  it("installs the brew formulas before staging so a runner-side drift fails loudly in prep", async () => {
    const { doc } = await loadWorkflow(FILENAME);
    const brew = stepsOf(jobsOf(doc).freeze).find((s) => stepRuns(s).includes("brew install vips ghostscript"));
    expect(brew, "brew install step must exist (drift gate needs the active keg)").toBeDefined();
    expect(
      brew.run,
      "the formula install must be naked — drift handling belongs to prep/verify, not to a version flag here",
    ).not.toContain("@");
    expect(brew.shell).toBe("bash");
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

  it("gate job runs a fail-closed tag-collision preflight before the expensive freeze matrix", async () => {
    const { doc } = await loadWorkflow(FILENAME);
    const gate = jobsOf(doc).gate;
    expect(gate, "gate job must exist").toBeDefined();
    expect(gate.needs).toBeUndefined();
    expect(gate["runs-on"]).toBe("ubuntu-24.04");
    expect(jobsOf(doc).freeze.needs).toEqual(["gate"]);
    expect(
      stepsOf(jobsOf(doc).finalize).find((s) => stepRuns(s).includes("collision")),
      "collision preflight must live only in the gate job",
    ).toBeUndefined();
    expect(
      stepsOf(jobsOf(doc).finalize).find((s) => stepRuns(s).includes("2>&1 >/dev/null)\" || rc=$?")),
      "stderr-classified collision probe must not run in finalize",
    ).toBeUndefined();

    const collision = stepsOf(gate).find((s) => stepRuns(s).includes('gh release view "$tag"'));
    expect(collision, "collision preflight must query gh release view").toBeDefined();
    expect(collision.name).toBe("report same-day sidecars release collision with remediation");
    expect(collision.run).toContain("set -euo pipefail");
    expect(collision.run).toContain('tag="sidecars-$(date -u +%Y%m%d)"');
    expect(collision.run, "tag must not be recomputed inline").not.toContain('gh release view "sidecars-');
    expect(collision.run, "stderr must be captured and classified (fail-closed)").toContain(
      'err="$(gh release view "$tag" 2>&1 >/dev/null)" || rc=$?',
    );
    expect(collision.run).toContain(
      "::error::collision preflight could not verify tag absence (auth/scopes/rate limit/network): $err",
    );
    expect(collision.run, "only genuine 'not found' stderr may pass the gate").toMatch(/not found\|no release/i);
    expect(collision.run).toContain(
      "release $tag already exists — recovery: delete any leftover draft release, run 'gh release delete $tag --cleanup-tag --yes', then re-run the failed freeze jobs",
    );
    expect(collision.env?.GH_REPO).toBe("${{ github.repository }}");
    expect(collision.env?.GH_TOKEN).toBe("${{ github.token }}");
  });

  it("finalize job needs freeze and downloads bundles", async () => {
    const { doc } = await loadWorkflow(FILENAME);
    const finalize = jobsOf(doc).finalize;
    expect(finalize).toBeDefined();
    expect(finalize.needs).toEqual(["freeze"]);

    const steps = stepsOf(finalize);
    const downloadIdx = steps.findIndex((s) => stepUses(s).startsWith("actions/download-artifact@"));
    expect(downloadIdx, "finalize must download artifacts").toBeGreaterThanOrEqual(0);
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

  it("finalize count preflight annotates a missing release-assets dir and runs before create", async () => {
    const { doc } = await loadWorkflow(FILENAME);
    const steps = stepsOf(jobsOf(doc).finalize);

    const downloadIdx = steps.findIndex((s) => stepUses(s).startsWith("actions/download-artifact@"));
    const countIdx = steps.findIndex((s) => stepRuns(s).includes("expected 4 bundle assets (2 tarballs + 2 .sha256)"));
    const createIdx = steps.findIndex((s) => stepRuns(s).includes('gh release create "$tag"'));

    expect(countIdx, "asset-count preflight step must exist").toBeGreaterThanOrEqual(0);
    expect(createIdx, "publish step must exist").toBeGreaterThanOrEqual(0);
    expect(countIdx, "count preflight must run after download").toBeGreaterThan(downloadIdx);
    expect(createIdx, "release must only be created after the count preflight").toBeGreaterThan(countIdx);

    const countStep = steps[countIdx];
    expect(countStep.run).toContain("set -euo pipefail");
    expect(countStep.run, "missing dir must fail loudly before find runs").toContain("[ ! -d release-assets ]");
    expect(countStep.run).toContain(
      "::error::release-assets directory missing — download-artifact step produced nothing",
    );
    expect(countStep.shell).toBe("bash");
  });

  it("finalize publishes draft-first (draft → upload → verify 4 assets → publish) in one step", async () => {
    const { doc } = await loadWorkflow(FILENAME);
    const publish = stepsOf(jobsOf(doc).finalize).find((s) => stepRuns(s).includes('gh release create "$tag"'));
    expect(publish, "publish step must exist").toBeDefined();
    const run = publish.run;

    expect(run).toContain("set -euo pipefail");
    expect(run).toContain('tag="sidecars-$(date -u +%Y%m%d)"');
    expect(run, "tag must not be recomputed inline").not.toContain('gh release create "sidecars-');
    expect(run).toContain('gh release create "$tag" --draft --target "$GITHUB_SHA" --title "$tag"');
    expect(run, "assets must not be uploaded as part of create (torn-publish risk)").not.toContain(
      'gh release create "$tag" release-assets',
    );
    expect(run).toContain('gh release upload "$tag" release-assets/* --clobber');
    expect(run).toContain("n=\"$(gh release view \"$tag\" --json assets --jq 'length')\"");
    expect(run).toContain('[ "$n" -ne 4 ]');
    expect(run).toContain("::error::$tag has $n/4 assets — draft left in place, not published");
    expect(run).toContain("gh release delete $tag --cleanup-tag --yes");
    expect(run).toContain('gh release edit "$tag" --draft=false');
    expect(publish.env?.GH_REPO).toBe("${{ github.repository }}");
    expect(publish.env?.GH_TOKEN).toBe("${{ github.token }}");

    const order = [
      run.indexOf('gh release create "$tag" --draft'),
      run.indexOf('gh release upload "$tag" release-assets/* --clobber'),
      run.indexOf("--json assets --jq 'length'"),
      run.indexOf('gh release edit "$tag" --draft=false'),
    ];
    for (const [i, idx] of order.entries()) {
      expect(idx, `draft-first stage #${i} (create/upload/verify/publish) missing`).toBeGreaterThanOrEqual(0);
    }
    for (let i = 1; i < order.length; i++) {
      expect(order[i], `draft-first stage ${i} out of order`).toBeGreaterThan(order[i - 1]);
    }
  });
});

describe("release.yml release workflow", () => {
  const FILENAME = "release.yml";

  it("has a self-check status of current", () => {
    expect(EXPECTED_WORKFLOWS.find((wf) => wf.file === FILENAME)?.status).toBe("current");
  });

  it("triggers on push of v* tags and workflow_dispatch with a tag input", async () => {
    const { doc } = await loadWorkflow(FILENAME);
    expect(doc.on.push.tags).toEqual(["v*"]);
    expect(doc.on.push.branches).toBeUndefined();
    const dispatch = doc.on.workflow_dispatch;
    expect(dispatch, "workflow_dispatch must be configured").toBeTypeOf("object");
    expect(dispatch.inputs?.tag?.type, "dispatch must carry a string tag input").toBe("string");
  });

  it("queues concurrent runs per computed release tag (concurrency, cancel-in-progress: false)", async () => {
    const { doc } = await loadWorkflow(FILENAME);
    expect(doc.concurrency.group).toBe(
      "release-${{ github.event_name == 'workflow_dispatch' && inputs.tag || github.ref }}",
    );
    expect(doc.concurrency["cancel-in-progress"]).toBe(false);
  });

  it("scopes permissions: workflow reads, gate reads, release rows write contents", async () => {
    const { doc } = await loadWorkflow(FILENAME);
    expect(doc.permissions).toEqual({ contents: "read" });
    expect(jobsOf(doc).gate.permissions).toEqual({ contents: "read" });
    for (const [jobName, job] of Object.entries(jobsOf(doc))) {
      if (jobName === "gate") continue;
      expect(job.permissions, `job ${jobName} must hold job-scoped contents: write`).toEqual({
        contents: "write",
      });
    }
  });

  it("has exactly the four-triple / four-runner matrix with stages", async () => {
    const { doc } = await loadWorkflow(FILENAME);
    const release = jobsOf(doc).release;
    expect(release).toBeDefined();
    expect(release.strategy["fail-fast"]).toBe(false);
    expect(release.strategy.matrix.include).toEqual(RELEASE_MATRIX_ROWS);
  });

  it("version-sync uses trigger-context env instead of run-string interpolation", async () => {
    const { doc } = await loadWorkflow(FILENAME);
    const sync = stepsOf(jobsOf(doc).gate).find((s) =>
      stepRuns(s).includes("node scripts/ci/release-version-check.mjs"),
    );
    expect(sync, "gate version-sync step must exist").toBeDefined();
    expect(sync.env?.GITHUB_EVENT_NAME).toBe("${{ github.event_name }}");
    expect(sync.env?.GITHUB_REF_NAME).toBe("${{ github.ref_name }}");
    expect(sync.env?.DISPATCH_TAG).toBe("${{ inputs.tag }}");
    expect(sync.run).toContain("node scripts/ci/release-version-check.mjs");
    expect(sync.run, "untrusted fragments must enter through env, not the script text").not.toContain(
      "${{",
    );
    expect(sync.shell).toBe("bash");

    const checkoutIdx = stepsOf(jobsOf(doc).gate).findIndex((s) => stepUses(s).startsWith("actions/checkout@"));
    const syncIdx = stepsOf(jobsOf(doc).gate).findIndex((s) => stepRuns(s).includes("node scripts/ci/release-version-check.mjs"));
    expect(checkoutIdx, "checkout must precede version-sync").toBeLessThan(syncIdx);
  });

  it("no run: step in any job interpolates raw ${{ }} templates", async () => {
    const { doc } = await loadWorkflow(FILENAME);
    for (const [jobName, job] of Object.entries(jobsOf(doc))) {
      for (const step of stepsOf(job)) {
        const runText = stepRuns(step);
        if (!runText) continue;
        expect(
          runText.includes("${{"),
          `job ${jobName} step "${step.name}": run scripts must not embed raw templates — pass context through step env`,
        ).toBe(false);
      }
    }
  });

  it("gate jobs fail fast on a workflow_dispatch missing the tag input", async () => {
    const { doc } = await loadWorkflow(FILENAME);
    const steps = stepsOf(jobsOf(doc).gate);
    const checkoutIdx = steps.findIndex((s) => stepUses(s).startsWith("actions/checkout@"));
    const setupNodeIdx = steps.findIndex((s) => stepUses(s).startsWith("actions/setup-node@"));
    const syncIdx = steps.findIndex((s) => stepRuns(s).includes("node scripts/ci/release-version-check.mjs"));
    const preflightIdx = steps.findIndex((s) => stepRuns(s).includes("sidecars-availability"));
    const draftIdx = steps.findIndex((s) => stepRuns(s).includes('gh release create "$RELEASE_TAG"'));

    expect(checkoutIdx).toBeGreaterThanOrEqual(0);
    expect(setupNodeIdx, "node must be set up before the helper runs").toBeGreaterThanOrEqual(0);
    expect(syncIdx, "version-sync step must exist").toBeGreaterThanOrEqual(0);
    expect(preflightIdx, "sidecars-availability preflight must be a real step").toBeGreaterThanOrEqual(0);
    expect(draftIdx, "draft pre-creation step must exist").toBeGreaterThanOrEqual(0);
    for (let i = 1; i < [checkoutIdx, setupNodeIdx, syncIdx, preflightIdx, draftIdx].length; i++) {
      const idx = [checkoutIdx, setupNodeIdx, syncIdx, preflightIdx, draftIdx][i];
      expect(idx, `gate step group ${i} out of order (cheap fail-fast before the 30-min matrix)`).toBeGreaterThan(
        [checkoutIdx, setupNodeIdx, syncIdx, preflightIdx, draftIdx][i - 1],
      );
    }
    expect(setupNodeIdx).toBeLessThan(syncIdx);
  });

  it("gate preflights sidecars availability for both mac triples with all four bundle assets", async () => {
    const { doc } = await loadWorkflow(FILENAME);
    const preflight = stepsOf(jobsOf(doc).gate).find((s) => stepRuns(s).includes("sidecars-"));
    expect(preflight, "sidecars-availability preflight must exist").toBeDefined();
    const run = preflight.run;
    expect(run).toContain("set -euo pipefail");
    expect(run).toContain("gh release list --limit 200 --json tagName");
    expect(run).toContain('startswith("sidecars-")');
    expect(run).toContain("::error::no sidecars-* release found — run the Freeze mac sidecars workflow before building the release (ADR 0001), then re-run the release");
    for (const triple of ["aarch64-apple-darwin", "x86_64-apple-darwin"]) {
      expect(run).toContain(triple);
    }
    for (const pattern of ["sidecar-bundle-${triple}.tar.gz", "sidecar-bundle-${triple}.tar.gz.sha256"]) {
      expect(run).toContain(pattern);
    }
    expect(run).toContain("::error::sidecars release '$newest' is missing asset");
    expect(preflight.env?.GH_TOKEN).toBe("${{ github.token }}");
    expect(preflight.env?.GH_REPO).toBe("${{ github.repository }}");
    expect(preflight.shell).toBe("bash");
  });

  it("gate pre-creates the draft release fail-closed and exports job outputs", async () => {
    const { doc } = await loadWorkflow(FILENAME);
    const gate = jobsOf(doc).gate;
    expect(gate.outputs).toEqual({
      release_id: "${{ steps.draft.outputs.release_id }}",
      release_tag: "${{ steps.draft.outputs.release_tag }}",
      app_version: "${{ steps.draft.outputs.app_version }}",
      prerelease: "${{ steps.draft.outputs.prerelease }}",
    });

    const draft = stepsOf(gate).find((s) => stepRuns(s).includes('gh release create "$RELEASE_TAG"'));
    expect(draft, "draft creation must live in the gate job").toBeDefined();
    expect(draft.id).toBe("draft");
    const run = draft.run;

    expect(run).toContain("set -euo pipefail");
    expect(run, "leftover drafts or published releases must fail the gate loudly").toContain(
      "::error::release $RELEASE_TAG already exists — recovery: run 'gh release delete $RELEASE_TAG --cleanup-tag --yes', then re-run the release",
    );
    expect(run).toContain('err="$(gh release view "$RELEASE_TAG" 2>&1 >/dev/null)" || rc=$?');
    expect(run, "stderr must be captured and classified (fail-closed)").toMatch(/not found\|no release/i);

    expect(run).toContain('gh release create "$RELEASE_TAG" "${draft_flags[@]}" >/dev/null');
    expect(run).toContain("draft_flags=(--draft --target \"$GITHUB_SHA\" --title \"File Size Optimizer $RELEASE_TAG\")");
    expect(run, "the prerelease flag must be decided from the helper env, not recomputed").toContain(
      '[ "$PRERELEASE" = "true" ]',
    );
    expect(run).toContain("draft_flags+=(--prerelease)");
    expect(run).toContain('release_id="$(gh release view "$RELEASE_TAG" --json id --jq \'.id\')"');
    for (const output of ["release_id", "release_tag", "app_version", "prerelease"]) {
      expect(run).toContain(`echo "${output}=`);
    }
    expect(draft.env?.GH_TOKEN).toBe("${{ github.token }}");
    expect(draft.env?.GH_REPO).toBe("${{ github.repository }}");
    expect(draft.shell).toBe("bash");
  });

  it("rows re-run the version check validate-only before engine work", async () => {
    const { doc } = await loadWorkflow(FILENAME);
    const steps = stepsOf(jobsOf(doc).release);
    const checkoutIdx = steps.findIndex((s) => stepUses(s).startsWith("actions/checkout@"));
    const syncIdx = steps.findIndex((s) => stepRuns(s).includes("--validate-only"));
    expect(syncIdx, "row validate-only version check must exist").toBeGreaterThanOrEqual(0);
    expect(checkoutIdx, "checkout must precede the row version check").toBeLessThan(syncIdx);
    const sync = steps[syncIdx];
    expect(sync.run).toContain("node scripts/ci/release-version-check.mjs --validate-only");
    expect(sync.env?.GITHUB_EVENT_NAME).toBe("${{ github.event_name }}");
    expect(sync.env?.DISPATCH_TAG).toBe("${{ inputs.tag }}");
    expect(sync.shell).toBe("bash");
  });

  it("runs the gate command verbatim after engine staging", async () => {
    const { doc } = await loadWorkflow(FILENAME);
    const release = jobsOf(doc).release;
    const gateIdx = runIndexesByText(release, GATE_COMMAND)[0];
    expect(gateIdx, "gate command must appear verbatim").toBeGreaterThanOrEqual(0);
    const steps = stepsOf(release);
    const auditIdx = steps.findIndex((s) =>
      stepRuns(s).includes("yarn binaries:audit") || stepRuns(s).includes("node scripts/binaries/all.mjs --target"),
    );
    expect(auditIdx, "engine staging/audit must precede the gate").toBeLessThan(gateIdx);
  });

  it("mac rows allow the inactive brew version-drift gate on the frozen-engine audit", async () => {
    const { doc } = await loadWorkflow(FILENAME);
    const audit = stepsOf(jobsOf(doc).release).find((s) => stepRuns(s).includes("yarn binaries:audit"));
    expect(audit, "frozen-engine audit step must exist").toBeDefined();
    expect(audit["if"]).toBe("matrix.stage == 'freeze'");
    expect(
      audit.env?.BINARIES_ALLOW_INACTIVE_BREW,
      "runner brew has no vips/ghostscript kegs — the inactive allowance is what keeps the audit from dying on brew-present/formula-missing hosts",
    ).toBe("1");
  });

  it("mac rows unfreeze + audit, windows rows stage fresh via all.mjs", async () => {
    const { doc } = await loadWorkflow(FILENAME);
    const release = jobsOf(doc).release;
    const steps = stepsOf(release);

    const unfreezeStep = steps.find((s) => stepRuns(s).includes("bash scripts/ci/unfreeze.sh --triple"));
    expect(unfreezeStep, "unfreeze step must exist for the freeze stage rows").toBeDefined();
    expect(unfreezeStep.run).toContain('--triple "$TRIPLE"');
    expect(unfreezeStep.env?.TRIPLE).toBe("${{ matrix.triple }}");
    expect(unfreezeStep["if"]).toBe("matrix.stage == 'freeze'");
    expect(unfreezeStep.env?.GH_TOKEN).toBe("${{ github.token }}");
    expect(unfreezeStep.env?.GH_REPO).toBe("${{ github.repository }}");

    const unfreezeIdx = steps.findIndex((s) => s === unfreezeStep);
    const auditIdx = steps.findIndex((s) => stepRuns(s).includes("yarn binaries:audit"));
    expect(auditIdx, "mac clean-room audit step must exist").toBeGreaterThanOrEqual(0);
    expect(auditIdx, "audit must run after unfreeze").toBeGreaterThan(unfreezeIdx);
    expect(steps[auditIdx]["if"]).toBe("matrix.stage == 'freeze'");

    const stageStep = steps.find((s) => stepRuns(s).includes('node scripts/binaries/all.mjs --target "$TRIPLE"'));
    expect(stageStep, "windows manifest staging step must exist").toBeDefined();
    expect(stageStep["if"]).toBe("matrix.stage == 'manifest'");
    expect(stageStep.env?.TRIPLE).toBe("${{ matrix.triple }}");

    const runsText = steps.map((s) => stepRuns(s)).join("\n");
    for (const row of RELEASE_MATRIX_ROWS) {
      const usesAllMjs = row.stage === "manifest";
      const expectedNeedle = usesAllMjs ? 'node scripts/binaries/all.mjs --target "$TRIPLE"' : 'bash scripts/ci/unfreeze.sh --triple "$TRIPLE"';
      expect(runsText.includes(expectedNeedle), `row ${row.triple}: ${expectedNeedle} must be invoked`).toBe(true);
    }
  });

  it("arm windows row adds its rustup target after toolchain setup", async () => {
    const { doc } = await loadWorkflow(FILENAME);
    const steps = stepsOf(jobsOf(doc).release);
    const toolchainIdx = steps.findIndex((s) => stepUses(s).startsWith("dtolnay/rust-toolchain@"));
    const rustupIdx = steps.findIndex((s) => stepRuns(s).includes("rustup target add aarch64-pc-windows-msvc"));
    expect(toolchainIdx).toBeGreaterThanOrEqual(0);
    expect(rustupIdx, "rustup target add step must exist").toBeGreaterThanOrEqual(0);
    expect(rustupIdx).toBeGreaterThan(toolchainIdx);
    const rustup = steps[rustupIdx];
    expect(rustup["if"]).toContain("aarch64-pc-windows-msvc");
    expect(rustup.shell).toBe("bash");
  });

  it("uses rust-cache keyed per triple over the src-tauri workspace", async () => {
    const { doc } = await loadWorkflow(FILENAME);
    const cache = stepsOf(jobsOf(doc).release).find((s) =>
      /swatinem\/rust-cache@/i.test(stepUses(s)),
    );
    expect(cache, "rust-cache step must exist").toBeDefined();
    expect(cache.with.key).toContain("${{ matrix.triple }}");
    expect(cache.with.workspaces).toBe("src-tauri");
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

  it("tauri-action uploads into the gated draft by releaseId, with no tag/name/prerelease inputs", async () => {
    const { doc } = await loadWorkflow(FILENAME);
    const action = stepsOf(jobsOf(doc).release).find((s) =>
      stepUses(s).startsWith("tauri-apps/tauri-action@"),
    );
    expect(action, "tauri-action step must exist").toBeDefined();
    expect(stepUses(action)).toMatch(/^tauri-apps\/tauri-action@[0-9a-f]{40}$/);
    expect(action.env?.GITHUB_TOKEN).toBe("${{ github.token }}");

    const withBlock = action.with ?? {};
    expect(withBlock.releaseId, "per tauri-action semantics at a6e90dd: releaseId wins, tagName/releaseName are ignored").toBe(
      "${{ needs.gate.outputs.release_id }}",
    );
    for (const dropped of ["tagName", "releaseName", "releaseBody", "prerelease"]) {
      expect(
        withBlock[dropped],
        `tauri-action input '${dropped}' must not be set — release creation is the gate's job and duplicate drafts were the known tauri-action race`,
      ).toBeUndefined();
    }
    expect(withBlock.releaseDraft).toBe(true);
    expect(withBlock.args).toBe("--target ${{ matrix.triple }}");
  });

  it("has no finalize job (the gate pre-creates the draft, matrix rows upload into it)", async () => {
    const { doc } = await loadWorkflow(FILENAME);
    expect(Object.keys(jobsOf(doc))).toContain("release");
    expect(Object.keys(jobsOf(doc))).not.toContain("finalize");
  });

  it("uploads sbom + third-party notices from the arm64 mac job after tauri-action and verifies the upload took", async () => {
    const { doc } = await loadWorkflow(FILENAME);
    const steps = stepsOf(jobsOf(doc).release);
    const sbomIdx = steps.findIndex((s) => stepRuns(s).includes("yarn sbom"));
    const actionIdx = steps.findIndex((s) => stepUses(s).startsWith("tauri-apps/tauri-action@"));
    expect(sbomIdx, "sbom step must exist").toBeGreaterThanOrEqual(0);
    expect(sbomIdx).toBeGreaterThan(actionIdx);

    const sbom = steps[sbomIdx];
    expect(sbom["if"]).toContain("aarch64-apple-darwin");
    expect(sbom.run).toContain('gh release upload "$RELEASE_TAG" sbom.json THIRD_PARTY_LICENSES.md --clobber');
    expect(
      sbom.env?.RELEASE_TAG,
      "RELEASE_TAG must come from the gate outputs, not from this row's own env",
    ).toBe("${{ needs.gate.outputs.release_tag }}");
    expect(sbom.run).toContain('gh release view "$RELEASE_TAG" --json assets --jq');
    expect(sbom.run, "post-upload verify counts the two expected asset names by default").toContain(
      '[ "$n" -ne 2 ]',
    );
    expect(sbom.run).toContain(
      "::error::release $RELEASE_TAG carries $n/2 of the expected sbom assets (sbom.json, THIRD_PARTY_LICENSES.md)",
    );
    expect(sbom.env?.GH_TOKEN).toBe("${{ github.token }}");
    expect(sbom.env?.GH_REPO).toBe("${{ github.repository }}");
  });

  it("prerelease flag is applied at gate draft creation from the helper-provided env", async () => {
    const { doc, text } = await loadWorkflow(FILENAME);
    const draft = stepsOf(jobsOf(doc).gate).find((s) => stepRuns(s).includes('gh release create "$RELEASE_TAG"'));
    expect(draft.run).toContain('[ "$PRERELEASE" = "true" ]');
    expect(draft.run).toContain("draft_flags+=(--prerelease)");
    expect(
      text.includes("${{ env.PRERELEASE }}"),
      "PRERELEASE must flow from the helper's GITHUB_ENV, not be rewritten per job",
    ).toBe(false);
    for (const [jobName, job] of Object.entries(jobsOf(doc))) {
      for (const step of stepsOf(job)) {
        if (stepRuns(step)) {
          expect(step.run, "no step may decide prerelease itself — the gate draft is authoritative").not.toContain(
            "-rc",
          );
          for (const [envName] of Object.entries(step.env ?? {})) {
            expect(envName).not.toBe("PRERELEASE");
          }
        }
      }
    }
  });
});
