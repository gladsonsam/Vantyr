//! Concrete data contracts for the household network layer.
//!
//! These are *evidence and policy* records, not a claim that every browsing
//! action is observed. A DNS decision, a proxy decision and an agent browser
//! event may describe the same action: keep `source` and `correlation_id` so
//! consumers can join without tripling visit counts.

use std::collections::BTreeSet;

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

pub type HouseholdId = Uuid;
pub type PersonId = Uuid;
pub type DeviceId = Uuid;
pub type AssignmentId = Uuid;
pub type SessionId = Uuid;
pub type ConnectionId = Uuid;
pub type PolicyRevision = u64;

/// The existing dashboard uses the strings `admin`/`operator`/`viewer`.
/// `NetworkAdmin` and `NetworkEvents` are *future, explicitly granted*
/// privileges: they are declared here so the policy layer has a boundary, but
/// this step does not change the server's role strings or UI.
#[derive(Clone, Copy, Debug, Eq, PartialEq, Ord, PartialOrd, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Role {
    Viewer,
    Operator,
    NetworkAdmin,
    NetworkEvents,
}

/// What a connection can actually enforce. Capabilities are advertised by the
/// connection itself; they are never inferred from an IP or MAC association.
#[derive(Clone, Copy, Debug, Eq, PartialEq, Ord, PartialOrd, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Capability {
    DomainFiltering,
    UrlFiltering,
    DecryptableHttps,
    AppRestrictions,
    RemoteDesktop,
    ScreenTimeSchedule,
}

/// UI-facing status: never show a stale "Protected" badge when a heartbeat is
/// lost or an agent is removed.
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum EnforcementStatus {
    Enforced,
    Unsupported,
    BypassedByPolicy,
    Offline,
    Unknown,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DeviceKind {
    PersonalComputer,
    Tablet,
    Tv,
    Phone,
    Iot,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct Household {
    pub id: HouseholdId,
    pub name: String,
    /// IANA timezone, e.g. `Australia/Sydney`. All schedules evaluate here.
    pub timezone: String,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct Person {
    pub id: PersonId,
    pub household_id: HouseholdId,
    pub display_name: String,
    /// External login links (OIDC subject, etc.). Present, not proof of who is
    /// currently sitting at a shared device.
    pub login_links: Vec<String>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AssignmentRole {
    Owner,
    Administrator,
    Member,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct Device {
    pub id: DeviceId,
    pub household_id: HouseholdId,
    pub label: String,
    pub kind: DeviceKind,
    /// A TV or shared tablet may have no verified current person. This flag
    /// makes that explicit rather than attributing use to the registered owner.
    pub shared: bool,
    pub default_profile: String,
    pub capabilities: BTreeSet<Capability>,
}

/// Many-to-many: several people may be assigned to one device, with roles.
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct Assignment {
    pub id: AssignmentId,
    pub person_id: PersonId,
    pub device_id: DeviceId,
    pub role: AssignmentRole,
    pub active: bool,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SessionSource {
    /// OS user session on an enrolled computer (subject to account mapping).
    AgentOsUser,
    /// Credential presented to the proxy CONNECT handshake.
    ProxyCredential,
    /// Parent temporarily asserts a person for a shared device; not equivalent
    /// to that person authenticating.
    ParentAssertion,
    /// Future native mobile enrollment.
    MobileEnrollment,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Assurance {
    /// Cryptographically authenticated (OS session, proxy credential, enrolled
    /// mobile identity). Required before person-specific rules can apply.
    Verified,
    /// A profile selector or nearby phone; an assertion only. Never grants
    /// person-specific or elevated rules on its own.
    Asserted,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct Session {
    pub id: SessionId,
    pub device_id: DeviceId,
    /// `None` is a first-class state: unknown / shared viewer.
    pub verified_person: Option<PersonId>,
    pub source: SessionSource,
    pub assurance: Assurance,
    pub started_at: DateTime<Utc>,
    pub expires_at: DateTime<Utc>,
    pub revoked: bool,
}

impl Session {
    pub fn valid_at(&self, now: DateTime<Utc>) -> bool {
        !self.revoked && self.started_at <= now && now < self.expires_at
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ConnectionKind {
    Agent,
    Dns,
    Proxy,
    Mobile,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ConnectionStatus {
    Active,
    Offline,
    Revoked,
    Unknown,
}

/// An enrolled communication/coverage binding. DNS is a connection, not a
/// persistent authenticated session.
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct Connection {
    pub id: ConnectionId,
    pub device_id: DeviceId,
    pub kind: ConnectionKind,
    /// Enrolled credential identity; a client-supplied name/header is not proof.
    pub enrolled_identity: Option<String>,
    pub capabilities: BTreeSet<Capability>,
    pub last_seen: DateTime<Utc>,
    pub status: ConnectionStatus,
}

impl Connection {
    pub fn online_at(&self, now: DateTime<Utc>, heartbeat_ttl_secs: u64) -> bool {
        self.status == ConnectionStatus::Active
            && (now - self.last_seen).num_seconds() as u64 <= heartbeat_ttl_secs
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ActionKind {
    Dns,
    Http,
    App,
    ScreenTime,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Action {
    DnsResolve { name: String },
    HttpRequest { host: String, path: String },
    AppLaunch { exe: String },
    ScreenTime,
}

impl Action {
    pub fn kind(&self) -> ActionKind {
        match self {
            Self::DnsResolve { .. } => ActionKind::Dns,
            Self::HttpRequest { .. } => ActionKind::Http,
            Self::AppLaunch { .. } => ActionKind::App,
            Self::ScreenTime => ActionKind::ScreenTime,
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RuleMatcher {
    DomainSuffix(String),
    HostExact(String),
    Category(String),
    Any,
}

impl RuleMatcher {
    pub(crate) fn matches(&self, action: &Action) -> bool {
        let (host, path) = match action {
            Action::DnsResolve { name } => (name.as_str(), ""),
            Action::HttpRequest { host, path } => (host.as_str(), path.as_str()),
            Action::AppLaunch { exe } => (exe.as_str(), ""),
            Action::ScreenTime => ("", ""),
        };
        let host = host.trim_end_matches('.').to_ascii_lowercase();
        match self {
            Self::Any => true,
            Self::HostExact(want) => host == want.trim_end_matches('.').to_ascii_lowercase(),
            Self::DomainSuffix(suffix) => {
                let suffix = suffix.trim_start_matches('.').to_ascii_lowercase();
                host == suffix || host.ends_with(&format!(".{suffix}"))
            }
            // Category matching is supplied by an external classifier. The
            // pure engine accepts the category tag carried on the action's host
            // field for now; production feeds are separate product work.
            Self::Category(category) => path.eq_ignore_ascii_case(category),
        }
    }
}

/// A schedule in an explicit IANA timezone. `start_minute`/`end_minute` are
/// minutes from local midnight (0..=1440); `end <= start` spans midnight.
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct Schedule {
    /// chrono weekday numbers: Monday = 0 … Sunday = 6.
    pub weekdays: Vec<u8>,
    pub start_minute: u32,
    pub end_minute: u32,
    pub timezone: String,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Effect {
    Allow,
    Deny,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct Rule {
    pub id: String,
    pub effect: Effect,
    pub matcher: RuleMatcher,
    pub schedule: Option<Schedule>,
    pub reason: String,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ExceptionScope {
    Device(DeviceId),
    Person(PersonId),
    DeviceAction {
        device_id: DeviceId,
        action: ActionKind,
    },
}

impl ExceptionScope {
    pub(crate) fn matches(
        &self,
        device_id: DeviceId,
        action: &Action,
        person: Option<PersonId>,
    ) -> bool {
        match self {
            Self::Device(id) => *id == device_id,
            Self::Person(id) => Some(*id) == person,
            Self::DeviceAction {
                device_id: id,
                action: kind,
            } => *id == device_id && *kind == action.kind(),
        }
    }
}

/// A temporary relaxation: authenticated approver, narrow scope, hard expiry
/// and an explicit return path (do not reassign the device permanently).
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct Exception {
    pub id: String,
    pub approver: PersonId,
    pub approved_at: DateTime<Utc>,
    pub scope: ExceptionScope,
    pub rules: Vec<Rule>,
    pub expires_at: DateTime<Utc>,
    pub revoked_at: Option<DateTime<Utc>>,
}

impl Exception {
    pub fn valid_at(&self, now: DateTime<Utc>) -> bool {
        self.approved_at <= now && now < self.expires_at && self.revoked_at.is_none()
    }
}

/// A versioned household baseline plus device/person rules and exceptions.
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct Policy {
    pub household_id: HouseholdId,
    pub revision: PolicyRevision,
    /// Non-overridable safety rules. Only `Deny` belongs here; the evaluator
    /// ignores any `Allow` in the baseline so an exception cannot weaken it.
    pub baseline: Vec<Rule>,
    /// Keyed by `Device::default_profile`.
    pub device_profiles: std::collections::BTreeMap<String, Vec<Rule>>,
    /// Keyed by verified person. Only consulted with a verified, active session.
    pub person_rules: std::collections::BTreeMap<PersonId, Vec<Rule>>,
    pub exceptions: Vec<Exception>,
    pub default_effect: Effect,
    pub timezone: String,
    /// If the effective snapshot is older than this, fail closed for new
    /// allows (the worker keeps last-known-good denies).
    pub stale_after_secs: u64,
    /// Bounded retention for network events. `0` (unlimited) is NOT accepted —
    /// the existing retention convention in the server must not be reused here.
    pub event_retention_secs: u64,
    pub published_at: DateTime<Utc>,
}

/// A separate credential family for DNS/proxy gateways. This is deliberately
/// NOT `agents.api_token_hash`, an enrollment claim/invite, or a module grant,
/// and network enrollment must never call the existing agent `policy_push`.
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct GatewayCredential {
    pub id: Uuid,
    pub household_id: HouseholdId,
    /// The worker this credential is scoped to, e.g. `dns-worker-1`.
    pub gateway_id: String,
    /// Argon2/PHC hash of a worker secret; never an agent token hash.
    pub secret_hash: String,
    pub issued_at: DateTime<Utc>,
    pub expires_at: DateTime<Utc>,
    pub revoked_at: Option<DateTime<Utc>>,
    pub allowed_commands: BTreeSet<GatewayCommand>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Ord, PartialOrd, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum GatewayCommand {
    FetchPolicy,
    ReportDecision,
    AckPolicy,
    ReportHealth,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DecisionSource {
    SafetyBaseline,
    AuthorizedException,
    VerifiedPerson,
    DeviceDefault,
    HouseholdDefault,
    StalePolicyFailClosed,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum EffectiveIdentity {
    VerifiedPerson(PersonId),
    SharedDevice,
    Unknown,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct Decision {
    pub allow: bool,
    pub reason_code: String,
    pub explanation: String,
    pub policy_revision: PolicyRevision,
    pub applied_rule: Option<String>,
    pub source: DecisionSource,
    pub effective_identity: EffectiveIdentity,
    /// Per-connection enforcement status; an enforced decision is not the same
    /// as a verified attribution of who performed the action.
    pub enforcement: std::collections::BTreeMap<Capability, EnforcementStatus>,
    pub evaluated_at: DateTime<Utc>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum EventSource {
    Agent,
    Dns,
    Proxy,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum EvidenceQuality {
    VerifiedSession,
    NetworkOnly,
    Asserted,
    Correlated,
}

/// One decision/event record. Join on `correlation_id` instead of counting
/// three sources as three visits.
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct Event {
    pub id: Uuid,
    pub occurred_at: DateTime<Utc>,
    pub household_id: HouseholdId,
    pub device_id: DeviceId,
    /// `None` for a TV or unknown viewer — never fill in the registered owner.
    pub person_id: Option<PersonId>,
    pub source: EventSource,
    pub action: Action,
    pub decision: Decision,
    pub evidence: EvidenceQuality,
    pub correlation_id: Option<String>,
    pub enforcing_component: String,
}
