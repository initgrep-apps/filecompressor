# History is an append-only JSONL file, not a database

`history.jsonl` in the app data dir records a session start, one record per file, and a session end. Queries parse the whole retained file and filter/page core-side; retention rewrites it atomically through a temp file and rename. An embedded database was rejected: it adds a native dependency, a build variant, and a migration baseline to an offline app whose history is one user's audit trail.

## Considered Options

- **JSONL append-only (chosen)** — crash-safe appends, no new dependency, readable and recoverable by hand.
- **SQLite/embedded DB** — fast queries and an index, at the cost of a native build dependency and migrations.
- **Frontend-side filtering of loaded rows** — would search a partial dataset once pagination exists.

## Consequences

- Query cost grows with file size; accepted to thousands of sessions, with page-level caching as the stated next step.
- Malformed lines are skipped and counted (`skippedLines`), never fatal.
- Every record is appended as it happens; the app never rewrites history except during retention trim.
