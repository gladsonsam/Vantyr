//! Small typed service catalog.
//!
//! A service is a *domain set*, not an app identity, URL or browser category.
//! Selected services are compiled through the same Hickory parser/evaluator as
//! hosts lists, so no second matching engine is introduced. The bundled
//! fixtures are synthetic; no popular-service feed is shipped or fetched.

use crate::canonical::canonical_entry;
use crate::hosts::{self, HostsEngine};
use crate::limits::Limits;
use crate::types::{CompileError, Diagnostic, DiagnosticKind};

/// Exact matches one canonical host; suffix matches that host and its
/// subdomains (via Hickory's maintained leading-wildcard support).
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ServiceDomain {
    Exact(String),
    Suffix(String),
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ServiceDefinition {
    pub id: String,
    pub label: String,
    pub domains: Vec<ServiceDomain>,
    pub version: String,
    /// Optional operator-supplied URL or reference. Stored as metadata only.
    pub source: Option<String>,
    /// Short operator-supplied justification. Stored as metadata only.
    pub evidence: Option<String>,
}

#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct ServiceCatalog {
    pub version: String,
    pub services: Vec<ServiceDefinition>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ServiceMeta {
    pub id: String,
    pub label: String,
    pub version: String,
    pub source: Option<String>,
    pub evidence: Option<String>,
    pub accepted_rules: usize,
}

pub(crate) struct ServiceEngine {
    pub(crate) id: String,
    pub(crate) inner: HostsEngine,
    pub(crate) meta: ServiceMeta,
}

/// Compile only the selected services. Inputs are sorted by id so overlapping
/// service domain sets resolve deterministically to the lexicographically
/// first selected id.
pub(crate) fn build(
    catalog: &ServiceCatalog,
    selected: &[String],
    limits: &Limits,
    diagnostics: &mut Vec<Diagnostic>,
) -> Result<Vec<ServiceEngine>, CompileError> {
    if catalog.services.len() > limits.max_services {
        return Err(CompileError::Limit(format!(
            "catalog has {} services, bound is {}",
            catalog.services.len(),
            limits.max_services
        )));
    }
    check_field("catalog version", &catalog.version, diagnostics, limits)?;

    let mut services = catalog.services.clone();
    services.sort_by(|a, b| a.id.cmp(&b.id));
    let mut seen = std::collections::BTreeSet::new();
    for service in &services {
        if !seen.insert(service.id.clone()) {
            return Err(CompileError::InvalidInput(format!(
                "duplicate service id {}",
                service.id
            )));
        }
        check_field("service id", &service.id, diagnostics, limits)?;
        check_field("service label", &service.label, diagnostics, limits)?;
        check_field("service version", &service.version, diagnostics, limits)?;
        if let Some(source) = &service.source {
            check_field("service source", source, diagnostics, limits)?;
        }
        if let Some(evidence) = &service.evidence {
            check_field("service evidence", evidence, diagnostics, limits)?;
        }
        if service.domains.is_empty() || service.domains.len() > limits.max_domains_per_service {
            return Err(CompileError::InvalidInput(format!(
                "service {} has {} domain rules",
                service.id,
                service.domains.len()
            )));
        }
    }

    let mut selected_ids: Vec<String> = selected.to_vec();
    selected_ids.sort();
    selected_ids.dedup();
    let mut engines = Vec::new();
    for id in selected_ids {
        let service = services
            .iter()
            .find(|service| service.id == id)
            .ok_or_else(|| CompileError::InvalidInput(format!("unknown selected service {id}")))?;
        let mut lines = String::new();
        for domain in &service.domains {
            let (value, suffix) = match domain {
                ServiceDomain::Exact(value) => (value, false),
                ServiceDomain::Suffix(value) => (value, true),
            };
            if value.contains('*') {
                return Err(CompileError::InvalidInput(format!(
                    "service {} domain {} contains a wildcard",
                    service.id, value
                )));
            }
            let canonical = canonical_entry(value).map_err(CompileError::InvalidInput)?;
            lines.push_str(&canonical);
            lines.push('\n');
            if suffix {
                let base = canonical.trim_end_matches('.');
                let wildcard =
                    canonical_entry(&format!("*.{base}")).map_err(CompileError::InvalidInput)?;
                lines.push_str(&wildcard);
                lines.push('\n');
            }
        }
        let inner = hosts::build(&service.id, &lines, limits, diagnostics)?;
        engines.push(ServiceEngine {
            id: service.id.clone(),
            meta: ServiceMeta {
                id: service.id.clone(),
                label: service.label.clone(),
                version: service.version.clone(),
                source: service.source.clone(),
                evidence: service.evidence.clone(),
                accepted_rules: inner.inner.entry_count(),
            },
            inner,
        });
    }
    Ok(engines)
}

/// Evidence for a selected service match. The upstream blocklist API exposes
/// no matched entry, so no specific domain rule is claimed.
pub(crate) fn evidence(id: &str) -> crate::types::Evidence {
    crate::types::Evidence {
        source_id: id.to_owned(),
        source_kind: crate::types::SourceKind::Service,
        rule: None,
        note: "upstream blocklist exposes no matched entry; service id is authoritative",
    }
}

fn check_field(
    what: &str,
    value: &str,
    diagnostics: &mut Vec<Diagnostic>,
    limits: &Limits,
) -> Result<(), CompileError> {
    if value.trim().is_empty() {
        return Err(CompileError::InvalidInput(format!(
            "{what} must not be empty"
        )));
    }
    if value.len() > crate::limits::MAX_FIELD_LEN {
        crate::hosts::push_diagnostic(
            diagnostics,
            limits,
            Diagnostic::new(
                "catalog",
                0,
                DiagnosticKind::InvalidEntry,
                format!("{what} exceeds the bounded field length"),
            ),
        );
        return Err(CompileError::Rejected(diagnostics.clone()));
    }
    Ok(())
}
