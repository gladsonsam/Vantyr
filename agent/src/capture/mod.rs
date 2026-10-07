//! Everything that captures the desktop: the live screen stream ([`screen`]),
//! the SYSTEM capture worker and secure-desktop attachment (Windows), loopback
//! audio (Windows), the frame geometry authority shared with remote input,
//! screen history ("Recall") with its spool, and the context sampled alongside it.

#[cfg(windows)]
pub mod audio;
pub mod geometry;
pub mod history;
pub mod recall_context;
pub mod screen;
#[cfg(windows)]
pub mod secure_desktop;
#[cfg(windows)]
pub mod worker;
