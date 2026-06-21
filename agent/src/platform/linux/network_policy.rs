//! Linux network kill-switch.
//!
//! Delegates to the shared `crate::network_policy`, whose non-Windows path uses a
//! dedicated nftables `inet` table. nftables requires `CAP_NET_ADMIN` (run the
//! agent elevated); without privilege `apply_block` returns an error and the
//! capability block reports `network_blocking: "needs_privilege"`.

pub use crate::network_policy::{apply_block, parse_server_host_port, remove_block};
