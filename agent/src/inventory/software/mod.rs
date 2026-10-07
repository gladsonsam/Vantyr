//! Installed software inventory (`software_inventory` frames).
//!
//! Windows reads the Uninstall registry keys; Linux asks the package managers
//! (pacman / dpkg / rpm / flatpak). Both produce the same item shape.

use std::cmp::Ordering;

#[cfg(not(windows))]
mod linux;
#[cfg(windows)]
mod windows;
#[cfg(not(windows))]
use self::linux as imp;
#[cfg(windows)]
use self::windows as imp;

pub use imp::{send_inventory, send_inventory_if_changed};

/// ASCII-only case folding; avoids per-comparison `to_lowercase()` allocations (MSRV-safe).
pub fn cmp_str_ascii_case_insensitive(a: &str, b: &str) -> Ordering {
    let mut ab = a.bytes().map(|x| x.to_ascii_lowercase());
    let mut bb = b.bytes().map(|x| x.to_ascii_lowercase());
    loop {
        match (ab.next(), bb.next()) {
            (None, None) => return Ordering::Equal,
            (None, Some(_)) => return Ordering::Less,
            (Some(_), None) => return Ordering::Greater,
            (Some(x), Some(y)) => match x.cmp(&y) {
                Ordering::Equal => {}
                o => return o,
            },
        }
    }
}
