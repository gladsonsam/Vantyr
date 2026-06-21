//! Linux system info.
//!
//! Delegates to the shared `crate::system_info`, whose cross-platform core uses
//! `sysinfo` and whose non-Windows hooks read `/sys`, `/etc/resolv.conf`, and
//! `ip` for network adapters. (DMI identity — model/serial via `/sys/class/dmi`
//! — and a logind active-user lookup are future increments.)

pub use crate::system_info::{
    active_username, collect_agent_info, collect_resource_metrics, env_username_fallback,
};
