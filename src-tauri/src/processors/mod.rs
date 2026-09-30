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

pub mod image;
pub mod pdf;
pub mod video;

use std::collections::HashMap;

use crate::engine::CompressionProcessor;
use crate::models::Category;

pub struct ProcessorRegistry {
    processors: HashMap<Category, Box<dyn CompressionProcessor>>,
    extension_map: HashMap<String, Category>,
}

impl ProcessorRegistry {
    pub fn new() -> Self {
        let mut registry = ProcessorRegistry {
            processors: HashMap::new(),
            extension_map: HashMap::new(),
        };
        registry.register(Box::new(image::ImageProcessor::new()));
        registry.register(Box::new(pdf::PdfProcessor::new()));
        registry.register(Box::new(video::VideoProcessor::new()));
        registry
    }

    fn register(&mut self, processor: Box<dyn CompressionProcessor>) {
        let category = processor.category();
        for ext in processor.supported_extensions() {
            self.extension_map.insert(ext.to_lowercase(), category);
        }
        self.processors.insert(category, processor);
    }

    pub fn get_processor(&self, category: Category) -> Option<&dyn CompressionProcessor> {
        self.processors.get(&category).map(|p| p.as_ref())
    }

    pub fn lookup(&self, ext: &str) -> Option<Category> {
        self.extension_map.get(&ext.to_lowercase()).copied()
    }
}

impl Default for ProcessorRegistry {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn registry_maps_all_image_extensions_to_image_category() {
        let registry = ProcessorRegistry::new();
        for ext in ["jpg", "jpeg", "png", "webp", "heic", "heif"] {
            assert_eq!(
                registry.extension_map.get(ext),
                Some(&Category::Image),
                "ext: {}",
                ext
            );
        }
        // lowercased on insert — uppercase input still maps
        assert_eq!(registry.lookup("JPEG"), Some(Category::Image));
    }

    #[test]
    fn registry_maps_pdf_extension_to_pdf_category() {
        let registry = ProcessorRegistry::new();
        assert_eq!(registry.lookup("pdf"), Some(Category::Pdf));
        assert_eq!(registry.lookup("PDF"), Some(Category::Pdf));
        assert!(registry.get_processor(Category::Pdf).is_some());
    }

    #[test]
    fn registry_maps_video_extensions_to_video_category() {
        let registry = ProcessorRegistry::new();
        assert_eq!(registry.lookup("mp4"), Some(Category::Video));
        assert_eq!(registry.lookup("MOV"), Some(Category::Video));
        assert!(registry.get_processor(Category::Video).is_some());
    }

    #[test]
    fn registry_lookup_matches_category() {
        let registry = ProcessorRegistry::new();
        assert!(registry.get_processor(Category::Video).is_some());
        assert!(registry.get_processor(Category::Document).is_none());
        assert!(registry.get_processor(Category::Other).is_none());
    }
}
