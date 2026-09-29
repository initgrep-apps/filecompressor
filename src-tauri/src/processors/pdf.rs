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
use crate::engine::{
    CompressionError, CompressionProcessor, CompressionResult, ProgressSender, SidecarPaths,
};
use crate::models::Category;
use crate::settings::QualityFloors;

pub struct PdfProcessor;

const STDERR_TAIL_CHARS: usize = 500;
const WAIT_POLL_MILLIS: u64 = 30;
const QPDF_JPEG_QUALITY: u32 = 75;
const GS_SCREEN_QUALITY: u32 = 72;
const PDF_DPI_RUNGS: [u32; 4] = [100, 72, 50, 36];
const PDF_JPEGQ_RUNGS: [u32; 4] = [60, 40, 25, 15];

impl Default for PdfProcessor {
    fn default() -> Self {
        Self::new()
    }
}

enum PdfPass {
    QpdfLossless,
    QpdfImageOpt,
    GsScreen,
    GsLadder { dpi: u32, jpegq: u32 },
}

struct PassSpec {
    label: &'static str,
    sidecar_path: String,
    args: Vec<String>,
    strategy: String,
    quality: u32,
}

impl PdfProcessor {
    pub fn new() -> Self {
        PdfProcessor
    }

    fn qpdf_lossless_args(input: &Path, output: &Path) -> Vec<String> {
        vec![
            "--linearize".to_string(),
            "--object-streams=generate".to_string(),
            "--compression-level=9".to_string(),
            input.display().to_string(),
            output.display().to_string(),
        ]
    }

    fn qpdf_image_opt_args(input: &Path, output: &Path) -> Vec<String> {
        vec![
            "--linearize".to_string(),
            "--object-streams=generate".to_string(),
            "--recompress-flate".to_string(),
            "--compression-level=9".to_string(),
            "--optimize-images".to_string(),
            format!("--jpeg-quality={}", QPDF_JPEG_QUALITY),
            input.display().to_string(),
            output.display().to_string(),
        ]
    }

    fn gs_args(dpi: Option<u32>, jpegq: Option<u32>, input: &Path, output: &Path) -> Vec<String> {
        let mut args = vec![
            "-sDEVICE=pdfwrite".to_string(),
            "-dPDFSETTINGS=/screen".to_string(),
        ];
        if let Some(dpi) = dpi {
            args.push(format!("-r{}", dpi));
        }
        if let Some(jpegq) = jpegq {
            args.push(format!("-dJPEGQ={}", jpegq));
        }
        args.extend([
            "-dNOPAUSE".to_string(),
            "-dQUIET".to_string(),
            "-dBATCH".to_string(),
            format!("-sOutputFile={}", output.display()),
            input.display().to_string(),
        ]);
        args
    }

    fn pass_spec(
        pass: &PdfPass,
        qpdf_path: &str,
        gs_path: &str,
        input: &Path,
        output: &Path,
    ) -> PassSpec {
        match pass {
            PdfPass::QpdfLossless => PassSpec {
                label: "qpdf",
                sidecar_path: qpdf_path.to_string(),
                args: Self::qpdf_lossless_args(input, output),
                strategy: "qpdf-lossless".to_string(),
                quality: 100,
            },
            PdfPass::QpdfImageOpt => PassSpec {
                label: "qpdf",
                sidecar_path: qpdf_path.to_string(),
                args: Self::qpdf_image_opt_args(input, output),
                strategy: format!("qpdf-image-opt,jpeg-quality={}", QPDF_JPEG_QUALITY),
                quality: QPDF_JPEG_QUALITY,
            },
            PdfPass::GsScreen => PassSpec {
                label: "gs",
                sidecar_path: gs_path.to_string(),
                args: Self::gs_args(None, None, input, output),
                strategy: "gs-screen".to_string(),
                quality: GS_SCREEN_QUALITY,
            },
            PdfPass::GsLadder { dpi, jpegq } => PassSpec {
                label: "gs",
                sidecar_path: gs_path.to_string(),
                args: Self::gs_args(Some(*dpi), Some(*jpegq), input, output),
                strategy: format!("gs dpi={},jpegq={}", dpi, jpegq),
                quality: *dpi,
            },
        }
    }

    /// Runs a sidecar to completion, draining stderr on a reader thread so a
    /// chatty tool can never deadlock on a full pipe. Polls the cancel token:
    /// a cancel kills the child process first, then surfaces as `Cancelled` —
    /// cancelled beats exit code.
    fn run_sidecar(
        sidecar_path: &str,
        label: &str,
        args: &[String],
        cancel_token: &CancellationToken,
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
                let _ = std::io::Read::read_to_end(pipe, &mut buffer);
            }
            buffer
        });

        let status = loop {
            match child.try_wait() {
                Ok(Some(status)) => break status,
                Ok(None) => {
                    if cancel_token.is_cancelled() {
                        let _ = child.kill();
                        let _ = child.wait();
                        let _ = stderr_reader.join();
                        return Err(CompressionError::Cancelled);
                    }
                    std::thread::sleep(std::time::Duration::from_millis(WAIT_POLL_MILLIS));
                }
                Err(e) => {
                    let _ = stderr_reader.join();
                    return Err(CompressionError::SidecarFailed(format!(
                        "{} wait failed: {}",
                        label, e
                    )));
                }
            }
        };

        let stderr_bytes = stderr_reader.join().unwrap_or_default();
        if !status.success() {
            if cancel_token.is_cancelled() {
                return Err(CompressionError::Cancelled);
            }
            return Err(Self::sidecar_failure(
                label,
                status.code(),
                Self::stderr_tail(&stderr_bytes),
            ));
        }
        Ok(())
    }

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

    fn sidecar_failure(
        label: &str,
        exit_code: Option<i32>,
        stderr_tail: String,
    ) -> CompressionError {
        CompressionError::SidecarFailed(format!(
            "File may be corrupt ({} exited with code {:?}): {}",
            label, exit_code, stderr_tail
        ))
    }

    /// A sidecar exit 0 with a 0-byte output is not success — reject it.
    fn measure_output(path: &Path) -> Result<u64, CompressionError> {
        let size = std::fs::metadata(path)
            .map(|m| m.len())
            .map_err(|e| {
                CompressionError::OutputFileError(format!(
                    "attempt output ({}): {e}",
                    path.display()
                ))
            })?;
        if size == 0 {
            return Err(CompressionError::SidecarFailed(
                "File may be corrupt (sidecar produced an empty output)".to_string(),
            ));
        }
        Ok(size)
    }

    fn remove_all(paths: &[PathBuf]) {
        for path in paths {
            let _ = std::fs::remove_file(path);
        }
    }

    fn ladder_passes(quality_floor: &QualityFloors) -> Vec<PdfPass> {
        let mut passes = vec![
            PdfPass::QpdfLossless,
            PdfPass::QpdfImageOpt,
            PdfPass::GsScreen,
        ];
        let min_dpi = quality_floor.pdf.min_dpi;
        let min_jpegq = quality_floor.pdf.min_jpeg_quality;
        for dpi in PDF_DPI_RUNGS {
            for jpegq in PDF_JPEGQ_RUNGS {
                if dpi >= min_dpi && jpegq >= min_jpegq {
                    passes.push(PdfPass::GsLadder { dpi, jpegq });
                }
            }
        }
        passes
    }
}

impl CompressionProcessor for PdfProcessor {
    fn category(&self) -> Category {
        Category::Pdf
    }

    fn supported_extensions(&self) -> &[&str] {
        &["pdf"]
    }

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

        let qpdf_path = sidecar_paths.require("qpdf")?;
        let gs_path = sidecar_paths.require("gs")?;

        let passes = Self::ladder_passes(quality_floor);
        let total = passes.len();
        let mut smallest: Option<(u64, PathBuf, String, u32)> = None;
        let mut attempt_paths: Vec<PathBuf> = Vec::new();

        for (index, pass) in passes.iter().enumerate() {
            if cancel_token.is_cancelled() {
                Self::remove_all(&attempt_paths);
                return Err(CompressionError::Cancelled);
            }

            let temp_file = temp_dir.join(format!("attempt-{}.pdf", index));
            attempt_paths.push(temp_file.clone());
            let spec = Self::pass_spec(pass, qpdf_path, gs_path, input, &temp_file);

            progress.send_progress(((index * 95) / total) as u32);

            let attempt = Self::run_sidecar(
                &spec.sidecar_path,
                spec.label,
                &spec.args,
                &cancel_token,
            )
            .and_then(|_| Self::measure_output(&temp_file));

            match attempt {
                Ok(size) => {
                    if size <= target_bytes {
                        std::fs::copy(&temp_file, output)
                            .map_err(|e| CompressionError::OutputFileError(e.to_string()))?;
                        progress.send_progress(100);
                        return Ok(CompressionResult {
                            output_path: output.to_path_buf(),
                            compressed_size: size,
                            quality_used: spec.quality,
                            met_target: true,
                            strategy_used: spec.strategy,
                        });
                    }
                    if smallest.as_ref().map(|(s, ..)| size < *s).unwrap_or(true) {
                        smallest = Some((
                            size,
                            temp_file.clone(),
                            spec.strategy.clone(),
                            spec.quality,
                        ));
                    }
                }
                Err(CompressionError::Cancelled) => {
                    Self::remove_all(&attempt_paths);
                    return Err(CompressionError::Cancelled);
                }
                Err(e) => {
                    let _ = std::fs::remove_file(&temp_file);
                    return Err(e);
                }
            }
        }

        if let Some((size, path, strategy, quality)) = smallest {
            std::fs::copy(&path, output)
                .map_err(|e| CompressionError::OutputFileError(e.to_string()))?;
            progress.send_progress(100);
            return Ok(CompressionResult {
                output_path: output.to_path_buf(),
                compressed_size: size,
                quality_used: quality,
                met_target: false,
                strategy_used: format!("{},best-effort", strategy),
            });
        }

        Err(CompressionError::SidecarFailed(
            "Could not compress pdf".to_string(),
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::time::{Duration, Instant};

    #[cfg(unix)]
    fn make_executable_script(dir: &Path, name: &str, script: &str) -> String {
        use std::os::unix::fs::PermissionsExt;
        let path = dir.join(name);
        fs::write(&path, script).unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o755)).unwrap();
        path.to_string_lossy().to_string()
    }

    #[cfg(unix)]
    fn test_sidecar_paths(qpdf: Option<String>, gs: Option<String>) -> SidecarPaths {
        SidecarPaths {
            vips: None,
            ffmpeg: None,
            ffprobe: None,
            gs,
            qpdf,
        }
    }

    #[cfg(unix)]
    fn fake_qpdf(dir: &Path, pass1_bytes: usize, pass2_bytes: usize) -> String {
        make_executable_script(
            dir,
            "fake-qpdf",
            &format!(
                r#"#!/bin/bash
echo "qpdf $*" >> "$(dirname "$0")/qpdf.log"
out="${{@: -1}}"
case "$*" in
  *--optimize-images*) head -c {pass2} /dev/zero > "$out" ;;
  *) head -c {pass1} /dev/zero > "$out" ;;
esac
"#,
                pass1 = pass1_bytes,
                pass2 = pass2_bytes,
            ),
        )
    }

    #[cfg(unix)]
    fn fake_qpdf_failing(dir: &Path, message: &str) -> String {
        make_executable_script(
            dir,
            "fake-qpdf-fail",
            &format!(
                r#"#!/bin/bash
echo "qpdf $*" >> "$(dirname "$0")/qpdf.log"
echo "{message}" >&2
exit 1
"#,
                message = message,
            ),
        )
    }

    #[cfg(unix)]
    fn fake_gs(dir: &Path, screen_bytes: usize, ladder_multiplier: usize) -> String {
        make_executable_script(
            dir,
            "fake-gs",
            &format!(
                r#"#!/bin/bash
echo "gs $*" >> "$(dirname "$0")/gs.log"
out=""; dpi=""; q=""
for a in "$@"; do
  case "$a" in
    -sOutputFile=*) out="${{a#-sOutputFile=}}" ;;
    -r*) dpi="${{a#-r}}" ;;
    -dJPEGQ=*) q="${{a#-dJPEGQ=}}" ;;
  esac
done
case "$dpi" in
  "") head -c {screen} /dev/zero > "$out" ;;
  *) head -c "$(( dpi * q * {mult} ))" /dev/zero > "$out" ;;
esac
"#,
                screen = screen_bytes,
                mult = ladder_multiplier,
            ),
        )
    }

    #[cfg(unix)]
    fn fake_gs_zero_byte(dir: &Path) -> String {
        make_executable_script(
            dir,
            "fake-gs-zero",
            r#"#!/bin/bash
echo "gs $*" >> "$(dirname "$0")/gs.log"
out=""
for a in "$@"; do
  case "$a" in
    -sOutputFile=*) out="${a#-sOutputFile=}" ;;
  esac
done
: > "$out"
"#,
        )
    }

    #[cfg(unix)]
    fn fake_gs_stderr_chatter_failer(dir: &Path) -> String {
        make_executable_script(
            dir,
            "fake-gs-chatter",
            r#"#!/bin/bash
echo "gs $*" >> "$(dirname "$0")/gs.log"
printf 'HEAD_START%0585d' 0 >&2
printf 'TAIL_END\n' >&2
exit 1
"#,
        )
    }

    #[cfg(unix)]
    fn fake_qpdf_sleeper(dir: &Path, pass1_bytes: usize, pass2_bytes: usize) -> String {
        make_executable_script(
            dir,
            "fake-qpdf-sleeper",
            &format!(
                r#"#!/bin/bash
echo "qpdf $*" >> "$(dirname "$0")/qpdf.log"
out="${{@: -1}}"
case "$*" in
  *--optimize-images*) head -c {pass2} /dev/zero > "$out"; sleep 60 ;;
  *) head -c {pass1} /dev/zero > "$out" ;;
esac
"#,
                pass1 = pass1_bytes,
                pass2 = pass2_bytes,
            ),
        )
    }

    #[cfg(unix)]
    fn oversized_input(dir: &Path) -> PathBuf {
        let input = dir.join("in.pdf");
        fs::write(&input, vec![0u8; 300 * 1024]).unwrap();
        input
    }

    #[cfg(unix)]
    fn temp_dir_under(dir: &Path) -> PathBuf {
        let tmp = dir.join("tmp");
        fs::create_dir_all(&tmp).unwrap();
        tmp
    }

    #[test]
    fn pdf_pass1_qpdf_lossless_stops_early_when_under_target() {
        let dir = tempfile::tempdir().unwrap();
        let fake_qpdf = fake_qpdf(&dir.path(), 1000, 1000);
        let fake_gs = fake_gs(&dir.path(), 100, 100);
        let input = oversized_input(&dir.path());
        let tmp = temp_dir_under(&dir.path());

        let result = PdfProcessor
            .compress_to_target(
                &input,
                &dir.path().join("out.pdf"),
                2000,
                &QualityFloors::default(),
                CancellationToken::new(),
                ProgressSender::test_stub(),
                &test_sidecar_paths(Some(fake_qpdf), Some(fake_gs)),
                &tmp,
            )
            .unwrap();

        assert!(result.met_target, "strategy: {}", result.strategy_used);
        assert_eq!(result.strategy_used, "qpdf-lossless");
        assert_eq!(result.compressed_size, 1000);

        let qpdf_log = fs::read_to_string(dir.path().join("qpdf.log")).unwrap();
        let lines: Vec<&str> = qpdf_log.lines().collect();
        assert_eq!(
            lines.len(),
            1,
            "pass 1 fitting must not run later passes: {:?}",
            lines
        );
        assert!(lines[0].contains("--compression-level=9"));
        assert!(lines[0].contains("--linearize"));
        assert!(lines[0].contains("--object-streams=generate"));
        assert!(
            !dir.path().join("gs.log").exists(),
            "gs must never spawn when pass 1 already fits"
        );
    }

    #[test]
    #[cfg(unix)]
    fn pdf_pass2_qpdf_image_opt_stops_early() {
        let dir = tempfile::tempdir().unwrap();
        let fake_qpdf = fake_qpdf(&dir.path(), 5000, 1000);
        let fake_gs = fake_gs(&dir.path(), 100, 1);
        let input = oversized_input(&dir.path());
        let tmp = temp_dir_under(&dir.path());

        let result = PdfProcessor
            .compress_to_target(
                &input,
                &dir.path().join("out.pdf"),
                2000,
                &QualityFloors::default(),
                CancellationToken::new(),
                ProgressSender::test_stub(),
                &test_sidecar_paths(Some(fake_qpdf), Some(fake_gs)),
                &tmp,
            )
            .unwrap();

        assert!(result.met_target, "strategy: {}", result.strategy_used);
        assert!(result.strategy_used.contains("qpdf-image-opt"));
        assert!(result.strategy_used.contains("jpeg-quality=75"));
        assert_eq!(result.compressed_size, 1000);

        let qpdf_log = fs::read_to_string(dir.path().join("qpdf.log")).unwrap();
        let lines: Vec<&str> = qpdf_log.lines().collect();
        assert_eq!(lines.len(), 2, "got: {:?}", lines);
        assert!(
            lines[1].contains("--optimize-images") && lines[1].contains("--jpeg-quality=75"),
            "second invocation must be the image-opt pass: {}",
            lines[1]
        );
        assert!(
            !dir.path().join("gs.log").exists(),
            "gs must never run when pass 2 fits"
        );
    }

    #[test]
    #[cfg(unix)]
    fn pdf_pass3_gs_screen_stops_early() {
        let dir = tempfile::tempdir().unwrap();
        let fake_qpdf = fake_qpdf(&dir.path(), 5000, 5000);
        let fake_gs = fake_gs(&dir.path(), 1000, 1);
        let input = oversized_input(&dir.path());
        let tmp = temp_dir_under(&dir.path());

        let result = PdfProcessor
            .compress_to_target(
                &input,
                &dir.path().join("out.pdf"),
                2000,
                &QualityFloors::default(),
                CancellationToken::new(),
                ProgressSender::test_stub(),
                &test_sidecar_paths(Some(fake_qpdf), Some(fake_gs)),
                &tmp,
            )
            .unwrap();

        assert!(result.met_target, "strategy: {}", result.strategy_used);
        assert_eq!(result.strategy_used, "gs-screen");
        assert_eq!(result.compressed_size, 1000);

        let qpdf_log = fs::read_to_string(dir.path().join("qpdf.log")).unwrap();
        assert_eq!(qpdf_log.lines().count(), 2);

        let gs_log = fs::read_to_string(dir.path().join("gs.log")).unwrap();
        let gs_lines: Vec<&str> = gs_log.lines().collect();
        assert_eq!(gs_lines.len(), 1, "screen fitting must stop the ladder: {:?}", gs_lines);
        assert!(
            gs_lines[0].contains("-dPDFSETTINGS=/screen"),
            "got: {}",
            gs_lines[0]
        );
        assert!(
            gs_lines[0].contains("-sDEVICE=pdfwrite") && gs_lines[0].contains("-dNOPAUSE"),
            "got: {}",
            gs_lines[0]
        );
    }

    #[test]
    #[cfg(unix)]
    fn pdf_binary_search_dpi_jpegq_grid() {
        let dir = tempfile::tempdir().unwrap();
        let fake_qpdf = fake_qpdf(&dir.path(), 600_000, 600_000);
        let fake_gs = fake_gs(&dir.path(), 600_000, 1000);
        let input = oversized_input(&dir.path());
        let tmp = temp_dir_under(&dir.path());

        let floors = QualityFloors {
            pdf: crate::settings::PdfQualityFloor {
                min_dpi: 36,
                min_jpeg_quality: 15,
            },
            ..QualityFloors::default()
        };

        let result = PdfProcessor
            .compress_to_target(
                &input,
                &dir.path().join("out.pdf"),
                2000,
                &floors,
                CancellationToken::new(),
                ProgressSender::test_stub(),
                &test_sidecar_paths(Some(fake_qpdf), Some(fake_gs)),
                &tmp,
            )
            .unwrap();

        assert!(
            !result.met_target,
            "nothing fits — must be best effort: {}",
            result.strategy_used
        );
        assert!(
            result.strategy_used.contains("best-effort"),
            "got: {}",
            result.strategy_used
        );
        assert_eq!(
            result.compressed_size, 540_000,
            "smallest grid cell is dpi=36 × jpegq=15 → 36*15*1000 bytes"
        );

        let gs_log = fs::read_to_string(dir.path().join("gs.log")).unwrap();
        let gs_lines: Vec<&str> = gs_log.lines().collect();
        assert_eq!(gs_lines.len(), 17, "1 screen pass + 16 ladder cells: {:?}", gs_lines);
        assert_eq!(fs::read_to_string(dir.path().join("qpdf.log")).unwrap().lines().count(), 2);

        let ladder: Vec<(u32, u32)> = gs_lines
            .iter()
            .filter(|l| l.contains("-r"))
            .map(|l| {
                let dpi = l
                    .split_whitespace()
                    .find(|a| a.starts_with("-r"))
                    .unwrap()[2..]
                    .parse()
                    .unwrap();
                let jpegq = l
                    .split_whitespace()
                    .find(|a| a.starts_with("-dJPEGQ="))
                    .unwrap()["-dJPEGQ=".len()..]
                    .parse()
                    .unwrap();
                (dpi, jpegq)
            })
            .collect();

        let expected: Vec<(u32, u32)> = [100u32, 72, 50, 36]
            .iter()
            .flat_map(|dpi| [60u32, 40, 25, 15].iter().map(move |q| (*dpi, *q)))
            .collect();
        assert_eq!(
            ladder, expected,
            "pass 4 must walk the enumerated grid in descending order"
        );
        for line in &gs_lines {
            assert!(
                line.contains("-dPDFSETTINGS=/screen"),
                "gs args must carry -dPDFSETTINGS: {}",
                line
            );
        }
    }

    #[test]
    #[cfg(unix)]
    fn pdf_all_passes_fail_returns_best_effort_smallest_output() {
        let dir = tempfile::tempdir().unwrap();
        let fake_qpdf = fake_qpdf(&dir.path(), 5000, 4000);
        let fake_gs = fake_gs(&dir.path(), 6000, 100);
        let input = oversized_input(&dir.path());
        let tmp = temp_dir_under(&dir.path());

        let result = PdfProcessor
            .compress_to_target(
                &input,
                &dir.path().join("out.pdf"),
                2000,
                &QualityFloors::default(),
                CancellationToken::new(),
                ProgressSender::test_stub(),
                &test_sidecar_paths(Some(fake_qpdf), Some(fake_gs)),
                &tmp,
            )
            .unwrap();

        assert!(!result.met_target);
        assert!(
            result.strategy_used.contains("best-effort"),
            "got: {}",
            result.strategy_used
        );
        assert_eq!(
            result.compressed_size, 4000,
            "best effort = SMALLEST output (qpdf image-opt), never last-wins"
        );
        assert_eq!(
            fs::metadata(&dir.path().join("out.pdf")).unwrap().len(),
            4000
        );
    }

    #[test]
    #[cfg(unix)]
    fn pdf_already_under_target_skips_all_sidecars() {
        let dir = tempfile::tempdir().unwrap();
        let fake_qpdf = fake_qpdf(&dir.path(), 1000, 1000);
        let fake_gs = fake_gs(&dir.path(), 100, 1);
        let input = dir.path().join("small.pdf");
        fs::write(&input, b"tiny pdf").unwrap();
        let tmp = temp_dir_under(&dir.path());

        let result = PdfProcessor
            .compress_to_target(
                &input,
                &dir.path().join("out.pdf"),
                2000,
                &QualityFloors::default(),
                CancellationToken::new(),
                ProgressSender::test_stub(),
                &test_sidecar_paths(Some(fake_qpdf), Some(fake_gs)),
                &tmp,
            )
            .unwrap();

        assert!(result.met_target);
        assert_eq!(result.strategy_used, "already-under-target");
        assert_eq!(result.compressed_size, 8);
        assert_eq!(fs::read(&dir.path().join("out.pdf")).unwrap(), b"tiny pdf");
        assert!(
            !dir.path().join("qpdf.log").exists() && !dir.path().join("gs.log").exists(),
            "no sidecar may be spawned for an under-target pdf"
        );
    }

    #[test]
    #[cfg(unix)]
    fn pdf_gs_missing_binary_fails_with_engine_error() {
        let dir = tempfile::tempdir().unwrap();
        let fake_qpdf = fake_qpdf(&dir.path(), 1000, 1000);
        let input = oversized_input(&dir.path());
        let tmp = temp_dir_under(&dir.path());

        let result = PdfProcessor.compress_to_target(
            &input,
            &dir.path().join("out.pdf"),
            2000,
            &QualityFloors::default(),
            CancellationToken::new(),
            ProgressSender::test_stub(),
            &test_sidecar_paths(Some(fake_qpdf), None),
            &tmp,
        );
        match result {
            Err(e) => {
                assert!(
                    matches!(e, CompressionError::SidecarNotFound(ref n) if n == "gs"),
                    "expected SidecarNotFound(gs), got {:?}",
                    e
                );
                assert_eq!(e.to_string(), "Engine error: gs not available");
            }
            Ok(r) => panic!("expected error, got {:?}", r.strategy_used),
        }
        assert!(
            !dir.path().join("qpdf.log").exists(),
            "fail-fast: qpdf must not run when gs is already known missing"
        );
    }

    #[test]
    #[cfg(unix)]
    fn pdf_corrupt_input_sidecar_error_maps_to_file_may_be_corrupt() {
        let dir = tempfile::tempdir().unwrap();
        let fake_qpdf = fake_qpdf_failing(&dir.path(), "qpdf: input file is damaged");
        let fake_gs = fake_gs(&dir.path(), 100, 1);
        let input = oversized_input(&dir.path());
        let tmp = temp_dir_under(&dir.path());

        let result = PdfProcessor.compress_to_target(
            &input,
            &dir.path().join("out.pdf"),
            2000,
            &QualityFloors::default(),
            CancellationToken::new(),
            ProgressSender::test_stub(),
            &test_sidecar_paths(Some(fake_qpdf), Some(fake_gs)),
            &tmp,
        );
        match result {
            Err(CompressionError::SidecarFailed(msg)) => {
                assert!(
                    msg.contains("File may be corrupt"),
                    "got: {}",
                    msg
                );
                assert!(msg.contains("input file is damaged"), "got: {}", msg);
            }
            other => panic!("expected SidecarFailed, got {:?}", other.map(|r| r.strategy_used)),
        }
    }

    #[test]
    #[cfg(unix)]
    fn pdf_cancel_mid_pass_returns_cancelled_and_cleans_temp() {
        let dir = tempfile::tempdir().unwrap();
        let fake_qpdf = fake_qpdf_sleeper(&dir.path(), 5000, 1000);
        let fake_gs = fake_gs(&dir.path(), 1000, 1);
        let input = oversized_input(&dir.path());
        let tmp = temp_dir_under(&dir.path());

        let worker_input = input.clone();
        let worker_output = dir.path().join("out.pdf");
        let worker_tmp = tmp.clone();
        let worker_qpdf = fake_qpdf.clone();
        let worker_gs = fake_gs.clone();

        let token = CancellationToken::new();
        let worker_token = token.clone();
        let started = Instant::now();
        let handle = std::thread::spawn(move || {
            PdfProcessor.compress_to_target(
                &worker_input,
                &worker_output,
                2000,
                &QualityFloors::default(),
                worker_token,
                ProgressSender::test_stub(),
                &test_sidecar_paths(Some(worker_qpdf), Some(worker_gs)),
                &worker_tmp,
            )
        });
        std::thread::sleep(Duration::from_millis(300));
        token.cancel();
        let result = handle.join().unwrap();
        let elapsed = started.elapsed();

        assert!(
            matches!(result, Err(CompressionError::Cancelled)),
            "cancel mid-pass must surface as Cancelled, got {:?}",
            result.map(|r| r.strategy_used)
        );
        assert!(
            elapsed < Duration::from_secs(10),
            "sidecar must be killed promptly, took {:?} (sleep was 60s)",
            elapsed
        );
        assert_eq!(
            fs::read_dir(&tmp).unwrap().count(),
            0,
            "temp attempt files must be cleaned after cancel"
        );
    }

    #[test]
    #[cfg(unix)]
    fn pdf_sidecar_stderr_tail_in_error_message() {
        let dir = tempfile::tempdir().unwrap();
        let fake_qpdf = fake_qpdf(&dir.path(), 5000, 5000);
        let fake_gs = fake_gs_stderr_chatter_failer(&dir.path());
        let input = oversized_input(&dir.path());
        let tmp = temp_dir_under(&dir.path());

        let result = PdfProcessor.compress_to_target(
            &input,
            &dir.path().join("out.pdf"),
            2000,
            &QualityFloors::default(),
            CancellationToken::new(),
            ProgressSender::test_stub(),
            &test_sidecar_paths(Some(fake_qpdf), Some(fake_gs)),
            &tmp,
        );
        match result {
            Err(CompressionError::SidecarFailed(msg)) => {
                assert!(
                    msg.contains("exited with code Some(1)"),
                    "msg: {}",
                    msg
                );
                assert!(
                    msg.contains("TAIL_END"),
                    "last ~500 chars must be retained: {}",
                    msg
                );
                assert!(
                    !msg.contains("HEAD_START"),
                    "head beyond 500 chars must be truncated: {}",
                    msg
                );
            }
            other => panic!("expected SidecarFailed, got {:?}", other.map(|r| r.strategy_used)),
        }
    }

    #[test]
    #[cfg(unix)]
    fn pdf_zero_byte_output_rejected() {
        let dir = tempfile::tempdir().unwrap();
        let fake_qpdf = fake_qpdf(&dir.path(), 5000, 5000);
        let fake_gs = fake_gs_zero_byte(&dir.path());
        let input = oversized_input(&dir.path());
        let tmp = temp_dir_under(&dir.path());

        let result = PdfProcessor.compress_to_target(
            &input,
            &dir.path().join("out.pdf"),
            2000,
            &QualityFloors::default(),
            CancellationToken::new(),
            ProgressSender::test_stub(),
            &test_sidecar_paths(Some(fake_qpdf), Some(fake_gs)),
            &tmp,
        );
        match result {
            Err(e) => {
                assert!(
                    matches!(
                        e,
                        CompressionError::SidecarFailed(ref m)
                            if m.contains("File may be corrupt")
                    ),
                    "exit 0 + empty file must not count as success, got {:?}",
                    e
                );
            }
            Ok(r) => panic!("zero-byte output must be rejected, got {:?}", r.strategy_used),
        }
    }

    #[test]
    #[cfg(unix)]
    fn pdf_ladder_respects_settings_quality_floors() {
        let dir = tempfile::tempdir().unwrap();
        let fake_qpdf = fake_qpdf(&dir.path(), 5000, 5000);
        let fake_gs = fake_gs(&dir.path(), 5000, 1000);
        let input = oversized_input(&dir.path());
        let tmp = temp_dir_under(&dir.path());

        let result = PdfProcessor
            .compress_to_target(
                &input,
                &dir.path().join("out.pdf"),
                2000,
                &QualityFloors::default(),
                CancellationToken::new(),
                ProgressSender::test_stub(),
                &test_sidecar_paths(Some(fake_qpdf), Some(fake_gs)),
                &tmp,
            )
            .unwrap();

        assert!(!result.met_target);
        let gs_log = fs::read_to_string(dir.path().join("gs.log")).unwrap();
        let ladder: Vec<u32> = gs_log
            .lines()
            .filter(|l| l.contains("-r"))
            .map(|l| {
                l.split_whitespace()
                    .find(|a| a.starts_with("-r"))
                    .unwrap()[2..]
                    .parse()
                    .unwrap()
            })
            .collect();
        assert_eq!(
            ladder,
            vec![100, 100, 100, 100, 72, 72, 72, 72],
            "default floors (minDpi=72, minJpegQuality=15) truncate the ladder, not hardcoded"
        );
    }

    /// End-to-end smoke against the REAL qpdf + gs sidecars on this machine
    /// (ignored in CI-style runs; mirrors real_vips_compresses_oversized_jpeg_to_target).
    #[test]
    #[cfg(unix)]
    #[ignore = "requires real qpdf + gs sidecars on this machine"]
    fn real_pdf_sidecars_compress_oversized_pdf_through_all_passes() {
        let dir = tempfile::tempdir().unwrap();
        let binaries = format!("{}/binaries", env!("CARGO_MANIFEST_DIR"));
        let qpdf = format!(
            "{}/{}",
            binaries,
            crate::sidecar::sidecar_filename("qpdf").unwrap()
        );
        let gs = format!(
            "{}/{}",
            binaries,
            crate::sidecar::sidecar_filename("gs").unwrap()
        );
        assert!(Path::new(&qpdf).exists(), "qpdf sidecar missing: {}", qpdf);
        assert!(Path::new(&gs).exists(), "gs sidecar missing: {}", gs);

        let input = dir.path().join("in.pdf");
        let postscript: String = (1..=60)
            .map(|page| {
                format!(
                    "/Helvetica findfont 12 scalefont setfont\n72 700 moveto \
                     (Page {page}: The quick brown fox jumps over the lazy dog) show\nshowpage\n"
                )
            })
            .collect();
        let postscript_path = dir.path().join("in.ps");
        fs::write(&postscript_path, &postscript).unwrap();
        let output = std::process::Command::new(&gs)
            .args(["-sDEVICE=pdfwrite", "-dNOPAUSE", "-dQUIET", "-dBATCH"])
            .arg(format!("-sOutputFile={}", input.display()))
            .arg(&postscript_path)
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .output()
            .expect("gs generates the input pdf");
        assert!(
            output.status.success(),
            "gs failed to generate the input pdf"
        );

        let tmp = temp_dir_under(&dir.path());
        let result = PdfProcessor
            .compress_to_target(
                &input,
                &dir.path().join("out.pdf"),
                10 * 1024,
                &QualityFloors::default(),
                CancellationToken::new(),
                ProgressSender::test_stub(),
                &test_sidecar_paths(Some(qpdf), Some(gs)),
                &tmp,
            )
            .unwrap();

        assert!(
            result.compressed_size > 0 && fs::metadata(&dir.path().join("out.pdf")).unwrap().len() > 0,
            "output must be a real file, strategy: {}",
            result.strategy_used
        );
    }
}
