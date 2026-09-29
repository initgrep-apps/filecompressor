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

use std::path::{Path, PathBuf};

use tokio_util::sync::CancellationToken;

use crate::engine::result::STRATEGY_ALREADY_UNDER_TARGET;
use crate::engine::{CompressionError, CompressionProcessor, CompressionResult, ProgressSender};
use crate::models::Category;
use crate::settings::QualityFloors;

pub struct ImageProcessor;

const MAX_SEARCH_ITERATIONS: u32 = 8;
const SCALE_FLOOR_PERCENT: u32 = 50;

impl ImageProcessor {
    pub fn new() -> Self {
        ImageProcessor
    }

    fn get_output_extension(input: &Path) -> String {
        let ext = input
            .extension()
            .and_then(|e| e.to_str())
            .unwrap_or("");
        match ext.to_lowercase().as_str() {
            "jpg" | "jpeg" => "jpg".to_string(),
            "png" => "png".to_string(),
            "webp" => "webp".to_string(),
            // HEIC/HEIF → JPEG output (spec §3); unknown → jpg fallback
            _ => "jpg".to_string(),
        }
    }

    /// vips save-string options per output format. `quality` applies only to
    /// lossy formats (jpg/webp). PNG uses palette quantization instead —
    /// pngsave has no lossy Q.
    fn save_options(ext: &str, quality: u32) -> String {
        match ext {
            "png" => "[compression=9,palette,colours=256,strip]".to_string(),
            _ => format!("[Q={},strip]", quality),
        }
    }

    fn run_vips(
        sidecar_path: &str,
        input: &Path,
        output: &Path,
        ext: &str,
        quality: u32,
        cancel_token: &CancellationToken,
    ) -> Result<(), CompressionError> {
        let mut child = std::process::Command::new(sidecar_path)
            .arg("copy")
            .arg(input)
            .arg(format!("{}{}", output.display(), Self::save_options(ext, quality)))
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .spawn()
            .map_err(|e| {
                CompressionError::SidecarFailed(format!("Failed to start vips: {}", e))
            })?;

        let status = child
            .wait()
            .map_err(|e| CompressionError::SidecarFailed(format!("vips wait failed: {}", e)))?;

        if !status.success() {
            // Cancelled beats exit-code (kill surfaces as non-zero exit)
            if cancel_token.is_cancelled() {
                return Err(CompressionError::Cancelled);
            }
            return Err(CompressionError::SidecarFailed(format!(
                "vips exited with code {:?}",
                status.code()
            )));
        }
        Ok(())
    }

    /// Dimension reduction via `vips resize` — scale is a float factor (0.9 = 90%).
    /// NOT `vips thumbnail` (3rd arg there is width in pixels, not a percent).
    fn run_vips_resize(
        sidecar_path: &str,
        input: &Path,
        output: &Path,
        ext: &str,
        quality: u32,
        scale_factor: f64,
        cancel_token: &CancellationToken,
    ) -> Result<(), CompressionError> {
        let mut child = std::process::Command::new(sidecar_path)
            .arg("resize")
            .arg(input)
            .arg(format!("{}{}", output.display(), Self::save_options(ext, quality)))
            .arg(format!("{}", scale_factor))
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .spawn()
            .map_err(|e| {
                CompressionError::SidecarFailed(format!("Failed to start vips resize: {}", e))
            })?;

        let status = child
            .wait()
            .map_err(|e| CompressionError::SidecarFailed(format!("vips wait failed: {}", e)))?;

        if !status.success() {
            if cancel_token.is_cancelled() {
                return Err(CompressionError::Cancelled);
            }
            return Err(CompressionError::SidecarFailed(format!(
                "vips resize exited with code {:?}",
                status.code()
            )));
        }
        Ok(())
    }
}

/// Highest quality whose produced size fits `target_bytes`, within
/// `max_iterations`. Returns None when every attempt stays over target.
/// Pure/closure-injected so the search policy is unit-testable without vips.
fn binary_search_quality(
    lo: u32,
    hi: u32,
    max_iterations: u32,
    target_bytes: u64,
    cancel_token: &CancellationToken,
    progress: &ProgressSender,
    attempt: &mut dyn FnMut(u32) -> Result<(u64, PathBuf), CompressionError>,
) -> Result<Option<(u32, u64, PathBuf)>, CompressionError> {
    let mut lo = lo;
    let mut hi = hi;
    let mut best: Option<(u32, u64, PathBuf)> = None;

    for iteration in 0..max_iterations {
        if cancel_token.is_cancelled() {
            return Err(CompressionError::Cancelled);
        }
        if lo > hi {
            break;
        }

        let mid = (lo + hi) / 2;
        progress.send_progress((iteration * 100 / MAX_SEARCH_ITERATIONS).min(90));

        let (size, path) = attempt(mid)?;
        if size <= target_bytes {
            best = Some((mid, size, path));
            lo = mid + 1;
        } else {
            hi = mid.saturating_sub(1);
        }
    }

    Ok(best)
}

impl CompressionProcessor for ImageProcessor {
    fn category(&self) -> Category {
        Category::Image
    }

    fn supported_extensions(&self) -> &[&str] {
        &["jpg", "jpeg", "png", "webp", "heic", "heif"]
    }

    fn compress_to_target(
        &self,
        input: &Path,
        output: &Path,
        target_bytes: u64,
        quality_floor: &QualityFloors,
        cancel_token: CancellationToken,
        progress: ProgressSender,
        sidecar_path: &str,
        temp_dir: &Path,
    ) -> Result<CompressionResult, CompressionError> {
        let input_size = std::fs::metadata(input)
            .map(|m| m.len())
            .map_err(|e| CompressionError::InputFileError(e.to_string()))?;

        // Already under target — copy as-is (spec §6)
        if input_size <= target_bytes {
            std::fs::copy(input, output)
                .map_err(|e| CompressionError::OutputFileError(e.to_string()))?;
            progress.send_progress(100);
            return Ok(CompressionResult {
                output_path: output.to_path_buf(),
                compressed_size: input_size,
                quality_used: 100,
                met_target: true,
                strategy_used: STRATEGY_ALREADY_UNDER_TARGET.to_string(),
            });
        }

        let ext = Self::get_output_extension(input);
        let min_quality = quality_floor.image.min_quality;

        // Distinct temp file per attempt — a later attempt must never
        // overwrite the file recorded as the best one.
        let attempt = |n: u32,
                       quality: u32,
                       scale: Option<f64>|
         -> Result<(u64, PathBuf), CompressionError> {
            let temp_file = temp_dir.join(format!("attempt-{}.{}", n, ext));
            match scale {
                None => Self::run_vips(
                    sidecar_path,
                    input,
                    &temp_file,
                    &ext,
                    quality,
                    &cancel_token,
                )?,
                Some(s) => Self::run_vips_resize(
                    sidecar_path,
                    input,
                    &temp_file,
                    &ext,
                    quality,
                    s,
                    &cancel_token,
                )?,
            }
            let size = std::fs::metadata(&temp_file)
                .map(|m| m.len())
                .map_err(|e| CompressionError::InputFileError(e.to_string()))?;
            Ok((size, temp_file))
        };

        // Phase 1: binary search on quality (PNG loses here — save_options
        // ignores quality for png, so the search converges after floor hits).
        let mut attempt_n: u32 = 0;
        let quality_search = binary_search_quality(
            min_quality,
            95,
            MAX_SEARCH_ITERATIONS,
            target_bytes,
            &cancel_token,
            &progress,
            &mut |q| {
                let r = attempt(attempt_n, q, None)?;
                attempt_n += 1;
                Ok(r)
            },
        )?;

        if let Some((quality, size, path)) = quality_search {
            std::fs::copy(&path, output)
                .map_err(|e| CompressionError::OutputFileError(e.to_string()))?;
            progress.send_progress(100);
            return Ok(CompressionResult {
                output_path: output.to_path_buf(),
                compressed_size: size,
                quality_used: quality,
                met_target: true,
                strategy_used: format!("quality={}", quality),
            });
        }

        // Phase 2: dimension reduction in 10% steps, floor at SCALE_FLOOR_PERCENT
        progress.send_progress(92);
        let mut smallest: Option<(u32, u64, PathBuf)> = None;
        let mut scale_percent = 90;
        while scale_percent >= SCALE_FLOOR_PERCENT {
            if cancel_token.is_cancelled() {
                return Err(CompressionError::Cancelled);
            }
            let scale = scale_percent as f64 / 100.0;
            let r = attempt(attempt_n, min_quality, Some(scale))?;
            attempt_n += 1;

            if r.0 <= target_bytes {
                std::fs::copy(&r.1, output)
                    .map_err(|e| CompressionError::OutputFileError(e.to_string()))?;
                progress.send_progress(100);
                return Ok(CompressionResult {
                    output_path: output.to_path_buf(),
                    compressed_size: r.0,
                    quality_used: min_quality,
                    met_target: true,
                    strategy_used: format!("quality={},dims={}%", min_quality, scale_percent),
                });
            }
            if smallest.as_ref().map(|(_, s, _)| r.0 < *s).unwrap_or(true) {
                smallest = Some((min_quality, r.0, r.1));
            }
            scale_percent -= 10;
        }

        // Phase 3: best effort — smallest attempt wins (spec §5 step 7)
        if let Some((quality, size, path)) = smallest {
            std::fs::copy(&path, output)
                .map_err(|e| CompressionError::OutputFileError(e.to_string()))?;
            progress.send_progress(100);
            return Ok(CompressionResult {
                output_path: output.to_path_buf(),
                compressed_size: size,
                quality_used: quality,
                met_target: false,
                strategy_used: format!("quality={},best-effort", quality),
            });
        }

        Err(CompressionError::SidecarFailed(
            "Could not compress image".to_string(),
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn get_output_extension_maps_heic_heif_to_jpg() {
        assert_eq!(
            ImageProcessor::get_output_extension(Path::new("p/photo.heic")),
            "jpg"
        );
        assert_eq!(
            ImageProcessor::get_output_extension(Path::new("p/photo.HEIF")),
            "jpg"
        );
    }

    #[test]
    fn get_output_extension_preserves_png_jpg_webp() {
        assert_eq!(ImageProcessor::get_output_extension(Path::new("p/a.png")), "png");
        assert_eq!(ImageProcessor::get_output_extension(Path::new("p/a.JPG")), "jpg");
        assert_eq!(
            ImageProcessor::get_output_extension(Path::new("p/a.webp")),
            "webp"
        );
    }

    #[test]
    fn get_output_extension_defaults_unknown_to_jpg() {
        assert_eq!(ImageProcessor::get_output_extension(Path::new("p/a.tiff")), "jpg");
        assert_eq!(ImageProcessor::get_output_extension(Path::new("p/a")), "jpg");
    }

    #[test]
    fn binary_search_finds_highest_quality_meeting_target() {
        // size shrinks as quality drops; exactly Q<=80 fits target
        let attempt = |q: u32| {
            Ok::<(u64, PathBuf), CompressionError>((u64::from(q.max(80)) * 1500, PathBuf::from("t")))
        };
        let result = binary_search_quality(
            30, 95, MAX_SEARCH_ITERATIONS, 120_000, &CancellationToken::new(),
            &ProgressSender::test_stub(),
            &mut |q| attempt(q),
        )
        .unwrap();
        let (q, size, _) = result.expect("should find a fitting quality");
        assert!(size <= 120_000);
        assert!(q >= 80, "expected highest fitting quality, got {}", q);
    }

    #[test]
    fn binary_search_caps_at_max_eight_iterations() {
        // 256-wide window needs exactly 8 halvings to exhaust — verifies the cap
        let count = std::cell::Cell::new(0u32);
        let result = binary_search_quality(
            0, 255, MAX_SEARCH_ITERATIONS, 1, // target 1 byte — nothing fits
            &CancellationToken::new(), &ProgressSender::test_stub(),
            &mut |_q| {
                count.set(count.get() + 1);
                Ok((u64::MAX, PathBuf::from("t")))
            },
        )
        .unwrap();
        assert!(result.is_none());
        assert_eq!(count.get(), 8, "must cap at 8 iterations");
    }

    #[test]
    fn binary_search_exhausts_real_range_within_cap() {
        let count = std::cell::Cell::new(0u32);
        let result = binary_search_quality(
            30, 95, MAX_SEARCH_ITERATIONS, 1,
            &CancellationToken::new(), &ProgressSender::test_stub(),
            &mut |_q| {
                count.set(count.get() + 1);
                Ok((u64::MAX, PathBuf::from("t")))
            },
        )
        .unwrap();
        assert!(result.is_none());
        assert!(count.get() <= 8);
    }

    #[test]
    fn binary_search_cancelled_before_first_iteration_returns_cancelled() {
        let token = CancellationToken::new();
        token.cancel();
        let count = std::cell::Cell::new(0u32);
        let result = binary_search_quality(
            30, 95, MAX_SEARCH_ITERATIONS, 100,
            &token, &ProgressSender::test_stub(),
            &mut |_q| {
                count.set(count.get() + 1);
                Ok((1, PathBuf::from("t")))
            },
        );
        assert!(matches!(result, Err(CompressionError::Cancelled)));
        assert_eq!(count.get(), 0);
    }

    #[test]
    fn binary_search_cancelled_mid_search_returns_cancelled() {
        let token = CancellationToken::new();
        let count = std::cell::Cell::new(0u32);
        let result = binary_search_quality(
            30, 95, MAX_SEARCH_ITERATIONS, 100,
            &token, &ProgressSender::test_stub(),
            &mut |_q| {
                count.set(count.get() + 1);
                if count.get() == 3 {
                    token.cancel();
                }
                Ok((u64::MAX, PathBuf::from("t")))
            },
        );
        assert!(matches!(result, Err(CompressionError::Cancelled)));
    }

    #[test]
    fn already_under_target_copies_file_and_marks_result() {
        let dir = tempfile::tempdir().unwrap();
        let input = dir.path().join("in.jpg");
        let output = dir.path().join("out.jpg");
        fs::write(&input, b"tiny").unwrap();

        let result = ImageProcessor.compress_to_target(
            &input, &output, 200 * 1024,
            &crate::settings::QualityFloors::default(),
            CancellationToken::new(),
            ProgressSender::test_stub(),
            "/bin/false", // must never be invoked
            &dir.path().join("tmp"),
        )
        .unwrap();

        assert!(result.met_target);
        assert_eq!(result.strategy_used, "already-under-target");
        assert_eq!(result.compressed_size, 4);
        assert_eq!(fs::read(&output).unwrap(), b"tiny");
    }

    #[test]
    fn sidecar_nonzero_exit_marks_job_failed_with_exit_code() {
        // unix only: /bin/false exists and exits 1
        if !Path::new("/bin/false").exists() {
            return;
        }
        let dir = tempfile::tempdir().unwrap();
        let input = dir.path().join("in.jpg");
        fs::write(&input, vec![0u8; 300 * 1024]).unwrap(); // over target → search runs
        let result = ImageProcessor.compress_to_target(
            &input,
            &dir.path().join("out.jpg"),
            200 * 1024,
            &crate::settings::QualityFloors::default(),
            CancellationToken::new(),
            ProgressSender::test_stub(),
            "/bin/false",
            &dir.path().join("tmp"),
        );
        match result {
            Err(CompressionError::SidecarFailed(msg)) => {
                assert!(msg.contains("exited with code"))
            }
            other => panic!(
                "expected SidecarFailed, got {:?}",
                other.map(|r| r.strategy_used)
            ),
        }
    }

    /// Writes a deterministic bash fake of the vips CLI:
    /// `copy IN OUT[opts]`         → file of exactly 100_000 bytes
    /// `resize IN OUT[opts] SCALE` → file of exactly 100_000 * SCALE bytes
    /// Lets the dims-reduction + best-effort paths be tested end-to-end
    /// without libvips. Skipped on non-unix (needs bash + chmod).
    #[cfg(unix)]
    fn write_fake_vips(dir: &Path) -> String {
        use std::os::unix::fs::PermissionsExt;
        let path = dir.join("fake-vips");
        let script = r#"#!/bin/bash
op="$1"; out="$3"
base="${out%%\[*}"
case "$op" in
  copy)   head -c 100000 /dev/zero > "$base" ;;
  resize) head -c "$(awk -v s="$4" 'BEGIN { printf "%d", 100000 * s }')" /dev/zero > "$base" ;;
esac
"#;
        fs::write(&path, script).unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o755)).unwrap();
        path.to_string_lossy().to_string()
    }

    #[test]
    #[cfg(unix)]
    fn quality_floor_reached_triggers_dimension_reduction() {
        let dir = tempfile::tempdir().unwrap();
        let fake = write_fake_vips(&dir.path()); // copy → 100_000 B, resize 0.5 → 50_000 B
        let input = dir.path().join("in.jpg");
        fs::write(&input, vec![0u8; 300 * 1024]).unwrap();
        let tmp = dir.path().join("tmp");
        fs::create_dir_all(&tmp).unwrap();

        // target 56320 (55 KB): quality search (always 100_000) fails; resizes
        // 0.9→90k, 0.8→80k, 0.7→70k, 0.6→60k all exceed 56320,
        // resize 0.5 → 50_000 fits
        let result = ImageProcessor.compress_to_target(
            &input,
            &dir.path().join("out.jpg"),
            55 * 1024,
            &crate::settings::QualityFloors::default(),
            CancellationToken::new(),
            ProgressSender::test_stub(),
            &fake,
            &tmp,
        )
        .unwrap();

        assert!(result.met_target);
        assert!(
            result.strategy_used.contains("dims=50%"),
            "got: {}",
            result.strategy_used
        );
        assert_eq!(result.compressed_size, 50_000);
    }

    #[test]
    #[cfg(unix)]
    fn unachievable_returns_best_effort_with_smallest_attempt() {
        let dir = tempfile::tempdir().unwrap();
        let fake = write_fake_vips(&dir.path());
        let input = dir.path().join("in.jpg");
        fs::write(&input, vec![0u8; 300 * 1024]).unwrap();
        let tmp = dir.path().join("tmp");
        fs::create_dir_all(&tmp).unwrap();

        // target 10 KB: nothing ever fits (smallest possible = 50_000)
        let result = ImageProcessor.compress_to_target(
            &input,
            &dir.path().join("out.jpg"),
            10 * 1024,
            &crate::settings::QualityFloors::default(),
            CancellationToken::new(),
            ProgressSender::test_stub(),
            &fake,
            &tmp,
        )
        .unwrap();

        assert!(!result.met_target);
        assert!(result.strategy_used.contains("best-effort"));
        assert_eq!(
            result.compressed_size, 50_000,
            "best effort = smallest attempt, not last quality attempt"
        );
        assert_eq!(
            fs::metadata(&dir.path().join("out.jpg")).unwrap().len(),
            50_000
        );
    }
}
