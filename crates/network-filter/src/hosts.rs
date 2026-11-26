//! Thin adapter over Hickory 0.26.4's maintained blocklist parser and matcher.
//!
//! Hickory's `BlocklistZoneHandler::add(Read)` already understands bare
//! domains, `0.0.0.0 <host>` hosts lines and leading wildcards. The only
//! adaptation here is normalising other address prefixes (`127.0.0.1`, `::1`,
//! ...) to the bare form and dropping `localhost`; name parsing, wildcard
//! expansion and matching stay entirely in Hickory through the public
//! `ZoneHandler::lookup` API.

use std::net::IpAddr;
use std::path::PathBuf;

use hickory_server::proto::rr::{LowerName, Name, RecordType};
use hickory_server::store::blocklist::{
    BlocklistConfig, BlocklistConsultAction, BlocklistZoneHandler,
};
use hickory_server::zone_handler::{LookupControlFlow, LookupOptions, ZoneHandler};

use crate::canonical::canonical_entry;
use crate::limits::{Limits, MAX_HOSTS_PER_LINE};
use crate::types::{CompileError, Diagnostic, DiagnosticKind};

/// One per-list engine. The upstream blocklist API does not expose which
/// entry matched, so attribution is list-level only and stated as such.
pub(crate) struct HostsEngine {
    pub(crate) inner: BlocklistZoneHandler,
    pub(crate) source_id: String,
}

pub(crate) fn build(
    source_id: &str,
    text: &str,
    limits: &Limits,
    diagnostics: &mut Vec<Diagnostic>,
) -> Result<HostsEngine, CompileError> {
    let mut normalised = String::new();
    let mut accepted = 0usize;

    for (index, raw) in text.lines().enumerate() {
        let line = raw.trim();
        if line.is_empty() || line.starts_with('#') || line.starts_with('!') {
            continue;
        }
        let mut fields = line.split_whitespace();
        let first = match fields.next() {
            Some(value) => value,
            None => continue,
        };
        let mut hosts: Vec<&str> = Vec::new();
        match first.parse::<IpAddr>() {
            Ok(_address) => {
                push(
                    diagnostics,
                    limits,
                    Diagnostic::new(
                        source_id,
                        index + 1,
                        DiagnosticKind::Note,
                        "address-prefixed hosts entry normalised to a bare domain",
                    ),
                );
                for field in fields {
                    if field.starts_with('#') {
                        break;
                    }
                    hosts.push(field);
                }
            }
            Err(_) => {
                if fields.next().is_some() {
                    push(
                        diagnostics,
                        limits,
                        Diagnostic::new(
                            source_id,
                            index + 1,
                            DiagnosticKind::Unsupported,
                            "only one bare domain or one address plus hosts are supported",
                        ),
                    );
                    continue;
                }
                hosts.push(first);
            }
        }

        if hosts.len() > MAX_HOSTS_PER_LINE {
            push(
                diagnostics,
                limits,
                Diagnostic::new(
                    source_id,
                    index + 1,
                    DiagnosticKind::Limit("hosts per line".to_owned()),
                    "too many hosts on one line",
                ),
            );
            continue;
        }
        for host in hosts {
            if host.eq_ignore_ascii_case("localhost")
                || host.eq_ignore_ascii_case("localhost.localdomain")
            {
                push(
                    diagnostics,
                    limits,
                    Diagnostic::new(
                        source_id,
                        index + 1,
                        DiagnosticKind::Note,
                        "localhost entry ignored to avoid blocking local resolution",
                    ),
                );
                continue;
            }
            match canonical_entry(host) {
                Ok(canonical) => {
                    normalised.push_str(&canonical);
                    normalised.push('\n');
                    accepted += 1;
                }
                Err(reason) => push(
                    diagnostics,
                    limits,
                    Diagnostic::new(source_id, index + 1, DiagnosticKind::Malformed, reason),
                ),
            }
        }
    }

    if accepted == 0 {
        push(
            diagnostics,
            limits,
            Diagnostic::new(
                source_id,
                0,
                DiagnosticKind::EmptySource,
                "no usable host domain in hosts source",
            ),
        );
        return Err(CompileError::Rejected(diagnostics.clone()));
    }

    let config = BlocklistConfig {
        wildcard_match: true,
        min_wildcard_depth: 2,
        lists: Vec::<PathBuf>::new(),
        sinkhole_ipv4: None,
        sinkhole_ipv6: None,
        block_message: None,
        ttl: 0,
        consult_action: BlocklistConsultAction::Disabled,
        log_clients: false,
    };
    let mut inner = BlocklistZoneHandler::try_from_config(Name::root(), config, None)
        .map_err(|err| CompileError::InvalidInput(format!("blocklist setup failed: {err}")))?;
    inner
        .add(normalised.as_bytes())
        .map_err(|err| CompileError::InvalidInput(format!("blocklist add failed: {err}")))?;

    let unique = inner.entry_count();
    if unique > limits.max_rules {
        return Err(CompileError::Limit(format!(
            "source {source_id} has {unique} unique rules, bound is {}",
            limits.max_rules
        )));
    }

    Ok(HostsEngine {
        inner,
        source_id: source_id.to_owned(),
    })
}

/// Match through Hickory's public `ZoneHandler::lookup`. The future is always
/// immediately ready (no I/O in the blocklist handler), so no async runtime is
/// created or required.
pub(crate) fn matches(engine: &HostsEngine, name: &Name, qtype: RecordType) -> bool {
    let lower = LowerName::from(name.clone());
    let flow = futures_executor::block_on(engine.inner.lookup(
        &lower,
        qtype,
        None,
        LookupOptions::default(),
    ));
    matches!(flow, LookupControlFlow::Break(Ok(_)))
}

fn push(diagnostics: &mut Vec<Diagnostic>, limits: &Limits, diagnostic: Diagnostic) {
    if diagnostics.len() < limits.max_diagnostics {
        diagnostics.push(diagnostic);
    }
}

pub(crate) fn push_diagnostic(
    diagnostics: &mut Vec<Diagnostic>,
    limits: &Limits,
    diagnostic: Diagnostic,
) {
    push(diagnostics, limits, diagnostic);
}
