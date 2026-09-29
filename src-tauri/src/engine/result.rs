use std::path::PathBuf;

#[derive(Debug)]
pub struct CompressionResult {
    pub output_path: PathBuf,
    pub compressed_size: u64,
    pub quality_used: u32,
    pub met_target: bool,
    pub strategy_used: String,
}

#[derive(Debug, Clone)]
pub enum CompressionError {
    Cancelled,
    SidecarNotFound(String),
    SidecarFailed(String),
    InputFileError(String),
    OutputFileError(String),
    DiskFull,
    Unknown(String),
}

impl std::fmt::Display for CompressionError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            CompressionError::Cancelled => write!(f, "Cancelled"),
            CompressionError::SidecarNotFound(name) => write!(f, "Engine error: {} not available", name),
            CompressionError::SidecarFailed(msg) => write!(f, "Processing error: {}", msg),
            CompressionError::InputFileError(msg) => write!(f, "Cannot read file: {}", msg),
            CompressionError::OutputFileError(msg) => write!(f, "Cannot write output: {}", msg),
            CompressionError::DiskFull => write!(f, "Not enough disk space"),
            CompressionError::Unknown(msg) => write!(f, "{}", msg),
        }
    }
}

impl std::error::Error for CompressionError {}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn compression_error_display_strings_match_spec_wording() {
        let cases: Vec<(CompressionError, &str)> = vec![
            (CompressionError::Cancelled, "Cancelled"),
            (CompressionError::SidecarNotFound("vips".into()), "Engine error: vips not available"),
            (CompressionError::SidecarFailed("boom".into()), "Processing error: boom"),
            (CompressionError::InputFileError("locked".into()), "Cannot read file: locked"),
            (CompressionError::OutputFileError("readonly".into()), "Cannot write output: readonly"),
            (CompressionError::DiskFull, "Not enough disk space"),
            (CompressionError::Unknown("odd".into()), "odd"),
        ];
        for (err, expected) in cases {
            assert_eq!(err.to_string(), expected);
        }
    }
}
