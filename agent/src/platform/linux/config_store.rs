//! Linux config storage.
//!
//! Currently delegates to the shared `crate::config`, which on non-Windows uses
//! a `0600` XDG JSON store. A future increment can add Secret Service (`oo7`)
//! with an encrypted-file fallback for headless/daemon sessions.

pub use crate::config::{
    config_path, load_config, save_config, take_reopen_settings_ui_after_restart, Config,
};
