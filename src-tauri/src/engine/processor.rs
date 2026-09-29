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
use std::path::{Path, PathBuf};
use tokio_util::sync::CancellationToken;

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
