# Bugs and improvements

## Bugs
- when the a batch is compress, the new button shows up and when clicked -> the old list shows in the drag-drop with status. i think it is not required. that place is a staging zone and must be cleared when a new batch is click. either clear it before or later. does not matter but we shall get to the empty screen since it is a new batch


## Improvements:
- UI - 

## Refinement Drift — 2026-10-07-ui-overhaul-bugs
**Date:** 2026-10-07 | **Plan:** docs/superpowers/plans/2026-10-07-ui-overhaul-bugs.md

1. Task 2: plan says "add clearList to destructure" — already destructured at src/providers/CompressionProvider.tsx:55; only endRun body changes
2. Task 2: 5 existing CompressView tests break on B1 — :285-295, :297-308 (consolidate), :321-351 + :418-441 (empty-staging nav plumbing), :389-416 pins the buggy behavior in its title ("returns with final statuses still listed") — delete/rewrite
3. Task 4: App.test.tsx:140-178 asserts data-slot="sidebar-menu-badge" — SidebarMenuBadge removed; rewrite against count-pill contract
4. Task 5: tint opacity normalizes /10 → /12; token text fields must preserve current classes (text-blue-600 etc.) or DropZone.test.tsx:156-175 breaks
5. Task 6: DropZone.test.tsx:247-291 pins the exact inverse of the new contract (mono string present + text-swap-on-drag) — rewrite in task
6. Task 8: chipFor best_effort tone (inline amber, RunRow.tsx:62) stays amber; done accent + lane-tinted bg are net-new; NAME_TONES/RESULT_STATUSES preserved
7. Task 9: FileList.tsx:132 Badge variant="secondary" base classes may mask tinted className — assert merged output; StatusBadge :47-84 scope extended (best_effort red→amber)
8. Task 10: plan line list omitted :360-364 (session file-table category badges) + :594 (category chip dots) — added
9. Task 12: ref target label stale — RunMonitor wrapper is CompressView.tsx:103 (no `relative`); cramped-detection must observe kanban-board content element (spec §8). RO global stub needed in test-setup.ts or App/History/Settings suites crash at gate
10. Spec conflict resolved: UI spec §4 best_effort=amber supersedes base spec §4 Status Colors (Best effort | destructive (red)) — base spec row not amended; FileList was split (status red, kanban chip amber), unified to amber in Task 9
11. Base spec §4:258 "Compressing | primary (green, pulsing)" — no pulse exists in code and neither UI spec nor plan adds one; treated as dropped requirement

## Live verification — Task 12 (2026-10-08, agent-browser at 900×588 Tauri-equivalent, mock `__TAURI_INTERNALS__` IPC)

- **Kanban last lane clipped ~3px at full scroll (900px viewport).** Lanes are 318px + 12px gap; `pr-3` (12px) on the scroll container leaves the right-edge pill boxes (lane count pill right = 903 > 900) 3px past the viewport at max scroll; lane box extends 16px past. Card text/chips end at 895 (=visible); only pill padding + 1px border are cut — visible as a sliver in pixel zoom. No dimming/fade overlay (Task 10 fix holds). Fix candidate: bump scroll-container right padding to `pr-4`+ or add `mr-1` on lane pill. Belongs to Task 10 scope (KanbanBoard padding), filed here for triage.
- Staging table fit, sidebar auto-collapse cycle (cramped→collapsed→grow→expanded), and compact-bar chip wrapping all verified live and passing; history/session cards and compressed-state kanban cards still need an interactive Tauri dev-build pass (mock IPC can't drive real runs) — deferred to user manual verification.
