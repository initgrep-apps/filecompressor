# Open bugs, known gaps, and deferred work

Open items only. Resolved investigations belong in git history or as a durable rule in `docs/ci-process.md`. Design decisions belong in `docs/adr/`.

## Bugs

1. **Windows kanban input unverified** — slice #20's wheel-to-horizontal panning, thin scrollbar styling, and `select-none` need a real Windows build check (WebView2); cua-driver cannot synthesize wheel events on WebKit on macOS. Trackpad scroll feel on the new history table likewise needs a human pass.

No other open bugs; the known gaps and accepted limitations below still apply.

## Known gaps

| Gap | Impact |
|---|---|
| No row memoization or progress throttling | 1000-file history tables virtualize above 200 rows; compression views still re-render the active view on every `file:progress`; measurable webview CPU |
| File picker passes `filters: []` | Unsupported files are only rejected after selection |
| `history.jsonl` is re-folded on every `get_history` call | Acceptable while history stays small; cache the fold in `HistoryStore` keyed by `(mtime, len)` if history grows past ~10k records |
| Linux chrome unverified | Linux builds from source with native decorations while the shell renders non-macOS controls and drag surfaces; no packaging or acceptance run |
| Manual acceptance matrix not yet run on released builds | CI proves packages start and compress; the UI matrix in `docs/distribution-acceptance.md` is manual |

## Accepted limitations

- Output copies are normalized: metadata is stripped, HEIC/HEIF becomes JPEG, MOV becomes MP4 (`README.md`).
- macOS builds are ad-hoc signed and not notarized (ADR 0002); Windows builds are unsigned.
- Linux builds from source but is not packaged.
- No per-file target override, presets, HEIC output, EMF/WMF conversion, magic-byte detection, telemetry, or auto-update.

## CI follow-ups

1. **mv-shim cygpath tests are win32-skipped** — the freeze/unfreeze rollback tests drive a mock `mv` shim whose msys/cygpath behavior differs. POSIX coverage is complete. Next step: a real win32 shell session, then un-skip or port.
2. **Five lock-refusal tests are win32-skipped** — under msys bash, the pre-existing-lock path exits 1 with empty stdout+stderr, so refusal/recovery output cannot be asserted. Next step: observe `acquire_lock` under `bash -x` on Windows.
3. **SBOM does not attribute bundled DLL/dylib licenses** — `sbom.mjs` maps the five top-level engines only; the msys2 closure (freetype, glib2, harfbuzz, …) and mac dylib closure ship their own licenses. Next step: component-level license map, generated on the arm64 release row.
4. **`engines/*.staging-*` litter** — `prep-windows.mjs` work dirs survive a crashed prep and are not gitignored. Next step: ignore `src-tauri/binaries/engines/*.staging-*` and sweep stale dirs at prep start.
5. **Windows loader diagnostics still in `ci.yml`** — `cargo test --no-run`, PE-imports probe, and test-enumeration probe were added while the `0xc0000139` class was open. Decide: keep as canaries or remove; if kept, keep them non-flaky (they only print today).
6. **Release gate fails closed on a leftover draft** — re-running a partially failed tag requires `gh release delete <tag> --cleanup-tag --yes` first. Candidate: reuse an existing *draft* by database id, keep failing on a published release. Deferred because retries are rare and fail-closed is safer.
