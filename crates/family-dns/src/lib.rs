//! Vantyr DNS: a policy-connected filtering resolver built on Hickory.
//!
//! The `vantyr-dns` binary loads a bounded JSON configuration, validates it
//! before binding anything, then serves UDP and TCP on the same loopback high
//! port by default. Every query is evaluated with the accepted policy engine;
//! allowed queries are answered by an immutable catalog snapshot (local split
//! zones plus forwarding), while denied queries receive a configured
//! NXDOMAIN, REFUSED, or sinkhole answer. Operator-configured exact-domain
//! answer overrides are applied only after a question is allowed. Alias
//! inspection currently covers CNAME and differing-owner A/AAAA answers;
//! SVCB/HTTPS, DNAME and other
//! redirection mechanisms are explicitly out of scope, as are TSIG-signed
//! queries (keys are not validated and signatures are not preserved).
//!
//! Durable mode is opt-in: an explicit state path and worker id turn on one
//! atomic config+policy bundle with a preserved original publication time and
//! an `Arc` snapshot swap on reload. See `README.md` for the exact behaviour
//! and limits, including what is deliberately not claimed.
//!
//! API paths used here (Hickory 0.26.4), recorded to avoid rediscovery:
//!   `hickory_server::server::{Server, Request, RequestHandler, ResponseHandler, ResponseInfo}`
//!   `hickory_server::zone_handler::{Catalog, MessageResponse, MessageResponseBuilder}`
//!   `hickory_server::store::{in_memory::InMemoryZoneHandler, forwarder::ForwardZoneHandler}`
//!   `hickory_server::proto::rr::{Name, Record, RecordSet, RrKey, RData, RecordType}`

pub mod bundle;
pub mod compile;
pub mod config;
pub mod controller;
pub mod dot;
pub mod events;
pub mod filter;
pub mod handler;
pub mod management;
pub mod management_dto;
pub mod management_worker;
pub mod observe;
pub mod policy;
pub mod runtime;
pub(crate) mod safe_search;
pub mod server;
pub mod subscription;
pub mod upstream;

pub use bundle::{Bundle, BundleStore, BundleValidator};
pub use compile::{compile, CompileError};
pub use config::{
    read_bounded, BindConfig, CacheConfig, Config, DenyConfig, DeviceConfig, DotListenerConfig,
    EncryptedUpstreamSpec, FilterConfig, FilterSourceSpec, ListFormatSpec, MatchSpec, RecordSpec,
    RuleSpec, SafeSearchConfig, ScheduleSpec, ServiceCatalogSpec, ServiceDomainSpec, ServiceSpec,
    SourceOrigin, SubscriptionSettings, SubscriptionSourceSpec, MAX_BOGUS_NXDOMAIN_IPS,
    MAX_CACHE_ENTRIES, MAX_CA_PEM_BYTES, MAX_CONFIG_BYTES, MAX_TLS_PATH_LEN,
};
pub use controller::{
    policy_digest, sync_once, ControllerClient, ControllerError, ControllerOptions,
    ControllerPoller, PolicyReadResponse, SyncCapability, CONTROLLER_AUDIENCE, CONTROLLER_COMMAND,
    CONTROLLER_KIND, CONTROLLER_POLICY_SCHEMA_VERSION, READ_PATH,
};
pub use events::{
    protocol_label, query_type_label, BatchAck, DnsEventDto, EventBatchBody, EventClient,
    EventError, EventMetrics, EventOptions, EventQueue, EventWorker, FinalDecision, FlagsDto,
    InvalidEvent, EVENT_COMMAND, EVENT_KIND, EVENT_PATH, MAX_EVENTS_PER_BATCH,
};
pub use filter::{
    compile_from_material, empty_filter, material_identity, no_remote,
    prepare as prepare_filter_material, validate_material_shape, FilterDerivation, FilterError,
    FilterMaterial, StoredList, StoredListDerivation, StoredServiceDerivation,
    MAX_FILTER_BUNDLE_BYTES,
};
pub use management::{ManagementClient, ManagementError, ManagementOptions, ManagementState};
pub use management_dto::{
    AppliedStatusDto, DownloadState, ListFormatDto, ManagementConfig, RefreshAckDto,
    ServiceCatalogDto, ServiceDomainDto, ServiceDto, SourceMetadataDto, SourceStatusDto,
    SubscriptionSourceDto, WorkerReadResponse, WorkerStatusBody, CONFIG_SCHEMA_VERSION,
};
pub use management_worker::{config_digest, ManagementWorker};
pub use observe::{DecisionObservation, ObservationLog, MAX_OBSERVATIONS};
pub use server::{
    DnsServer, DnsStatus, DurableOptions, MaterialOutcome, ReloadError, ReloadOutcome,
};
pub use subscription::{
    single_source_config, AppliedStatus, FormatValidator, RuntimeDiagnostics, SourceStatus,
    SubscriptionError, SubscriptionHandle, SubscriptionRuntime, DEFAULT_TICK,
};
// Re-exported so callers can use the same injectable pre/post-rename seam that
// the worker itself uses for durability tests.
pub use vantyr_network_runtime::WriteHooks;
