# Bugs & Drift Log

## Refinement Drift — 2026-09-27-slice-3-settings
**Date:** 2026-09-28 | **Plan:** docs/superpowers/plans/2026-09-27-slice-3-settings.md

1. Task 1: Plan capabilities snippet omitted `opener:default`, which already exists in `src-tauri/capabilities/default.json:6-10` — applying verbatim would break opener. Plan fixed to preserve it.
2. Task 2: Plan specified `dirs = "5"`; AGENTS.md pins `dirs 7.0`. Plan fixed to `dirs = "7"`.
3. Task 3: Plan's `add_files` replacement body dropped canonicalization + canonical-path dedup (commands.rs:34-41), `is_file()` directory rejection, and poisoned-mutex recovery (commands.rs:60-63) — regression vs Slice 2. Plan fixed to extend `add_files_core` with a target resolver, not replace the body.
4. Task 3: `FileEntry::new` signature change breaks 10 single-arg call sites in models.rs tests + `models.rs:116` hardcoded `target_bytes == 200*1024` assertion. Plan now requires updating all call sites in the same task.
5. Task 3/5: Spec §7 lists `browse_folder` as a Rust IPC command; plan implements browse frontend-side via `@tauri-apps/plugin-dialog` instead. Divergence accepted (dialog capability already granted); spec table not updated. If native-side reveal/resolve semantics are needed later, add the Rust command then.
6. Task 5: Plan's hook had zero error handling, drifting from `useFileList.ts` convention (try/catch, non-throwing ops) established in slice-2 review (commit e3cca5d). Plan hook rewritten with try/catch + `error` state.
7. Task 6: Plan's Cancel button called `setSettings(settings)` — `setSettings` not returned by the hook (undefined). Cancel rewritten to `setDraft(settings)` via `handleCancel`.
8. Task 6: Plan ran `yarn dlx shadcn@latest add input select accordion separator` — `input.tsx`/`separator.tsx` already exist as customized base-ui variants (regeneration would overwrite); `select` unused in JSX (native `<select>` used). Reduced to `add accordion` only.
9. Task 7: Plan gate was `cd src-tauri && cargo test` only; AGENTS.md `GATE_COMMAND` = `yarn build && yarn test && cd src-tauri && cargo test`. Plan fixed to full gate.
10. Task 2/3: Quality-floor and target number inputs had no clamping; negative values would fail Rust `u64`/`u32` serde → save silently no-ops while UI shows saved. Plan adds `min`/`max` input attrs (0–100 %, 0–51 CRF) + corrupt-store fallback tests.
11. Task 3: Plan's `load_settings`/`save_settings_to_store` snippet used `try_store(path)` and `store_builder().build(path)` — neither exists in tauri-plugin-store 2.5.0 (2.5.0 API: `store(path) -> Result<Arc<Store>>`, `store_builder(path).build()`). Implemented with the 2.5.0 API: `app.store(STORE_FILE).ok()` for load, `app.store(STORE_FILE).or_else(|_| app.store_builder(STORE_FILE).build())` for save.
12. Task 3: Plan's `browse_folder` note confirmed — implemented frontend-side via `@tauri-apps/plugin-dialog` in Task 5; no Rust command added (per plan divergence already logged in item 5).