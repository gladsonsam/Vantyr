//! The official Network API authenticates with an `X-API-KEY` header. The key
//! is held in a `secrecy::SecretString`, is never `Serialize`, `Display` or
//! `Debug`-printable, and is only exposed at the point the HTTP header is set.

use std::fmt;

use secrecy::{ExposeSecret, SecretString};

#[derive(Clone)]
pub struct ApiKey(SecretString);

impl ApiKey {
    pub fn new(key: impl Into<String>) -> Self {
        Self(SecretString::from(key.into()))
    }

    /// Used only when constructing the request header.
    pub fn expose(&self) -> &str {
        self.0.expose_secret()
    }
}

impl fmt::Debug for ApiKey {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("ApiKey([REDACTED])")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn secret_is_redacted_in_debug_and_never_serialized() {
        let key = ApiKey::new("super-secret-key");
        let debug = format!("{:?}", key);
        assert!(!debug.contains("super-secret-key"));
        assert!(debug.contains("REDACTED"));
        assert_eq!(key.expose(), "super-secret-key");
    }
}
