//! Backend PKI foundation for Vantyr Network.
//!
//! This crate owns exactly one thing: a dedicated, application-generated
//! inspection root CA whose private key lives only inside an encrypted age
//! vault on disk and in process memory while unlocked. It issues short-lived
//! server leaves for validated DNS/IP names. It is deliberately separate from
//! user identity certificates and from Wi-Fi / RADIUS server certificates, and
//! it does not provision trust onto any device.
//!
//! # What this slice does not do
//!
//! No live TLS interception, no router/AP/RADIUS configuration, no MDM or
//! mobile app work, no HTTP API, no CRL/OCSP publication and no client trust
//! removal. A later enrollment step consumes only [`CaMetadata`] and the public
//! certificate. Rotation marks the previous root retired in a machine-readable
//! file but leaves device trust stores alone.

#![forbid(unsafe_code)]

pub mod envelope;
pub mod error;
mod fsutil;
pub mod metadata;
pub mod names;
pub mod signer;
pub mod vault;

pub use error::{PkiError, Result};
pub use fsutil::{MAX_METADATA_BYTES, MAX_SECRET_BYTES, MAX_VAULT_BYTES};
pub use metadata::{CaMetadata, PURPOSE_ID};
pub use signer::{CaSigner, IssuedLeaf, LeafRequest};
pub use vault::{
    check, export_public, init_ca, inspect_metadata, inspect_retirement, paths_for,
    read_secret_file, rotate_ca, unlock, CaPaths, RetirementRecord, VaultOptions, DEFAULT_CA_NAME,
};
