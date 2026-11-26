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
use hickory_server::zone_handler::{Catalog, MessageResponse, MessageResponseBuilder};
use tracing::{debug, warn};

use crate::config::DenyConfig;
use crate::policy::PolicyEvaluator;

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

/// Policy-filtering request handler. All state is immutable and cloned behind
/// `Arc`; no lock is held across an upstream lookup.
#[derive(Clone)]
pub struct FilteringHandler {
    catalog: Arc<Catalog>,
    evaluator: Arc<PolicyEvaluator>,
    deny: DenyConfig,
}

impl FilteringHandler {
    pub fn new(catalog: Arc<Catalog>, evaluator: Arc<PolicyEvaluator>, deny: DenyConfig) -> Self {
        Self {
            catalog,
            evaluator,
            deny,
        }
    }

    /// Inspect the answer records for an allowed alias that leads to a denied
    /// name. Both explicit CNAME targets and A/AAAA owners other than the
    /// question name are checked, so an alias cannot bypass policy.
    fn denied_alias_target(
        &self,
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
                if !self.evaluator.evaluate_alias(source, &target, qtype).allow {
                    return Some(target.to_string().to_ascii_lowercase());
                }
            }
        }
        None
    }

    async fn send_denied<R: ResponseHandler>(
        &self,
        request: &Request,
        handle: &mut R,
        qname: &Name,
        qtype: RecordType,
    ) -> ResponseInfo {
        if let Some((v4, v6, ttl)) = self.deny.sinkhole() {
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

        let code = match self.deny {
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
        // Malformed / non-query messages go through the catalog's own error
        // paths, so its wire behaviour stays authoritative.
        let Ok(info) = request.request_info() else {
            return self
                .catalog
                .handle_request::<R, T>(request, response_handle)
                .await;
        };
        if info.metadata.message_type != MessageType::Query
            || info.metadata.op_code != OpCode::Query
        {
            return self
                .catalog
                .handle_request::<R, T>(request, response_handle)
                .await;
        }

        let source = request.src().ip();
        let qname = info.query.original().name().clone();
        let qtype = info.query.query_type();
        let decision = self.evaluator.evaluate(source, &qname, qtype);
        debug!(
            %qname,
            revision = decision.policy_revision,
            reason = %decision.reason_code,
            allow = decision.allow,
            "policy decision"
        );
        if !decision.allow {
            return self
                .send_denied(request, &mut response_handle, &qname, qtype)
                .await;
        }

        let capture = CaptureHandler::default();
        let catalog_info = self
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
        if let Some(target) = self.denied_alias_target(&message, &qname, source, qtype) {
            debug!(%qname, %target, "denied via CNAME chain");
            return self
                .send_denied(request, &mut response_handle, &qname, qtype)
                .await;
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
