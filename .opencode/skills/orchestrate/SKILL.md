---
name: orchestrate
description: >
  Orchestrate plan implementation as task-granular PRs. Resolves plan,
  picks next task, creates worktree+branch, launches implementer subagent,
  runs independent PR review (up to 3 rounds), finalizes docs, merges,
  reports. Sequential — one task at a time. Generic — works for any project
  with a plan file + AGENTS.md config. Trigger: "orchestrate <plan-id>",
  "orchestrate <plan-id> task 5".
---

# Orchestrator

Autonomous pipeline: plan → task → implementer → review → merge. Main agent runs skill → becomes orchestrator. Spawns `implementer` subagent per task. Owns worktree/branch/merge. Independent review via `pr-review-toolkit` skill.

**7 steps, in order.** Skip none. Each step has explicit gate before proceeding.

```
digraph orchestrate {
  rankdir=TB;
  node [fontname="sans"];

  "Resolve plan\n+ validate deps" [shape=box, label="STEP 1 — VALIDATE"];
  "Pick next open task" [shape=box, label="STEP 2 — PICK TASK"];
  "Create worktree\n+ branch" [shape=box, label="STEP 3 — WORKTREE"];
  "Launch implementer\nsubagent" [shape=box, label="STEP 4 — IMPLEMENTER"];
  "PR created?" [shape=diamond];
  "Run pr-review-toolkit\n(6 reviewers)" [shape=box, label="STEP 5 — REVIEW"];
  "Findings?" [shape=diamond];
  "Re-invoke implementer\nfix-review mode" [shape=box];
  "Doc finalize\n(implementer re-invoke)" [shape=box, label="STEP 6a — DOC FINALIZE"];
  "Merge PR\n+ cleanup worktree" [shape=box, label="STEP 6b — MERGE"];
  "Report +\nmore tasks?" [shape=diamond, label="STEP 7 — REPORT"];
  "Done" [shape=doublecircle];

  "Resolve plan\n+ validate deps" -> "Pick next open task";
  "Pick next open task" -> "Create worktree\n+ branch";
  "Create worktree\n+ branch" -> "Launch implementer\nsubagent";
  "Launch implementer\nsubagent" -> "PR created?";
  "PR created?" -> "Run pr-review-toolkit\n(6 reviewers)" [label="yes"];
  "PR created?" -> "STOP\nescalate" [label="no"];
  "Run pr-review-toolkit\n(6 reviewers)" -> "Findings?";
  "Findings?" -> "Doc finalize\n(implementer re-invoke)" [label="none"];
  "Findings?" -> "Re-invoke implementer\nfix-review mode" [label="yes, round < 3"];
  "Re-invoke implementer\nfix-review mode" -> "Run pr-review-toolkit\n(6 reviewers)";
  "Findings?" -> "STOP\nleave PR open" [label="yes, round = 3"];
  "Doc finalize\n(implementer re-invoke)" -> "Merge PR\n+ cleanup worktree";
  "Merge PR\n+ cleanup worktree" -> "Report +\nmore tasks?";
  "Report +\nmore tasks?" -> "Pick next open task" [label="yes, loop"];
  "Report +\nmore tasks?" -> "Done" [label="no, last task"];
}
```

---

## BEFORE START

Read `AGENTS.md` at repo root. It is the project config — derive all project-specific values from it, never assume. Extract these keys if present (fallback in brackets):

- `PLAN_GLOB` — glob pattern to find plan files [`docs/**/plans/**/*.md`]
- `TECH_SPEC_PATH` — path to tech spec [none]
- `PRD_PATH` — path to PRD [none]
- `GATE_COMMAND` — lint+build+test [`yarn build && cd src-tauri && cargo test`]
- `GATE_E2E_COMMAND` — e2e command [`none`]
- `BOUNDARY_RULES_REF` — where boundary rules live (e.g. "tech spec → Module boundaries") [`AGENTS.md`]

If `AGENTS.md` absent, use fallbacks. Never hardcode app-specific paths.

---

## INPUT

Parse user input into:
- **plan-id**: plan identifier (filename stem, slice name, or absolute path) OR absolute plan path
- **task** (optional): `--task N` for specific task number; default = next open task

Examples: `orchestrate slice-0`, `orchestrate 2026-08-07-slice-0-walking-skeleton`, `orchestrate slice-0 --task 5`.

---

## STEP 1 — VALIDATE

Gate: do not proceed until validation passes.

1. Resolve plan-id → plan path: if absolute path, use directly. Else glob `PLAN_GLOB` matching plan-id. If multiple match, use most recent (highest date prefix). If none → stop, report.
2. Verify plan file exists.
3. Verify plan has tasks with unchecked `- [ ]` boxes (open work exists). If all checked → plan done, stop.
4. If `--task N` given: verify `### Task N:` heading exists in plan.
5. **Dependency check** (if `TECH_SPEC_PATH` set): read tech spec's build-sequence / slice-dependencies section. If target plan depends on prior plans, verify those are complete (all tasks checked `- [x]`). If prior plan incomplete → stop, report:
   ```
   <plan-id> depends on <prior-plan-id>.
   <prior-plan-id> status: In Progress — Task 5.
   Complete <prior-plan-id> before starting <plan-id>.
   ```
6. If `TECH_SPEC_PATH` set, read sections referenced by target task for design rules.

---

## STEP 2 — PICK NEXT TASK

Gate: do not proceed until task identified.

1. Scan plan for `### Task N:` headings.
2. Find first task with any unchecked `- [ ]` step (completed task = all boxes checked `- [x]`).
3. Record: task number, task title, task heading line.
4. If `--task N` given, use that task (validated in Step 1).
5. Read task's Files / Interfaces / Acceptance Criteria / Required Tests / Steps sections from plan (if AC + Required Tests blocks absent, note it — `refine` skill should have added them; if not, implementer derives AC from tech spec).
6. Record GATE_TYPE — single gate for this project: use `GATE_COMMAND` from AGENTS.md.

---

## STEP 3 — WORKTREE & BRANCH

Gate: do not proceed until WORKTREE_PATH and BRANCH resolved and worktree ready.

Follow `using-git-worktrees` skill (git fallback — no native worktree tool in opencode).

1. **Detect existing isolation** (skill Step 0):
   ```bash
   GIT_DIR=$(cd "$(git rev-parse --git-dir)" 2>/dev/null && pwd -P)
   GIT_COMMON=$(cd "$(git rev-parse --git-common-dir)" 2>/dev/null && pwd -P)
   ```
   If `GIT_DIR != GIT_COMMON` (and not in submodule): already in worktree. Abort — don't nest. Report current path + branch.

2. **Ensure `.worktrees/` ignored**:
   ```bash
   git check-ignore -q .worktrees || echo ".worktrees/" >> .gitignore
   ```
   Commit only if `.gitignore` changed:
   ```bash
   git diff --quiet .gitignore || git add .gitignore && git commit -m "chore: ignore .worktrees/"
   ```

3. **Branch naming**: `task/<plan-id>-task<NN>`
   - `<plan-id>` = plan filename stem (slug)
   - `<NN>` = zero-padded task number (01, 02... 14)
   - Example: `task/slice-0-task03`

4. **Worktree path**: `<repo-root>/.worktrees/<branch-with-dashes>`
   - Replace `/` with `-`: `.worktrees/task-slice-0-task03`

5. **Pull main first** (in main worktree):
   ```bash
   git checkout main && git pull origin main
   ```

6. **Create worktree** (pick matching case):
   ```bash
   # A: worktree exists (resume after crash)
   git worktree list | grep ".worktrees/task-<plan-id>-..."
   # → nothing more to do; record WORKTREE_PATH and BRANCH

   # B: branch exists, worktree removed → re-attach
   git worktree add .worktrees/task-<plan-id>-... task/<plan-id>-...

   # C: new task → create branch + worktree from origin/main
   git worktree add -b task/<plan-id>-... .worktrees/task-<plan-id>-... origin/main
   ```

7. Record resolved **WORKTREE_PATH** (absolute) and **BRANCH** — passed to implementer.

---

## STEP 4 — LAUNCH IMPLEMENTER

Gate: do not proceed until PR URL received.

1. Launch `implementer` agent via `task` tool with `subagent_type: "implementer"`:

   ```
   Implement Task <N> from <plan-id>.
   Plan: <absolute plan path>
   Tech spec: <TECH_SPEC_PATH or "none">
   PRD: <PRD_PATH or "none">
   Task heading: "### Task N: <title>"
   WORKTREE_PATH: <absolute worktree path>
   BRANCH: <branch name>
    GATE_COMMAND: <GATE_COMMAND from AGENTS.md>
    GATE_E2E_COMMAND: <GATE_E2E_COMMAND from AGENTS.md or "none">
    BOUNDARY_RULES_REF: <BOUNDARY_RULES_REF from AGENTS.md>
    ```

2. Await return. Expect: summary of what was built + PR URL.
3. Extract PR number from URL.
4. **Record implementation summary** — needed for re-invocation prompts.

Escalation (spec ambiguity, gate failure, blocker) → surface to user, **STOP**.
No PR URL → report agent output to user, **STOP**.

---

## STEP 5 — REVIEW LOOP (up to 3 rounds)

**Mandatory.** Do not skip. At least one review round required.

Implementer self-reviews during implementation (Phase 4). This is independent second opinion.

For round 1–3:

### 5a. Run review

Invoke `pr-review-toolkit` skill on PR number. It spawns 6 reviewer subagents:
- `pr-code-reviewer`, `pr-comment-analyzer`, `pr-test-analyzer`, `pr-silent-failure-hunter`, `pr-type-design-analyzer`, `pr-code-simplifier`

Reviewers at depth 1 (siblings of implementer, spawned by main agent). Default `subagent_depth: 1` suffices.

### 5b. Collect findings

**Every finding is a must-fix** — no minor/suggestion bucket, no bugs-log dumping. Unfixed findings pile up; fix all. Collect every finding (any severity) into REVIEW_ISSUES list:
`N. <issue> — <file path> — <suggested fix>`

### 5c. Clean exit

Zero findings → **break loop**, proceed to Step 6.

### 5d. Findings present → re-invoke implementer

Re-invoke `implementer` via `task` tool with `subagent_type: "implementer"`:

```
REINVOCATION_MODE: fix-review

Task <N> from <plan-id>.
Plan: <absolute plan path>
Tech spec: <TECH_SPEC_PATH or "none">
Task heading: "### Task N: <title>"
WORKTREE_PATH: <absolute worktree path>
BRANCH: <branch name>
GATE_COMMAND: <GATE_COMMAND from AGENTS.md>
GATE_E2E_COMMAND: <GATE_E2E_COMMAND from AGENTS.md or "none">
BOUNDARY_RULES_REF: <BOUNDARY_RULES_REF from AGENTS.md>

IMPLEMENTATION_SUMMARY:
<summary from Step 4 — what was built, key files, patterns used>

PR_REVIEW_ROUND: <N>
REVIEW_ISSUES (must fix all):
1. <issue> — <file path> — <suggested fix>
2. ...

Fix on branch, run gate, commit, push.
Only gate output matters for verification.
```

Await agent return confirming fixes pushed. Continue to next round.

### 5e. 3 rounds exhausted

Findings still present → **STOP**:
```
PR #<number> still has unresolved findings after 3 review rounds.
PR open at <URL>. Remaining findings:
1. <finding>
Manual intervention needed.
```
Leave PR open. Do not merge.

---

## STEP 6 — FINALIZE AND MERGE

Only after review loop exits clean (Step 5c).

### 6a. Doc finalization

Re-invoke `implementer` with `REINVOCATION_MODE: doc-finalize`:

```
REINVOCATION_MODE: doc-finalize

Task <N> from <plan-id>.
WORKTREE_PATH: <absolute worktree path>
BRANCH: <branch name>

IMPLEMENTATION_SUMMARY:
<summary from Step 4>

PR #<number> approved. On the branch, make these updates:

1. Tick task checkboxes: - [ ] → - [x] in <plan path> (only Task <N>'s steps)
2. If plan has a status header, update task <N> row → Status: done, PR: #<number>
3. Commit: chore(docs): mark task <N> done
4. Push to branch.
```

Await push confirmation.

### 6b. Merge

Run directly via Bash:

```bash
gh pr merge <number> --merge
git checkout main && git pull origin main
git worktree remove <WORKTREE_PATH>
git branch -d <BRANCH>
```

Worktree dirty (shouldn't be — implementer commits per step):
```bash
git worktree remove --force <WORKTREE_PATH>
```
Only `--force` if clean check blocks and dirty state confirmed.

---

## STEP 7 — REPORT + CONTINUE

```
## Orchestration Progress

**Plan:** <plan-id> (<plan filename>)
**Task:** <N> — <title>
**PR:** #<number> — <url>
**Status:** Merged to main
**Review:** <clean | passed after N round(s)>

**Summary:**
<1-3 sentences from implementer>
```

- **More open tasks** → loop to Step 2 with next task
- **Last task** → plan done, report

---

## CONSTRAINTS

- **Sequential only** — one implementer at a time, never parallel.
- **Re-invoke with context** — review fixes and doc finalization use new `task` call with `REINVOCATION_MODE` + implementation summary from Step 4.
- **Gate is truth** — use `GATE_COMMAND` from AGENTS.md. E2E separate: `GATE_E2E_COMMAND` (run only if task touches e2e or auth flows).
- **Never merge on failure** — 3 rounds exhausted → leave PR open, escalate.
- **Respect plan dependency order** — Step 1 verifies prior plans complete before starting dependent plan (if tech spec declares dependencies).
- **Review loop mandatory** — Step 5 always runs, even after clean self-review.
- **Every finding is a must-fix** — no minor/suggestion bucket, no bugs-log dumping. All review findings go back to implementer to fix.
- **Orchestrator owns git mutations** — worktree, branch, merge, cleanup. Implementer never does these.
- **No app-specific paths in this skill** — all paths read from AGENTS.md or passed in prompt.

---

## RESUME AFTER CRASH

Orchestrator idempotent. On re-run `orchestrate <plan-id>`:

1. Find first task with any unchecked `- [ ]` step in plan.
2. For in-progress task (worktree + branch exist):
   - Worktree + branch + PR → resume at Step 5 (review) on existing PR
   - Worktree + branch, no PR → resume at Step 4 (launch implementer — it pushes + creates PR)
   - Neither → restart task fresh (Step 3)
3. For pending → start fresh (Step 3)