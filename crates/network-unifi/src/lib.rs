//! Bounded, optional UniFi Network controller adapter for Vantyr Network.
//!
//! Scope of this slice:
//! - read-only discovery through the official versioned Network API
//!   (`v10.6.109` reference contract), with explicit operator URL/site scope,
//!   verified TLS and redacted `X-API-KEY` custody;
//! - a pure planner that produces before/proposed/rollback values only for
//!   documented DNS override fields, plus dependencies, manual steps and
//!   verification steps;
//! - mock apply/preview/verify/rollback against an in-memory controller.
//!
//! No live mutating HTTP method, credential prompt, DHCP server, VLAN/SSID or
//! firewall change, CA installation or person-identity claim is included.
//! Controller credentials and a live controller are intentionally deferred.

pub mod auth;
pub mod capabilities;
pub mod config;
pub mod discovery;
pub mod error;
pub mod execution;
pub mod model;
pub mod planner;
pub mod transport;

pub use auth::ApiKey;
pub use capabilities::{Capabilities, Operation, Support};
pub use config::{ControllerConfig, API_DOC_VERSION, LOCAL_BASE_PATH};
pub use discovery::{Discovery, DiscoveryReport};
pub use error::Error;
pub use execution::{
    apply, preview, rollback, verify, ApplyOutcome, AuditRecord, FieldCheck, Preview,
    PreviewStatus, Rejection, RollbackOutcome, SimulatedController, Verification,
};
pub use model::{
    get_field, remove_field, set_field, ApplicationInfo, BeforeValue, ClientObservation, DnsView,
    Ipv6View, Management, NetworkObservation, NetworkOverview, Page, SiteOverview, IPV4_DNS_PATH,
    IPV6_DNS_PATH,
};
pub use planner::{
    identity_matches, plan, plan_integrity_holds, ControllerIdentity, Dependency,
    DependencyEvidence, PlanDisposition, PlannedChange, SetupInputs, SetupPlan, WorkerEndpoint,
    ADVERTISED_DNS_PORT, WORKER_DEFAULT_PORT,
};
pub use transport::{Endpoint, HttpTransport, RawResponse, Transport};
