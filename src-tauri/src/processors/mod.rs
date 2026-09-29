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

use std::collections::HashMap;

use crate::engine::CompressionProcessor;
use crate::models::Category;

pub struct ProcessorRegistry {
    processors: HashMap<Category, Box<dyn CompressionProcessor>>,
    extension_map: HashMap<String, Category>,
}

impl ProcessorRegistry {
    pub fn new() -> Self {
        let mut processors: HashMap<Category, Box<dyn CompressionProcessor>> = HashMap::new();
        let mut extension_map: HashMap<String, Category> = HashMap::new();

        let image_proc = image::ImageProcessor::new();
        for ext in image_proc.supported_extensions() {
            extension_map.insert(ext.to_lowercase(), Category::Image);
        }
        processors.insert(Category::Image, Box::new(image_proc));

        ProcessorRegistry {
            processors,
            extension_map,
        }
    }

    pub fn get_processor(&self, category: Category) -> Option<&dyn CompressionProcessor> {
        self.processors.get(&category).map(|p| p.as_ref())
    }

    pub fn lookup(&self, ext: &str) -> Option<Category> {
        self.extension_map.get(&ext.to_lowercase()).copied()
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
    fn registry_lookup_returns_none_for_non_image_categories() {
        let registry = ProcessorRegistry::new();
        assert!(registry.get_processor(Category::Video).is_none());
        assert!(registry.get_processor(Category::Pdf).is_none());
        assert!(registry.get_processor(Category::Document).is_none());
        assert!(registry.get_processor(Category::Other).is_none());
    }
}
