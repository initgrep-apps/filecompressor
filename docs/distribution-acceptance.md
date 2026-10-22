# Distribution acceptance checklist

The automated half — `node scripts/ci/package-gate.mjs --triple <triple>` — proves the built package carries every engine where the app looks, that each engine starts, reports the manifest version, and completes a real operation, and that the app's own resolver finds all five. It does **not** exercise the UI layer: drag & drop, progress, output folder, history, error messaging. That layer is what this checklist covers.

Run it against the artifacts from a tagged release, on real machines.

## Install on macOS

macOS builds are ad-hoc signed and not notarized (ADR 0002), so Gatekeeper quarantines the download. The DMG mounts read-only and the mounted files carry no per-file quarantine mark; the mark lands on the copy, including the helper programs inside the bundle. Copy first, then strip it recursively from the installed app:

```bash
hdiutil attach ~/Downloads/*.dmg
cp -R /Volumes/<volume-name>/*.app /Applications/
hdiutil detach /Volumes/<volume-name>
xattr -dr com.apple.quarantine /Applications/<app-name>.app
```

The alternative is **System Settings → Privacy & Security → Open Anyway** after the first launch attempt. On macOS 15+ that is the only route when the command is not used.

## Install on Windows

Run the installer. When SmartScreen warns, choose **More info** → **Run anyway**. Windows builds are unsigned.

## Acceptance matrix

One row per platform × file type. Record the artifact version, the date, and the machine.

| platform | PNG | MP4 | PDF | DOCX |
|---|---|---|---|---|
| macOS arm64 | | | | |
| macOS x64 | | | | |
| Windows x64 (NSIS) | | | | |
| Windows x64 (MSI) | | | | |
| Windows arm64 | | | | |

Mark every row explicitly. The CI package gate only opens the **NSIS** installer; the **MSI** payload is built from the same Tauri resource map but is not CI-gated, so the MSI row is a real gap if it is not run. A platform with no available hardware is recorded as "not run — no hardware", not left blank and not assumed green.

Use a real input for each type, not a synthetic zero-byte file: a PNG with metadata, an MP4 with audio, a text-bearing PDF, and a DOCX with an embedded image.

## What to record on failure

- the platform and the exact artifact version;
- the file type and the input file;
- the **exact error text** the app showed;
- whether the helper produced any output file (size, and whether it opens).

A screenshot of the app's error is enough if it contains the text. Add the row to `docs/bugs.md` with the date.

## Where the automated half lives

`node scripts/ci/package-gate.mjs --triple <triple>` (also run by every release row in `.github/workflows/release.yml`). Pass `--bundle-dir <path>` to point it at a specific package — the `.app` path on macOS or the `-setup.exe` file on Windows — when the package is not in the default `src-tauri/target/<triple>/release/bundle/` location.

What the gate opens: the built `.app` on macOS and the NSIS installer payload on Windows. It does not open the `.dmg`, the `.app.tar.gz`, or the MSI — `hdiutil attach` plus the documented install is the manual check for the macOS download, and the MSI row above is the manual check for that installer.
