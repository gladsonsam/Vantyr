//! Query handler connecting the maintained Hickory wire machinery to the
//! accepted policy evaluator.
//!
//! Allowed questions are answered by the immutable catalog snapshot (local
//! zones and forwarding resolver). The handler inspects the answer the client
//! would receive; if an allowed alias resolves to a denied target, the answer
//! is replaced with the configured denial. Denied questions are answered
//! directly with a library-built message. No DNS/TLS wire format is authored
//! here.
//!
//! Scope of alias inspection: only `CNAME` records and `A`/`AAAA` answers at
//! a different owner are checked. `SVCB`/`HTTPS`, `DNAME` and other alias or
//! redirection mechanisms are NOT covered in this slice, so this worker makes
//! no claim that every possible DNS alias form is protected. TSIG-signed
//! queries are likewise not guaranteed: the capture path does not validate
//! keys, and signatures are not preserved when an allowed answer is rebuilt.

use std::net::IpAddr;
use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use hickory_server::net::runtime::Time;
use hickory_server::net::NetError;
use hickory_server::proto::op::{Message, MessageType, Metadata, OpCode, ResponseCode};
use hickory_server::proto::rr::rdata::{A as AData, AAAA as AaaaData};
use hickory_server::proto::rr::{Name, RData, Record, RecordType};
use hickory_server::proto::serialize::binary::BinEncoder;
use hickory_server::server::{Request, RequestHandler, ResponseHandler, ResponseInfo};
use hickory_server::zone_handler::{MessageResponse, MessageResponseBuilder};
use tracing::{debug, warn};

use crate::config::DenyConfig;
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
}

impl FilteringHandler {
    pub(crate) fn new(current: SnapshotHandle) -> Self {
        Self { current }
    }

    /// Inspect the answer records for an allowed alias that leads to a denied
    /// name. Both explicit CNAME targets and A/AAAA owners other than the
    /// question name are checked, so an alias cannot bypass policy.
    fn denied_alias_target(
        snapshot: &RuntimeSnapshot,
        message: &Message,
        qname: &Name,
        source: IpAddr,
        qtype: RecordType,
    ) -> Option<String> {
        for record in &message.answers {
            let target = match &record.data {
                RData::CNAME(target) => Some(target.0.clone()),
                RData::A(_) | RData::AAAA(_) if record.name != *qname => Some(record.name.clone()),
                _ => None,
            };
            if let Some(target) = target {
                if !snapshot
                    .evaluator
                    .evaluate_alias_with_filter(
                        source,
                        &target,
                        qtype,
                        Some(snapshot.filter.as_ref()),
                    )
                    .allow
                {
                    return Some(target.to_string().to_ascii_lowercase());
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
        if !decision.allow {
            return Self::send_denied(&snapshot, request, &mut response_handle, &qname, qtype)
                .await;
        }

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
        if let Some(target) = Self::denied_alias_target(&snapshot, &message, &qname, source, qtype)
        {
            debug!(%qname, %target, "denied via CNAME chain");
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
