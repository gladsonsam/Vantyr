//! Vantyr Proxy — a bounded HTTP/CONNECT forward proxy for Vantyr Network.
//!
//! Step5a milestone: a public `vantyr-proxy` binary with validated bounded
//! configuration, static scoped client credentials, accepted-core policy
//! evaluation on the device-default path, and an egress connector that checks
//! every dialled socket. Rama 0.4 owns the HTTP/1 parser, the eager CONNECT
//! upgrade and the upstream HTTP client; there is no custom HTTP/DNS parser.
//!
//! Public tunnel CONNECT is opaque end-to-end TLS validated by the client by
//! default. OPTIONAL inspection is off unless an operator explicitly enables it
//! for named credentials; when enabled, Rama's maintained rustls connector and
//! TLS acceptor terminate both directions with a short-lived leaf from the
//! dedicated PKI signer. HTTP/2 and WebSocket upgrades are rejected explicitly
//! rather than silently bypassed. There is no health endpoint and no client
//! trust installation here.
//!
//! The crate path is temporarily `family-proxy` until the coordinated rename;
//! all user-facing names are Vantyr Network / Vantyr Proxy.

pub mod auth;
pub mod bound;
pub mod config;
pub mod egress;
pub mod inspection;
pub mod server;
pub mod timeout_body;

pub use auth::{AuthError, AuthState, AuthenticatedClient};
pub use config::{
    BindConfig, ClientConfig, Config, DestinationConfig, DeviceConfig, LimitsConfig, MatchSpec,
    RuleSpec, DEFAULT_BIND_ADDRESS, DEFAULT_BIND_PORT, MAX_CONFIG_BYTES,
};
pub use egress::{classify_ip, DenyReason, DestinationPolicy, EgressConnector, EgressPolicy};
pub use inspection::{CompiledException, InspectionConfig, InspectionException, InspectionRuntime};
pub use server::ProxyServer;
