//! Vantyr DNS: a policy-connected filtering resolver built on Hickory.
//!
//! The `vantyr-dns` binary loads a bounded JSON configuration, validates it
//! before binding anything, then serves UDP and TCP on the same loopback high
//! port by default. Every query is evaluated with the accepted policy engine;
//! allowed queries are answered by an immutable catalog snapshot (local split
//! zones plus forwarding), while denied queries receive a configured
//! NXDOMAIN, REFUSED, or sinkhole answer. Alias inspection currently covers
//! CNAME and differing-owner A/AAAA answers; SVCB/HTTPS, DNAME and other
//! redirection mechanisms are explicitly out of scope, as are TSIG-signed
//! queries (keys are not validated and signatures are not preserved).
//!
//! API paths used here (Hickory 0.26.4), recorded to avoid rediscovery:
//!   `hickory_server::server::{Server, Request, RequestHandler, ResponseHandler, ResponseInfo}`
//!   `hickory_server::zone_handler::{Catalog, MessageResponse, MessageResponseBuilder}`
//!   `hickory_server::store::{in_memory::InMemoryZoneHandler, forwarder::ForwardZoneHandler}`
//!   `hickory_server::proto::rr::{Name, Record, RecordSet, RrKey, RData, RecordType}`

pub mod config;
pub mod handler;
pub mod observe;
pub mod policy;
pub mod server;

pub use config::{
    BindConfig, Config, DenyConfig, DeviceConfig, MatchSpec, RecordSpec, RuleSpec, MAX_CONFIG_BYTES,
};
pub use observe::{DecisionObservation, ObservationLog, MAX_OBSERVATIONS};
pub use server::DnsServer;
