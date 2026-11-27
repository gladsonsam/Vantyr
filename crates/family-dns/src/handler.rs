//! Query handler connecting the maintained Hickory wire machinery to the
//! accepted policy evaluator.
//!
//! Allowed questions are answered by the immutable catalog snapshot (local
//! zones and forwarding resolver) or by an operator-configured exact-domain
//! answer override carried in that same snapshot. The handler inspects the
//! answer the client would receive; if an allowed alias resolves to a denied
//! target, the answer is replaced with the configured denial. Denied questions
//! are answered directly with a library-built message. No DNS/TLS wire format
//! is authored here.
//!
//! Scope of alias inspection: only `CNAME` records and `A`/`AAAA` answers at
//! a different owner are checked. `SVCB`/`HTTPS`, `DNAME` and other alias or
//! redirection mechanisms are NOT covered in this slice, so this worker makes
//! no claim that every possible DNS alias form is protected. TSIG-signed
//! queries are likewise not guaranteed: the capture path does not validate
//! keys, and signatures are not preserved when an allowed answer is rebuilt.

use std::net::{IpAddr, Ipv4Addr, Ipv6Addr};
use std::str::FromStr;
use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use chrono::Utc;
use hickory_server::net::runtime::Time;
use hickory_server::net::NetError;
use hickory_server::proto::op::{Message, MessageType, Metadata, OpCode, ResponseCode};
use hickory_server::proto::rr::rdata::{A as AData, AAAA as AaaaData, CNAME as CnameData};
use hickory_server::proto::rr::{Name, RData, Record, RecordType};
use hickory_server::proto::serialize::binary::BinEncoder;
use hickory_server::server::{Request, RequestHandler, ResponseHandler, ResponseInfo};
use hickory_server::zone_handler::{MessageResponse, MessageResponseBuilder};
use tracing::{debug, warn};
use uuid::Uuid;

use crate::config::{DenyConfig, RecordSpec};
use crate::events::{protocol_label, query_type_label, EventQueue, FinalDecision, FlagsDto};
use crate::policy::DecisionView;
use crate::runtime::{RuntimeSnapshot, SnapshotHandle};

/// Captures the exact response the catalog produced so the handler can check
/// CNAME targets before anything reaches the client.
#[derive(Clone, Default)]
struct CaptureHandler {
    encoded: Arc<Mutex<Option<Vec<u8>>>>,
}

#[async_trait]
impl ResponseHandler for CaptureHandler {
    async fn send_response<'a>(
        &mut self,
        response: MessageResponse<
            '_,
            'a,
            impl Iterator<Item = &'a Record> + Send + 'a,
            impl Iterator<Item = &'a Record> + Send + 'a,
            impl Iterator<Item = &'a Record> + Send + 'a,
            impl Iterator<Item = &'a Record> + Send + 'a,
        >,
    ) -> Result<ResponseInfo, NetError> {
        let mut bytes = Vec::with_capacity(512);
        let mut encoder = BinEncoder::new(&mut bytes);
        let info = response.destructive_emit(&mut encoder)?;
        *self
            .encoded
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(bytes);
        Ok(info)
    }
}

/// Policy-filtering request handler. Each request clones one immutable
/// snapshot under a brief read lock, then uses only that snapshot for policy,
/// catalog and denial. No lock is held across an upstream lookup or `.await`.
#[derive(Clone)]
pub struct FilteringHandler {
    current: SnapshotHandle,
    /// Optional opt-in event channel. `None` keeps the resolver exactly as it
    /// was before event reporting existed; `Some` never blocks a query.
    events: Option<Arc<EventQueue>>,
}

impl FilteringHandler {
    pub(crate) fn with_events(current: SnapshotHandle, events: Option<Arc<EventQueue>>) -> Self {
        Self { current, events }
    }

    /// Select operator-configured records for one exact owner and query type.
    /// A matching owner with no record of the queried type yields an empty
    /// answer set on purpose (NODATA); it never falls through to the catalog.
    /// CNAME records accompany A/AAAA questions, as they do for normal answers.
    fn rewrite_records<'a>(
        snapshot: &'a RuntimeSnapshot,
        qname: &Name,
        qtype: RecordType,
    ) -> Option<Vec<&'a RecordSpec>> {
        if snapshot.config.rewrites.is_empty() {
            return None;
        }
        let owner = qname.to_string().to_ascii_lowercase();
        let mut matched_owner = false;
        let mut selected = Vec::new();
        for record in &snapshot.config.rewrites {
            if !record.name().eq_ignore_ascii_case(&owner) {
                continue;
            }
            matched_owner = true;
            let applies = matches!(
                (qtype, record),
                (RecordType::A, RecordSpec::A { .. } | RecordSpec::Cname { .. })
                | (RecordType::AAAA, RecordSpec::Aaaa { .. } | RecordSpec::Cname { .. })
                | (RecordType::CNAME, RecordSpec::Cname { .. })
                | (RecordType::ANY, _)
            );
            if applies {
                selected.push(record);
            }
        }
        matched_owner.then_some(selected)
    }

    /// Build a complete response for an exact rewrite without consulting the
    /// catalog or an upstream. Metadata is derived from the request, so the
    /// transaction id and RD/CD flags match every other response path. The
    /// answer is still passed through alias, bogus-IP and IPv6 shaping below.
    fn rewritten_message(request: &Request, qname: &Name, records: &[&RecordSpec]) -> Message {
        let mut metadata = Metadata::response_from_request(&request.metadata);
        metadata.response_code = ResponseCode::NoError;
        let mut message = Message::new(metadata.id, MessageType::Response, OpCode::Query);
        message.metadata = metadata;
        for record in records {
            let (ttl, rdata) = match record {
                RecordSpec::A { ttl, addr, .. } => (
                    *ttl,
                    RData::A(AData::from(
                        Ipv4Addr::from_str(addr).expect("validated rewrite A address"),
                    )),
                ),
                RecordSpec::Aaaa { ttl, addr, .. } => (
                    *ttl,
                    RData::AAAA(AaaaData::from(
                        Ipv6Addr::from_str(addr).expect("validated rewrite AAAA address"),
                    )),
                ),
                RecordSpec::Cname { ttl, target, .. } => (
                    *ttl,
                    RData::CNAME(CnameData(
                        Name::from_str(target).expect("validated rewrite CNAME target"),
                    )),
                ),
            };
            message
                .answers
                .push(Record::from_rdata(qname.clone(), ttl, rdata));
        }
        message
    }

    /// Inspect the answer records for an allowed alias that leads to a denied
    /// name. Both explicit CNAME targets and A/AAAA owners other than the
    /// question name are checked, so an alias cannot bypass policy. The failing
    /// alias decision is returned so the one emitted observation records the
    /// FINAL decision, not just the original question.
    fn denied_alias_target(
        snapshot: &RuntimeSnapshot,
        message: &Message,
        qname: &Name,
        source: IpAddr,
        qtype: RecordType,
    ) -> Option<AliasDenial> {
        for record in &message.answers {
            let target = match &record.data {
                RData::CNAME(target) => Some(target.0.clone()),
                RData::A(_) | RData::AAAA(_) if record.name != *qname => Some(record.name.clone()),
                _ => None,
            };
            if let Some(target) = target {
                let decision = snapshot.evaluator.evaluate_alias_with_filter(
                    source,
                    &target,
                    qtype,
                    Some(snapshot.filter.as_ref()),
                );
                if !decision.allow {
                    return Some(AliasDenial {
                        target: target.to_string().to_ascii_lowercase(),
                        decision,
                    });
                }
            }
        }
        None
    }

    /// A response containing an operator-listed IP in any section becomes
    /// NXDOMAIN. NXDOMAIN is emitted through `error_msg`, which emits no
    /// answer, authority or additional records, so nothing can leak.
    fn bogus_nxdomain_target(message: &Message, bogus: &[IpAddr]) -> Option<String> {
        for section in [&message.answers, &message.authorities, &message.additionals] {
            for record in section {
                let ip = match &record.data {
                    RData::A(data) => Some(IpAddr::V4(data.0)),
                    RData::AAAA(data) => Some(IpAddr::V6(data.0)),
                    _ => None,
                };
                if let Some(ip) = ip {
                    if bogus.contains(&ip) {
                        return Some(format!("{} -> {ip}", record.name));
                    }
                }
            }
        }
        None
    }

    /// Remove AAAA data from every section, including CNAME glue in the
    /// additional section and IPv6 authority records. HTTPS/SVCB hints are not
    /// covered by this slice and remain an open row.
    fn strip_ipv6_records(message: &mut Message) {
        message
            .answers
            .retain(|record| !matches!(&record.data, RData::AAAA(_)));
        message
            .authorities
            .retain(|record| !matches!(&record.data, RData::AAAA(_)));
        message
            .additionals
            .retain(|record| !matches!(&record.data, RData::AAAA(_)));
    }

    async fn send_denied<R: ResponseHandler>(
        snapshot: &RuntimeSnapshot,
        request: &Request,
        handle: &mut R,
        qname: &Name,
        qtype: RecordType,
    ) -> ResponseInfo {
        if let Some((v4, v6, ttl)) = snapshot.deny.sinkhole() {
            let mut answers: Vec<Record> = Vec::new();
            match qtype {
                RecordType::A => {
                    if let Some(ip) = v4 {
                        answers.push(Record::from_rdata(
                            qname.clone(),
                            ttl,
                            RData::A(AData::from(ip)),
                        ));
                    }
                }
                RecordType::AAAA => {
                    if let Some(ip) = v6 {
                        answers.push(Record::from_rdata(
                            qname.clone(),
                            ttl,
                            RData::AAAA(AaaaData::from(ip)),
                        ));
                    }
                }
                RecordType::ANY => {
                    if let Some(ip) = v4 {
                        answers.push(Record::from_rdata(
                            qname.clone(),
                            ttl,
                            RData::A(AData::from(ip)),
                        ));
                    }
                    if let Some(ip) = v6 {
                        answers.push(Record::from_rdata(
                            qname.clone(),
                            ttl,
                            RData::AAAA(AaaaData::from(ip)),
                        ));
                    }
                }
                // Other query types have no configured sinkhole address.
                _ => {}
            }
            if !answers.is_empty() {
                // Derive from the request so RD/CD and the other copied flags
                // match the NXDOMAIN/REFUSED paths, which use `error_msg`.
                let mut metadata = Metadata::response_from_request(&request.metadata);
                metadata.response_code = ResponseCode::NoError;
                let response = MessageResponseBuilder::new(&request.queries, request.edns.as_ref())
                    .build(
                        metadata,
                        answers.iter(),
                        std::iter::empty::<&Record>(),
                        std::iter::empty::<&Record>(),
                        std::iter::empty::<&Record>(),
                    );
                return match handle.send_response(response).await {
                    Ok(info) => info,
                    Err(error) => {
                        warn!(%error, "failed to send denial");
                        error_response(request, ResponseCode::ServFail)
                    }
                };
            }
        }

        let code = match snapshot.deny {
            DenyConfig::Refused => ResponseCode::Refused,
            _ => ResponseCode::NXDomain,
        };
        send_error(request, handle, code).await
    }

    async fn send_allowed<R: ResponseHandler>(
        &self,
        request: &Request,
        handle: &mut R,
        message: Message,
    ) -> Result<ResponseInfo, NetError> {
        let response = MessageResponseBuilder::new(&request.queries, request.edns.as_ref()).build(
            message.metadata,
            message.answers.iter(),
            message.authorities.iter(),
            std::iter::empty::<&Record>(),
            message.additionals.iter(),
        );
        handle.send_response(response).await
    }
}

/// The failing alias and the policy/filter decision that denied it.
struct AliasDenial {
    target: String,
    decision: DecisionView,
}

/// Emits exactly one observation when the request leaves the handler, on every
/// terminal path (direct deny, catalog failure, alias deny, shaping deny and
/// allow). Dropping is synchronous and bounded, so it cannot block a response.
struct EventGuard {
    queue: Option<Arc<EventQueue>>,
    decision: Option<FinalDecision>,
}

impl Drop for EventGuard {
    fn drop(&mut self) {
        let (Some(queue), Some(decision)) = (self.queue.as_ref(), self.decision.take()) else {
            return;
        };
        match decision.into_event() {
            Ok(event) => {
                queue.push(event);
            }
            Err(_) => queue.note_invalid(),
        }
    }
}

#[async_trait]
impl RequestHandler for FilteringHandler {
    async fn handle_request<R: ResponseHandler, T: Time>(
        &self,
        request: &Request,
        mut response_handle: R,
    ) -> ResponseInfo {
        // Clone one whole version, then release the lock before any I/O.
        let snapshot = {
            self.current
                .read()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .clone()
        };
        // Malformed / non-query messages go through the catalog's own error
        // paths, so its wire behaviour stays authoritative.
        let Ok(info) = request.request_info() else {
            return snapshot
                .catalog
                .handle_request::<R, T>(request, response_handle)
                .await;
        };
        if info.metadata.message_type != MessageType::Query
            || info.metadata.op_code != OpCode::Query
        {
            return snapshot
                .catalog
                .handle_request::<R, T>(request, response_handle)
                .await;
        }

        let source = request.src().ip();
        let qname = info.query.original().name().clone();
        let qtype = info.query.query_type();
        let decision = snapshot.evaluator.evaluate_with_filter(
            source,
            &qname,
            qtype,
            Some(snapshot.filter.as_ref()),
        );
        debug!(
            %qname,
            revision = decision.policy_revision,
            reason = %decision.reason_code,
            allow = decision.allow,
            filter_blocked = decision.filter_blocked,
            filter_source = decision.filter_source_id.as_deref().unwrap_or("none"),
            filter_rule = decision.filter_rule.as_deref().unwrap_or("none"),
            "policy decision"
        );

        // ONE observation per query. The guard is armed before any terminal
        // return and is finalised on drop, including the alias/shaping paths
        // below. Its data is what the worker actually decided, not an inferred
        // person or a claimed enforcement receipt.
        let mut guard = EventGuard {
            queue: self.events.clone(),
            decision: Some(FinalDecision {
                event_id: Uuid::new_v4(),
                observed_at: Utc::now(),
                device_id: snapshot.config.device_for(source).0,
                name: qname.to_string().to_ascii_lowercase(),
                query_type: query_type_label(qtype).unwrap_or("").to_owned(),
                protocol: protocol_label(info.protocol).to_owned(),
                allow: decision.allow,
                reason_code: decision.reason_code.clone(),
                policy_revision: Some(decision.policy_revision),
                applied_rule: decision.applied_rule.clone(),
                filter_blocked: decision.filter_blocked,
                filter_source_id: decision.filter_source_id.clone(),
                filter_source_kind: decision.filter_source_kind.clone(),
                denied_alias_target: None,
                flags: FlagsDto {
                    rd: request.metadata.recursion_desired,
                    cd: request.metadata.checking_disabled,
                    ra: request.metadata.recursion_available,
                    ad: request.metadata.authentic_data,
                },
            }),
        };
        if !decision.allow {
            return Self::send_denied(&snapshot, request, &mut response_handle, &qname, qtype)
                .await;
        }

        // An exact rewrite is answered from the immutable snapshot itself. It
        // never reaches an upstream, so it cannot be defeated by an outage or
        // enriched with data the operator did not configure. The policy
        // decision above still gates every rewrite unconditionally.
        let (message, catalog_info) = if let Some(records) =
            Self::rewrite_records(&snapshot, &qname, qtype)
        {
            (
                Self::rewritten_message(request, &qname, &records),
                error_response(request, ResponseCode::NoError),
            )
        } else {
            let capture = CaptureHandler::default();
            let catalog_info = snapshot
                .catalog
                .handle_request::<CaptureHandler, T>(request, capture.clone())
                .await;
            let Some(bytes) = capture
                .encoded
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .take()
            else {
                warn!("catalog produced no response for an allowed query");
                return send_error(request, &mut response_handle, ResponseCode::ServFail).await;
            };
            let message = match Message::from_vec(&bytes) {
                Ok(message) => message,
                Err(error) => {
                    warn!(%error, "could not inspect catalog response");
                    return send_error(request, &mut response_handle, ResponseCode::ServFail).await;
                }
            };
            (message, catalog_info)
        };
        if let Some(alias) = Self::denied_alias_target(&snapshot, &message, &qname, source, qtype) {
            debug!(%qname, target = %alias.target, "denied via alias chain");
            if let Some(final_decision) = guard.decision.as_mut() {
                final_decision.allow = false;
                final_decision.denied_alias_target = Some(alias.target);
                final_decision.reason_code = alias.decision.reason_code;
                final_decision.policy_revision = Some(alias.decision.policy_revision);
                final_decision.filter_blocked |= alias.decision.filter_blocked;
                if let Some(id) = alias.decision.filter_source_id {
                    final_decision.filter_source_id = Some(id);
                }
                if let Some(kind) = alias.decision.filter_source_kind {
                    final_decision.filter_source_kind = Some(kind);
                }
            }
            return Self::send_denied(&snapshot, request, &mut response_handle, &qname, qtype)
                .await;
        }

        // Response shaping runs on EVERY answer, cached or freshly resolved.
        // Policy/filter evaluation already happened above, so a cache hit can
        // never bypass denial. Bogus-NXDOMAIN is checked before IPv6 stripping
        // so a configured IPv6 address cannot be hidden by the other setting.
        let cache_settings = &snapshot.config.cache;
        if let Some(evidence) = Self::bogus_nxdomain_target(&message, &cache_settings.bogus_ips()) {
            debug!(%qname, %evidence, "bogus answer IP -> NXDOMAIN");
            if let Some(final_decision) = guard.decision.as_mut() {
                final_decision.allow = false;
                final_decision.reason_code = "bogus_answer_ip".to_owned();
            }
            // `error_msg` preserves the request's RD/CD metadata and emits an
            // empty answer/authority/additional set.
            return send_error(request, &mut response_handle, ResponseCode::NXDomain).await;
        }
        let mut message = message;
        if cache_settings.disable_ipv6 {
            Self::strip_ipv6_records(&mut message);
        }

        match self
            .send_allowed(request, &mut response_handle, message)
            .await
        {
            Ok(info) => info,
            Err(error) => {
                warn!(%error, "failed to send allowed response");
                catalog_info
            }
        }
    }
}

fn error_response(request: &Request, code: ResponseCode) -> ResponseInfo {
    let mut metadata = Metadata::response_from_request(&request.metadata);
    metadata.response_code = code;
    ResponseInfo::from(hickory_server::proto::op::Header {
        metadata,
        counts: hickory_server::proto::op::HeaderCounts::default(),
    })
}

async fn send_error<R: ResponseHandler>(
    request: &Request,
    handle: &mut R,
    code: ResponseCode,
) -> ResponseInfo {
    let response = MessageResponseBuilder::new(&request.queries, request.edns.as_ref())
        .error_msg(&request.metadata, code);
    match handle.send_response(response).await {
        Ok(info) => info,
        Err(error) => {
            warn!(%error, "failed to send error response");
            error_response(request, code)
        }
    }
}
