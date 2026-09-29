# Slice 4b: Self-Contained Sidecar Binaries — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The bundled vips sidecar carries every dylib it needs inside the app — no absolute non-system paths — proven by a machine-verifiable audit gate that runs in the project gate.

**Architecture:** Two scripts: `bundle-vips-macos.sh` collects every transitive dylib of the bundled sidecar into `src-tauri/frameworks/`, rewrites all load commands to `@rpath`, adds rpaths for both the bundled (`Contents/MacOS → ../Frameworks`) and dev (`target/debug → ../../frameworks`) layouts, and ad-hoc signs everything. `audit-sidecars.sh` then gates every binary in `src-tauri/binaries/` and every collected dylib in `src-tauri/frameworks/`: only `@rpath/…`, system frameworks (`/System/Library/`, `/usr/lib/system/`), and musl-static ELF are allowed. A Rust test invokes the audit so `cargo test` is the gate.

**Tech Stack:** bash, macOS `otool`/`install_name_tool`/`codesign`, Tauri 2 bundle config, Rust tests

## Global Constraints

- **Never ship a sidecar that asks the user's machine for parts** — every engine binary must be self-contained per platform: no absolute non-system dylib paths (macOS policy: `@rpath/*` + `/usr/lib/system/*` + `/System/Library/*` + `/usr/lib/*` allowed; anything else absolute = audit failure. Linux policy: ELF engines must be musl-static — `ldd` must fail with "not a dynamic executable". Windows PE artifacts are sourced later and skipped by the gate with an explicit comment).
- **Audit gate runs in the project gate** — `cargo test` invokes `scripts/audit-sidecars.sh` via the Rust test `sidecars_are_self_contained` in `src-tauri/src/sidecar.rs`; a failing audit fails the gate.
- **Bundled dylibs are committed** — `src-tauri/frameworks/*.dylib` are part of the repo (needed for `yarn tauri build`); `bundle.macOS.frameworks: ["frameworks/*.dylib"]` added to `src-tauri/tauri.conf.json`.
- **Dev mode must keep working** — after the rewrite, `cd src-tauri && cargo test -- --ignored` (real-vips smoke) must still pass: dev exe resolves dylibs via the `@executable_path/../../frameworks` rpath pointing at `src-tauri/frameworks/`.
- **Source of truth stays `src-tauri/binaries/`** — the sidecar is rewritten in-place there (never duplicated); `yarn tauri build` copies it into the bundle. Re-running the bundle script must be idempotent (`|| true` on `add_rpath`; the audit verifies the final state, not the run).
- **License compliance:** libvips is LGPLv3; dynamic dylib bundling is the LGPL-native path (users can swap libs). App is GPLv3 — compliant.
- **Conventional commits; no comments in Rust code** (bash scripts carry plan-mandated comments only).

## File Structure

```
scripts/
├── audit-sidecars.sh       # gate: audits binaries/ + frameworks/ per-platform policy
└── bundle-vips-macos.sh    # collects + rewrites + signs the macOS vips sidecar chain

src-tauri/
├── frameworks/             # committed transitive dylibs (bundled to Frameworks/)
│   └── *.dylib
├── binaries/vips-<triple>  # rewritten in-place (id → @rpath, loads → @rpath, rpaths added)
├── src/sidecar.rs          # (modify) adds gate test sidecars_are_self_contained
└── tauri.conf.json         # (modify) bundle.macOS.frameworks: ["frameworks/*.dylib"]

docs/bugs.md                # (modify) mark dylib item resolved
```

## Acceptance Criteria

1. `bash scripts/audit-sidecars.sh` fails BEFORE the fix, printing every absolute non-system path found (TDD RED).
2. After `bundle-vips-macos.sh`, every binary in `src-tauri/binaries/` lists only `@rpath/*` + system paths; every dylib in `src-tauri/frameworks/` has id `@rpath/<name>` and loads only `@rpath/*` + system paths (TDD GREEN).
3. `cd src-tauri && cargo test -- --ignored` passes: `sidecar_binary_exists_for_current_target_triple` + `real_vips_compresses_oversized_jpeg_to_target` (dev layout works).
4. `cd src-tauri && cargo test sidecars_are_self_contained` passes → gate is wired into `yarn build && yarn test && cd src-tauri && cargo test`.
5. `src-tauri/tauri.conf.json` contains `bundle.macOS.frameworks` and remains valid JSON.
6. `docs/bugs.md` dylib item updated to resolved with the audit-gate reference.

---

## Task 1: Self-Contained vips Sidecar + Audit Gate

**Files:**
- Create: `scripts/audit-sidecars.sh`
- Create: `scripts/bundle-vips-macos.sh`
- Create: `src-tauri/frameworks/` (populated by the bundle script)
- Modify: `src-tauri/tauri.conf.json` (add `bundle.macOS.frameworks`)
- Modify: `src-tauri/src/sidecar.rs` (add gate test)
- Modify: `docs/bugs.md` (mark item resolved)

**Interfaces:**
- Consumes: bundled sidecar `src-tauri/binaries/vips-<triple>` (Task 6, PR #31); `sidecar_filename(name)` from `src-tauri/src/sidecar.rs:22-30`; Tauri bundle config `src-tauri/tauri.conf.json:29-43`.
- Produces: gate test `sidecars_are_self_contained` (later slices rely on it staying green); bundle script `scripts/bundle-vips-macos.sh` reusable by slices 5-8 engine-bundle steps.

**Required Tests:**
- `sidecars_are_self_contained` (Rust, in sidecar.rs `#[cfg(test)]`) — runs `bash scripts/audit-sidecars.sh`, asserts exit 0. Fails while any sidecar/dylib lists absolute non-system paths.

- [x] **Step 1: Write the audit gate script (expects current state to FAIL)**

```bash
#!/usr/bin/env bash
# Audits every sidecar binary in src-tauri/binaries/ and every collected dylib
# in src-tauri/frameworks/: absolute non-system dylib paths are a release bug
# (dev-only paths like /opt/homebrew abort on end-user machines).
# Exit 0 = self-contained. Exit 1 = findings printed.
set -u

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BIN_DIR="$ROOT/src-tauri/binaries"
FRAMEWORKS_DIR="$ROOT/src-tauri/frameworks"

failures=()

audit_macho() {
  local file="$1"
  while IFS= read -r path; do
    [ -z "$path" ] && continue
    case "$path" in
      @rpath/*|/usr/lib/system/*|/System/Library/*|/usr/lib/*) ;;
      /*)
        printf 'FAIL %s: absolute non-system dylib path: %s\n' "$file" "$path"
        failures+=("$file")
        ;;
      *)
        printf 'FAIL %s: relative dylib path: %s\n' "$file" "$path"
        failures+=("$file")
        ;;
    esac
  done < <(otool -L "$file" | tail -n +2 | awk '{print $1}' | sort -u)
}

audit_elf() {
  local file="$1"
  if ldd "$file" >/dev/null 2>&1; then
    printf 'FAIL %s: dynamically linked — ELF engines must be musl-static\n' "$file"
    failures+=("$file")
  fi
}

if [ ! -d "$BIN_DIR" ]; then
  printf 'FAIL binaries dir missing: %s\n' "$BIN_DIR"
  exit 1
fi

for f in "$BIN_DIR"/*; do
  [ -f "$f" ] || continue
  kind=$(file -b "$f")
  case "$kind" in
    *"Mach-O"*) audit_macho "$f" ;;
    *"ELF"*) audit_elf "$f" ;;
    *"PE32"*) : ;;
    *) printf 'FAIL unknown binary type: %s (%s)\n' "$f" "$kind"; failures+=("$f") ;;
  esac
done

if [ -d "$FRAMEWORKS_DIR" ]; then
  for lib in "$FRAMEWORKS_DIR"/*.dylib; do
    [ -e "$lib" ] || continue
    audit_macho "$lib"
  done
fi

if [ ${#failures[@]} -gt 0 ]; then
  printf 'sidecar audit: %d file(s) not self-contained\n' "${#failures[@]}"
  exit 1
fi

printf 'sidecar audit: PASS (%d binaries, %d framework dylibs)\n' \
  "$(find "$BIN_DIR" -type f | wc -l)" \
  "$( [ -d "$FRAMEWORKS_DIR" ] && find "$FRAMEWORKS_DIR" -name '*.dylib' | wc -l || echo 0 )"
```

Run:
```bash
chmod +x scripts/audit-sidecars.sh && bash scripts/audit-sidecars.sh
```
Expected: exit 1, printing `FAIL ... absolute non-system dylib path: /opt/homebrew/...` lines for the vips sidecar.

- [x] **Step 2: Write the macOS bundling script (the fix)**

```bash
#!/usr/bin/env bash
# Makes the bundled vips sidecar self-contained on macOS.
# 1. Recursively collects every transitive non-system dylib into
#    src-tauri/frameworks/ (single source per test run, committed).
# 2. Rewrites every load command (dylibs + sidecar) to @rpath/<basename>.
# 3. Adds rpaths for both layouts: bundled (Contents/MacOS → ../Frameworks)
#    and dev (src-tauri/target/<profile> → ../../frameworks).
# 4. Ad-hoc signs everything (install_name_tool invalidates signatures).
# Re-runnable: add_rpath failures are tolerated; the audit verifies final state.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BIN="$ROOT/src-tauri/binaries"
FRAMEWORKS="$ROOT/src-tauri/frameworks"
TRIPLE="$(rustc -Vv | grep '^host:' | sed 's/host: //')"
SIDECAR="$BIN/vips-$TRIPLE"

[ -f "$SIDECAR" ] || { printf 'FAIL sidecar missing: %s\n' "$SIDECAR"; exit 1; }
[ "$(uname)" = "Darwin" ] || { printf 'FAIL macOS only\n'; exit 1; }

system_path() {
  case "$1" in
    /usr/lib/system/*|/System/Library/*|/usr/lib/*|@*) return 0 ;;
    /*) return 1 ;;
    *) return 0 ;;
  esac
}

collect() {
  local src="$1"
  local base="$(basename "$src")"
  local dest="$FRAMEWORKS/$base"
  [ -f "$dest" ] && return 0
  mkdir -p "$FRAMEWORKS"
  cp "$src" "$dest"
  chmod u+w "$dest"
  for dep in $(otool -L "$src" | tail -n +2 | awk '{print $1}'); do
    system_path "$dep" || collect "$dep"
  done
}

rewrite() {
  local file="$1"
  chmod u+w "$file"
  for dep in $(otool -L "$file" | tail -n +2 | awk '{print $1}'); do
    system_path "$dep" || install_name_tool -change "$dep" "@rpath/$(basename "$dep")" "$file"
  done
}

rm -rf "$FRAMEWORKS"

for dep in $(otool -L "$SIDECAR" | tail -n +2 | awk '{print $1}'); do
  system_path "$dep" || collect "$dep"
done

for lib in "$FRAMEWORKS"/*.dylib; do
  install_name_tool -id "@rpath/$(basename "$lib")" "$lib"
done
rewrite "$SIDECAR"

install_name_tool -add_rpath "@executable_path/../Frameworks" "$SIDECAR" 2>/dev/null || true
install_name_tool -add_rpath "@executable_path/../../frameworks" "$SIDECAR" 2>/dev/null || true

codesign --force --sign - "$SIDECAR" 2>/dev/null || true
for lib in "$FRAMEWORKS"/*.dylib; do
  codesign --force --sign - "$lib" 2>/dev/null || true
done
```

Run:
```bash
chmod +x scripts/bundle-vips-macos.sh && bash scripts/bundle-vips-macos.sh
```

Then verify the gate flips to GREEN:
```bash
bash scripts/audit-sidecars.sh
```
Expected: `sidecar audit: PASS` (only `@rpath/*` + system paths; dylib count matches collected files).

- [x] **Step 3: Add frameworks to tauri.conf.json**

In `src-tauri/tauri.conf.json`, add `macOS.frameworks` inside the existing `bundle` section (keep every existing key; valid JSON):

```json
"bundle": {
    "active": true,
    "targets": "all",
    "externalBin": [
      "binaries/vips"
    ],
    "macOS": {
      "frameworks": ["frameworks/*.dylib"]
    },
    "icon": [
      "icons/32x32.png",
      "icons/128x128.png",
      "icons/128x128@2x.png",
      "icons/icon.icns",
      "icons/icon.ico"
    ]
  }
```

Verify JSON validity:
```bash
python3 -c "import json; json.load(open('src-tauri/tauri.conf.json'))"
```
Expected: no output (valid).

- [x] **Step 4: Add the gate test to sidecar.rs**

Append inside the existing `#[cfg(test)] mod tests` in `src-tauri/src/sidecar.rs`:

```rust
    #[cfg(unix)]
    #[test]
    fn sidecars_are_self_contained() {
        let script = format!(
            "{}/../scripts/audit-sidecars.sh",
            env!("CARGO_MANIFEST_DIR")
        );
        let out = std::process::Command::new("bash")
            .arg(&script)
            .output()
            .expect("audit-sidecars.sh runs");
        assert!(
            out.status.success(),
            "self-contained audit failed:\nstdout:\n{}\nstderr:\n{}",
            String::from_utf8_lossy(&out.stdout),
            String::from_utf8_lossy(&out.stderr),
        );
    }
```

Run:
```bash
cd src-tauri && cargo test sidecars_are_self_contained
```
Expected: PASS (1 passed).

- [x] **Step 5: Verify dev mode still works**

```bash
cd src-tauri && cargo test -- --ignored
```
Expected: 2 passed (`sidecar_binary_exists_for_current_target_triple` + `real_vips_compresses_oversized_jpeg_to_target`) — the dev exe resolves dylibs via the `@executable_path/../../frameworks` rpath.

- [x] **Step 6: Close the bugs.md item**

Edit `docs/bugs.md` item 1 (the Homebrew dylib entry): mark resolved —
```markdown
1. RESOLVED (PR #<slice-4b-pr>): vips sidecar is self-contained — transitive dylibs collected into src-tauri/frameworks/ (committed, bundled via bundle.macOS.frameworks), all load commands rewritten to @rpath, ad-hoc signed. Audit gate scripts/audit-sidecars.sh runs in cargo test (sidecars_are_self_contained). Clean-VM launch verification still manual before release.
```

- [x] **Step 7: Full gate + commit**

```bash
yarn build && yarn test && cd src-tauri && cargo test
```
Expected: all green.

```bash
git add -A
git commit -m "feat: self-contained vips sidecar with audit gate"
git push
```
