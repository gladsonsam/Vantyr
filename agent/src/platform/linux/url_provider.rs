//! Linux active-tab URL provider.
//!
//! No portable OS API exists for the active browser tab URL on Linux. A future
//! increment will source it from a browser extension (native messaging) or the
//! AT-SPI accessibility bus; until then this reports none and the capability
//! block reports `url_tracking: "unsupported"`.

pub use crate::platform::types::ActiveUrl;

pub fn active_url() -> Option<ActiveUrl> {
    None
}
