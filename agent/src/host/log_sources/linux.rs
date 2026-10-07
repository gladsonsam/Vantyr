//! Linux: a single standalone agent, so there are no service-owned logs.

use std::path::PathBuf;

use super::LogSourceDesc;

pub(super) fn service_sources() -> Vec<LogSourceDesc> {
    Vec::new()
}

pub(super) fn service_log(file: &str) -> Result<PathBuf, String> {
    Err(format!("{file} is only used on Windows"))
}
