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

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Category {
    Image,
    Video,
    Pdf,
    Document,
    Other,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FileStatus {
    Pending,
    Compressing,
    Done,
    BestEffort,
    Failed,
    Cancelled,
    Unsupported,
    AlreadyUnderTarget,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileEntry {
    pub id: String,
    pub name: String,
    pub path: String,
    pub category: Category,
    pub target_bytes: u64,
    pub original_size: u64,
    pub status: FileStatus,
    pub compressed_size: Option<u64>,
    pub output_path: Option<String>,
    pub error: Option<String>,
}

impl FileEntry {
    pub fn new(path: &str) -> Self {
        let name = std::path::Path::new(path)
            .file_name()
            .unwrap_or_default()
            .to_string_lossy()
            .to_string();
        let name = if name.is_empty() {
            "unknown".to_string()
        } else {
            name
        };

        let original_size = std::fs::metadata(path)
            .map(|m| m.len())
            .unwrap_or(0);

        let category = crate::detection::detect_category(&name);
        let status = if category == Category::Other {
            FileStatus::Unsupported
        } else {
            FileStatus::Pending
        };

        let target_bytes = crate::detection::default_target_bytes(category);

        FileEntry {
            id: uuid::Uuid::new_v4().to_string(),
            name,
            path: path.to_string(),
            category,
            target_bytes,
            original_size,
            status,
            compressed_size: None,
            output_path: None,
            error: None,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::tempdir;

    #[test]
    fn test_file_entry_new_valid_file() {
        let dir = tempdir().unwrap();
        let file_path = dir.path().join("test.jpg");
        fs::write(&file_path, b"test content").unwrap();

        let entry = FileEntry::new(file_path.to_str().unwrap());

        assert_eq!(entry.name, "test.jpg");
        assert!(entry.original_size > 0);
        assert_eq!(entry.category, Category::Image);
        assert_eq!(entry.status, FileStatus::Pending);
        assert_eq!(entry.target_bytes, 200 * 1024);
        assert!(!entry.id.is_empty());
        assert!(entry.compressed_size.is_none());
        assert!(entry.output_path.is_none());
        assert!(entry.error.is_none());
    }

    #[test]
    fn test_file_entry_new_missing_file() {
        let entry = FileEntry::new("/nonexistent/path/test.jpg");

        assert_eq!(entry.name, "test.jpg");
        assert_eq!(entry.original_size, 0);
        assert_eq!(entry.category, Category::Image);
        assert_eq!(entry.status, FileStatus::Pending);
    }

    #[test]
    fn test_file_entry_new_permission_denied() {
        let entry = FileEntry::new("/root/forbidden.jpg");

        assert_eq!(entry.name, "forbidden.jpg");
        assert_eq!(entry.original_size, 0);
    }

    #[test]
    fn test_file_entry_new_empty_filename() {
        let entry = FileEntry::new("/path/to/");

        assert_eq!(entry.name, "to");
    }

    #[test]
    fn test_file_entry_new_no_filename() {
        let entry = FileEntry::new("/");

        assert_eq!(entry.name, "unknown");
        assert_eq!(entry.category, Category::Other);
    }

    #[test]
    fn test_file_entry_new_unicode_filename() {
        let dir = tempdir().unwrap();
        let file_path = dir.path().join("测试文件.jpg");
        fs::write(&file_path, b"test").unwrap();

        let entry = FileEntry::new(file_path.to_str().unwrap());

        assert_eq!(entry.name, "测试文件.jpg");
    }

    #[test]
    fn test_file_entry_status_assignment() {
        let dir = tempdir().unwrap();
        
        let img_path = dir.path().join("test.jpg");
        fs::write(&img_path, b"test").unwrap();
        let img_entry = FileEntry::new(img_path.to_str().unwrap());
        assert_eq!(img_entry.status, FileStatus::Pending);

        let other_path = dir.path().join("test.xyz");
        fs::write(&other_path, b"test").unwrap();
        let other_entry = FileEntry::new(other_path.to_str().unwrap());
        assert_eq!(other_entry.status, FileStatus::Unsupported);
    }

    #[test]
    fn test_file_entry_serialization_roundtrip() {
        let dir = tempdir().unwrap();
        let file_path = dir.path().join("test.jpg");
        fs::write(&file_path, b"test content").unwrap();

        let entry = FileEntry::new(file_path.to_str().unwrap());
        let json = serde_json::to_string(&entry).unwrap();
        let deserialized: FileEntry = serde_json::from_str(&json).unwrap();

        assert_eq!(entry.id, deserialized.id);
        assert_eq!(entry.name, deserialized.name);
        assert_eq!(entry.path, deserialized.path);
        assert_eq!(entry.category, deserialized.category);
        assert_eq!(entry.target_bytes, deserialized.target_bytes);
        assert_eq!(entry.original_size, deserialized.original_size);
        assert_eq!(entry.status, deserialized.status);
        assert_eq!(entry.compressed_size, deserialized.compressed_size);
        assert_eq!(entry.output_path, deserialized.output_path);
        assert_eq!(entry.error, deserialized.error);
    }

    #[test]
    fn test_file_entry_uuid_format() {
        let dir = tempdir().unwrap();
        let file_path = dir.path().join("test.jpg");
        fs::write(&file_path, b"test").unwrap();

        let entry = FileEntry::new(file_path.to_str().unwrap());
        let uuid = uuid::Uuid::parse_str(&entry.id).unwrap();
        assert_eq!(uuid.get_version(), Some(uuid::Version::Random));
    }

    #[test]
    fn test_category_enum_serialization() {
        let cat = Category::Image;
        let json = serde_json::to_string(&cat).unwrap();
        assert_eq!(json, "\"image\"");

        let cat = Category::Other;
        let json = serde_json::to_string(&cat).unwrap();
        assert_eq!(json, "\"other\"");
    }

    #[test]
    fn test_file_status_enum_serialization() {
        let status = FileStatus::Pending;
        let json = serde_json::to_string(&status).unwrap();
        assert_eq!(json, "\"pending\"");

        let status = FileStatus::AlreadyUnderTarget;
        let json = serde_json::to_string(&status).unwrap();
        assert_eq!(json, "\"already_under_target\"");
    }
}