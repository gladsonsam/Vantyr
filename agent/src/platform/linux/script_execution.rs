//! Linux remote script execution.
//!
//! Delegates to the shared `crate::remote_script`, whose non-Windows path runs
//! `sh`/`bash` (and rejects Windows shell values). Server-side
//! `ALLOW_REMOTE_SCRIPT_EXECUTION` gating is unchanged.

pub use crate::remote_script::{run, RunOutcome};
