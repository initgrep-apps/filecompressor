# File Size Optimizer

## Product

An offline desktop application for batch-optimizing files to maximum size limits while preserving the best possible quality.

Primary users: teachers and administrative users who need to prepare files for portals with file-size restrictions.

---

## Core Feature: Category-Based Size Targets

The application supports **different compression size limits for different file categories**.

Example:

```text
Images       ≤ 200 KB
Videos       ≤ 10 MB
PDF          ≤ 2 MB
Documents    ≤ 1 MB
```

The user configures targets at the category level rather than for individual file formats.

When processing a mixed batch, each file is automatically assigned to its category and receives the corresponding target.

### Target Resolution

Target size is resolved in this order:

1. Explicit per-file/user override
2. Category-specific user setting
3. Preset/profile setting
4. Application default

Example:

```text
Images      → 200 KB
Videos      → 10 MB
PDF         → 2 MB
Documents   → 1 MB
```

Users can change these independently.

---

## File Categories

The initial application uses the following high-level categories:

### Images

Examples include JPEG, PNG, WebP, HEIC/HEIF and other supported image formats.

### Videos

Examples include MP4, MOV, WebM and other supported video formats.

### PDF

PDF files are handled separately because PDF optimization requires different processing strategies from general documents.

### Documents

Examples include DOCX, XLSX, PPTX and other supported office/document formats.

### Other

Unsupported or formats for which meaningful optimization is not available should be identified clearly rather than forced through an inappropriate compression pipeline.

Individual file formats are an **internal implementation detail** and should not unnecessarily complicate user configuration.

---

## Compression Profiles

The application should provide simple configurable targets by category.

Example:

```text
Images       [ 200 KB ]
Videos       [ 10 MB  ]
PDF          [ 2 MB   ]
Documents    [ 1 MB   ]
```

Defaults should be sensible and editable.

The application should not require users to understand codecs, image formats, bitrates, compression algorithms, or other technical settings for normal operation.

---

## Batch Processing

A batch can contain mixed file types.

Example:

```text
photo1.jpg
photo2.png
marksheet.pdf
assignment.docx
video.mp4
```

The application automatically resolves each file to its category:

```text
photo1.jpg       → Images    → ≤ 200 KB
photo2.png       → Images    → ≤ 200 KB
marksheet.pdf    → PDF       → ≤ 2 MB
assignment.docx  → Documents → ≤ 1 MB
video.mp4        → Videos    → ≤ 10 MB
```

The UI should clearly display the target being applied to each file.

---

## Target Size Engine

The central engine receives:

```text
Input file
File category
Target maximum size
Quality constraints
Compression policy
```

and produces:

```text
Optimized file
Actual size
Compression parameters
Quality/result metadata
```

The engine selects the appropriate internal processor based on the file format while keeping this complexity hidden from the user.

```text
                    Target Size Engine
                           │
                    File Category
                           │
        ┌──────────┬───────┼─────────┐
        ▼          ▼       ▼         ▼
      Image      Video    PDF     Document
    Processor   Processor Processor Processor
        │          │       │         │
        └──────────┴───────┴─────────┘
                           │
                     Target achieved
```

Each processor may use different optimization techniques internally.

The engine must verify the final file size rather than assuming the requested target was achieved.

---

## User Interface

Primary workflow:

```text
Drop files
    ↓
Application detects file types/categories
    ↓
Show applicable target for each category
    ↓
User optionally adjusts targets
    ↓
Compress
    ↓
Review results
```

Example:

```text
┌────────────────────────────────────────────┐
│ Compression targets                        │
│                                            │
│ Images       [ 200 KB ]                    │
│ Videos       [ 10 MB  ]                    │
│ PDF          [ 2 MB   ]                    │
│ Documents    [ 1 MB   ]                    │
│                                            │
│              [ Compress Files ]            │
└────────────────────────────────────────────┘
```

For individual files, users should be able to override the applicable target.

---

## Initial Supported Formats

Support should be organized internally by category rather than exposing individual formats as configuration options.

### Images

Initial support should include common image formats such as:

- JPEG/JPG
- PNG
- WebP
- HEIC/HEIF

### Videos

Initial support should include common video formats such as:

- MP4
- MOV

Additional formats should be added without requiring changes to the user-facing compression model.

### PDF

- PDF

### Documents

Initial support should include:

- DOCX
- XLSX
- PPTX

The architecture should allow additional formats to be added to an existing category without changing the core target-size engine.

---

## Technology Stack

### Desktop

- Tauri 2
- Rust

### Frontend

- React
- TypeScript
- Vite

### Processing

- libvips / appropriate native image codecs
- FFmpeg
- Appropriate PDF optimization libraries/tools
- OOXML package manipulation for Office formats

### Architecture

```text
React + TypeScript
        │
      Tauri
        │
       Rust
        │
 ┌──────┴────────────┐
 │ Application Core  │
 │                   │
 │ Category Targets  │
 │ Target Engine     │
 │ Job Queue         │
 │ File Detection    │
 │ Progress          │
 │ Cancellation      │
 └──────┬────────────┘
        │
 ┌──────┼─────────────────────┐
 ▼      ▼          ▼          ▼
Image  Video      PDF      Document
Engine  Engine    Engine      Engine
```

The compression core must remain independent of the UI.

---

## Offline / Privacy

- No server.
- No account.
- No cloud processing.
- No upload of user files.
- All processing happens locally.
- No database required initially.
- Internet connection is not required for normal operation.

---

## Safety

- Never modify original files by default.
- Write results to a separate output location.
- Handle filename collisions safely.
- Support cancellation of active jobs.
- Clean up incomplete temporary files.
- Clearly report unsupported files.
- Clearly report when the target cannot reasonably be achieved without unacceptable quality loss.

---

## MVP

Category-based compression targets are part of **v1**.

V1 must support:

- Mixed-format batch input
- Category-based compression targets
- User-editable category targets
- Per-file target override
- Automatic file type/category detection
- Image compression
- PDF compression
- Batch processing
- Progress and cancellation
- Original-file preservation
- Before/after file sizes
- Clear indication when a target cannot be achieved without unacceptable quality loss

Video and additional document formats can be added as processors while retaining the same category-based target architecture.

The user-facing model should remain simple:

```text
Images
Videos
PDF
Documents
```

Individual formats and codecs should remain implementation details wherever possible.