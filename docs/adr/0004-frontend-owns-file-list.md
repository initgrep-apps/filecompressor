# The frontend owns the file list; Rust mirrors it

`CompressionProvider` mounts above the view switch and is the only writer of the staged file list; every mutation calls a Rust command first and stores the returned list. Rust keeps its own `FileListState` copy, and during a batch the events are authoritative. Making Rust the single source of truth with a `get_files` refetch was rejected as too large for the problem: it needs status writeback plus event replay to survive a remount.

## Considered Options

- **Frontend-owned list + Rust mirror (chosen)** — the list survives navigation because the provider never unmounts, and listeners stay alive for the whole app.
- **Keep views mounted and hidden** — traps future views in one component tree and does not solve listeners dying with a remount.
- **Backend as truth** — correct in principle, but needs a status writeback path and replay of events missed while a view was unmounted. Deferred, not forgotten.

## Consequences

- Two copies of the list exist and can drift; the rule is that the frontend always adopts the command response and never edits status optimistically.
- A run keeps going when the user opens History or Settings.
