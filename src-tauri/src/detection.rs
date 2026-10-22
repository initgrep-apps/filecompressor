// Yard — offline batch file compression
// Copyright (C) 2026 Yard Contributors
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

use crate::models::Category;

pub fn detect_category(filename: &str) -> Category {
    let ext = std::path::Path::new(filename)
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_lowercase())
        .unwrap_or_default();
    match ext.as_str() {
        "jpg" | "jpeg" | "png" | "webp" | "heic" | "heif" => Category::Image,
        "mp4" | "mov" => Category::Video,
        "pdf" => Category::Pdf,
        "docx" | "xlsx" | "pptx" => Category::Document,
        _ => Category::Other,
    }
}

#[cfg(test)]
pub fn default_target_bytes(category: Category) -> u64 {
    let settings = crate::settings::Settings::default();
    let key = match category {
        Category::Image => "image",
        Category::Video => "video",
        Category::Pdf => "pdf",
        Category::Document => "document",
        Category::Other => "other",
    };
    settings.target_bytes_for(key)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_detect_image_formats() {
        assert_eq!(detect_category("photo.jpg"), Category::Image);
        assert_eq!(detect_category("photo.JPEG"), Category::Image);
        assert_eq!(detect_category("photo.png"), Category::Image);
        assert_eq!(detect_category("photo.webp"), Category::Image);
        assert_eq!(detect_category("photo.heic"), Category::Image);
        assert_eq!(detect_category("photo.heif"), Category::Image);
    }

    #[test]
    fn test_detect_video_formats() {
        assert_eq!(detect_category("video.mp4"), Category::Video);
        assert_eq!(detect_category("video.MOV"), Category::Video);
    }

    #[test]
    fn test_detect_pdf() {
        assert_eq!(detect_category("doc.pdf"), Category::Pdf);
        assert_eq!(detect_category("doc.PDF"), Category::Pdf);
    }

    #[test]
    fn test_detect_document_formats() {
        assert_eq!(detect_category("report.docx"), Category::Document);
        assert_eq!(detect_category("sheet.xlsx"), Category::Document);
        assert_eq!(detect_category("slides.pptx"), Category::Document);
    }

    #[test]
    fn test_detect_unknown() {
        assert_eq!(detect_category("archive.zip"), Category::Other);
        assert_eq!(detect_category("file.xyz"), Category::Other);
        assert_eq!(detect_category("noextension"), Category::Other);
    }

    #[test]
    fn test_default_targets() {
        assert_eq!(default_target_bytes(Category::Image), 200 * 1024);
        assert_eq!(default_target_bytes(Category::Video), 10 * 1024 * 1024);
        assert_eq!(default_target_bytes(Category::Pdf), 2 * 1024 * 1024);
        assert_eq!(default_target_bytes(Category::Document), 1 * 1024 * 1024);
        assert_eq!(default_target_bytes(Category::Other), 0);
    }

    #[test]
    fn test_detect_case_insensitivity_all() {
        assert_eq!(detect_category("photo.PNG"), Category::Image);
        assert_eq!(detect_category("photo.WEBP"), Category::Image);
        assert_eq!(detect_category("photo.HEIC"), Category::Image);
        assert_eq!(detect_category("photo.HEIF"), Category::Image);
        assert_eq!(detect_category("video.MP4"), Category::Video);
        assert_eq!(detect_category("report.DOCX"), Category::Document);
        assert_eq!(detect_category("sheet.XLSX"), Category::Document);
        assert_eq!(detect_category("slides.PPTX"), Category::Document);
    }

    #[test]
    fn test_detect_multi_dot_filename() {
        assert_eq!(detect_category("file.v1.jpg"), Category::Image);
        assert_eq!(detect_category("my.document.v2.pdf"), Category::Pdf);
        assert_eq!(detect_category("video.clip.final.mp4"), Category::Video);
    }

    #[test]
    fn test_detect_hidden_file() {
        assert_eq!(detect_category(".hidden.jpg"), Category::Image);
        assert_eq!(detect_category(".config.png"), Category::Image);
    }

    #[test]
    fn test_detect_empty_string() {
        assert_eq!(detect_category(""), Category::Other);
    }

    #[test]
    fn test_detect_whitespace_only() {
        assert_eq!(detect_category("   "), Category::Other);
    }

    #[test]
    fn test_detect_dotless_names_not_extensions() {
        assert_eq!(detect_category("jpg"), Category::Other);
        assert_eq!(detect_category("pdf"), Category::Other);
        assert_eq!(detect_category("mp4"), Category::Other);
    }

    #[test]
    fn test_detect_trailing_dot() {
        assert_eq!(detect_category("file."), Category::Other);
    }

    #[test]
    fn test_detect_dotfile_no_ext() {
        assert_eq!(detect_category(".hidden"), Category::Other);
    }
}
