pub mod processor;
pub mod result;
pub mod progress;

pub use processor::CompressionProcessor;
pub use result::{CompressionResult, CompressionError};
pub use progress::ProgressSender;
