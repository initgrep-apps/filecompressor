# UI Bugs Fix — Implementation Plan

> **Goal:** Fix 4 UI bugs identified in live-browser investigation (2026-10-08).
> **Plan:** 5 tasks, sequential. Each task: implement → review → merge → next.

## Task 1: Global overflow fix + sidebar inset min-width ✅

**Files:**
- `src/index.css` — add `html, body { overflow: hidden; }`
- `src/components/ui/sidebar.tsx` — `SidebarInset` add `min-w-0`

**Acceptance:**
- `html, body` overflow hidden in built CSS
- `SidebarInset` has `min-w-0` class
- No horizontal rubber-band pan in WKWebView at any window size

**Tests:** Manual visual check at 900×640 and 760×640

---

## Task 2: Kanban card active accent ✅

**Files:** `src/components/run/RunRow.tsx`

**Changes:**
- Compressing card: replace `CATEGORY_TONES[file.category].tint` + weak `ACCENT_SHADOW_PRIMARY` with:
  - `bg-primary/20` (stronger than `/12`)
  - `border-primary/30`
  - `shadow-[0_0_0_2px_var(--primary)]` (2px ring instead of inset shadow)
  - `animate-pulse` on the border for visual feedback
- Keep `bg-card` for other statuses

**Acceptance:**
- Compressing cards show visible primary ring with pulse animation
- Other statuses unchanged

**Tests:** Existing `RunRow` tests pass; visual confirmation at 900×640

---

## Task 3: Kanban responsive + scroll fixes

**Files:**
- `src/components/run/RunHeader.tsx`
- `src/components/run/KanbanBoard.tsx`
- `src/views/CompressView.tsx`

**Changes:**

1. **RunHeader.tsx** — header overflow fix:
   ```tsx
   <section className="... max-w-full overflow-hidden">
     <div className="flex flex-wrap items-center justify-between gap-3.5 max-w-full overflow-hidden">
   ```

2. **KanbanBoard.tsx** — scroll-end padding:
   ```tsx
   className="flex items-start gap-3 overflow-x-auto pb-3 pr-6"  // pr-4 → pr-6
   ```

3. **CompressView.tsx** — view container min-width:
   ```tsx
   <div className="flex min-h-0 flex-1 flex-col overflow-hidden min-w-0">
   ```

**Acceptance:**
- At 900×640: max scroll ≥ 120px, last lane fully visible at max scroll
- At 760×640: staging table fits, kanban scrollable, no horizontal overflow on body
- RunHeader buttons ("Cancel All"/"New Batch") fully visible at 900px
- No horizontal body overflow at any size

**Tests:** Live verification at 900×640 and 760×640

---

## Task 4: Sidebar footer left-align

**Files:** `src/App.tsx`

**Change:**
```tsx
<SidebarFooter>
  <div className="flex items-center justify-start px-3 py-2">  // justify-start
```

**Acceptance:** Footer text (version + GPLv3) left-aligned in both expanded and collapsed states.

---

## Task 5: Full gate

**Command:** `yarn build && yarn test && cd src-tauri && cargo test`

**Expected:** All green (698+ vitest, 421+ cargo). No new Rust changes expected.

---

## Notes
- Tasks 1-4 are independent enough to review in parallel but will be sequential per orchestrator
- Task 5 runs on main after Task 4 merges (branch already has all fixes)
- All changes are CSS/TSX only — no Rust source changes