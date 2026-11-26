//! Errors for the Network PKI crate.
//!
//! Every variant is safe to log or print: none carries key material or a
//! passphrase. Details that may contain operator-controlled *public* input
//! (names, paths, sizes) are kept deliberately small and bounded.

use std::fmt;

/// Result alias used throughout this crate.
pub type Result<T> = std::result::Result<T, PkiError>;

/// Failures from CA generation, encrypted custody, metadata and leaf issuance.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum PkiError {
    /// The destination already exists. This crate never overwrites by default.
    AlreadyExists,
    /// The path resolves through a symbolic link; refused for secrets and vaults.
    SymlinkRejected,
    /// The path is not a regular file.
    NotRegularFile,
    /// A required owner-only mode was not present.
    BadMode {
        /// File name only, never its contents.
        file: String,
        expected: u32,
        found: u32,
    },
    /// A bounded input was larger than its cap.
    TooLarge {
        what: &'static str,
        bytes: u64,
        limit: u64,
    },
    /// A filesystem operation failed.
    Io { op: &'static str, detail: String },
    /// The operator secret file was empty or could not be read as a secret.
    SecretRead(String),
    /// An empty passphrase is not accepted.
    EmptySecret,
    /// A passphrase shorter than the required minimum.
    WeakSecret { bytes: usize, minimum: usize },
    /// Decryption failed, including a wrong passphrase. No underlying detail is
    /// propagated: this is deliberately fail-closed with no fallback.
    DecryptFailed,
    /// The decrypted envelope was not a well-formed vault payload.
    MalformedVault,
    /// A version field from disk did not match this implementation.
    SchemaMismatch { found: u32, expected: u32 },
    /// The envelope purpose did not match the inspection-CA purpose identifier.
    PurposeMismatch,
    /// Public metadata did not match the authenticated vault contents.
    MetadataMismatch,
    /// An invalid server identity was requested (public input, never a secret).
    InvalidName(String),
    /// More names were supplied than the bounded limit.
    TooManyNames { count: usize, limit: usize },
    /// A requested validity window was zero, negative or outside its cap.
    InvalidValidity,
    /// An rcgen operation failed.
    Rcgen(String),
    /// JSON serialization or parsing failed.
    Serialize(String),
}

impl fmt::Display for PkiError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::AlreadyExists => write!(f, "destination already exists; refusing to overwrite"),
            Self::SymlinkRejected => write!(f, "symbolic link refused for a protected path"),
            Self::NotRegularFile => write!(f, "path is not a regular file"),
            Self::BadMode {
                file,
                expected,
                found,
            } => write!(f, "{file} mode is {found:04o}, expected {expected:04o}"),
            Self::TooLarge { what, bytes, limit } => {
                write!(f, "{what} is {bytes} bytes, limit is {limit}")
            }
            Self::Io { op, detail } => write!(f, "{op} failed: {detail}"),
            Self::SecretRead(detail) => write!(f, "operator secret file rejected: {detail}"),
            Self::EmptySecret => write!(f, "operator secret must not be empty"),
            Self::WeakSecret { bytes, minimum } => {
                write!(f, "operator secret is {bytes} bytes, minimum is {minimum}")
            }
            Self::DecryptFailed => write!(f, "vault could not be decrypted with this secret"),
            Self::MalformedVault => write!(f, "vault payload is malformed"),
            Self::SchemaMismatch { found, expected } => {
                write!(f, "schema {found} does not match expected {expected}")
            }
            Self::PurposeMismatch => write!(f, "vault purpose is not the inspection CA purpose"),
            Self::MetadataMismatch => {
                write!(f, "public metadata does not match the authenticated vault")
            }
            Self::InvalidName(detail) => write!(f, "invalid server name: {detail}"),
            Self::TooManyNames { count, limit } => {
                write!(f, "{count} names supplied, limit is {limit}")
            }
            Self::InvalidValidity => write!(f, "validity window is invalid or out of range"),
            Self::Rcgen(detail) => write!(f, "certificate generation failed: {detail}"),
            Self::Serialize(detail) => write!(f, "serialization failed: {detail}"),
        }
    }
}

impl std::error::Error for PkiError {}

impl From<rcgen::Error> for PkiError {
    fn from(value: rcgen::Error) -> Self {
        Self::Rcgen(value.to_string())
    }
}

impl From<serde_json::Error> for PkiError {
    fn from(value: serde_json::Error) -> Self {
        Self::Serialize(value.to_string())
    }
}
