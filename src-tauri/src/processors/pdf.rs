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

use std::io::Read;
use std::path::{Path, PathBuf};

use tokio_util::sync::CancellationToken;

use crate::engine::result::STRATEGY_ALREADY_UNDER_TARGET;
use crate::engine::{
    BestAttempt, CompressionError, CompressionProcessor, CompressionResult, ProgressSender,
    SidecarName, SidecarPaths,
};
use crate::models::Category;
use crate::settings::QualityFloors;

pub struct PdfProcessor;

const PDF_MAGIC: &[u8] = b"%PDF-";
const STDERR_TAIL_CHARS: usize = 500;
const WAIT_POLL_MILLIS: u64 = 30;
const QPDF_JPEG_QUALITY: u32 = 75;
const GS_SCREEN_QUALITY: u32 = 72;
const GS_SCREEN_JPEGQ_FLOOR: u32 = 15;
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

impl PdfPass {
    fn sidecar_name(&self) -> SidecarName {
        match self {
            Self::QpdfLossless | Self::QpdfImageOpt => SidecarName::Qpdf,
            Self::GsScreen | Self::GsLadder { .. } => SidecarName::Gs,
        }
    }
}

struct PassSpec {
    label: &'static str,
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

    fn pass_spec(pass: &PdfPass, input: &Path, output: &Path) -> PassSpec {
        match pass {
            PdfPass::QpdfLossless => PassSpec {
                label: "qpdf",
                args: Self::qpdf_lossless_args(input, output),
                strategy: "qpdf-lossless".to_string(),
                quality: 100,
            },
            PdfPass::QpdfImageOpt => PassSpec {
                label: "qpdf",
                args: Self::qpdf_image_opt_args(input, output),
                strategy: format!("qpdf-image-opt,jpeg-quality={}", QPDF_JPEG_QUALITY),
                quality: QPDF_JPEG_QUALITY,
            },
            PdfPass::GsScreen => PassSpec {
                label: "gs",
                args: Self::gs_args(None, None, input, output),
                strategy: "gs-screen".to_string(),
                quality: GS_SCREEN_QUALITY,
            },
            PdfPass::GsLadder { dpi, jpegq } => PassSpec {
                label: "gs",
                args: Self::gs_args(Some(*dpi), Some(*jpegq), input, output),
                strategy: format!("gs dpi={},jpegq={}", dpi, jpegq),
                quality: *jpegq,
            },
        }
    }

    /// Runs a sidecar to completion, draining stderr on a reader thread so a
    /// chatty tool can never deadlock on a full pipe. Polls the cancel token:
    /// a cancel SIGKILLs the child process first, then surfaces as
    /// `Cancelled` — cancelled beats exit code.
    ///
    /// SIGKILL trade-off: only the direct child is killed, so grandchild
    /// processes it spawned survive and hold the stderr pipe open — the
    /// drain thread is therefore NOT joined on cancel (it self-terminates
    /// once the stragglers exit). gs's own /tmp/gs_* litter is reclaimed by
    /// the OS; the app temp dir is cleaned by the queue after each job.
    fn run_sidecar(
        sidecar_path: &str,
        label: &'static str,
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
                        // pipe — the drain thread is skipped, not joined.
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

        let stderr_bytes = match stderr_reader.join() {
            Ok(bytes) => bytes,
            Err(_) => {
                eprintln!("warn: {label} stderr reader panicked; diagnostics unavailable");
                b"<stderr unreadable>".to_vec()
            }
        };
        // qpdf exit 2 = "warnings, output still valid"; its output is
        // validated by measure_output instead of failing the pass here.
        let tolerated = label == "qpdf" && status.code() == Some(2);
        if !status.success() && !tolerated {
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

    /// A non-zero exit alone does not prove the INPUT was corrupt — it proves
    /// the pass failed. The "File may be corrupt" wording is reserved for
    /// invalid output (see `measure_output`).
    fn sidecar_failure(
        label: &str,
        exit_code: Option<i32>,
        stderr_tail: String,
    ) -> CompressionError {
        CompressionError::SidecarFailed(format!(
            "{} exited with code {:?}: {}",
            label, exit_code, stderr_tail
        ))
    }

    /// A sidecar exit 0 is not success on its own — an empty or non-PDF
    /// output must never copy through as Done (spec §6). The output must be
    /// non-empty and start with the `%PDF-` header.
    fn measure_output(path: &Path) -> Result<u64, CompressionError> {
        let mut file = std::fs::File::open(path).map_err(|e| {
            CompressionError::OutputFileError(format!("attempt output ({}): {e}", path.display()))
        })?;
        let mut head = Vec::new();
        (&mut file)
            .take(PDF_MAGIC.len() as u64)
            .read_to_end(&mut head)
            .map_err(|e| {
                CompressionError::OutputFileError(format!(
                    "attempt output ({}): {e}",
                    path.display()
                ))
            })?;
        if head.as_slice() != PDF_MAGIC {
            return Err(CompressionError::SidecarFailed(
                "File may be corrupt (sidecar output is not a readable PDF)".to_string(),
            ));
        }
        let size = file.metadata().map(|m| m.len()).map_err(|e| {
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
            if let Err(e) = std::fs::remove_file(path) {
                if e.kind() != std::io::ErrorKind::NotFound {
                    eprintln!("warn: temp cleanup failed for {}: {e}", path.display());
                }
            }
        }
    }

    /// Copies `from` to the final output path and reports completion. One
    /// enforcement point for the fs::copy + send_progress(100) + result
    /// triple shared by the early-exit and best-effort deliverables.
    fn deliver_output(
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

    fn ladder_passes(quality_floor: &QualityFloors) -> Vec<PdfPass> {
        let mut passes = vec![PdfPass::QpdfLossless, PdfPass::QpdfImageOpt];
        let min_dpi = quality_floor.pdf.min_dpi;
        let min_jpegq = quality_floor.pdf.min_jpeg_quality;
        if GS_SCREEN_QUALITY >= min_dpi && GS_SCREEN_JPEGQ_FLOOR >= min_jpegq {
            passes.push(PdfPass::GsScreen);
        }
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
            return Self::deliver_output(
                input,
                output,
                input_size,
                STRATEGY_ALREADY_UNDER_TARGET.to_string(),
                100,
                true,
                &progress,
            );
        }

        let qpdf_path = sidecar_paths.require(SidecarName::Qpdf)?;
        let gs_path = sidecar_paths.require(SidecarName::Gs)?;

        let passes = Self::ladder_passes(quality_floor);
        let total = passes.len();
        let mut smallest: Option<BestAttempt> = None;
        let mut attempt_paths: Vec<PathBuf> = Vec::new();
        let mut last_error: Option<CompressionError> = None;

        for (index, pass) in passes.iter().enumerate() {
            if cancel_token.is_cancelled() {
                Self::remove_all(&attempt_paths);
                return Err(CompressionError::Cancelled);
            }

            let temp_file = temp_dir.join(format!("attempt-{}.pdf", index));
            attempt_paths.push(temp_file.clone());
            let spec = Self::pass_spec(pass, input, &temp_file);
            let sidecar_path = match pass.sidecar_name() {
                SidecarName::Qpdf => qpdf_path,
                SidecarName::Gs => gs_path,
                SidecarName::Vips | SidecarName::Ffmpeg | SidecarName::Ffprobe => unreachable!(
                    "pdf passes may only resolve qpdf/gs engines"
                ),
            };

            progress.send_progress(((index * 95) / total) as u32);

            let attempt = Self::run_sidecar(
                sidecar_path,
                spec.label,
                &spec.args,
                &cancel_token,
            )
            .and_then(|_| Self::measure_output(&temp_file));

            match attempt {
                Ok(size) => {
                    if size <= target_bytes {
                        return Self::deliver_output(
                            &temp_file,
                            output,
                            size,
                            spec.strategy,
                            spec.quality,
                            true,
                            &progress,
                        );
                    }
                    BestAttempt::keep_smaller_in(
                        &mut smallest,
                        BestAttempt {
                            size,
                            path: temp_file.clone(),
                            strategy: spec.strategy.clone(),
                            quality: spec.quality,
                        },
                    );
                }
                Err(CompressionError::Cancelled) => {
                    Self::remove_all(&attempt_paths);
                    return Err(CompressionError::Cancelled);
                }
                // Spec §5: one failing pass must not abort the remaining
                // passes — a corrupt-input failure in qpdf still leaves the
                // gs ladder a chance to succeed. Record the attempt as
                // failed and move on (issue 13).
                Err(e) => {
                    eprintln!("warn: {} pass failed, trying next: {e}", spec.label);
                    last_error = Some(e);
                    Self::remove_all(std::slice::from_ref(&temp_file));
                }
            }
        }

        if let Some(best) = smallest {
            return Self::deliver_output(
                &best.path,
                output,
                best.size,
                format!("{},best-effort", best.strategy),
                best.quality,
                false,
                &progress,
            );
        }

        Err(last_error.unwrap_or_else(|| {
            CompressionError::SidecarFailed("Could not compress pdf".to_string())
        }))
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
printf '%%PDF-' > "$out"
case "$*" in
  *--optimize-images*) head -c $(( {pass2} - 5 )) /dev/zero >> "$out" ;;
  *) head -c $(( {pass1} - 5 )) /dev/zero >> "$out" ;;
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
    fn fake_qpdf_garbage_ok(dir: &Path, pass1_bytes: usize, pass2_bytes: usize) -> String {
        make_executable_script(
            dir,
            "fake-qpdf-garbage",
            &format!(
                r#"#!/bin/bash
echo "qpdf $*" >> "$(dirname "$0")/qpdf.log"
out="${{@: -1}}"
case "$*" in
  *--optimize-images*) head -c {pass2} /dev/urandom > "$out" ;;
  *) head -c {pass1} /dev/urandom > "$out" ;;
esac
exit 0
"#,
                pass1 = pass1_bytes,
                pass2 = pass2_bytes,
            ),
        )
    }

    #[cfg(unix)]
    fn fake_qpdf_warn_ok(dir: &Path, pass1_bytes: usize, pass2_bytes: usize) -> String {
        make_executable_script(
            dir,
            "fake-qpdf-warn",
            &format!(
                r#"#!/bin/bash
echo "qpdf $*" >> "$(dirname "$0")/qpdf.log"
out="${{@: -1}}"
printf '%%PDF-' > "$out"
case "$*" in
  *--optimize-images*) head -c $(( {pass2} - 5 )) /dev/zero >> "$out" ;;
  *) head -c $(( {pass1} - 5 )) /dev/zero >> "$out" ;;
esac
echo "WARNING: something recoverable happened" >&2
exit 2
"#,
                pass1 = pass1_bytes,
                pass2 = pass2_bytes,
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
  "") {{ printf '%%PDF-'; head -c $(( {screen} - 5 )) /dev/zero; }} > "$out" ;;
  *) {{ printf '%%PDF-'; head -c $(( dpi * q * {mult} - 5 )) /dev/zero; }} > "$out" ;;
esac
"#,
                screen = screen_bytes,
                mult = ladder_multiplier,
            ),
        )
    }

    #[cfg(unix)]
    fn fake_gs_garbage(dir: &Path) -> String {
        make_executable_script(
            dir,
            "fake-gs-garbage",
            r#"#!/bin/bash
echo "gs $*" >> "$(dirname "$0")/gs.log"
out=""
for a in "$@"; do
  case "$a" in
    -sOutputFile=*) out="${a#-sOutputFile=}" ;;
  esac
done
head -c 2000 /dev/urandom > "$out"
exit 0
"#,
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

    /// gs exit 0 with a non-PDF payload (deterministic — no urandom timing).
    #[cfg(unix)]
    fn fake_gs_text_garbage(dir: &Path) -> String {
        make_executable_script(
            dir,
            "fake-gs-text",
            r#"#!/bin/bash
echo "gs $*" >> "$(dirname "$0")/gs.log"
out=""
for a in "$@"; do
  case "$a" in
    -sOutputFile=*) out="${a#-sOutputFile=}" ;;
  esac
done
printf 'not a pdf at all, just text' > "$out"
exit 0
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
printf '%%PDF-' > "$out"
case "$*" in
  *--optimize-images*) head -c $(( {pass2} - 5 )) /dev/zero >> "$out"; sleep 60 ;;
  *) head -c $(( {pass1} - 5 )) /dev/zero >> "$out" ;;
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
    fn pdf_dpi_jpegq_grid_walks_descending() {
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
        assert_eq!(
            result.quality_used, 15,
            "ladder quality_used is the JPEGQ rung, not the DPI rung"
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
            result.quality_used, QPDF_JPEG_QUALITY,
            "qpdf-image-opt best-effort keeps the jpeg-quality"
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
        let fake_qpdf = fake_qpdf_garbage_ok(&dir.path(), 1000, 1000);
        let fake_gs = fake_gs_text_garbage(&dir.path());
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
                    "exit-0 garbage bytes must never count as success, got: {}",
                    msg
                );
                assert!(
                    !dir.path().join("out.pdf").exists(),
                    "no invalid output may be delivered"
                );
            }
            Ok(r) => panic!("garbage output must be rejected, got {:?}", r.strategy_used),
            other => panic!("expected SidecarFailed, got {:?}", other.map(|r| r.strategy_used)),
        }
    }

    #[test]
    #[cfg(unix)]
    fn pdf_corrupt_gs_output_falls_back_to_earlier_valid_best_effort() {
        let dir = tempfile::tempdir().unwrap();
        let fake_qpdf = fake_qpdf(&dir.path(), 5000, 4000);
        let fake_gs = fake_gs_garbage(&dir.path());
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

        assert!(
            !result.met_target,
            "corrupt gs output must not be delivered as Done (400 B fits target)"
        );
        assert!(
            result.strategy_used.contains("best-effort"),
            "gs pass errors must not abort the run: got {}",
            result.strategy_used
        );
        assert_eq!(
            result.compressed_size, 4000,
            "best effort = SMALLEST earlier valid output (qpdf image-opt)"
        );
    }

    #[test]
    #[cfg(unix)]
    fn pdf_qpdf_exit_two_warnings_output_still_measures() {
        let dir = tempfile::tempdir().unwrap();
        let fake_qpdf = fake_qpdf_warn_ok(&dir.path(), 1000, 1000);
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

        assert!(
            result.met_target,
            "qpdf exit 2 (warnings) keeps its output: strategy {}",
            result.strategy_used
        );
        assert_eq!(result.strategy_used, "qpdf-lossless");
        assert_eq!(result.compressed_size, 1000);
        assert!(
            !dir.path().join("gs.log").exists(),
            "pass-1 success (warnings included) must stop the ladder"
        );
    }

    #[test]
    #[cfg(unix)]
    fn run_sidecar_exit_semantics_are_per_engine() {
        let dir = tempfile::tempdir().unwrap();
        let warn = make_executable_script(
            &dir.path(),
            "sidecar-warn",
            r#"#!/bin/bash
echo "hello" >&2
exit 2
"#,
        );
        let fail3 = make_executable_script(
            &dir.path(),
            "sidecar-fail3",
            r#"#!/bin/bash
echo "hard error" >&2
exit 3
"#,
        );

        let cancelled = CancellationToken::new();
        assert!(
            PdfProcessor::run_sidecar(&warn, "qpdf", &[], &cancelled).is_ok(),
            "qpdf exit 2 = warnings; output validity is decided by measure_output"
        );
        match PdfProcessor::run_sidecar(&fail3, "qpdf", &[], &cancelled) {
            Err(CompressionError::SidecarFailed(msg)) => {
                assert!(msg.contains("exited with code Some(3)"), "msg: {}", msg);
                assert!(
                    !msg.contains("File may be corrupt"),
                    "exit code alone must not claim corruption: {}",
                    msg
                );
            }
            other => panic!("expected failure, got {:?}", other.as_ref().map(|_| ())),
        }
        match PdfProcessor::run_sidecar(&warn, "gs", &[], &cancelled) {
            Err(CompressionError::SidecarFailed(msg)) => {
                assert!(msg.contains("exited with code Some(2)"), "msg: {}", msg);
                assert!(
                    !msg.contains("File may be corrupt"),
                    "got: {}",
                    msg
                );
            }
            other => panic!("gs exit 2 is not a warning code, got {:?}", other.as_ref().map(|_| ())),
        }
    }

    #[test]
    #[cfg(unix)]
    fn pdf_floor_above_screen_rung_skips_gs_screen_pass() {
        let dir = tempfile::tempdir().unwrap();
        let fake_qpdf = fake_qpdf(&dir.path(), 600_000, 600_000);
        let fake_gs = fake_gs(&dir.path(), 600_000, 1000);
        let input = oversized_input(&dir.path());
        let tmp = temp_dir_under(&dir.path());

        let floors = QualityFloors {
            pdf: crate::settings::PdfQualityFloor {
                min_dpi: 81,
                min_jpeg_quality: 20,
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

        assert!(!result.met_target, "nothing fits — best effort expected");
        let gs_log = fs::read_to_string(dir.path().join("gs.log")).unwrap();
        let screen_count = gs_log
            .lines()
            .filter(|l| l.contains("gs ") && !l.contains("-r"))
            .count();
        assert_eq!(
            screen_count, 0,
            "screen pass (72 DPI < minDpi 81) must be skipped: {:?}",
            gs_log.lines().collect::<Vec<_>>()
        );
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
            vec![100, 100, 100],
            "floor min_dpi=81 truncates ladder to dpi>=81; screen pass absent"
        );
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
        let fake_qpdf = fake_qpdf_failing(&dir.path(), "qpdf: input unreadable");
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
        let fake_qpdf = fake_qpdf_failing(&dir.path(), "qpdf: cannot process");
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
