//! Enrollment persistence: pairing codes (invites), pending claims and their approval,
//! token-use history, and per-device credential revocation / replacement. Callers import the
//! submodule they need (`db::claims`, `db::invites`).

use sha2::{Digest, Sha256};

pub mod claims;
pub mod invites;

fn sha256_hex(raw: &str) -> String {
    let digest = Sha256::digest(raw.as_bytes());
    digest.iter().map(|b| format!("{b:02x}")).collect()
}
