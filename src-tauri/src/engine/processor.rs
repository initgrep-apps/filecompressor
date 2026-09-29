use std::path::Path;
use tokio_util::sync::CancellationToken;
use crate::engine::result::{CompressionResult, CompressionError};
use crate::engine::progress::ProgressSender;
use crate::models::Category;
use crate::settings::QualityFloors;

pub trait CompressionProcessor: Send + Sync {
    fn category(&self) -> Category;
    fn supported_extensions(&self) -> &[&str];

    fn compress_to_target(
        &self,
        input: &Path,
        output: &Path,
        target_bytes: u64,
        quality_floor: &QualityFloors,
        cancel_token: CancellationToken,
        progress: ProgressSender,
        sidecar_path: &str,
        temp_dir: &Path,
    ) -> Result<CompressionResult, CompressionError>;
}
