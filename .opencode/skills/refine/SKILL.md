---
name: refine
description: >
  Augment plan tasks with Acceptance Criteria + Required Tests blocks.
  Reads tech spec + plan, analyzes via code-explorer (implementation drift) +
  pr-test-analyzer (test coverage gaps), augments all tasks, adds new tasks
  if gaps found, logs drift. Generic — works for any project with a plan
  file + AGENTS.md config. Trigger: "refine <plan-id>".
---

# Refine

Augments existing plan tasks with two missing blocks: **Acceptance Criteria** (implementer gate for completion + scope) and **Required Tests** (implementer gate for coverage). Works for any plan file.

Main agent runs skill. 4 phases, in order.

```
digraph refine {
  rankdir=TB;
  node [fontname="sans"];

  start [shape=circle, label="START"];
  "Resolve plan\n+ create branch" [shape=box, label="PHASE 1 — RESOLVE"];
  "resolved?" [shape=diamond];
  "STOP not found" [shape=doublecircle];
  "code exists?" [shape=diamond];
  "Spawn code-explorer\n(per subsystem)" [shape=box];
  "Spawn pr-test-analyzer" [shape=box, label="Spawn pr-test-analyzer\n(always)"];
  "Synthesize\nper-task analysis" [shape=box, label="Synthesize"];
  "Per task:\ninsert AC + Required Tests" [shape=box, label="PHASE 3 — AUGMENT"];
  "gaps need new task?" [shape=diamond];
  "Add Task N+1\n(full structure)" [shape=box];
  "drift found?" [shape=diamond];
  "Log to bugs" [shape=box, label="Log to <BUGS_PATH>"];
  "Verify: AC + RT count\nmatch task count" [shape=box, label="PHASE 4 — VERIFY"];
  "mismatch?" [shape=diamond];
  "fix before commit" [shape=box];
  "Commit + push + PR" [shape=box, label="Deliver"];
  done [shape=doublecircle];

  start -> "Resolve plan\n+ create branch";
  "Resolve plan\n+ create branch" -> "resolved?";
  "resolved?" -> "STOP not found" [label="no"];
  "resolved?" -> "code exists?" [label="yes"];
  "code exists?" -> "Spawn code-explorer\n(per subsystem)" [label="yes (has_code=true)"];
  "code exists?" -> "Spawn pr-test-analyzer\n(always)" [label="no (has_code=false)"];
  "Spawn code-explorer\n(per subsystem)" -> "Spawn pr-test-analyzer\n(always)";
  "Spawn pr-test-analyzer\n(always)" -> "Synthesize\nper-task analysis";
  "Synthesize\nper-task analysis" -> "Per task:\ninsert AC + Required Tests";
  "Per task:\ninsert AC + Required Tests" -> "gaps need new task?";
  "gaps need new task?" -> "Add Task N+1\n(full structure)" [label="yes"];
  "Add Task N+1\n(full structure)" -> "drift found?";
  "gaps need new task?" -> "drift found?" [label="no"];
  "drift found?" -> "Log to bugs" [label="yes"];
  "drift found?" -> "Verify: AC + RT count\nmatch task count" [label="no"];
  "Log to bugs" -> "Verify: AC + RT count\nmatch task count";
  "Verify: AC + RT count\nmatch task count" -> "mismatch?";
  "mismatch?" -> "fix before commit" [label="yes"];
  "fix before commit" -> "Commit + push + PR";
  "mismatch?" -> "Commit + push + PR" [label="no"];
  "Commit + push + PR" -> done;
}
```

---

## BEFORE START

Read `AGENTS.md` at repo root — project config. Derive all project-specific values from it, never assume. Extract these keys if present (fallback in brackets):

- `PLAN_GLOB` — glob pattern to find plan files [`docs/**/plans/**/*.md`]
- `TECH_SPEC_PATH` — path to tech spec [none]
- `PRD_PATH` — path to PRD [none]
- `BUGS_PATH` — path to drift/bugs log [`docs/bugs.md`]
- `GATE_COMMAND` — lint+build+test [`yarn build && cd src-tauri && cargo test`]
- `GATE_E2E_COMMAND` — e2e command [`none`]
- `BOUNDARY_RULES_REF` — where boundary rules live (e.g. "tech spec → Module boundaries") [`AGENTS.md`]
- `CODE_PATHS` — source directories to scan for existing code [`src/`, `app/`, `components/`, `lib/`]

If `AGENTS.md` absent, use fallbacks. Never hardcode app-specific paths.

---

## INPUT

Parse user input:
- **plan-id**: plan identifier (filename stem, slice name, or absolute path)

Examples: `refine slice-0`, `refine 2026-08-07-slice-0-walking-skeleton`.

---

## PHASE 1 — RESOLVE

Gate: do not proceed until paths resolved + branch created.

1. Resolve plan-id → plan path: if absolute path, use directly. Else glob `PLAN_GLOB` matching plan-id. If multiple match, use most recent (highest date prefix). If none → stop, report.
2. Verify plan file exists. If not → stop, report.
3. Read plan (full) in parallel with: tech spec (if `TECH_SPEC_PATH` set), PRD ACs section (if `PRD_PATH` set).
4. `git checkout main && git pull origin main`
5. Create branch: `refine/<plan-id>-ac-tests`
6. Check if implementation code exists — scan `CODE_PATHS`:
   ```bash
   for dir in <CODE_PATHS>; do
     ls "$dir"/*.{ts,tsx,js,jsx,py} 2>/dev/null
   done
   ```
   Record: `has_code = true` if any files found, `false` otherwise.

---

## PHASE 2 — ANALYZE (boost)

Gate: do not proceed until analysis complete.

Spawn subagents in parallel via `task` tool at depth 1.

### invoke code-explorer agents (1+, only if `has_code = true`)

Spawn 1 by default. If codebase large (>20 files in scope per plan), spawn more in parallel — one per subsystem (derive subsystems from `CODE_PATHS` + plan scope). Main agent decides count from plan scope.

Prompt per explorer:
```
Trace <TECH_SPEC_PATH or "none"> + plan <absolute plan path>. For each task in plan, identify:
1. Which tech spec section (or AGENTS.md section) defines this task's behavior
2. Acceptance signals from tech spec + PRD ACs (what must be true when task done)
3. Implementation drift — does existing code under <CODE_PATHS>
   differ from what plan describes? List file:line mismatches.
Return: per-task {task_num, spec_section, acceptance_signals[], drift[]}
```

If `has_code = false`: skip code-explorer entirely. Main agent derives acceptance_signals from tech spec + PRD AC reading (or AGENTS.md if no tech spec).

### invoke pr-test-analyzer agent (always, 1)

```
Analyze plan <absolute plan path> TDD steps. For each task, identify:
1. Test names already present in steps
2. Behaviors in tech spec + PRD ACs with NO corresponding test
3. Coverage gaps — edge cases, error paths, boundary conditions not tested
Return: per-task {task_num, existing_tests[], missing_tests[], gaps[]}
```

### Synthesize

Await both. Merge outputs into per-task analysis:
```
task_num: N
  spec_section: <from explorer or spec reading>
  acceptance_signals: [<from explorer or spec>]
  existing_tests: [<from analyzer>]
  missing_tests: [<from analyzer>]
  drift: [<from explorer>]
```

---

## PHASE 3 — AUGMENT

Gate: do not proceed until all tasks augmented.

Per task in plan, using `edit` tool:

### Insert Acceptance Criteria block

After `**Interfaces:**` section, before first `- [ ]` step:

```markdown
**Acceptance Criteria:**
- <criterion 1 from tech spec acceptance_signals or PRD ACs>
- <criterion 2>
- All Required Tests pass
- Gate passes clean: `<GATE_COMMAND>`
```

If task touches e2e or auth flows, add: `- E2E passes: \`<GATE_E2E_COMMAND>\``

If `BOUNDARY_RULES_REF` set, add: `- Boundary rules enforced (per <BOUNDARY_RULES_REF>)`

### Insert Required Tests block

After AC block:

```markdown
**Required Tests:**
- `test_name_1` — <behavior under test>
- `test_name_2` — <behavior>
- `<gap-fill from analyzer>` — <behavior>
```

### Fix inconsistencies

- Fix test names in TDD steps if inconsistent with Required Tests block (Required Tests is canonical)
- Update `**Interfaces: Produces**` if vague — make concrete (e.g. "working app" → `yarn tauri dev` opens window, `<GATE_COMMAND>` passes)

### Add new tasks if gaps found

If analyzer found a gap requiring new file/module (not just missing test — missing entire task):
- Add new `### Task N+1:` with full structure: Files / Interfaces / Acceptance Criteria / Required Tests / Steps
- If inserting mid-plan, renumber subsequent tasks (Task N+1 → Task N+2, etc.)

### Record implementation drift

If drift found (code differs from plan), log to `<BUGS_PATH>` under `## Refinement Drift` section (create if missing):

```markdown
## Refinement Drift — <plan-id>
**Date:** <YYYY-MM-DD> | **Plan:** <plan path>

1. Task <N>: <drift description> — <file:line> — <plan says X, code does Y>
```

Do NOT change plan to match code. Plan is spec; code is implementation. Drift logged for implementer/orchestrator to address in future task.

---

## PHASE 4 — VERIFY + DELIVER

Gate: do not proceed until verification passes.

### Verify

1. Scan: every `### Task` heading has `**Acceptance Criteria:**` + `**Required Tests:**` blocks:
   ```bash
   task_count=$(grep -c "^### Task" <plan>)
   ac_count=$(grep -c "^\*\*Acceptance Criteria:\*\*" <plan>)
   rt_count=$(grep -c "^\*\*Required Tests:\*\*" <plan>)
   test "$task_count" -eq "$ac_count" || echo "MISMATCH: tasks=$task_count AC=$ac_count"
   test "$task_count" -eq "$rt_count" || echo "MISMATCH: tasks=$task_count RT=$rt_count"
   ```
2. Scan: no `TODO` / `TBD` / placeholder in new blocks:
   ```bash
   grep -n "TODO\|TBD" <plan> | grep -A2 "Acceptance Criteria\|Required Tests"
   ```

If mismatches → fix before commit.

### Deliver

1. Commit: `refine(<plan-id>): add AC + Required Tests per task`
2. `git push -u origin refine/<plan-id>-ac-tests`
3. `gh pr create`:
   - Title: `refine(<plan-id>): add acceptance criteria + required tests`
   - Body:
     ```
     Tasks refined: <count>
     Drift items: <count or "none">
     Gaps filled: <count or "none">
     New tasks added: <count or "none">
     ```
4. Report: PR URL + summary

---

## CONSTRAINTS

- **Doc edits only** — no app code changes, no gate to run. Branch in main worktree.
- **code-explorer agent conditional** — only if implementation code exists. If empty (pre-implementation), skip, rely on tech spec + PRD ACs (or AGENTS.md) only.
- **pr-test-analyzer agent always runs** — analyzes plan TDD steps + tech spec regardless of code existence.
- **Never delete existing steps** — only add/fix. Preserve plan structure.
- **New tasks get full structure** — Files / Interfaces / Acceptance Criteria / Required Tests / Steps.
- **Renumber if inserting mid-plan** — update all subsequent task numbers + references.
- **Required Tests is canonical** — if step test name differs, fix step to match Required Tests.
- **No app-specific paths in this skill** — all paths read from AGENTS.md or passed in prompt. Boundary rules referenced via `BOUNDARY_RULES_REF`, not hardcoded.