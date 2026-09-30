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

use std::io::{BufRead, BufReader, Read};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::{Duration, Instant};

use tokio_util::sync::CancellationToken;

use crate::engine::result::{CompressionError, CompressionResult, STRATEGY_ALREADY_UNDER_TARGET};
use crate::engine::{
    BestAttempt, CompressionProcessor, ProgressSender, SidecarName, SidecarPaths, deliver_output,
};
use crate::models::Category;
use crate::settings::QualityFloors;

pub struct VideoProcessor;

impl Default for VideoProcessor {
    fn default() -> Self {
        Self::new()
    }
}

/// Resolution ladder per spec §5: 1080p → 720p → 480p. Each rung is the
/// target height; the scale filter derives width from the aspect ratio.
const RESOLUTION_RUNGS: [u32; 3] = [1080, 720, 480];
const RESOLUTION_WIDTHS: [u32; 3] = [1920, 1280, 854];
/// CRF walk ascends toward the quality floor (higher CRF = smaller file).
const BASE_CRF_RUNGS: [u32; 2] = [23, 28];
/// Durations below this cannot yield a sane two-pass bitrate.
const MIN_DURATION_SECS: f64 = 0.5;
const AUDIO_BITRATE_K: u32 = 128;
const WAIT_POLL_MILLIS: u64 = 30;
const STDERR_TAIL_CHARS: usize = 500;
const STDERR_JOIN_TIMEOUT: Duration = Duration::from_secs(5);

/// Pass 1 discards its output. Windows has no `/dev/null`; cmd's `NUL`
/// device is the equivalent sink.
#[cfg(windows)]
const PASS1_SINK: &str = "NUL";
#[cfg(not(windows))]
const PASS1_SINK: &str = "/dev/null";

impl VideoProcessor {
    pub fn new() -> Self {
        VideoProcessor
    }

    /// ffprobe prints the duration as decimal seconds on stdout, one line
    /// (`123.456\n`). Empty output, `N/A`, or any other non-number means the
    /// container has no readable duration — the job fails instead of letting
    /// a NaN/zero reach the bitrate math.
    fn parse_duration_output(raw: &str) -> Option<f64> {
        raw.trim()
            .parse::<f64>()
            .ok()
            .filter(|d| d.is_finite() && *d > 0.0)
    }

    /// Spec §5: `(target_bytes * 8 * 0.95) / duration_seconds`, expressed in
    /// kbps for ffmpeg's `-b:v`. The multiplication runs in u128 so a huge
    /// target can never wrap; durations below `MIN_DURATION_SECS` and targets
    /// that round down to 0 kbps are rejected instead of handed to ffmpeg.
    fn calculate_bitrate_kbps(target_bytes: u64, duration_secs: f64) -> Option<u64> {
        if !duration_secs.is_finite() || duration_secs < MIN_DURATION_SECS || target_bytes == 0 {
            return None;
        }
        let millis = (duration_secs * 1000.0).round() as u128;
        if millis == 0 {
            return None;
        }
        let bits = target_bytes as u128 * 8 * 95 / 100;
        let kbps = bits / millis;
        if kbps == 0 {
            None
        } else {
            Some(kbps as u64)
        }
    }

    /// `HH:MM:SS.ms` (also accepts `MM:SS` / bare seconds) to seconds.
    fn parse_time_hms(token: &str) -> Option<f64> {
        let parts: Vec<f64> = token
            .split(':')
            .map(|p| p.trim().parse::<f64>().ok())
            .collect::<Option<Vec<_>>>()?;
        match parts.len() {
            3 => Some(parts[0] * 3600.0 + parts[1] * 60.0 + parts[2]),
            2 => Some(parts[0] * 60.0 + parts[1]),
            1 => Some(parts[0]),
            _ => None,
        }
    }

    /// Extracts the encode position from one ffmpeg stderr line. Accepts both
    /// `time=00:01:23.45` and `out_time_ms=12345678` — the latter is
    /// MICROSECONDS despite the `_ms` name (modern ffmpeg mislabels it).
    /// Garbage, partial, and unrelated lines yield `None`.
    fn progress_line_seconds(line: &str) -> Option<f64> {
        let mut best: Option<f64> = None;
        if let Some(pos) = line.find("out_time_ms=") {
            let rest = &line[pos + "out_time_ms=".len()..];
            let digits: String = rest.chars().take_while(|c| c.is_ascii_digit()).collect();
            if let Ok(micros) = digits.parse::<u64>() {
                best = Some(micros as f64 / 1_000_000.0);
            }
        }
        if let Some(pos) = line.find("time=") {
            let rest = &line[pos + "time=".len()..];
            let token = rest.split_ascii_whitespace().next().unwrap_or("");
            if let Some(t) = Self::parse_time_hms(token) {
                best = Some(best.map_or(t, |b| b.max(t)));
            }
        }
        best
    }

    /// Percent of `duration_secs` reached, from the maximum timestamp seen in
    /// the whole stderr. Clamped to 0..=100 — a `time=01:00:01` line on a
    /// 01:00:00 video must never emit 100.001%.
    #[allow(dead_code)]
    fn parse_progress_percent(stderr: &str, duration_secs: f64) -> u32 {
        if duration_secs <= 0.0 || !duration_secs.is_finite() {
            return 0;
        }
        let max = stderr
            .lines()
            .filter_map(Self::progress_line_seconds)
            .fold(0.0f64, f64::max);
        ((max / duration_secs) * 100.0).clamp(0.0, 100.0) as u32
    }

    /// Resolution rungs allowed by the settings floor (`"480p"` → 480).
    /// Unparseable floors do not restrict the ladder.
    fn resolution_rungs(min_resolution: &str) -> Vec<u32> {
        let digits: String = min_resolution.chars().filter(|c| c.is_ascii_digit()).collect();
        let min = digits.parse::<u32>().unwrap_or(0);
        RESOLUTION_RUNGS
            .iter()
            .copied()
            .filter(|r| *r >= min)
            .collect()
    }

    /// CRF rungs ascending toward the floor: the floor is the WORST allowed
    /// quality (highest CRF), so rungs above it are filtered out and the
    /// floor itself always terminates the walk.
    fn crf_rungs(min_crf: u32) -> Vec<u32> {
        let mut rungs: Vec<u32> = BASE_CRF_RUNGS
            .iter()
            .copied()
            .filter(|c| *c <= min_crf)
            .collect();
        if rungs.last().copied() != Some(min_crf) {
            rungs.push(min_crf);
        }
        rungs
    }

    fn scale_args(scale_width: Option<u32>) -> Vec<String> {
        match scale_width {
            Some(w) => vec!["-vf".to_string(), format!("scale={w}:-2")],
            None => Vec::new(),
        }
    }

    /// Pass 1 (analysis): `-y -i input -c:v libx264 -b:v {br}k [-vf …]
    /// -pass 1 -passlogfile <prefix> -an -f mp4 <sink>`. The sink is last.
    fn pass1_args(
        input: &Path,
        bitrate_k: u64,
        scale_width: Option<u32>,
        passlog_prefix: &Path,
    ) -> Vec<String> {
        let mut args = vec![
            "-y".to_string(),
            "-i".to_string(),
            input.display().to_string(),
            "-c:v".to_string(),
            "libx264".to_string(),
            "-b:v".to_string(),
            format!("{bitrate_k}k"),
        ];
        args.extend(Self::scale_args(scale_width));
        args.extend([
            "-pass".to_string(),
            "1".to_string(),
            "-passlogfile".to_string(),
            passlog_prefix.display().to_string(),
            "-an".to_string(),
            "-f".to_string(),
            "mp4".to_string(),
            PASS1_SINK.to_string(),
        ]);
        args
    }

    /// Pass 2 (encode): `-i input -c:v libx264 -b:v {br}k [-vf …]
    /// -pass 2 -passlogfile <same prefix> -c:a aac -b:a 128k output`.
    fn pass2_args(
        input: &Path,
        output: &Path,
        bitrate_k: u64,
        scale_width: Option<u32>,
        passlog_prefix: &Path,
    ) -> Vec<String> {
        let mut args = vec![
            "-i".to_string(),
            input.display().to_string(),
            "-c:v".to_string(),
            "libx264".to_string(),
            "-b:v".to_string(),
            format!("{bitrate_k}k"),
        ];
        args.extend(Self::scale_args(scale_width));
        args.extend([
            "-pass".to_string(),
            "2".to_string(),
            "-passlogfile".to_string(),
            passlog_prefix.display().to_string(),
            "-c:a".to_string(),
            "aac".to_string(),
            "-b:a".to_string(),
            format!("{AUDIO_BITRATE_K}k"),
            output.display().to_string(),
        ]);
        args
    }

    /// CRF fallback (single pass): `-y -i input -c:v libx264 -crf {crf}
    /// [-vf …] -c:a aac -b:a 128k output`.
    fn crf_args(
        input: &Path,
        output: &Path,
        crf: u32,
        scale_width: Option<u32>,
    ) -> Vec<String> {
        let mut args = vec![
            "-y".to_string(),
            "-i".to_string(),
            input.display().to_string(),
            "-c:v".to_string(),
            "libx264".to_string(),
            "-crf".to_string(),
            crf.to_string(),
        ];
        args.extend(Self::scale_args(scale_width));
        args.extend([
            "-c:a".to_string(),
            "aac".to_string(),
            "-b:a".to_string(),
            format!("{AUDIO_BITRATE_K}k"),
            output.display().to_string(),
        ]);
        args
    }

    /// An ffmpeg exit 0 is not success on its own — the output must be
    /// non-empty and carry the MP4 `ftyp` box header.
    fn measure_output(path: &Path) -> Result<u64, CompressionError> {
        let mut file = std::fs::File::open(path).map_err(|e| {
            CompressionError::OutputFileError(format!("attempt output ({}): {e}", path.display()))
        })?;
        let mut head = [0u8; 8];
        let mut filled = 0;
        while filled < head.len() {
            let n = file
                .read(&mut head[filled..])
                .map_err(|e| {
                    CompressionError::OutputFileError(format!(
                        "attempt output ({}): {e}",
                        path.display()
                    ))
                })?;
            if n == 0 {
                break;
            }
            filled += n;
        }
        if filled < head.len() || &head[4..8] != b"ftyp" {
            return Err(CompressionError::SidecarFailed(
                "File may be corrupt (sidecar output is not a readable MP4)".to_string(),
            ));
        }
        let size = file
            .metadata()
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
            if let Err(e) = std::fs::remove_file(path) {
                if e.kind() != std::io::ErrorKind::NotFound {
                    eprintln!("warn: temp cleanup failed for {}: {e}", path.display());
                }
            }
        }
    }

    /// Removes every temp-dir file sharing the passlogfile prefix (ffmpeg
    /// writes `<prefix>-0.log`, `<prefix>-0.log.mbtree`, …). Orphan passlogs
    /// after cancel/error are a regression.
    fn remove_passlogs(temp_dir: &Path, prefix: &Path) {
        let Some(name) = prefix.file_name() else {
            return;
        };
        let name = name.to_string_lossy().into_owned();
        let entries = match std::fs::read_dir(temp_dir) {
            Ok(entries) => entries,
            Err(_) => return,
        };
        for entry in entries.flatten() {
            if entry.file_name().to_string_lossy().starts_with(&name) {
                if let Err(e) = std::fs::remove_file(entry.path()) {
                    if e.kind() != std::io::ErrorKind::NotFound {
                        eprintln!(
                            "warn: passlog cleanup failed for {}: {e}",
                            entry.path().display()
                        );
                    }
                }
            }
        }
    }

    fn stderr_tail(bytes: &[u8]) -> String {
        let stderr = String::from_utf8_lossy(bytes).into_owned();
        let count = stderr.chars().count();
        let tail: String = if count > STDERR_TAIL_CHARS {
            stderr.chars().skip(count - STDERR_TAIL_CHARS).collect()
        } else {
            stderr
        };
        let detail = tail.trim_end();
        if detail.is_empty() {
            "<no stderr>".to_string()
        } else {
            detail.to_string()
        }
    }

    /// Runs ffprobe to completion and returns its stdout. Any non-zero exit
    /// maps to "File may be corrupt" (spec §6): a container ffprobe cannot
    /// read will not survive encoding either.
    fn run_ffprobe(
        ffprobe_path: &str,
        input: &Path,
        cancel_token: &CancellationToken,
    ) -> Result<String, CompressionError> {
        let args = vec![
            "-v".to_string(),
            "error".to_string(),
            "-show_entries".to_string(),
            "format=duration".to_string(),
            "-of".to_string(),
            "default=noprint_wrappers=1:nokey=1".to_string(),
            input.display().to_string(),
        ];
        let mut child = std::process::Command::new(ffprobe_path)
            .args(&args)
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|e| {
                CompressionError::SidecarFailed(format!("Failed to start ffprobe: {e}"))
            })?;

        let mut stdout_pipe = child.stdout.take();
        let stdout_reader = std::thread::spawn(move || {
            let mut buffer = Vec::new();
            if let Some(pipe) = stdout_pipe.as_mut() {
                if let Err(e) = pipe.read_to_end(&mut buffer) {
                    eprintln!("warn: ffprobe stdout drain failed: {e}");
                }
            }
            buffer
        });
        let mut stderr_pipe = child.stderr.take();
        let stderr_reader = std::thread::spawn(move || {
            let mut buffer = Vec::new();
            if let Some(pipe) = stderr_pipe.as_mut() {
                let _ = pipe.read_to_end(&mut buffer);
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
                        return Err(CompressionError::Cancelled);
                    }
                    std::thread::sleep(Duration::from_millis(WAIT_POLL_MILLIS));
                }
                Err(e) => {
                    let _ = child.kill();
                    let _ = child.wait();
                    return Err(CompressionError::SidecarFailed(format!(
                        "ffprobe wait failed: {e}"
                    )));
                }
            }
        };
        if cancel_token.is_cancelled() {
            return Err(CompressionError::Cancelled);
        }
        let stdout = recv_bounded(stdout_reader).unwrap_or_default();
        let stderr = recv_bounded(stderr_reader).unwrap_or_default();

        if !status.success() {
            return Err(CompressionError::SidecarFailed(format!(
                "File may be corrupt (ffprobe exited with code {:?}): {}",
                status.code(),
                Self::stderr_tail(&stderr)
            )));
        }
        Ok(String::from_utf8_lossy(&stdout).into_owned())
    }

    /// Runs one ffmpeg invocation with live progress: stderr is streamed line
    /// by line, each line parsed for `time=` / `out_time_ms=`, mapped into
    /// this pass's slice of the overall percent range and sent as it arrives.
    /// Cancel SIGKILLs the child and surfaces as `Cancelled`.
    #[allow(clippy::too_many_arguments)]
    fn run_ffmpeg_with_progress(
        ffmpeg_path: &str,
        args: &[String],
        cancel_token: &CancellationToken,
        progress: &ProgressSender,
        range_base: u32,
        range_span: u32,
        duration_secs: f64,
    ) -> Result<(), CompressionError> {
        let mut child = std::process::Command::new(ffmpeg_path)
            .args(args)
            .stdout(Stdio::null())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|e| {
                CompressionError::SidecarFailed(format!("Failed to start ffmpeg: {e}"))
            })?;

        let mut stderr_pipe = child.stderr.take();
        let progress_for_thread = progress.clone();
        let reader = std::thread::spawn(move || {
            let mut max_percent: u32 = 0;
            let mut tail: Vec<String> = Vec::new();
            if let Some(pipe) = stderr_pipe.as_mut() {
                let mut lines = BufReader::new(pipe);
                let mut line = String::new();
                loop {
                    line.clear();
                    match lines.read_line(&mut line) {
                        Ok(0) | Err(_) => break,
                        Ok(_) => {
                            if let Some(secs) = Self::progress_line_seconds(line.trim()) {
                                let pct = if duration_secs > 0.0 && duration_secs.is_finite() {
                                    ((secs / duration_secs) * 100.0).clamp(0.0, 100.0) as u32
                                } else {
                                    0
                                };
                                max_percent = max_percent.max(pct);
                                if range_span > 0 {
                                    progress_for_thread
                                        .send_progress(range_base + (pct * range_span) / 100);
                                }
                            }
                            tail.push(line.trim_end().to_string());
                            if tail.len() > 20 {
                                tail.remove(0);
                            }
                        }
                    }
                }
            }
            (max_percent, tail.join("\n"))
        });

        let status = loop {
            match child.try_wait() {
                Ok(Some(status)) => break status,
                Ok(None) => {
                    if cancel_token.is_cancelled() {
                        let _ = child.kill();
                        let _ = child.wait();
                        return Err(CompressionError::Cancelled);
                    }
                    std::thread::sleep(Duration::from_millis(WAIT_POLL_MILLIS));
                }
                Err(e) => {
                    let _ = child.kill();
                    let _ = child.wait();
                    return Err(CompressionError::SidecarFailed(format!(
                        "ffmpeg wait failed: {e}"
                    )));
                }
            }
        };
        if cancel_token.is_cancelled() {
            return Err(CompressionError::Cancelled);
        }
        let (max_percent, tail) = match recv_bounded(reader) {
            Some(pair) => pair,
            None => {
                eprintln!(
                    "warn: ffmpeg stderr drain did not finish within {STDERR_JOIN_TIMEOUT:?}; \
                     diagnostics unavailable"
                );
                (0, "<stderr unreadable>".to_string())
            }
        };

        if !status.success() {
            return Err(CompressionError::SidecarFailed(format!(
                "ffmpeg exited with code {:?}: {}",
                status.code(),
                Self::stderr_tail(tail.as_bytes())
            )));
        }
        if range_span > 0 {
            let scaled = (max_percent as u32 * range_span) / 100;
            progress.send_progress(range_base + scaled);
        }
        Ok(())
    }
}

/// Bounded wait on a drain-thread handle: poll `is_finished`, then join.
/// `None` = abandoned (detached; the thread self-terminates at pipe close).
fn recv_bounded<T: Send + 'static>(
    handle: std::thread::JoinHandle<T>,
) -> Option<T> {
    let deadline = Instant::now() + STDERR_JOIN_TIMEOUT;
    loop {
        if handle.is_finished() {
            return handle.join().ok();
        }
        if Instant::now() >= deadline {
            return None;
        }
        std::thread::sleep(Duration::from_millis(WAIT_POLL_MILLIS));
    }
}

enum VideoAttempt {
    TwoPass {
        scale_width: Option<u32>,
    },
    Crf {
        crf: u32,
        scale_width: Option<u32>,
    },
}

impl VideoAttempt {
    fn strategy(&self, bitrate_k: u64) -> String {
        match self {
            VideoAttempt::TwoPass { scale_width } => match scale_width {
                Some(w) => format!("two-pass h264 b={bitrate_k}k scale={w}"),
                None => format!("two-pass h264 b={bitrate_k}k"),
            },
            VideoAttempt::Crf { crf, scale_width } => match scale_width {
                Some(w) => format!("crf={crf} scale={w}"),
                None => format!("crf={crf}"),
            },
        }
    }

    fn quality(&self, bitrate_k: u64) -> u32 {
        match self {
            VideoAttempt::TwoPass { .. } => bitrate_k.min(u32::MAX as u64) as u32,
            VideoAttempt::Crf { crf, .. } => *crf,
        }
    }
}

impl CompressionProcessor for VideoProcessor {
    fn category(&self) -> Category {
        Category::Video
    }

    fn supported_extensions(&self) -> &[&str] {
        &["mp4", "mov"]
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

        // Already under target — copy as-is, no sidecar spawn (spec §6).
        // Checked BEFORE requiring ffmpeg/ffprobe so a video under target
        // never fails on missing sidecars.
        if input_size <= target_bytes {
            return deliver_output(
                input,
                output,
                input_size,
                STRATEGY_ALREADY_UNDER_TARGET.to_string(),
                100,
                true,
                &progress,
            );
        }

        let ffmpeg_path = sidecar_paths.require(SidecarName::Ffmpeg)?;
        let ffprobe_path = sidecar_paths.require(SidecarName::Ffprobe)?;

        let duration_raw = Self::run_ffprobe(ffprobe_path, input, &cancel_token)?;
        let duration_secs =
            Self::parse_duration_output(&duration_raw).ok_or_else(|| {
                CompressionError::SidecarFailed(
                    "File may be corrupt (ffprobe reported no readable duration)".to_string(),
                )
            })?;
        let bitrate_k = Self::calculate_bitrate_kbps(target_bytes, duration_secs).ok_or_else(
            || {
                CompressionError::SidecarFailed(
                    "Cannot calculate target bitrate (duration too short or target too small)"
                        .to_string(),
                )
            },
        )?;

        // MOV input → MP4 output (spec §3 format table).
        let final_output = output.with_extension("mp4");

        let res_rungs = Self::resolution_rungs(&quality_floor.video.min_resolution);
        let crf_values = Self::crf_rungs(quality_floor.video.min_crf);
        let total_attempts = res_rungs.len() + crf_values.len();
        let span = if total_attempts > 0 { 95 / total_attempts } else { 95 };

        let mut smallest: Option<BestAttempt> = None;
        let mut attempt_outputs: Vec<PathBuf> = Vec::new();
        let mut passlog_prefixes: Vec<PathBuf> = Vec::new();
        let mut last_error: Option<CompressionError> = None;
        let mut attempt_index: usize = 0;

        let cancel_cleanup = |outputs: &[PathBuf], prefixes: &[PathBuf]| {
            Self::remove_all(outputs);
            for prefix in prefixes {
                Self::remove_passlogs(temp_dir, prefix);
            }
        };

        let run_attempt = |attempt: &VideoAttempt,
                               temp_output: &Path,
                               passlog_prefix: Option<&Path>,
                               base: u32|
         -> Result<u64, CompressionError> {
            match attempt {
                VideoAttempt::TwoPass { scale_width } => {
                    let prefix = passlog_prefix.expect("two-pass requires a passlog prefix");
                    let half = (span / 2) as u32;
                    let pass1 = Self::pass1_args(input, bitrate_k, *scale_width, prefix);
                    Self::run_ffmpeg_with_progress(
                        ffmpeg_path,
                        &pass1,
                        &cancel_token,
                        &progress,
                        base,
                        half,
                        duration_secs,
                    )?;
                    let pass2 =
                        Self::pass2_args(input, temp_output, bitrate_k, *scale_width, prefix);
                    Self::run_ffmpeg_with_progress(
                        ffmpeg_path,
                        &pass2,
                        &cancel_token,
                        &progress,
                        base + half,
                        span as u32 - half,
                        duration_secs,
                    )?;
                }
                VideoAttempt::Crf { crf, scale_width } => {
                    let args = Self::crf_args(input, temp_output, *crf, *scale_width);
                    Self::run_ffmpeg_with_progress(
                        ffmpeg_path,
                        &args,
                        &cancel_token,
                        &progress,
                        base,
                        span as u32,
                        duration_secs,
                    )?;
                }
            }
            Self::measure_output(temp_output)
        };

        for (res_index, height) in res_rungs.iter().enumerate() {
            if cancel_token.is_cancelled() {
                cancel_cleanup(&attempt_outputs, &passlog_prefixes);
                return Err(CompressionError::Cancelled);
            }

            let scale_width = RESOLUTION_WIDTHS
                .get(RESOLUTION_RUNGS.iter().position(|r| r == height).unwrap_or(0))
                .copied();
            let attempt = VideoAttempt::TwoPass { scale_width };
            let temp_output = temp_dir.join(format!("attempt-{attempt_index}.mp4"));
            let passlog_prefix = temp_dir.join(format!("passlog-attempt-{attempt_index}"));
            attempt_index += 1;
            attempt_outputs.push(temp_output.clone());
            passlog_prefixes.push(passlog_prefix.clone());
            let base = (res_index * span) as u32;
            progress.send_progress(base);

            let outcome = run_attempt(
                &attempt,
                &temp_output,
                Some(&passlog_prefix),
                base,
            );

            match outcome {
                Ok(size) => {
                    if size <= target_bytes {
                        return deliver_output(
                            &temp_output,
                            &final_output,
                            size,
                            attempt.strategy(bitrate_k),
                            attempt.quality(bitrate_k),
                            true,
                            &progress,
                        );
                    }
                    BestAttempt::keep_smaller_in(
                        &mut smallest,
                        BestAttempt {
                            size,
                            path: temp_output.clone(),
                            strategy: attempt.strategy(bitrate_k),
                            quality: attempt.quality(bitrate_k),
                        },
                    );
                }
                Err(CompressionError::Cancelled) => {
                    cancel_cleanup(&attempt_outputs, &passlog_prefixes);
                    return Err(CompressionError::Cancelled);
                }
                Err(e) => {
                    eprintln!("warn: video attempt failed, trying next: {e}");
                    last_error = Some(e);
                    Self::remove_all(std::slice::from_ref(&temp_output));
                }
            }
            Self::remove_passlogs(temp_dir, &passlog_prefix);
        }

        // CRF fallback at the lowest allowed resolution: quality descends
        // (CRF ascends) until the floor. Single-pass — no passlog files.
        let fallback_width = res_rungs
            .last()
            .and_then(|h| {
                RESOLUTION_RUNGS
                    .iter()
                    .position(|r| r == h)
                    .map(|i| RESOLUTION_WIDTHS[i])
            });
        for (crf_index, crf) in crf_values.iter().enumerate() {
            if cancel_token.is_cancelled() {
                cancel_cleanup(&attempt_outputs, &passlog_prefixes);
                return Err(CompressionError::Cancelled);
            }

            let attempt = VideoAttempt::Crf {
                crf: *crf,
                scale_width: fallback_width,
            };
            let temp_output = temp_dir.join(format!("attempt-{attempt_index}.mp4"));
            attempt_index += 1;
            attempt_outputs.push(temp_output.clone());
            let base = ((res_rungs.len() + crf_index) * span) as u32;
            progress.send_progress(base);

            let outcome = run_attempt(&attempt, &temp_output, None, base);

            match outcome {
                Ok(size) => {
                    if size <= target_bytes {
                        return deliver_output(
                            &temp_output,
                            &final_output,
                            size,
                            attempt.strategy(bitrate_k),
                            attempt.quality(bitrate_k),
                            true,
                            &progress,
                        );
                    }
                    BestAttempt::keep_smaller_in(
                        &mut smallest,
                        BestAttempt {
                            size,
                            path: temp_output.clone(),
                            strategy: attempt.strategy(bitrate_k),
                            quality: attempt.quality(bitrate_k),
                        },
                    );
                }
                Err(CompressionError::Cancelled) => {
                    cancel_cleanup(&attempt_outputs, &passlog_prefixes);
                    return Err(CompressionError::Cancelled);
                }
                Err(e) => {
                    eprintln!("warn: video crf attempt failed, trying next: {e}");
                    last_error = Some(e);
                    Self::remove_all(std::slice::from_ref(&temp_output));
                }
            }
        }

        if let Some(best) = smallest {
            return deliver_output(
                &best.path,
                &final_output,
                best.size,
                format!("{},best-effort", best.strategy),
                best.quality,
                false,
                &progress,
            );
        }

        Err(last_error.unwrap_or_else(|| {
            CompressionError::SidecarFailed("Could not compress video".to_string())
        }))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[cfg(unix)]
    fn make_executable_script(dir: &Path, name: &str, script: &str) -> String {
        use std::os::unix::fs::PermissionsExt;
        let path = dir.join(name);
        fs::write(&path, script).unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o755)).unwrap();
        path.to_string_lossy().to_string()
    }

    #[cfg(unix)]
    fn test_sidecar_paths(ffmpeg: Option<String>, ffprobe: Option<String>) -> SidecarPaths {
        SidecarPaths {
            vips: None,
            ffmpeg,
            ffprobe,
            gs: None,
            qpdf: None,
        }
    }

    #[cfg(unix)]
    fn oversized_input(dir: &Path, name: &str) -> PathBuf {
        let input = dir.join(name);
        fs::write(&input, vec![0u8; 300 * 1024]).unwrap();
        input
    }

    #[cfg(unix)]
    fn temp_dir_under(dir: &Path) -> PathBuf {
        let tmp = dir.join("tmp");
        fs::create_dir_all(&tmp).unwrap();
        tmp
    }

    /// Writes a valid MP4 header + `size` zero bytes. Pass 1 must NOT create
    /// the output (its sink is /dev/null); it must materialize the passlog.
    #[cfg(unix)]
    fn fake_ffmpeg(dir: &Path, bitrate_size: usize, vf_size: usize, crf_sizes: &str) -> String {
        make_executable_script(
            dir,
            "fake-ffmpeg",
            &format!(
                r#"#!/bin/bash
echo "ffmpeg $*" >> "$(dirname "$0")/ffmpeg.log"
pass=""; pl=""; w=""; crf=""
prev=""
for a in "$@"; do
  case "$prev" in
    -pass) pass="$a" ;;
    -passlogfile) pl="$a" ;;
    -vf) w="${{a#scale=}}"; w="${{w%%:*}}" ;;
    -crf) crf="$a" ;;
  esac
  prev="$a"
done
if [ "$pass" = "1" ]; then
  if [ -n "$pl" ]; then printf 'x' > "${{pl}}-0.log"; printf 'x' > "${{pl}}-0.log.mbtree"; fi
  exit 0
fi
out="${{@: -1}}"
size=0
if [ -n "$crf" ]; then
  case "$crf" in
    {crf_sizes}
    *) size={bitrate_size} ;;
  esac
elif [ -n "$w" ]; then
  size={vf_size}
else
  size={bitrate_size}
fi
printf '\x00\x00\x00\x18ftypmp42' > "$out"
head -c $(( size - 12 )) /dev/zero >> "$out"
"#,
                bitrate_size = bitrate_size,
                vf_size = vf_size,
                crf_sizes = crf_sizes,
            ),
        )
    }

    #[cfg(unix)]
    fn fake_ffmpeg_sleeper(dir: &Path) -> String {
        make_executable_script(
            dir,
            "fake-ffmpeg-sleeper",
            r#"#!/bin/bash
pass=""; pl=""; prev=""
for a in "$@"; do
  case "$prev" in
    -pass) pass="$a" ;;
    -passlogfile) pl="$a" ;;
  esac
  prev="$a"
done
echo "ffmpeg $*" >> "$(dirname "$0")/ffmpeg.log"
if [ "$pass" = "1" ]; then
  if [ -n "$pl" ]; then printf 'x' > "${pl}-0.log"; printf 'x' > "${pl}-0.log.mbtree"; fi
  sleep 60
fi
"#,
        )
    }

    #[cfg(unix)]
    fn fake_ffprobe(dir: &Path, stdout: &str) -> String {
        make_executable_script(
            dir,
            "fake-ffprobe",
            &format!(
                r#"#!/bin/bash
echo "ffprobe $*" >> "$(dirname "$0")/ffprobe.log"
printf '{stdout}'
"#,
                stdout = stdout,
            ),
        )
    }

    #[cfg(unix)]
    fn fake_ffprobe_failing(dir: &Path, message: &str) -> String {
        make_executable_script(
            dir,
            "fake-ffprobe-fail",
            &format!(
                r#"#!/bin/bash
echo "ffprobe $*" >> "$(dirname "$0")/ffprobe.log"
echo "{message}" >&2
exit 1
"#,
                message = message,
            ),
        )
    }

    fn ffmpeg_log(dir: &Path) -> Vec<String> {
        fs::read_to_string(dir.join("ffmpeg.log"))
            .unwrap_or_default()
            .lines()
            .map(str::to_string)
            .collect()
    }

    // ---------- pure-function tests ----------

    #[test]
    fn ffprobe_parses_duration_decimal_and_missing_entries_fail() {
        assert_eq!(VideoProcessor::parse_duration_output("123.456\n"), Some(123.456));
        assert_eq!(VideoProcessor::parse_duration_output("0.5"), Some(0.5));
        assert_eq!(VideoProcessor::parse_duration_output("  42.0  "), Some(42.0));
        assert_eq!(VideoProcessor::parse_duration_output(""), None);
        assert_eq!(VideoProcessor::parse_duration_output("\n"), None);
        assert_eq!(VideoProcessor::parse_duration_output("N/A"), None);
        assert_eq!(VideoProcessor::parse_duration_output("garbage"), None);
        assert_eq!(VideoProcessor::parse_duration_output("-3.5"), None);
        assert_eq!(VideoProcessor::parse_duration_output("0"), None);
        assert_eq!(VideoProcessor::parse_duration_output("inf"), None);
        assert_eq!(VideoProcessor::parse_duration_output("NaN"), None);
    }

    #[test]
    fn video_bitrate_formula_matches_spec() {
        // (target * 8 * 0.95) / duration, in kbps: 10 MB over 60 s.
        let target = 10 * 1024 * 1024;
        let expected = (target as f64 * 8.0 * 0.95 / 60.0 / 1000.0).floor() as u64;
        assert_eq!(
            VideoProcessor::calculate_bitrate_kbps(target, 60.0),
            Some(expected)
        );
        // 2 MB over 100 s → (2*1024*1024*8*0.95)/100 bits/s = 159.38 kbps.
        assert_eq!(
            VideoProcessor::calculate_bitrate_kbps(2 * 1024 * 1024, 100.0),
            Some(159)
        );
        // Tiny-duration guard: below MIN_DURATION_SECS there is no sane bitrate.
        assert_eq!(VideoProcessor::calculate_bitrate_kbps(target, 0.0), None);
        assert_eq!(VideoProcessor::calculate_bitrate_kbps(target, 0.4), None);
        assert_eq!(VideoProcessor::calculate_bitrate_kbps(target, -5.0), None);
        assert_eq!(VideoProcessor::calculate_bitrate_kbps(target, f64::NAN), None);
        assert_eq!(VideoProcessor::calculate_bitrate_kbps(target, f64::INFINITY), None);
        // Zero target guard.
        assert_eq!(VideoProcessor::calculate_bitrate_kbps(0, 60.0), None);
        // Overflow guard: u64::MAX must not wrap — u128 math keeps it finite.
        assert!(VideoProcessor::calculate_bitrate_kbps(u64::MAX, 1.0).is_some());
        // Target so small the kbps floor rounds to zero → reject, never -b:v 0k.
        assert_eq!(VideoProcessor::calculate_bitrate_kbps(1, 3600.0), None);
    }

    #[test]
    fn video_two_pass_commands_constructed_correctly() {
        let input = Path::new("/in/video.mp4");
        let prefix = Path::new("/tmp/app/passlog-attempt-0");
        let pass1 = VideoProcessor::pass1_args(input, 1328, None, prefix);
        assert_eq!(
            pass1,
            vec![
                "-y",
                "-i",
                "/in/video.mp4",
                "-c:v",
                "libx264",
                "-b:v",
                "1328k",
                "-pass",
                "1",
                "-passlogfile",
                "/tmp/app/passlog-attempt-0",
                "-an",
                "-f",
                "mp4",
                PASS1_SINK,
            ]
            .into_iter()
            .map(String::from)
            .collect::<Vec<_>>()
        );
        let pass2 = VideoProcessor::pass2_args(
            input,
            Path::new("/tmp/app/attempt-0.mp4"),
            1328,
            None,
            prefix,
        );
        assert_eq!(
            pass2,
            vec![
                "-i",
                "/in/video.mp4",
                "-c:v",
                "libx264",
                "-b:v",
                "1328k",
                "-pass",
                "2",
                "-passlogfile",
                "/tmp/app/passlog-attempt-0",
                "-c:a",
                "aac",
                "-b:a",
                "128k",
                "/tmp/app/attempt-0.mp4",
            ]
            .into_iter()
            .map(String::from)
            .collect::<Vec<_>>()
        );
        // Scale rung lands on BOTH passes, before the -pass flags.
        let pass1_scaled = VideoProcessor::pass1_args(input, 1328, Some(1280), prefix);
        let vf_pos = pass1_scaled.iter().position(|a| a == "-vf").unwrap();
        assert_eq!(pass1_scaled[vf_pos + 1], "scale=1280:-2");
        assert!(pass1_scaled.iter().position(|a| a == "-pass").unwrap() > vf_pos);
        let pass2_scaled = VideoProcessor::pass2_args(
            input,
            Path::new("/tmp/app/attempt-0.mp4"),
            1328,
            Some(1280),
            prefix,
        );
        let vf_pos2 = pass2_scaled.iter().position(|a| a == "-vf").unwrap();
        assert_eq!(pass2_scaled[vf_pos2 + 1], "scale=1280:-2");
        assert!(pass2_scaled.iter().position(|a| a == "-pass").unwrap() > vf_pos2);
    }

    #[test]
    fn video_progress_parses_time_and_out_time_ms() {
        // `time=` HH:MM:SS.ms format.
        assert_eq!(
            VideoProcessor::progress_line_seconds("frame= 30 fps=25 time=00:01:23.45 bitrate=1234.0kbits/s"),
            Some(83.45)
        );
        // `out_time_ms=` is MICROSECONDS despite the name.
        assert_eq!(
            VideoProcessor::progress_line_seconds("frame=1 out_time_ms=12345678"),
            Some(12.345678)
        );
        // Shorter HH:MM:SS precision.
        assert_eq!(
            VideoProcessor::progress_line_seconds("time=00:00:10.00"),
            Some(10.0)
        );
        // Garbage / partial / unrelated lines are ignored.
        assert_eq!(VideoProcessor::progress_line_seconds("Press [q] to stop"), None);
        assert_eq!(VideoProcessor::progress_line_seconds("frame= 12 fps= 5"), None);
        assert_eq!(VideoProcessor::progress_line_seconds(""), None);
        assert_eq!(VideoProcessor::progress_line_seconds("time=garbage"), None);
        assert_eq!(VideoProcessor::progress_line_seconds("out_time_ms=N/A"), None);
        // Multi-line stderr: maximum timestamp wins.
        let stderr = "Press [q] to stop\ntime=00:00:05.00\nframe= 99 time=00:00:12.50\nspeed=1x\n";
        assert_eq!(VideoProcessor::parse_progress_percent(stderr, 100.0), 12);
        // Mixed formats in one stream — both accepted.
        let mixed = "out_time_ms=3000000\ntime=00:00:05.00\n";
        assert_eq!(VideoProcessor::parse_progress_percent(mixed, 100.0), 5);
    }

    #[test]
    fn video_progress_percent_clamped_0_to_100() {
        // time beyond the duration must clamp to exactly 100.
        assert_eq!(
            VideoProcessor::parse_progress_percent("time=01:00:01.00", 60.0),
            100
        );
        assert_eq!(VideoProcessor::parse_progress_percent("time=01:00:00.00", 60.0), 100);
        // Before any progress: 0.
        assert_eq!(VideoProcessor::parse_progress_percent("no progress yet", 60.0), 0);
        assert_eq!(VideoProcessor::parse_progress_percent("time=00:00:00.00", 60.0), 0);
        // Mid-range stays proportional.
        assert_eq!(VideoProcessor::parse_progress_percent("time=00:00:30.00", 60.0), 50);
        // out_time_ms beyond duration also clamps.
        assert_eq!(
            VideoProcessor::parse_progress_percent("out_time_ms=999999999", 60.0),
            100
        );
    }

    // ---------- integration tests (fake sidecars) ----------

    #[test]
    #[cfg(unix)]
    fn video_over_target_steps_resolution_1080_720_480() {
        let dir = tempfile::tempdir().unwrap();
        let ffmpeg = fake_ffmpeg(&dir.path(), 9000, 9000, "  *) size=100 ;;");
        let ffprobe = fake_ffprobe(&dir.path(), "1.0\n");
        let input = oversized_input(&dir.path(), "in.mp4");
        let tmp = temp_dir_under(&dir.path());

        let result = VideoProcessor
            .compress_to_target(
                &input,
                &dir.path().join("out.mp4"),
                2000,
                &QualityFloors::default(),
                CancellationToken::new(),
                ProgressSender::test_stub(),
                &test_sidecar_paths(Some(ffmpeg), Some(ffprobe)),
                &tmp,
            )
            .unwrap();

        assert!(result.met_target, "strategy: {}", result.strategy_used);
        assert!(result.strategy_used.contains("crf=23"), "got: {}", result.strategy_used);

        let log = ffmpeg_log(&dir.path());
        // 3 resolution rungs × 2 passes + 1 fitting CRF pass = 7 invocations.
        assert_eq!(log.len(), 7, "log: {log:?}");
        let count = |needle: &str| log.iter().filter(|l| l.contains(needle)).count();
        assert_eq!(count("scale=1920"), 2, "1080p on both passes: {log:?}");
        assert_eq!(count("scale=1280"), 2, "720p on both passes: {log:?}");
        assert_eq!(count("scale=854"), 3, "480p on both passes + crf fallback: {log:?}");
        // Passlog isolation: every two-pass invocation gets a fresh prefix.
        let prefixes: Vec<String> = log
            .iter()
            .filter_map(|l| {
                let idx = l.find("-passlogfile ")?;
                Some(l[idx + "-passlogfile ".len()..].split(' ').next().unwrap().to_string())
            })
            .collect();
        // Both passes of one attempt share a prefix; each new attempt is fresh.
        let unique: std::collections::HashSet<&String> = prefixes.iter().collect();
        assert_eq!(unique.len(), 3, "one fresh prefix per attempt: {prefixes:?}");
        assert_eq!(prefixes[0], prefixes[1], "pass 2 reuses pass 1's prefix");
        assert_eq!(prefixes[2], prefixes[3], "pass 2 reuses pass 1's prefix");
        assert_ne!(prefixes[1], prefixes[2], "stale passlog must not leak across attempts");
        // All passlogs cleaned up after the run.
        let leftovers: Vec<_> = fs::read_dir(&tmp)
            .unwrap()
            .flatten()
            .filter(|e| e.file_name().to_string_lossy().starts_with("passlog-"))
            .collect();
        assert!(leftovers.is_empty(), "orphan passlogs: {leftovers:?}");
    }

    #[test]
    #[cfg(unix)]
    fn video_crf_floor_28_best_effort() {
        let dir = tempfile::tempdir().unwrap();
        // CRF 23 → 600, CRF 28 → 800: the LAST attempt is NOT the smallest,
        // so last-wins selection would regress this test.
        let ffmpeg = fake_ffmpeg(&dir.path(), 9000, 9000, "  23) size=600 ;;\n    28) size=800 ;;");
        let ffprobe = fake_ffprobe(&dir.path(), "1.0\n");
        let input = oversized_input(&dir.path(), "in.mp4");
        let tmp = temp_dir_under(&dir.path());

        let result = VideoProcessor
            .compress_to_target(
                &input,
                &dir.path().join("out.mp4"),
                500,
                &QualityFloors::default(),
                CancellationToken::new(),
                ProgressSender::test_stub(),
                &test_sidecar_paths(Some(ffmpeg), Some(ffprobe)),
                &tmp,
            )
            .unwrap();

        assert!(!result.met_target);
        assert_eq!(result.compressed_size, 600, "smallest output must win");
        assert!(result.strategy_used.contains("crf=23"), "got: {}", result.strategy_used);
        assert!(result.strategy_used.contains("best-effort"), "got: {}", result.strategy_used);

        // Floor respected: no CRF above 28 ever reaches ffmpeg.
        let log = ffmpeg_log(&dir.path());
        for line in &log {
            if line.contains("-crf") {
                let crf: u32 = line
                    .split("-crf ")
                    .nth(1)
                    .unwrap()
                    .split(' ')
                    .next()
                    .unwrap()
                    .parse()
                    .unwrap();
                assert!(crf <= 28, "CRF {crf} exceeds floor 28");
            }
        }
        assert!(log.iter().any(|l| l.contains("-crf 28")), "floor rung must be tried: {log:?}");
    }

    #[test]
    #[cfg(unix)]
    fn video_cancel_mid_encode_kills_ffmpeg_and_removes_passlogs() {
        let dir = tempfile::tempdir().unwrap();
        let ffmpeg = fake_ffmpeg_sleeper(&dir.path());
        let ffprobe = fake_ffprobe(&dir.path(), "1.0\n");
        let input = oversized_input(&dir.path(), "in.mp4");
        let tmp = temp_dir_under(&dir.path());

        let token = CancellationToken::new();
        let output_path = dir.path().join("out.mp4");
        let handle = std::thread::spawn({
            let token = token.clone();
            let ffmpeg = ffmpeg.clone();
            let ffprobe = ffprobe.clone();
            let input = input.clone();
            let tmp = tmp.clone();
            move || {
                VideoProcessor.compress_to_target(
                    &input,
                    &output_path,
                    2000,
                    &QualityFloors::default(),
                    token,
                    ProgressSender::test_stub(),
                    &test_sidecar_paths(Some(ffmpeg), Some(ffprobe)),
                    &tmp,
                )
            }
        });

        std::thread::sleep(Duration::from_millis(500));
        token.cancel();
        let result = handle.join().unwrap();

        assert!(
            matches!(result, Err(CompressionError::Cancelled)),
            "got: {result:?}"
        );
        // Temp dir must be EMPTY — no orphan passlogs, no partial attempts.
        let leftovers: Vec<_> = fs::read_dir(&tmp).unwrap().flatten().collect();
        assert!(leftovers.is_empty(), "orphaned temp files: {leftovers:?}");
    }

    #[test]
    #[cfg(unix)]
    fn video_mov_input_produces_mp4_output() {
        let dir = tempfile::tempdir().unwrap();
        let ffmpeg = fake_ffmpeg(&dir.path(), 100, 100, "  *) size=100 ;;");
        let ffprobe = fake_ffprobe(&dir.path(), "1.0\n");
        let input = oversized_input(&dir.path(), "clip.mov");
        let tmp = temp_dir_under(&dir.path());

        let result = VideoProcessor
            .compress_to_target(
                &input,
                &dir.path().join("clip.mov"),
                2000,
                &QualityFloors::default(),
                CancellationToken::new(),
                ProgressSender::test_stub(),
                &test_sidecar_paths(Some(ffmpeg), Some(ffprobe)),
                &tmp,
            )
            .unwrap();

        assert!(result.met_target);
        assert_eq!(result.output_path.extension().unwrap(), "mp4");
        assert!(result.output_path.exists());
    }

    #[test]
    #[cfg(unix)]
    fn video_ffprobe_nonzero_exit_fails_with_engine_error() {
        let dir = tempfile::tempdir().unwrap();
        let ffmpeg = fake_ffmpeg(&dir.path(), 100, 100, "");
        let ffprobe = fake_ffprobe_failing(&dir.path(), "Invalid data found when processing input");
        let input = oversized_input(&dir.path(), "broken.mp4");
        let tmp = temp_dir_under(&dir.path());

        let result = VideoProcessor.compress_to_target(
            &input,
            &dir.path().join("out.mp4"),
            2000,
            &QualityFloors::default(),
            CancellationToken::new(),
            ProgressSender::test_stub(),
            &test_sidecar_paths(Some(ffmpeg), Some(ffprobe)),
            &tmp,
        );

        let err = result.unwrap_err();
        assert!(
            err.to_string().contains("File may be corrupt"),
            "got: {err}"
        );
        // ffmpeg must never spawn when ffprobe already failed.
        assert!(!dir.path().join("ffmpeg.log").exists());
    }

    #[test]
    #[cfg(unix)]
    fn video_already_under_target_skips_sidecars() {
        let dir = tempfile::tempdir().unwrap();
        let input = dir.path().join("small.mp4");
        fs::write(&input, vec![0u8; 1000]).unwrap();
        let tmp = temp_dir_under(&dir.path());

        let result = VideoProcessor
            .compress_to_target(
                &input,
                &dir.path().join("small.mp4"),
                2000,
                &QualityFloors::default(),
                CancellationToken::new(),
                ProgressSender::test_stub(),
                // None sidecars: any spawn attempt would fail the job.
                &test_sidecar_paths(None, None),
                &tmp,
            )
            .unwrap();

        assert!(result.met_target);
        assert!(result.is_already_under_target());
        assert_eq!(result.compressed_size, 1000);
    }

    #[test]
    #[cfg(unix)]
    fn video_ffprobe_na_duration_fails_job() {
        let dir = tempfile::tempdir().unwrap();
        let ffmpeg = fake_ffmpeg(&dir.path(), 100, 100, "");
        let ffprobe = fake_ffprobe(&dir.path(), "N/A\n");
        let input = oversized_input(&dir.path(), "in.mp4");
        let tmp = temp_dir_under(&dir.path());

        let result = VideoProcessor.compress_to_target(
            &input,
            &dir.path().join("out.mp4"),
            2000,
            &QualityFloors::default(),
            CancellationToken::new(),
            ProgressSender::test_stub(),
            &test_sidecar_paths(Some(ffmpeg), Some(ffprobe)),
            &tmp,
        );

        let err = result.unwrap_err();
        assert!(err.to_string().contains("File may be corrupt"), "got: {err}");
    }

    #[test]
    #[cfg(unix)]
    fn video_missing_sidecar_fails_fast() {
        let dir = tempfile::tempdir().unwrap();
        let ffprobe = fake_ffprobe(&dir.path(), "1.0\n");
        let input = oversized_input(&dir.path(), "in.mp4");
        let tmp = temp_dir_under(&dir.path());

        let result = VideoProcessor.compress_to_target(
            &input,
            &dir.path().join("out.mp4"),
            2000,
            &QualityFloors::default(),
            CancellationToken::new(),
            ProgressSender::test_stub(),
            &test_sidecar_paths(None, Some(ffprobe)),
            &tmp,
        );

        let err = result.unwrap_err();
        assert!(
            err.to_string().contains("Engine error: ffmpeg not available"),
            "got: {err}"
        );
    }

    #[test]
    #[cfg(unix)]
    fn video_ladder_respects_settings_quality_floors() {
        let dir = tempfile::tempdir().unwrap();
        let ffmpeg = fake_ffmpeg(&dir.path(), 9000, 9000, "  *) size=100 ;;");
        let ffprobe = fake_ffprobe(&dir.path(), "1.0\n");
        let input = oversized_input(&dir.path(), "in.mp4");
        let tmp = temp_dir_under(&dir.path());

        let floors = QualityFloors {
            video: crate::settings::VideoQualityFloor {
                min_crf: 23,
                min_resolution: "720p".to_string(),
            },
            ..QualityFloors::default()
        };

        let result = VideoProcessor
            .compress_to_target(
                &input,
                &dir.path().join("out.mp4"),
                2000,
                &floors,
                CancellationToken::new(),
                ProgressSender::test_stub(),
                &test_sidecar_paths(Some(ffmpeg), Some(ffprobe)),
                &tmp,
            )
            .unwrap();

        let log = ffmpeg_log(&dir.path());
        // 720p floor: no 480p (854) attempt may appear.
        assert_eq!(log.iter().filter(|l| l.contains("scale=854")).count(), 0);
        assert_eq!(log.iter().filter(|l| l.contains("scale=1920")).count(), 2);
        assert_eq!(log.iter().filter(|l| l.contains("scale=1280")).count(), 3);
        assert!(result.strategy_used.contains("crf=23"));
        // CRF floor 23: only rung 23, never 28.
        for line in &log {
            if line.contains("-crf") {
                let crf: u32 = line
                    .split("-crf ")
                    .nth(1)
                    .unwrap()
                    .split(' ')
                    .next()
                    .unwrap()
                    .parse()
                    .unwrap();
                assert!(crf <= 23, "CRF {crf} exceeds floor 23");
            }
        }
    }

    #[test]
    fn video_windows_nul_dev_null_gated() {
        #[cfg(windows)]
        assert_eq!(PASS1_SINK, "NUL");
        #[cfg(not(windows))]
        assert_eq!(PASS1_SINK, "/dev/null");
    }
}
