# Compression Tools Research Report

For Tauri 2 desktop app — sidecar binaries called from Rust via `std::process::Command`.

---

## Table of Contents
1. [Images (JPEG, PNG, WebP, HEIC/HEIF)](#1-images-jpeg-png-webp-heicheif)
2. [Videos (MP4, MOV)](#2-videos-mp4-mov)
3. [PDF](#3-pdf)
4. [Documents (DOCX, XLSX, PPTX)](#4-documents-docx-xlsx-pptx)
5. [Tauri Sidecar Packaging](#tauri-sidecar-packaging)
6. [Summary Matrix](#summary-matrix)

---

## 1. Images (JPEG, PNG, WebP, HEIC/HEIF)

### Best Tool: libvips (`vips` / `vipsthumbnail` CLI)

**Why libvips over ImageMagick:**
- 5-10x faster, ~10x lower memory usage (demand-driven, streaming)
- Native support for JPEG, PNG, WebP, HEIC/HEIF, AVIF, TIFF, and 25+ other formats
- Built-in quality/compression params per format via save suffixes
- mozjpeg encoder in official prebuilt binaries (better compression than libjpeg-turbo)
- Active project (v8.18.6, Aug 2025), 11.7k GitHub stars

**CLI name:** `vips` (general operations) and `vipsthumbnail` (resize/thumbnail)

**Detection:**
```bash
vips --version
# Output: vips-8.18.6
```

#### Key CLI Commands

**Quality reduction (JPEG):**
```bash
# Save JPEG at quality 80, strip all metadata
vips copy input.jpg output.jpg[Q=80,strip]
```

**Quality reduction (WebP):**
```bash
# WebP at quality 80, strip metadata
vips copy input.png output.webp[Q=80,strip]
# Lossless WebP:
vips copy input.png output.webp[lossless=true,strip]
```

**PNG optimization (palette/quantization):**
```bash
# Quantize to 8bpp palette (like pngquant), with dithering
vips copy input.png output.png[palette=true,Q=256,dither=0.8,effort=7,strip]
```

**HEIC/HEIF save:**
```bash
# Save to HEIC at quality 50 (default), effort 4
vips copy input.jpg output.heic[Q=50,effort=4,strip]
```

**HEIC/HEIF read:**
```bash
# Read HEIC and convert to JPEG
vips copy input.heic output.jpg[Q=85,strip]
```

**Resize:**
```bash
# Using vipsthumbnail — resize to fit 1920x1080 bounding box
vipsthumbnail input.jpg --size 1920x1080 -o output.jpg[Q=85,strip]

# Using vips directly — thumbnail to width 1920
vips thumbnail input.jpg output.jpg 1920[Q=85,strip]

# Exact dimensions (ignore aspect ratio):
vipsthumbnail input.jpg --size 800x600! -o output.jpg[Q=85,strip]
```

**Format conversion + compression in one step:**
```bash
# JPEG → WebP with quality 80
vips jpegsave input.jpg output.webp[Q=80,strip]
# Or implicit:
vips copy input.jpg output.webp[Q=80,strip]
```

#### Target-Size Compression (Binary Search on Quality)

libvips has **no built-in target-size flag**. You must implement binary search:

```rust
// Pseudocode for target-size image compression
fn compress_to_target_size(input: &str, output: &str, target_bytes: u64) -> Result<()> {
    let mut lo = 5;
    let mut hi = 95;
    let mut best = None;
    
    for _ in 0..8 {
        let mid = (lo + hi) / 2;
        let args = ["copy", input, &format!("{}[Q={},strip]", output, mid)];
        Command::new("vips").args(&args).output()?;
        
        let size = fs::metadata(output)?.len();
        if size <= target_bytes {
            best = Some(mid);
            lo = mid + 1;  // Try higher quality
        } else {
            hi = mid - 1;  // Need lower quality
        }
    }
    
    // If still too large, try reducing dimensions
    if best.is_none() {
        // Reduce dimensions by 10% and retry
        vips_thumbnail_with_smaller_dimensions(input, output, target_bytes)?;
    }
    Ok(())
}
```

**Strategy:**
1. Binary search on Q (5–95) for 6-8 iterations
2. If still over target, reduce dimensions by 10% increments
3. If still over target, convert to more aggressive format (e.g., JPEG → WebP)

#### HEIC/HEIF Cross-Platform Support

**Critical gotcha:** HEIC encoding requires HEVC codecs (libde265 for decode, x265 for encode). These are patent-encumbered.

| Platform | HEIC Read | HEIC Write | Notes |
|----------|-----------|------------|-------|
| macOS     | ✅ (system libheif) | ✅ | Apple native support via ImageIO |
| Windows   | Needs libheif+libde265 | Needs x265 | Requires custom build with `--with-hevc` |
| Linux     | Needs libheif+libde265 | Needs x265 | Package `libheif-dev` + `libde265-dev` |

**The official prebuilt Windows binaries from `libvips/build-win64-mxe` do NOT include HEVC codecs** (libde265/x265) due to patent issues. You must build from source with `--with-hevc` flag, or ship libheif plugins separately.

**Alternative for HEIC:** On macOS, use system `sips` command as fallback:
```bash
sips -s format jpeg input.heic --out output.jpg
```

#### Format-Specific Save Parameters Reference

| Format | Key Params | Default Q |
|--------|-----------|-----------|
| JPEG   | `Q` (1-100), `strip`, `optimize_coding`, `interlace`, `trellis_quant`, `quant_table` | 75 |
| PNG    | `Q` (palette quantization 0-100), `palette` (bool), `dither` (0-1), `effort` (1-10), `compression` (0-9), `strip` | Q=100 |
| WebP   | `Q` (1-100), `lossless` (bool), `strip`, `reduction_effort` (0-4), `near_lossless` (bool) | 75 |
| HEIC   | `Q` (1-100), `effort` (0-9), `lossless` (bool), `strip` | 50 |
| AVIF   | `Q` (1-100), `effort` (0-9), `lossless` (bool), `strip` | 50 |

#### Binary Size & Licensing

| Property | Value |
|----------|-------|
| Binary size | ~15-25 MB (vips + dependencies, static build) |
| License | **LGPL v3** (libvips core) |
| Dependencies | mozjpeg (zlib/IJG/BSD), libwebp (BSD), libpng (libpng v2), libheif (LGPLv3), libde265 (LGPLv3), x265 (GPLv2) |
| Prebuilt binaries | macOS: Homebrew `brew install vips`; Windows: `build-win64-mxe` releases; Linux: package managers |

**Licensing concern:** If you ship x265 (for HEIC encoding), it's GPLv2 — this may require your app to be GPL. **Recommendation: Only support HEIC *reading* (libde265 is LGPLv3, safe for proprietary), skip HEIC *writing* or use AVIF instead** (AVIF uses aom which is BSD-2 + patent license).

#### Cross-Platform Binary Sources

| Platform | Source | Notes |
|----------|--------|-------|
| macOS (arm64) | Homebrew or build from source | `brew install vips` gives dynamic libs; for sidecar, build static |
| macOS (x86_64) | Same as above | |
| Windows (x86_64) | `github.com/libvips/build-win64-mxe/releases` | Prebuilt ZIP with all DLLs, ready to bundle |
| Windows (aarch64) | Same repo, aarch64 builds available | |
| Linux (x86_64) | Build from source or AppImage | Static build recommended for portability |
| Linux (aarch64) | Build from source | |

### Alternative: ImageMagick (`magick`)

```bash
# JPEG quality
magick input.jpg -quality 80 -strip output.jpg

# Resize
magick input.jpg -resize 1920x1080 -quality 80 -strip output.jpg

# HEIC support depends on delegate installed (libheif)
magick input.heic output.jpg
```

**Verdict:** ImageMagick is heavier (~30-50 MB), slower, GPL/Apache license, but has broader format support and simpler CLI. Use as fallback only.

---

## 2. Videos (MP4, MOV)

### Best Tool: FFmpeg + ffprobe

**CLI names:** `ffmpeg` (encoding), `ffprobe` (metadata probing)

**Detection:**
```bash
ffmpeg -version
ffprobe -version
```

#### Getting Video Duration (for bitrate calculation)

```bash
# Get duration in seconds
ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 input.mp4
# Output: 120.523

# Get video stream info (resolution, codec, fps)
ffprobe -v error -select_streams v:0 -show_entries stream=width,height,codec_name,r_frame_rate -of json input.mp4
```

#### Bitrate Calculation for Target Size

```rust
// Formula: bitrate (bits/sec) = (target_size_bytes * 8) / duration_seconds
// Leave 5% for container overhead + audio
fn calculate_bitrate(target_bytes: u64, duration_secs: f64) -> u64 {
    let total_bits = target_bytes * 8;
    let video_bits = (total_bits as f64 * 0.95) / duration_secs;
    video_bits as u64
}
```

```bash
# Example: target 50 MB for 120-second video
# bitrate = (50 * 1024 * 1024 * 8 * 0.95) / 120 = 3,329,429 bps ≈ 3329k
```

#### Two-Pass Encoding for Target Size (H.264)

```bash
# Pass 1 — analysis (output to /dev/null, just write stats)
ffmpeg -y -i input.mp4 \
  -c:v libx264 -b:v 3329k -pass 1 -passlogfile ffmpeg2pass \
  -an -f mp4 /dev/null

# Pass 2 — actual encode
ffmpeg -i input.mp4 \
  -c:v libx264 -b:v 3329k -pass 2 -passlogfile ffmpeg2pass \
  -c:a aac -b:a 128k \
  output.mp4
```

**Windows note:** Use `NUL` instead of `/dev/null`:
```bash
ffmpeg -y -i input.mp4 -c:v libx264 -b:v 3329k -pass 1 -passlogfile ffmpeg2pass -an -f mp4 NUL
```

#### H.264 vs H.265 Codec Selection

| Codec | Flag | Compression | Speed | Compatibility |
|-------|------|-------------|-------|---------------|
| H.264 | `-c:v libx264` | Good | Fast | Universal (all browsers, devices) |
| H.265/HEVC | `-c:v libx265` | ~50% better than H.264 | Slow | Good (modern devices, Safari) |
| VP9 | `-c:v libvpx-vp9` | Similar to H.265 | Very slow | Web-only (Chrome/Firefox) |
| AV1 | `-c:v libaom-av1` | Best | Extremely slow | Emerging |

**Recommendation:** Use H.264 for maximum compatibility, H.265 when targeting 50% smaller files.

#### Resolution Reduction

```bash
# Scale to 720p (preserving aspect ratio, avoid upscaling)
ffmpeg -i input.mp4 \
  -vf "scale='min(1280,iw)':'min(720,ih)':force_original_aspect_ratio=decrease" \
  -c:v libx264 -crf 28 -preset slow \
  -c:a aac -b:a 128k \
  output.mp4

# Scale to 480p
ffmpeg -i input.mp4 \
  -vf "scale='min(854,iw)':'min(480,ih)':force_original_aspect_ratio=decrease" \
  -c:v libx264 -crf 30 -preset slow \
  -c:a aac -b:a 128k \
  output.mp4
```

#### CRF Mode (Constant Rate Factor) — Quality-Based

```bash
# CRF 18 = visually lossless, CRF 23 = default, CRF 28 = lower quality
# Use CRF when you don't have a specific target size
ffmpeg -i input.mp4 -c:v libx264 -crf 23 -preset slow -c:a aac -b:a 128k output.mp4

# H.265 with CRF
ffmpeg -i input.mp4 -c:v libx265 -crf 28 -preset medium -c:a aac -b:a 128k output.mp4
```

#### Combined Strategy for Target Size

```rust
fn compress_video_to_target(input: &str, output: &str, target_bytes: u64) -> Result<()> {
    // 1. Get duration
    let duration = get_duration_ffprobe(input)?;
    
    // 2. Calculate bitrate
    let bitrate = calculate_bitrate(target_bytes, duration);
    
    // 3. Two-pass encode with calculated bitrate
    // Pass 1
    Command::new("ffmpeg")
        .args(["-y", "-i", input, "-c:v", "libx264", "-b:v", &format!("{}k", bitrate / 1000),
               "-pass", "1", "-passlogfile", "ffmpeg2pass", "-an", "-f", "mp4"])
        .arg(null_device())  // /dev/null or NUL
        .output()?;
    
    // Pass 2
    Command::new("ffmpeg")
        .args(["-i", input, "-c:v", "libx264", "-b:v", &format!("{}k", bitrate / 1000),
               "-pass", "2", "-passlogfile", "ffmpeg2pass",
               "-c:a", "aac", "-b:a", "128k", output])
        .output()?;
    
    // 4. If still over target, reduce resolution and retry
    let size = fs::metadata(output)?.len();
    if size > target_bytes {
        // Reduce to 720p and retry with lower bitrate
        compress_video_with_resolution(input, output, target_bytes, 720)?;
    }
    Ok(())
}
```

#### MOV Input Support

MOV files use the same codecs as MP4 (H.264/H.265 in QuickTime container). FFmpeg reads them natively:

```bash
# MOV input → MP4 output
ffmpeg -i input.mov -c:v libx264 -crf 23 -preset slow -c:a aac -b:a 128k output.mp4

# MOV → MOV (re-encode in place)
ffmpeg -i input.mov -c:v libx264 -crf 23 -preset slow -c:a aac -b:a 128k output.mov
```

#### `-fs` Flag (File Size Limit)

```bash
# -fs limits output file size (in bytes) — encoding stops at limit
# WARNING: This TRUNCATES the video, producing incomplete output. Do NOT use for target-size compression.
# Use two-pass with calculated bitrate instead.
ffmpeg -i input.mp4 -c:v libx264 -b:v 3329k -fs 52428800 output.mp4  # DON'T DO THIS
```

#### Binary Size & Licensing

| Property | Value |
|----------|-------|
| Binary size | ~70-100 MB (full build with all codecs) |
| License | **LGPL v2.1** (default build) or **GPL v2+** (with libx264/libx265) |
| Key dependency licenses | libx264 (GPLv2+), libx265 (GPLv2+), libaom (BSD-2 + AOM patent license) |
| Prebuilt binaries | `ffmpeg.org/download.html` — all 3 platforms, static builds available |

**Licensing concern:** libx264 and libx265 are GPLv2+. If your app is proprietary, you need a commercial license or use only LGPL-compatible codecs. **Alternative:** Use hardware encoders (h264_videotoolbox on macOS, h264_nvenc on Windows/NVIDIA, h264_vaapi on Linux) which don't require GPL encoders:

```bash
# macOS hardware H.264 (no GPL needed)
ffmpeg -i input.mp4 -c:v h264_videotoolbox -b:v 3329k -c:a aac -b:a 128k output.mp4

# Windows NVIDIA hardware H.264
ffmpeg -i input.mp4 -c:v h264_nvenc -b:v 3329k -c:a aac -b:a 128k output.mp4

# Linux VAAPI hardware H.264
ffmpeg -i input.mp4 -c:v h264_vaapi -b:v 3329k -c:a aac -b:a 128k output.mp4
```

**Prebuilt static FFmpeg binaries:**
- macOS: `evermeet.cx/ffmpeg/` (static, all codecs)
- Windows: `github.com/BtbN/FFmpeg-Builds/releases` (static, all codecs)
- Linux: `johnvansickle.com/ffmpeg/` (static, all codecs)

---

## 3. PDF

### Best Tool: Ghostscript (`gs`)

**CLI name:** `gs`

**Detection:**
```bash
gs --version
# Output: 10.02.1
```

#### PDFSETTINGS Presets

Ghostscript provides 4 presets via `-dPDFSETTINGS`:

| Preset | Resolution | Image Downsampling | Use Case | Typical Size |
|--------|-----------|-------------------|----------|-------------|
| `/screen` | 72 dpi | Yes (Average) | On-screen viewing | Smallest (~10-20% of original) |
| `/ebook` | 150 dpi | Yes (Average) | E-readers, tablets | Small (~30-50% of original) |
| `/printer` | 300 dpi | No | Printing | Medium (~70-90% of original) |
| `/prepress` | 300 dpi | No (Bicubic) | High-quality print | Largest (~90-100% of original) |

#### Basic PDF Compression

```bash
# Screen quality (smallest)
gs -sDEVICE=pdfwrite -dCompatibilityLevel=1.5 -dPDFSETTINGS=/screen \
  -dNOPAUSE -dQUIET -dBATCH \
  -sOutputFile=output.pdf input.pdf

# Ebook quality (balanced)
gs -sDEVICE=pdfwrite -dCompatibilityLevel=1.5 -dPDFSETTINGS=/ebook \
  -dNOPAUSE -dQUIET -dBATCH \
  -sOutputFile=output.pdf input.pdf

# Printer quality (larger)
gs -sDEVICE=pdfwrite -dCompatibilityLevel=1.7 -dPDFSETTINGS=/printer \
  -dNOPAUSE -dQUIET -dBATCH \
  -sOutputFile=output.pdf input.pdf
```

#### Fine-Grained PDF Compression

```bash
# Custom: downsample images to 150 dpi, JPEG quality 50
gs -sDEVICE=pdfwrite -dCompatibilityLevel=1.5 \
  -dDownsampleColorImages=true -dColorImageResolution=150 \
  -dColorImageDownsampleType=/Average \
  -dDownsampleGrayImages=true -dGrayImageResolution=150 \
  -dGrayImageDownsampleType=/Average \
  -dDownsampleMonoImages=true -dMonoImageResolution=300 \
  -dAutoFilterColorImages=false -dColorImageFilter=/DCTEncode \
  -dAutoFilterGrayImages=false -dGrayImageFilter=/DCTEncode \
  -dJPEGQ=50 \
  -dNOPAUSE -dQUIET -dBATCH \
  -sOutputFile=output.pdf input.pdf
```

#### Key Distiller Parameters (CLI-accessible)

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `dPDFSETTINGS` | preset | /default | Overall quality preset |
| `dDownsampleColorImages` | bool | false | Downsample color images |
| `dColorImageResolution` | int | 72 | Color image DPI (when downsampling) |
| `dColorImageDownsampleType` | enum | /Subsample | /Subsample, /Average, /Bicubic |
| `dDownsampleGrayImages` | bool | false | Downsample grayscale images |
| `dGrayImageResolution` | int | 72 | Grayscale image DPI |
| `dDownsampleMonoImages` | bool | false | Downsample monochrome images |
| `dMonoImageResolution` | int | 300 | Monochrome image DPI |
| `dJPEGQ` | int (0-100) | 75 | JPEG quality for images |
| `dCompressFonts` | bool | true | Compress embedded fonts |
| `dEmbedAllFonts` | bool | true | Embed all fonts |
| `dSubsetFonts` | bool | true | Subset fonts |
| `dDetectDuplicateImages` | bool | true | Deduplicate identical images |
| `dFastWebView` | bool | false | Linearize for web |
| `sColorConversionStrategy` | string | LeaveColorUnchanged | RGB, CMYK, Gray |

#### Target-Size PDF Compression (Binary Search)

```rust
fn compress_pdf_to_target(input: &str, output: &str, target_bytes: u64) -> Result<()> {
    // Strategy: Try presets from most aggressive to least, then fine-tune
    let presets = ["/screen", "/ebook", "/printer", "/prepress"];
    
    // 1. Try each preset
    for preset in &presets {
        Command::new("gs")
            .args(["-sDEVICE=pdfwrite", "-dPDFSETTINGS", preset,
                   "-dNOPAUSE", "-dQUIET", "-dBATCH",
                   "-sOutputFile", output, input])
            .output()?;
        
        if fs::metadata(output)?.len() <= target_bytes {
            return Ok(());
        }
    }
    
    // 2. If /screen is still too large, fine-tune with lower DPI + JPEG quality
    let dpi_values = [100, 72, 50, 36];
    let jpeg_qualities = [60, 40, 25, 15];
    
    for (dpi, q) in dpi_values.iter().zip(jpeg_qualities.iter()) {
        Command::new("gs")
            .args(["-sDEVICE=pdfwrite", "-dCompatibilityLevel=1.5",
                   "-dDownsampleColorImages=true",
                   &format!("-dColorImageResolution={}", dpi),
                   "-dColorImageDownsampleType=/Average",
                   "-dDownsampleGrayImages=true",
                   &format!("-dGrayImageResolution={}", dpi),
                   "-dGrayImageDownsampleType=/Average",
                   "-dJPEGQ", &q.to_string(),
                   "-dNOPAUSE", "-dQUIET", "-dBATCH",
                   "-sOutputFile", output, input])
            .output()?;
        
        if fs::metadata(output)?.len() <= target_bytes {
            return Ok(());
        }
    }
    
    // 3. Last resort: render pages to images and rebuild PDF
    Ok(())
}
```

#### Binary Size & Licensing

| Property | Value |
|----------|-------|
| Binary size | ~25-40 MB (static build) |
| License | **AGPL v3** (Ghostscript) or **commercial license** from Artifex |
| Prebuilt binaries | `ghostscript.com/releases/gsdnld.html` — all 3 platforms |

**CRITICAL LICENSING GOTCHA:** Ghostscript is **AGPL v3**. This means if you ship it as a sidecar in a networked application, you may need to open-source your app OR purchase a commercial license from Artifex Software. For a desktop app that's not a network service, AGPL is less restrictive but still requires providing source code to users. **Budget for a commercial Ghostscript license if your app is proprietary.**

### Alternative: qpdf

**CLI name:** `qpdf`

**What qpdf does:**
- PDF structure optimization (linearization, object stream compression)
- Stream recompression with `--recompress-flate` + `--compression-level=9`
- Image optimization with `--optimize-images` + `--jpeg-quality=N`
- Lossless size reduction typically 5-20%

**What qpdf does NOT do:**
- No image downsampling/resolution reduction
- No color space conversion
- No font subsetting (beyond what's already in the file)

```bash
# Basic optimization (lossless)
qpdf --linearize --object-streams=generate --compression-level=9 input.pdf output.pdf

# With image recompression (lossy)
qpdf --linearize --object-streams=generate \
  --recompress-flate --compression-level=9 \
  --optimize-images --jpeg-quality=75 \
  input.pdf output.pdf
```

| Property | Value |
|----------|-------|
| Binary size | ~5-10 MB |
| License | **Apache 2.0** (qpdf) — safe for proprietary apps |
| Prebuilt binaries | `github.com/qpdf/qpdf/releases` — all 3 platforms |

**Recommendation:** Use qpdf as a first pass (lossless, Apache-licensed), then Ghostscript if more compression is needed. Or use qpdf exclusively if you want to avoid AGPL.

### Alternative: mutool (MuPDF)

```bash
# Clean and optimize PDF
mutool clean -ggggz input.pdf output.pdf
# -g: garbage collect
# -g: more aggressive GC
# -g: even more
# -g: maximum GC
# -z: deflate compression
```

| Property | Value |
|----------|-------|
| Binary size | ~10-15 MB |
| License | **AGPL v3** (MuPDF) or **commercial license** from Artifex |
| Prebuilt binaries | `mupdf.com/releases` |

**Verdict:** Same AGPL licensing as Ghostscript. Use qpdf instead for Apache-licensed optimization.

---

## 4. Documents (DOCX, XLSX, PPTX)

### The Challenge

OOXML formats (DOCX, XLSX, PPTX) are **ZIP files containing XML + embedded media** (images, fonts). The main size consumers are:

1. **Embedded images** (JPEG, PNG, EMF, WMF) — typically 70-90% of file size in PPTX
2. **Embedded fonts** — can be large if full fonts are embedded
3. **XML bloat** — verbose XML markup
4. **ZIP compression level** — default is often not maximum

### Best Approach: Unzip → Recompress Media → Rezip

**No single mature CLI tool exists** for OOXML compression. The approach is:

1. Unzip the OOXML file
2. Find embedded media (`word/media/`, `ppt/media/`, `xl/media/`)
3. Compress each image using libvips (JPEG/PNG optimization)
4. Optionally strip embedded fonts (risky — may break rendering)
5. Re-zip with maximum compression (DEFLATE level 9 or better, zstd)

```rust
fn compress_docx(input: &str, output: &str, target_bytes: u64) -> Result<()> {
    let temp_dir = create_temp_dir()?;
    
    // 1. Unzip
    Command::new("unzip").arg(input).arg("-d").arg(&temp_dir).output()?;
    // Or use Rust zip crate (see below)
    
    // 2. Find and compress media files
    let media_dirs = ["word/media", "ppt/media", "xl/media"];
    for media_dir in &media_dirs {
        let media_path = temp_dir.join(media_dir);
        if media_path.exists() {
            for entry in fs::read_dir(&media_path)? {
                let file = entry?;
                let path = file.path();
                let ext = path.extension().and_then(|e| e.to_str()).unwrap_or("");
                
                match ext.to_lowercase().as_str() {
                    "jpg" | "jpeg" => {
                        // Recompress JPEG at lower quality
                        Command::new("vips")
                            .args(["copy", path.to_str().unwrap(),
                                   &format!("{}[Q=75,strip]", path.to_str().unwrap())])
                            .output()?;
                    }
                    "png" => {
                        // Optimize PNG (quantize if possible)
                        Command::new("vips")
                            .args(["copy", path.to_str().unwrap(),
                                   &format!("{}[palette=true,Q=256,strip]", path.to_str().unwrap())])
                            .output()?;
                    }
                    "emf" | "wmf" => {
                        // Convert EMF/WMF to PNG (harder — needs ImageMagick or LibreOffice)
                        // Skip for now
                    }
                    _ => {}
                }
            }
        }
    }
    
    // 3. Re-zip with maximum compression
    Command::new("zip")
        .args(["-9", "-r", "-X", output, "."])
        .current_dir(&temp_dir)
        .output()?;
    // -9: max compression, -X: exclude extra file attributes, -r: recursive
    
    // 4. Binary search on image quality if still over target
    // ...similar to image target-size approach
    
    Ok(())
}
```

### Rust Crates for OOXML Manipulation

No mature, complete Rust crate exists for full OOXML manipulation. Available options:

| Crate | Status | Capabilities |
|-------|--------|-------------|
| `zip` | Mature | Read/write ZIP files (the container) |
| `quick-xml` | Mature | Parse/write XML |
| `docx-rs` | Active | DOCX creation/editing (limited) |
| `ooxml` | Alpha | Partial OOXML parsing |
| `xlsx-rs` / `calamine` | Mature | XLSX reading (not writing) |
| `umya-spreadsheet` | Active | XLSX reading + writing |

**Recommended approach:** Use the `zip` crate + `quick-xml` for the container/XML, and call `vips` sidecar for image recompression. This gives you full control without depending on incomplete OOXML libraries.

```rust
use zip::ZipArchive;
use std::io::Read;

fn compress_ooxml(input: &str, output: &str, image_quality: u32) -> Result<()> {
    let file = File::open(input)?;
    let mut archive = ZipArchive::new(file)?;
    
    let output_file = File::create(output)?;
    let mut zip_writer = zip::ZipWriter::new(output_file);
    let options = zip::write::SimpleFileOptions::default()
        .compression_method(zip::CompressionMethod::Deflated)
        .compression_level(9);  // Max compression
    
    for i in 0..archive.len() {
        let mut file = archive.by_index(i)?;
        let name = file.name().to_string();
        
        if is_media_file(&name) {
            // Extract, recompress with vips, then add to zip
            let mut media_data = Vec::new();
            file.read_to_end(&mut media_data)?;
            let compressed = recompress_image_with_vips(&media_data, image_quality)?;
            zip_writer.start_file(&name, options)?;
            zip_writer.write_all(&compressed)?;
        } else {
            // Copy as-is (or re-compress XML)
            let mut data = Vec::new();
            file.read_to_end(&mut data)?;
            zip_writer.start_file(&name, options)?;
            zip_writer.write_all(&data)?;
        }
    }
    
    zip_writer.finish()?;
    Ok(())
}
```

### Existing Tools (for reference, not for sidecar use)

| Tool | Platform | Notes |
|------|----------|-------|
| **NXPowerLite** | Windows | Commercial, very effective, not scriptable |
| **Office Files Optimizer** | macOS | GUI only, not CLI |
| **Document Compressor** (various) | Web | Online services, privacy concern |
| **python-docx** + PIL | Python | Library approach, not standalone CLI |
| **LibreOffice headless** | Cross-platform | Can re-save files but doesn't optimize media |

**LibreOffice headless** can re-save OOXML files (may apply some compression):
```bash
# Re-save DOCX (may reduce size slightly via better XML compression)
libreoffice --headless --convert-to docx --outdir output/ input.docx
```

**No mature standalone CLI tool exists for OOXML compression.** The unzip → recompress media → rezip approach is the way to go.

### Binary Size & Licensing

| Property | Value |
|----------|-------|
| `zip`/`unzip` | ~200 KB, Info-ZIP license (BSD-like) |
| Rust `zip` crate | Compiled into your app, MIT/Apache |
| libvips (for image recompression) | Already bundled for image category |
| Total additional size | ~0 (reuses vips sidecar) |

---

## Tauri Sidecar Packaging

### How Tauri `externalBin` Works

From the [Tauri 2 docs](https://v2.tauri.app/develop/sidecar/):

1. Add binaries to `tauri.conf.json`:
```json
{
  "bundle": {
    "externalBin": [
      "binaries/vips",
      "binaries/ffmpeg",
      "binaries/ffprobe",
      "binaries/gs",
      "binaries/qpdf"
    ]
  }
}
```

2. Binary naming convention: `binaries/vips-{TARGET_TRIPLE}[.exe]`
   - macOS arm64: `binaries/vips-aarch64-apple-darwin`
   - macOS x86_64: `binaries/vips-x86_64-apple-darwin`
   - Windows x86_64: `binaries/vips-x86_64-pc-windows-msvc.exe`
   - Linux x86_64: `binaries/vips-x86_64-unknown-linux-gnu`

3. Call from Rust:
```rust
use tauri_plugin_shell::ShellExt;

let sidecar = app.shell().sidecar("vips").unwrap();
let (mut rx, mut child) = sidecar
    .args(["copy", "input.jpg", "output.jpg[Q=80,strip]"])
    .spawn()
    .expect("Failed to spawn vips");
```

Or using `std::process::Command` directly (simpler, no shell plugin needed):
```rust
use std::process::Command;

fn get_sidecar_path(app: &tauri::AppHandle, name: &str) -> String {
    let resource_path = app.path()
        .resolve("binaries", tauri::path::BaseDirectory::Resource)
        .unwrap();
    
    let target_triple = std::env::consts::ARCH;
    let platform_suffix = if cfg!(target_os = "windows") { ".exe" } else { "" };
    
    // Match the target triple format
    let triple = match (std::env::consts::OS, std::env::consts::ARCH) {
        ("macos", "aarch64") => "aarch64-apple-darwin",
        ("macos", "x86_64") => "x86_64-apple-darwin",
        ("windows", "x86_64") => "x86_64-pc-windows-msvc",
        ("linux", "x86_64") => "x86_64-unknown-linux-gnu",
        ("linux", "aarch64") => "aarch64-unknown-linux-gnu",
        _ => panic!("Unsupported platform"),
    };
    
    resource_path
        .join(format!("{}-{}{}", name, triple, platform_suffix))
        .to_str()
        .unwrap()
        .to_string()
}

fn compress_image(app: &tauri::AppHandle, input: &str, output: &str, quality: u32) {
    let vips = get_sidecar_path(app, "vips");
    Command::new(&vips)
        .args(["copy", input, &format!("{}[Q={},strip]", output, quality)])
        .output()
        .expect("Failed to run vips");
}
```

### Sidecar Binary Size Budget

| Binary | macOS | Windows | Linux | Notes |
|--------|-------|---------|-------|-------|
| vips | ~15 MB | ~20 MB (ZIP w/ DLLs) | ~15 MB | Static build; Windows needs DLLs alongside |
| ffmpeg | ~70 MB | ~80 MB | ~70 MB | Static build with all codecs |
| ffprobe | ~30 MB | ~35 MB | ~30 MB | Can be extracted from ffmpeg build |
| gs | ~30 MB | ~35 MB | ~30 MB | Static build |
| qpdf | ~5 MB | ~7 MB | ~5 MB | Static build |
| **Total** | **~150 MB** | **~177 MB** | **~150 MB** | Per-platform |

**Size reduction tips:**
- Build ffmpeg with only needed codecs (`--enable-decoder=h264 --enable-encoder=libx264` etc.) → ~20 MB
- Use shared libraries on macOS (bundle as .dylib in Frameworks)
- Strip debug symbols: `strip binaries/*`
- Use UPX compression on Windows/Linux binaries (not macOS — code signing issues)
- Consider lazy-downloading sidecars on first use (download ffmpeg only when user compresses video)

### Windows DLL Considerations

For libvips on Windows, the prebuilt ZIP from `build-win64-mxe` includes:
- `vips.exe` + `vips-dev` folder
- All required DLLs (`libvips.dll`, `libglib-2.0.dll`, etc.)

You need to bundle ALL DLLs alongside `vips.exe`. Tauri's `externalBin` only handles the single executable. Use `resources` config for DLLs:

```json
{
  "bundle": {
    "externalBin": ["binaries/vips"],
    "resources": ["binaries/vips-dlls/*.dll"]
  }
}
```

Then ensure the DLLs directory is in the PATH when calling vips, or place them next to the exe.

### macOS App Bundle Structure

```
MyApp.app/
  Contents/
    MacOS/
      MyApp
      vips-aarch64-apple-darwin      ← sidecar
      ffmpeg-aarch64-apple-darwin
      gs-aarch64-apple-darwin
    Frameworks/
      libvips.dylib                   ← if using dynamic libs
    Resources/
      binaries/
        vips-aarch64-apple-darwin
```

### Permissions (capabilities/default.json)

```json
{
  "permissions": [
    "core:default",
    {
      "identifier": "shell:allow-execute",
      "allow": [
        {
          "name": "binaries/vips",
          "sidecar": true,
          "args": true
        },
        {
          "name": "binaries/ffmpeg",
          "sidecar": true,
          "args": true
        },
        {
          "name": "binaries/gs",
          "sidecar": true,
          "args": true
        }
      ]
    }
  ]
}
```

---

## Summary Matrix

| Category | Tool | CLI | License | Size | Target-Size Strategy | HEIC/Format Support |
|----------|------|-----|---------|------|---------------------|---------------------|
| **Images** | libvips | `vips` / `vipsthumbnail` | LGPLv3 | ~15-20 MB | Binary search on Q param + dimension reduction | JPEG ✅, PNG ✅, WebP ✅, HEIC read ✅ (write needs GPLv2 x265) |
| **Videos** | FFmpeg | `ffmpeg` + `ffprobe` | LGPLv2.1 / GPLv2+ (with x264) | ~70-100 MB | Two-pass with calculated bitrate + resolution reduction | MP4 ✅, MOV ✅, H.264 ✅, H.265 ✅ |
| **PDF** | Ghostscript | `gs` | **AGPLv3** ⚠️ | ~30-40 MB | Binary search on PDFSETTINGS + DPI + JPEGQ | PDF ✅ |
| **PDF (alt)** | qpdf | `qpdf` | Apache 2.0 ✅ | ~5-10 MB | Lossless optimization + `--optimize-images` + `--jpeg-quality` | PDF ✅ (no downsampling) |
| **Documents** | Custom (zip + vips) | Rust `zip` crate + `vips` sidecar | MIT + LGPLv3 | ~0 (reuses vips) | Unzip → recompress media with vips → rezip at level 9 | DOCX ✅, XLSX ✅, PPTX ✅ |

### Recommended Tool Stack

```
┌─────────────────────────────────────────────────────┐
│                 Tauri 2 App (Rust)                    │
│                                                       │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐          │
│  │  vips    │  │  ffmpeg  │  │   gs /   │          │
│  │ sidecar  │  │ sidecar  │  │  qpdf    │          │
│  │ (LGPLv3) │  │ (GPLv2+) │  │ (AGPL /  │          │
│  │  ~15 MB  │  │  ~70 MB  │  │ Apache)  │          │
│  └────┬─────┘  └────┬─────┘  └────┬─────┘          │
│       │              │              │                │
│       │     ┌────────┴────────┐     │                │
│       │     │    ffprobe      │     │                │
│       │     │    sidecar      │     │                │
│       │     │    ~30 MB       │     │                │
│       │     └─────────────────┘     │                │
│       │                              │                │
│       └──────────┬───────────────────┘                │
│                  │                                    │
│          ┌───────┴────────┐                           │
│          │  zip crate     │                           │
│          │  (Rust, MIT)   │                           │
│          │  for OOXML     │                           │
│          └────────────────┘                           │
└─────────────────────────────────────────────────────┘
```

### Licensing Risk Summary

| Risk Level | Tool | License | Mitigation |
|------------|------|---------|------------|
| 🟢 Safe | qpdf | Apache 2.0 | Use for PDF |
| 🟢 Safe | zip crate | MIT | Use for OOXML |
| 🟡 Caution | libvips | LGPLv3 | Dynamic linking OK; static linking requires LGPL compliance |
| 🟡 Caution | ffmpeg (LGPL build) | LGPLv2.1 | Build without GPL codecs; use hardware encoders |
| 🔴 Risk | ffmpeg (GPL build) | GPLv2+ | Don't ship libx264/libx265 in proprietary app |
| 🔴 Risk | Ghostscript | AGPLv3 | Buy commercial license from Artifex, or use qpdf only |
| 🔴 Risk | x265 (HEIC encode) | GPLv2+ | Don't ship; use AVIF instead (BSD + AOM patent) |

### Prebuilt Binary Sources

| Tool | macOS | Windows | Linux |
|------|-------|---------|-------|
| vips | `brew install vips` | `github.com/libvips/build-win64-mxe/releases` | `apt install libvips-tools` / build from source |
| ffmpeg | `evermeet.cx/ffmpeg/` | `github.com/BtbN/FFmpeg-Builds/releases` | `johnvansickle.com/ffmpeg/` |
| gs | `ghostscript.com/releases/gsdnld.html` | Same | Same |
| qpdf | `github.com/qpdf/qpdf/releases` | Same | Same |

All sources provide static binaries that can be directly used as Tauri sidecars (after renaming with target triple suffix).