// File Size Optimizer — offline batch file compression
// Copyright (C) 2026 File Size Optimizer Contributors
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU General Public License as published by
// the Free Software Foundation, either version 3 of the License, or
// (at your option) any later version.
//
// This program is distributed in the hope that it will be useful,
// but WITHOUT ANY WARRANTY; without even the implied warranty of
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
// GNU General Public License for more details.
//
// You should have received a copy of the GNU General Public License
// along with this program.  If not, see <https://www.gnu.org/licenses/>.

use crate::engine::progress::ProgressSender;
use crate::engine::result::{CompressionError, CompressionResult};
use crate::models::Category;
use crate::settings::QualityFloors;
use crate::sidecar::resolve_sidecar_candidate;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::time::Duration;
use tokio_util::sync::CancellationToken;

const WAIT_POLL_MILLIS: u64 = 30;
const STDERR_TAIL_CHARS: usize = 500;
const STDERR_JOIN_TIMEOUT: Duration = Duration::from_secs(5);

/// Exhaustive registry of engines a processor may require. Taking this enum
/// instead of a `&str` makes `require` total: there is no stringly-typed
/// wildcard arm left to swallow misspellings at runtime.
///
/// `Ffmpeg`/`Ffprobe` are consumed by the video slice (6) — they register the
/// resolution wiring (`SidecarPaths::resolve_for`) ahead of their processor.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[allow(dead_code)]
pub enum SidecarName {
    Vips,
    Ffmpeg,
    Ffprobe,
    Gs,
    Qpdf,
}

impl SidecarName {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Vips => "vips",
            Self::Ffmpeg => "ffmpeg",
            Self::Ffprobe => "ffprobe",
            Self::Gs => "gs",
            Self::Qpdf => "qpdf",
        }
    }
}

/// Resolved sidecar binary paths handed to every processor. Engines whose
/// binary is not present resolve to `None` — each processor enforces the
/// engines it actually needs via `require`, so a missing or future engine
/// (ffmpeg, ffprobe) never breaks unrelated categories. `resolve` swallows
/// IO and non-UTF-8 errors to `None`, so `None` means "not resolved",
/// slightly narrower than every possible failure mode.
#[derive(Debug)]
pub struct SidecarPaths {
    pub vips: Option<String>,
    pub ffmpeg: Option<String>,
    pub ffprobe: Option<String>,
    pub gs: Option<String>,
    pub qpdf: Option<String>,
}

impl SidecarPaths {
    pub fn resolve_for(exe_dir: &Path) -> SidecarPaths {
        let resolve = |name: &str| resolve_sidecar_candidate(exe_dir, name).ok();
        SidecarPaths {
            vips: resolve("vips"),
            ffmpeg: resolve("ffmpeg"),
            ffprobe: resolve("ffprobe"),
            gs: resolve("gs"),
            qpdf: resolve("qpdf"),
        }
    }

    pub fn require(&self, name: SidecarName) -> Result<&str, CompressionError> {
        let resolved = match name {
            SidecarName::Vips => &self.vips,
            SidecarName::Ffmpeg => &self.ffmpeg,
            SidecarName::Ffprobe => &self.ffprobe,
            SidecarName::Gs => &self.gs,
            SidecarName::Qpdf => &self.qpdf,
        };
        resolved.as_deref().ok_or_else(|| {
            CompressionError::SidecarNotFound(name.as_str().to_string())
        })
    }
}

/// The best attempt seen so far in a multi-pass search. `size` is the byte
/// length of the output at `path`; `strategy`/`quality` describe the pass
/// that produced it. `keep_smaller_in` is the single smallest-wins
/// enforcement point shared by every processor's best-effort selection.
#[derive(Debug, Clone)]
pub struct BestAttempt {
    pub size: u64,
    pub path: PathBuf,
    pub strategy: String,
    pub quality: u32,
}

impl BestAttempt {
    /// Records `candidate` into `best` only when it is strictly smaller
    /// (ties keep the earlier attempt). Returns true when replaced.
    pub fn keep_smaller_in(best: &mut Option<BestAttempt>, candidate: BestAttempt) -> bool {
        let replaces = best.as_ref().map(|b| candidate.size < b.size).unwrap_or(true);
        if replaces {
            *best = Some(candidate);
        }
        replaces
    }
}

/// Copies `from` to the final output path and reports completion. One
/// enforcement point for the fs::copy + send_progress(100) + result triple
/// shared by every processor's deliverable paths (early exit, fitting pass,
/// best-effort).
pub fn deliver_output(
    from: &Path,
    output: &Path,
    size: u64,
    strategy_used: String,
    quality_used: u32,
    met_target: bool,
    progress: &ProgressSender,
) -> Result<CompressionResult, CompressionError> {
    std::fs::copy(from, output)
        .map_err(|e| CompressionError::OutputFileError(e.to_string()))?;
    progress.send_progress(100);
    Ok(CompressionResult {
        output_path: output.to_path_buf(),
        compressed_size: size,
        quality_used,
        met_target,
        strategy_used,
    })
}

/// Last ~`STDERR_TAIL_CHARS` characters of sidecar stderr — the failure
/// reason is almost always the last thing printed.
fn stderr_tail(bytes: &[u8]) -> String {
    let stderr = String::from_utf8_lossy(bytes).into_owned();
    let tail: String = {
        let count = stderr.chars().count();
        if count > STDERR_TAIL_CHARS {
            stderr.chars().skip(count - STDERR_TAIL_CHARS).collect()
        } else {
            stderr
        }
    };
    let detail = tail.trim_end();
    if detail.is_empty() {
        "<no stderr>".to_string()
    } else {
        detail.to_string()
    }
}

/// A sidecar exit code that, for this engine, still counts as pass success
/// and leaves output validation to the caller (e.g. qpdf exit 2 = "warnings,
/// output still valid"). Exit-code policy is per-engine, so the engine layer
/// takes it as a predicate instead of hardcoding tool quirks.
pub type ToleratedExit = fn(&str, Option<i32>) -> bool;

/// No tolerated exit codes: any non-zero exit fails the pass. Default for
/// engines whose tools have no "warning" exit code (vips, gs, ffmpeg).
pub fn strict_exit(_label: &str, _code: Option<i32>) -> bool {
    false
}

/// Runs a sidecar to completion, draining stderr on a reader thread so a
/// chatty tool can never deadlock on a full pipe. Polls the cancel token:
/// a cancel SIGKILLs the child process first, then surfaces as `Cancelled`
/// — cancelled beats exit code.
///
/// SIGKILL trade-off: only the direct child is killed, so grandchild
/// processes it spawned survive and hold the stderr pipe open. On cancel
/// the drain thread is therefore abandoned, not joined (it self-terminates
/// once the stragglers exit). On a normal exit the join is bounded: a
/// lingering grandchild that outlives `STDERR_JOIN_TIMEOUT` forces a warned
/// diagnostic loss instead of an indefinite block, since the child itself
/// is already reaped and the pass result must not depend on stragglers.
pub fn run_sidecar(
    sidecar_path: &str,
    label: &'static str,
    args: &[String],
    cancel_token: &CancellationToken,
    tolerated_exit: ToleratedExit,
) -> Result<(), CompressionError> {
    let mut child = std::process::Command::new(sidecar_path)
        .args(args)
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .map_err(|e| {
            CompressionError::SidecarFailed(format!("Failed to start {}: {}", label, e))
        })?;

    let mut stderr_pipe = child.stderr.take();
    let stderr_reader = std::thread::spawn(move || {
        let mut buffer = Vec::new();
        if let Some(pipe) = stderr_pipe.as_mut() {
            if let Err(e) = pipe.read_to_end(&mut buffer) {
                eprintln!("warn: {label}: stderr drain failed, diagnostics partial: {e}");
            }
        }
        buffer
    });

    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) => {
                if cancel_token.is_cancelled() {
                    // Grandchildren survive SIGKILL and hold the stderr
                    // pipe — the drain thread is abandoned, not joined.
                    let _ = child.kill();
                    let _ = child.wait();
                    return Err(CompressionError::Cancelled);
                }
                std::thread::sleep(std::time::Duration::from_millis(WAIT_POLL_MILLIS));
            }
            Err(e) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(CompressionError::SidecarFailed(format!(
                    "{} wait failed: {}",
                    label, e
                )));
            }
        }
    };

    // A cancel racing the final poll must not be lost: the child exits 0,
    // the caller would deliver Done, and no one re-checks the token. Verify
    // once more after reaping — cancelled beats exit code.
    if cancel_token.is_cancelled() {
        return Err(CompressionError::Cancelled);
    }
    let stderr_bytes = match recv_stderr_bounded(stderr_reader) {
        Some(bytes) => bytes,
        None => {
            eprintln!(
                "warn: {label} stderr drain did not finish within {:?} after exit \
                 (lingering grandchild); diagnostics unavailable",
                STDERR_JOIN_TIMEOUT
            );
            b"<stderr unreadable>".to_vec()
        }
    };

    if !status.success() && !tolerated_exit(label, status.code()) {
        if cancel_token.is_cancelled() {
            return Err(CompressionError::Cancelled);
        }
        return Err(CompressionError::SidecarFailed(format!(
            "{} exited with code {:?}: {}",
            label,
            status.code(),
            stderr_tail(&stderr_bytes)
        )));
    }
    Ok(())
}

/// Bounded wait on the drain thread: poll `is_finished`, then join. A
/// `None` return means "abandoned" — dropping the handle detaches the
/// thread, which self-terminates once the pipe closes.
fn recv_stderr_bounded(handle: std::thread::JoinHandle<Vec<u8>>) -> Option<Vec<u8>> {
    let deadline = std::time::Instant::now() + STDERR_JOIN_TIMEOUT;
    loop {
        if handle.is_finished() {
            return handle.join().ok();
        }
        if std::time::Instant::now() >= deadline {
            return None;
        }
        std::thread::sleep(std::time::Duration::from_millis(WAIT_POLL_MILLIS));
    }
}

pub trait CompressionProcessor: Send + Sync {
    fn category(&self) -> Category;
    fn supported_extensions(&self) -> &[&str];

    #[allow(clippy::too_many_arguments)]
    fn compress_to_target(
        &self,
        input: &Path,
        output: &Path,
        target_bytes: u64,
        quality_floor: &QualityFloors,
        cancel_token: CancellationToken,
        progress: ProgressSender,
        sidecar_paths: &SidecarPaths,
        temp_dir: &Path,
    ) -> Result<CompressionResult, CompressionError>;
}

#[cfg(test)]
mod tests {
    use super::*;

    fn empty_paths() -> SidecarPaths {
        SidecarPaths {
            vips: None,
            ffmpeg: None,
            ffprobe: None,
            gs: None,
            qpdf: None,
        }
    }

    #[test]
    fn require_maps_every_sidecar_name_to_its_field() {
        let paths = SidecarPaths {
            vips: Some("/bin/vips".to_string()),
            ffmpeg: Some("/bin/ffmpeg".to_string()),
            ffprobe: Some("/bin/ffprobe".to_string()),
            gs: Some("/bin/gs".to_string()),
            qpdf: Some("/bin/qpdf".to_string()),
        };
        for (name, expected) in [
            (SidecarName::Vips, "/bin/vips"),
            (SidecarName::Ffmpeg, "/bin/ffmpeg"),
            (SidecarName::Ffprobe, "/bin/ffprobe"),
            (SidecarName::Gs, "/bin/gs"),
            (SidecarName::Qpdf, "/bin/qpdf"),
        ] {
            assert_eq!(paths.require(name).unwrap(), expected, "name: {name:?}");
        }
    }

    #[test]
    fn require_returns_sidecar_not_found_for_unset_engine() {
        let paths = empty_paths();
        let err = paths.require(SidecarName::Gs).unwrap_err();
        assert!(
            matches!(err, CompressionError::SidecarNotFound(ref n) if n == "gs"),
            "got: {:?}",
            err
        );
        assert_eq!(err.to_string(), "Engine error: gs not available");
    }

    #[test]
    fn sidecar_name_as_str_covers_all_variants() {
        let names = [
            SidecarName::Vips,
            SidecarName::Ffmpeg,
            SidecarName::Ffprobe,
            SidecarName::Gs,
            SidecarName::Qpdf,
        ];
        for name in names {
            match name {
                SidecarName::Vips => assert_eq!(name.as_str(), "vips"),
                SidecarName::Ffmpeg => assert_eq!(name.as_str(), "ffmpeg"),
                SidecarName::Ffprobe => assert_eq!(name.as_str(), "ffprobe"),
                SidecarName::Gs => assert_eq!(name.as_str(), "gs"),
                SidecarName::Qpdf => assert_eq!(name.as_str(), "qpdf"),
            }
        }
    }

    #[test]
    fn best_attempt_keep_smaller_in_keeps_strictly_smallest() {
        let mut best: Option<BestAttempt> = None;

        assert!(BestAttempt::keep_smaller_in(
            &mut best,
            BestAttempt {
                size: 500,
                path: PathBuf::from("a"),
                strategy: "qpdf-lossless".to_string(),
                quality: 100,
            },
        ));
        let first = best.as_ref().unwrap();
        assert_eq!(first.size, 500);
        assert_eq!(first.path, PathBuf::from("a"));

        assert!(!BestAttempt::keep_smaller_in(
            &mut best,
            BestAttempt {
                size: 500,
                path: PathBuf::from("tie"),
                strategy: "tie".to_string(),
                quality: 1,
            },
        ));
        assert_eq!(best.as_ref().unwrap().path, PathBuf::from("a"));

        assert!(BestAttempt::keep_smaller_in(
            &mut best,
            BestAttempt {
                size: 400,
                path: PathBuf::from("b"),
                strategy: "gs dpi=72,jpegq=40".to_string(),
                quality: 40,
            },
        ));
        let winner: &BestAttempt = best.as_ref().unwrap();
        assert_eq!(winner.size, 400);
        assert_eq!(winner.path, PathBuf::from("b"));
        assert_eq!(winner.quality, 40);
    }
}
