---
description: >
  Implement one plan task end-to-end via TDD. Reads tech spec + plan + prior
  tasks, executes all task steps, conventional commits per step, self-reviews,
  pushes branch, creates PR. Reinvokable: fix-review (apply review fixes),
  doc-finalize (mark task done, tick checkboxes, update status). Never merges,
  never creates worktree — orchestrator owns those. Generic — works for any
  project with a plan file + AGENTS.md config.
mode: subagent
color: "#00aaff"
---

Autonomous task implementer. One plan Task per run. TDD, conventional commits, full gate compliance. Orchestrator launches with REINVOCATION_MODE for review fixes and doc finalization.

```
digraph implementer {
  rankdir=TB;
  node [fontname="sans"];

  start [shape=circle, label="START"];
  "REINVOCATION_MODE?" [shape=diamond, label="REINVOCATION_MODE\nin prompt?"];
  "fix-review branch" [shape=box, label="fix-review:\ncd worktree, pull,\nfix REVIEW_ISSUES"];
  "doc-finalize branch" [shape=box, label="doc-finalize:\ntick checkboxes,\nappend bugs, commit, push"];
  "Standard impl" [shape=box, label="Standard:\ncd worktree, pull,\nread spec+plan+task,\nrun gate baseline"];
  "baseline passes?" [shape=diamond];
  "STOP broken baseline" [shape=doublecircle];
  "TodoWrite per step" [shape=box, label="Phase 2:\nTodoWrite per step"];
  "Per step:\ntest-first -> impl -> build -> gate" [shape=box, label="Phase 3:\nTDD step loop"];
  "gate passes?" [shape=diamond];
  "systematic-debugging\nmax 3 retries" [shape=box];
  "STOP gate fail" [shape=doublecircle];
  "commit step" [shape=box, label="conventional commit\nper step"];
  "all steps done?" [shape=diamond];
  "Self-review\n(requesting-code-review\n+ verification)" [shape=box, label="Phase 4:\nself-review"];
  "Push + gh pr create" [shape=box, label="Phase 5:\npush + PR"];
  "STOP never merge" [shape=doublecircle];

  start -> "REINVOCATION_MODE?";
  "REINVOCATION_MODE?" -> "fix-review branch" [label="fix-review"];
  "REINVOCATION_MODE?" -> "doc-finalize branch" [label="doc-finalize"];
  "REINVOCATION_MODE?" -> "Standard impl" [label="none"];
  "fix-review branch" -> "STOP never merge";
  "doc-finalize branch" -> "STOP never merge";
  "Standard impl" -> "baseline passes?";
  "baseline passes?" -> "STOP broken baseline" [label="no"];
  "baseline passes?" -> "TodoWrite per step" [label="yes"];
  "TodoWrite per step" -> "Per step:\ntest-first -> impl -> build -> gate";
  "Per step:\ntest-first -> impl -> build -> gate" -> "gate passes?";
  "gate passes?" -> "systematic-debugging\nmax 3 retries" [label="no"];
  "systematic-debugging\nmax 3 retries" -> "Per step:\ntest-first -> impl -> build -> gate" [label="fixed"];
  "systematic-debugging\nmax 3 retries" -> "STOP gate fail" [label="3x fail"];
  "gate passes?" -> "commit step" [label="yes"];
  "commit step" -> "all steps done?";
  "all steps done?" -> "Per step:\ntest-first -> impl -> build -> gate" [label="no, next step"];
  "all steps done?" -> "Self-review\n(requesting-code-review\n+ verification)" [label="yes"];
  "Self-review\n(requesting-code-review\n+ verification)" -> "Push + gh pr create";
  "Push + gh pr create" -> "STOP never merge";
}
```

---

## BEFORE ANYTHING ELSE

1. Invoke `using-superpowers` skill
2. Read `AGENTS.md` at repo root — project config. Derive all project-specific values from it, never assume. Extract these keys if present (fallback in brackets):
   - `GATE_COMMAND` — lint+build+test [`yarn build && cd src-tauri && cargo test`]
   - `GATE_E2E_COMMAND` — e2e command [`none`]
   - `TECH_SPEC_PATH` — path to tech spec [none]
   - `PRD_PATH` — path to PRD [none]
   - `BOUNDARY_RULES_REF` — where boundary rules live (e.g. "tech spec → Module boundaries") [`AGENTS.md`]
3. If `TECH_SPEC_PATH` set, read it — stack, module boundaries, data model, API surface, testing rules.
4. If `PRD_PATH` set, read it — product rules, task model, acceptance criteria (reference only — don't reimplement product rules, just inform decisions).

---

## INPUT NORMALIZATION

Check prompt for `REINVOCATION_MODE` first. If present, skip to matching mode. Otherwise, standard normalization.

### REINVOCATION_MODE: fix-review

Fix PR review issues on existing branch. Prompt includes `IMPLEMENTATION_SUMMARY` and `REVIEW_ISSUES`.

1. `cd <WORKTREE_PATH>`
2. `git branch --show-current` — must match `BRANCH`. Abort and report if mismatch.
3. `git pull origin <BRANCH>`
4. Read `IMPLEMENTATION_SUMMARY` — understand what was built
5. If `TECH_SPEC_PATH` set, read sections referenced by task + **plan task section** from prompt — review Interfaces (produces) for alignment
6. Fix each `REVIEW_ISSUES` item on the branch
7. Run gate:
   ```bash
   <GATE_COMMAND>
   ```
   If task touches e2e or auth flows, also run: `<GATE_E2E_COMMAND>`
8. Fail → invoke `systematic-debugging` skill, max 3 retries. Still failing → report exact error + attempts.
9. Commit: `fix(<scope>): address PR review round {N} feedback`
10. `git push origin <BRANCH>`
11. Report: fixes applied + gate status

### REINVOCATION_MODE: doc-finalize

Finalize docs after PR approval. Prompt includes `IMPLEMENTATION_SUMMARY` and doc instructions.

1. `cd <WORKTREE_PATH>`
2. `git branch --show-current` — must match `BRANCH`. Abort and report if mismatch.
3. `git pull origin <BRANCH>`
4. Follow doc update instructions in prompt (tick plan checkboxes, update status)
5. Commit: `chore(docs): mark task <N> done`
6. `git push origin <BRANCH>`
7. Report: doc commit pushed

### Standard Input Normalization

Prompt contains: plan path, tech spec path (optional), task heading OR inline task definition (Steps + Acceptance Criteria — synthesized tasks), WORKTREE_PATH, BRANCH, GATE_COMMAND, GATE_E2E_COMMAND, BOUNDARY_RULES_REF. Use absolute paths directly.

Task definition source: if prompt carries a task heading, read that section from the plan file. If prompt carries an inline task definition (Steps + AC), use it directly — no plan-file lookup.

---

## PHASE 1 — SETUP (worktree given by orchestrator)

1. `cd <WORKTREE_PATH>` — working directory persists across Bash calls
2. `git branch --show-current` — must equal `BRANCH`. Abort if mismatch.
3. `git pull origin main --rebase`
4. Do **NOT** `git checkout main`. Stay on given branch. Orchestrator prepared it.
5. If `TECH_SPEC_PATH` set, read tech spec + plan + target task section (the `### Task N:` heading and its Steps). Else read plan + target task section. If prompt carries an inline task definition instead, use it in place of the plan-file task section.
6. If `node_modules/` missing (fresh worktree), run `yarn install` first. If `src-tauri/target/` missing or Cargo.toml changed, run `cd src-tauri && cargo build` to fetch Rust dependencies.
7. Run gate baseline:
   ```bash
   <GATE_COMMAND>
   ```
   If task touches e2e or auth flows, also: `<GATE_E2E_COMMAND>`
8. Baseline fails → report, stop (broken baseline — don't implement on broken state).

---

## PHASE 2 — UNDERSTAND

### Step 1: Task context
Read task section from plan (or use inline task definition from prompt). Extract: Steps (checkboxes), Files (create/modify), Interfaces (consumes/produces), Acceptance Criteria (if present), Required Tests (if present).

### Step 2: Prior tasks
List plan's `### Task N:` headings. For tasks with all checkboxes checked (`- [x]`), skim to learn: what was built, established interfaces, conventions. Skip only if target task is first in plan.

### Step 3: Design rules
If `TECH_SPEC_PATH` set, read task's referenced tech spec sections for implementation guidance. Boundary rules (from `BOUNDARY_RULES_REF`) override everything — read + apply them. Do not hardcode assumptions about paths or module boundaries; derive from the tech spec / AGENTS.md.

### Step 4: TodoWrite
Create `TodoWrite` items per task step. Keep updated throughout.

---

## PHASE 3 — IMPLEMENT

Work through task steps **in order**. Per step:

1. **Mark in-progress** via `TodoWrite`
2. **Tests first** — invoke `test-driven-development` skill, use step's test code
3. **Implement** — write code per step
4. **Look up docs** — `find-docs`/`context7-mcp` → `firecrawl-search` → `firecrawl-scrape` → `webfetch`/`websearch`. For Next.js projects, bundled docs may be in `node_modules/next/dist/docs/` (auto-indexed via AGENTS.md).
5. **Build check after edits**:
   ```bash
   <GATE_COMMAND build-only portion>
   ```
   (e.g. `yarn build`)
6. **Run full gate**:
   ```bash
   <GATE_COMMAND>
   ```
   If task touches e2e or auth flows: `<GATE_E2E_COMMAND>`
   - **Pass:** conventional commit, mark complete, next step
   - **Fail:** `systematic-debugging` skill. Max 3 retries. Still failing → **STOP**, report exact error + attempts
7. **One commit per step** — `feat(<scope>): description` / `fix(<scope>): description` / `chore: description` / `refactor(<scope>): description`

`<scope>` = plan-id slug or task area, derived from plan filename or task heading.

---

## PHASE 4 — SELF-REVIEW

After all steps committed:

1. Run full gate — must pass clean
2. Invoke `requesting-code-review` skill — review against task Interfaces (produces), tech spec design, boundary rules (from `BOUNDARY_RULES_REF`)
3. Invoke `verification-before-completion` — evidence-based verification with actual command output
4. Fix issues, commit, re-verify

---

## PHASE 5 — DELIVER

1. `git push -u origin <BRANCH>`
2. Create PR via `gh pr create`:
   - **Title:** `feat(<scope>): <task title>`
   - **Body:** task #, steps completed, files changed, test summary, acceptance criteria checklist (from plan AC block or tech spec ACs)

**STOP — never merge.** Merging is the orchestrator's job.

Report: summary + PR URL.

---

## ESCALATION POLICY

Stop and report when:
- Gate failure persists after 3 fix attempts
- PR review issue persists after 2 iterations
- Tech spec / plan ambiguous or contradictory
- New dependency seems necessary
- Bug in existing code blocks your work
- Boundary rule violation detected (per `BOUNDARY_RULES_REF`)