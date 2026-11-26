//! Proxy client authentication against scoped, static config credentials.
//!
//! The credential is parsed by Rama's maintained typed header support and
//! compared with a maintained constant-time primitive. Header values and
//! tokens are never logged. A credential selects a configured device (and an
//! optional explicit static profile); it never selects a person, and no
//! source-address association is performed anywhere in this crate.

use std::collections::BTreeMap;

use rama::http::header::HeaderValue;
use rama::http::headers::{HeaderMapExt, ProxyAuthorization};
use rama::http::Request;
use rama::net::user::Basic;
use rama::utils::bytes::ct::ct_eq_bytes;
use uuid::Uuid;

use crate::config::Config;

/// What an authenticated proxy client is bound to.
#[derive(Clone, Debug)]
pub struct AuthenticatedClient {
    pub id: Uuid,
    pub device_id: String,
    /// Explicit static profile mapping from config, if any. `None` means the
    /// device's own default profile applies.
    pub profile: Option<String>,
    token: Vec<u8>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AuthError {
    Missing,
    Invalid,
}

/// Constant-time verifier keyed by the public Basic username. Only the token
/// is secret; the username is an identifier used for lookup.
#[derive(Clone, Debug)]
pub struct AuthState {
    clients: BTreeMap<String, AuthenticatedClient>,
    /// Fixed dummy token so an unknown username still performs a real
    /// constant-time comparison instead of an early return.
    dummy_token: [u8; 32],
}

impl AuthState {
    pub fn new(config: &Config) -> Self {
        let clients = config
            .clients
            .iter()
            .map(|client| {
                (
                    client.id.clone(),
                    AuthenticatedClient {
                        id: Uuid::parse_str(&client.id).expect("client id validated"),
                        device_id: client.device_id.clone(),
                        profile: client.profile.clone(),
                        token: client.token.as_bytes().to_vec(),
                    },
                )
            })
            .collect();
        Self {
            clients,
            dummy_token: [0x5a; 32],
        }
    }

    /// Authenticate a request from its `Proxy-Authorization` header.
    pub fn authenticate<B>(&self, request: &Request<B>) -> Result<&AuthenticatedClient, AuthError> {
        let Some(ProxyAuthorization(basic)) =
            request.headers().typed_get::<ProxyAuthorization<Basic>>()
        else {
            return Err(AuthError::Missing);
        };
        self.verify(basic)
    }

    /// Verify an already decoded Basic credential. Kept separate so tests can
    /// exercise constant-time rejection without constructing wire requests.
    pub fn verify(&self, basic: Basic) -> Result<&AuthenticatedClient, AuthError> {
        let username = basic.username();
        let presented = basic.password().unwrap_or("").as_bytes();
        let client = self.clients.get(username);
        let expected = client
            .map(|c| c.token.as_slice())
            .unwrap_or(&self.dummy_token);
        let matched = ct_eq_bytes(presented, expected);
        // The username lookup is public information: check the token in
        // constant time for both known and unknown users, then bind the result.
        match client {
            Some(client) if matched => Ok(client),
            _ => Err(AuthError::Invalid),
        }
    }
}

/// Build a `407 Proxy Authentication Required` response. The challenge never
/// includes credential material.
pub fn proxy_authentication_required() -> rama::http::Response {
    let mut response = rama::http::Response::new(rama::http::Body::empty());
    *response.status_mut() = rama::http::StatusCode::PROXY_AUTHENTICATION_REQUIRED;
    response.headers_mut().insert(
        rama::http::header::PROXY_AUTHENTICATE,
        HeaderValue::from_static("Basic realm=\"Vantyr Proxy\", charset=\"UTF-8\""),
    );
    response
}

#[cfg(test)]
mod tests {
    use super::*;
    use rama::http::header::PROXY_AUTHORIZATION;
    use rama::http::Request;

    const VALID: &str = r#"{
        "household_id": "11111111-2222-3333-4444-555555555555",
        "policy_revision": 1,
        "clients": [{
            "id": "22222222-3333-4444-5555-666666666666",
            "token": "correct-token",
            "device_id": "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"
        }],
        "devices": [{
            "id": "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
            "default_profile": "restricted"
        }]
    }"#;

    #[test]
    fn accepts_only_the_exact_basic_token() {
        let config = Config::parse(VALID.as_bytes()).unwrap();
        let auth = AuthState::new(&config);
        let good = Basic::try_from("22222222-3333-4444-5555-666666666666:correct-token").unwrap();
        let bad = Basic::try_from("22222222-3333-4444-5555-666666666666:correct-token ").unwrap();
        let unknown = Basic::try_from("22222222-3333-4444-5555-666666666666:wrong").unwrap();
        let missing_user = Basic::try_from("deadbeef:correct-token").unwrap();
        assert_eq!(
            auth.verify(good).unwrap().device_id,
            config.clients[0].device_id
        );
        assert_eq!(auth.verify(bad).unwrap_err(), AuthError::Invalid);
        assert_eq!(auth.verify(unknown).unwrap_err(), AuthError::Invalid);
        assert_eq!(auth.verify(missing_user).unwrap_err(), AuthError::Invalid);
    }

    #[test]
    fn missing_header_is_distinct_from_invalid_credentials() {
        let config = Config::parse(VALID.as_bytes()).unwrap();
        let auth = AuthState::new(&config);
        let mut request = Request::new(());
        assert_eq!(auth.authenticate(&request).unwrap_err(), AuthError::Missing);
        request.headers_mut().insert(
            PROXY_AUTHORIZATION,
            HeaderValue::from_static("Basic bm90LWEtdG9rZW4="),
        );
        assert_eq!(auth.authenticate(&request).unwrap_err(), AuthError::Invalid);
        let challenge = proxy_authentication_required();
        assert_eq!(
            challenge.status(),
            rama::http::StatusCode::PROXY_AUTHENTICATION_REQUIRED
        );
        let header = challenge
            .headers()
            .get(rama::http::header::PROXY_AUTHENTICATE)
            .unwrap()
            .to_str()
            .unwrap();
        assert!(header.starts_with("Basic realm=\"Vantyr Proxy\""));
        assert!(!header.contains("correct-token"));
    }
}
