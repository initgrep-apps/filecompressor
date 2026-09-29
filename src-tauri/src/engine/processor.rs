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
use std::path::Path;
use tokio_util::sync::CancellationToken;

/// Resolved sidecar binary paths handed to every processor. Engines whose
/// binary is not present resolve to `None` — each processor enforces the
/// engines it actually needs via `require`, so a missing future engine
/// (ffmpeg, ffprobe, gs) never breaks unrelated categories.
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

    pub fn require(&self, name: &str) -> Result<&str, CompressionError> {
        let resolved = match name {
            "vips" => &self.vips,
            "ffmpeg" => &self.ffmpeg,
            "ffprobe" => &self.ffprobe,
            "gs" => &self.gs,
            "qpdf" => &self.qpdf,
            other => {
                return Err(CompressionError::SidecarNotFound(other.to_string()));
            }
        };
        resolved.as_deref().ok_or_else(|| {
            CompressionError::SidecarNotFound(name.to_string())
        })
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
