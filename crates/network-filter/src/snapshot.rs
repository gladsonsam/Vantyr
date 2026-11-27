//! Pure build and immutable snapshot evaluation.
//!
//! `compile` never mutates caller state and never fetches anything. A failed
//! build returns `Err` so the caller keeps its previous `Arc` snapshot. All
//! cross-source precedence is explicit and deterministic, never an iteration
//! accident.

use std::collections::BTreeSet;

use hickory_server::proto::rr::{Name, RecordType};
use sha2::{Digest, Sha256};

#[cfg(feature = "abp")]
use crate::abp::{self, AbpEngine, AbpVerdict};
#[cfg(feature = "abp")]
use crate::dns_rewrite::{self, DnsRewrite, DnsRewriteEngine};
use crate::canonical;
use crate::hosts::{self, HostsEngine};
use crate::limits::{Limits, MAX_FIELD_LEN};
use crate::service::{self, ServiceCatalog, ServiceEngine, ServiceMeta};
use crate::types::{
    CompileError, Diagnostic, DiagnosticKind, Evidence, FilterOutcome, ListFormat, ListMeta,
    ListSource, SourceKind,
};

/// Build with the documented production bounds.
pub fn compile(
    revision: u64,
    lists: &[ListSource<'_>],
    services: Option<&ServiceCatalog>,
    selected_service_ids: &[String],
) -> Result<FilterSnapshot, CompileError> {
    compile_with_limits(
        revision,
        lists,
        services,
        selected_service_ids,
        &Limits::default(),
    )
}

/// Build with explicit bounds. Intended for tests and for a future bounded
/// subscription layer that must validate raw bytes before publishing them.
pub fn compile_with_limits(
    revision: u64,
    lists: &[ListSource<'_>],
    services: Option<&ServiceCatalog>,
    selected_service_ids: &[String],
    limits: &Limits,
) -> Result<FilterSnapshot, CompileError> {
    if lists.len() > limits.max_lists {
        return Err(CompileError::Limit(format!(
            "{} lists exceed bound {}",
            lists.len(),
            limits.max_lists
        )));
    }
    let total_bytes: usize = lists.iter().map(|source| source.bytes.len()).sum();
    if total_bytes > limits.max_total_bytes {
        return Err(CompileError::Limit(format!(
            "{total_bytes} raw bytes exceed bound {}",
            limits.max_total_bytes
        )));
    }

    let mut prepared: Vec<Prepared<'_>> = Vec::new();
    let mut ids = BTreeSet::new();
    for source in lists {
        if source.id.is_empty() || source.id.len() > MAX_FIELD_LEN {
            return Err(CompileError::InvalidInput(
                "list id is empty or exceeds the bounded field length".to_owned(),
            ));
        }
        if !ids.insert(source.id.as_str()) {
            return Err(CompileError::InvalidInput(format!(
                "duplicate list id {}",
                source.id
            )));
        }
        if let Some(url) = &source.source_url {
            if url.len() > MAX_FIELD_LEN {
                return Err(CompileError::InvalidInput(format!(
                    "source_url for {} exceeds the bounded field length",
                    source.id
                )));
            }
        }
        let text = std::str::from_utf8(source.bytes).map_err(|err| {
            CompileError::InvalidInput(format!("{} is not UTF-8: {err}", source.id))
        })?;
        prepared.push(Prepared {
            id: source.id.as_str(),
            text,
            format: source.format,
            hash: Sha256::digest(source.bytes).into(),
            source_url: source.source_url.clone(),
        });
    }
    prepared.sort_by(|left, right| left.id.cmp(right.id));

    let mut diagnostics: Vec<Diagnostic> = Vec::new();
    let mut hosts_engines: Vec<HostsEngine> = Vec::new();
    let mut abp_prepared: Vec<&Prepared<'_>> = Vec::new();

    for source in &prepared {
        match source.format {
            ListFormat::Hosts => {
                let engine = hosts::build(source.id, source.text, limits, &mut diagnostics)?;
                hosts_engines.push(engine);
            }
            ListFormat::Abp => abp_prepared.push(source),
        }
    }

    let abp_sources: Vec<(&str, &str)> = abp_prepared
        .iter()
        .map(|source| (source.id, source.text))
        .collect();
    #[cfg(feature = "abp")]
    let abp::AbpBuild {
        engine: abp_engine,
        accepted_per_source: abp_counts,
        rewrites,
        exception_owners,
    } = abp::build(&abp_sources, limits, &mut diagnostics)?;
    #[cfg(feature = "abp")]
    let dns_rewrite_engine =
        dns_rewrite::build(rewrites, exception_owners, limits, &mut diagnostics)?;
    #[cfg(not(feature = "abp"))]
    let abp_counts: Vec<usize> = if abp_sources.is_empty() {
        Vec::new()
    } else {
        return Err(CompileError::InvalidInput(
            "ABP sources need the `abp` feature".to_owned(),
        ));
    };
    #[cfg(not(feature = "abp"))]
    let _abp_engine = ();
    #[cfg(not(feature = "abp"))]
    let _dns_rewrite_engine = ();

    let mut counts: std::collections::BTreeMap<String, usize> = prepared
        .iter()
        .map(|source| (source.id.to_owned(), 0usize))
        .collect();
    for engine in &hosts_engines {
        counts.insert(engine.source_id.clone(), engine.inner.entry_count());
    }
    for (source, count) in abp_prepared.iter().zip(abp_counts.iter()) {
        counts.insert(source.id.to_owned(), *count);
    }

    let service_engines = match services {
        Some(catalog) => service::build(catalog, selected_service_ids, limits, &mut diagnostics)?,
        None => Vec::new(),
    };

    if diagnostics
        .iter()
        .any(|diagnostic| diagnostic.kind != DiagnosticKind::Note)
    {
        return Err(CompileError::Rejected(diagnostics));
    }

    let mut total_rules: usize = counts.values().sum();
    for engine in &service_engines {
        total_rules += engine.inner.inner.entry_count();
    }
    if total_rules > limits.max_rules {
        return Err(CompileError::Limit(format!(
            "{total_rules} accepted rules exceed bound {}",
            limits.max_rules
        )));
    }

    let mut metas: Vec<ListMeta> = prepared
        .iter()
        .map(|source| ListMeta {
            id: source.id.to_owned(),
            format: source.format,
            content_sha256: source.hash,
            byte_len: source.text.len(),
            accepted_rules: counts.get(source.id).copied().unwrap_or(0),
            rejected_rules: diagnostics
                .iter()
                .filter(|d| d.source_id == source.id && d.kind != DiagnosticKind::Note)
                .count(),
            source_url: source.source_url.clone(),
        })
        .collect();
    metas.sort_by(|left, right| left.id.cmp(&right.id));

    let service_meta: Vec<ServiceMeta> = service_engines
        .iter()
        .map(|engine| engine.meta.clone())
        .collect();

    Ok(FilterSnapshot {
        revision,
        lists: metas,
        hosts_engines,
        #[cfg(feature = "abp")]
        abp: abp_engine,
        #[cfg(feature = "abp")]
        dns_rewrite: dns_rewrite_engine,
        service_engines,
        service_meta,
        diagnostics,
        total_rules,
        total_bytes,
    })
}

struct Prepared<'a> {
    id: &'a str,
    text: &'a str,
    format: ListFormat,
    hash: [u8; 32],
    source_url: Option<String>,
}

/// Immutable compiled filter state. Replace it by building a new snapshot and
/// swapping the caller's `Arc`; this type never mutates or auto-swaps.
pub struct FilterSnapshot {
    revision: u64,
    lists: Vec<ListMeta>,
    hosts_engines: Vec<HostsEngine>,
    #[cfg(feature = "abp")]
    abp: Option<AbpEngine>,
    #[cfg(feature = "abp")]
    dns_rewrite: DnsRewriteEngine,
    service_engines: Vec<ServiceEngine>,
    service_meta: Vec<ServiceMeta>,
    diagnostics: Vec<Diagnostic>,
    total_rules: usize,
    total_bytes: usize,
}

impl FilterSnapshot {
    pub fn revision(&self) -> u64 {
        self.revision
    }

    pub fn lists(&self) -> &[ListMeta] {
        &self.lists
    }

    pub fn diagnostics(&self) -> &[Diagnostic] {
        &self.diagnostics
    }

    pub fn services(&self) -> &[ServiceMeta] {
        &self.service_meta
    }

    pub fn total_rules(&self) -> usize {
        self.total_rules
    }

    pub fn total_bytes(&self) -> usize {
        self.total_bytes
    }

    /// Only these query types are evaluated. Others return `NoMatch` and
    /// must not be given list semantics by a caller.
    pub fn supported_query_type(qtype: RecordType) -> bool {
        matches!(qtype, RecordType::A | RecordType::AAAA | RecordType::CNAME)
    }

    /// Select the typed DNS rewrite for a supported query without changing any
    /// block or exception decision. This returns a compiler-only typed value:
    /// no DNS response is built here and no runtime enforcement is claimed.
    ///
    /// A list-layer exception (`@@||host^`, including `$important`) suppresses
    /// the rewrite; it is never a household allow. Owners were checked for
    /// conflicts at compile time. Selection is the most specific matching
    /// owner (label boundaries only), then (source id, line).
    #[cfg(feature = "abp")]
    pub fn select_dns_rewrite(&self, qname: &Name, qtype: RecordType) -> Option<DnsRewrite> {
        if !Self::supported_query_type(qtype) {
            return None;
        }
        let canonical = match canonical::canonical_query(&qname.to_string()) {
            Ok(name) => name,
            Err(_) => return None,
        };
        let host = canonical::hostname_of(&canonical);

        // Domain exceptions are indexed directly because upstream only
        // reports an exception when a block happens to pair with it. Regex
        // exceptions arrive through the existing list-layer verdict. Both
        // suppress a rewrite; neither grants an allow against household policy.
        if self.dns_rewrite.has_exception(&host) {
            return None;
        }
        if let Some(engine) = &self.abp {
            if matches!(
                engine.check(&host),
                AbpVerdict::Exception(_) | AbpVerdict::ImportantException(_)
            ) {
                return None;
            }
        }
        self.dns_rewrite.select(&host)
    }

    /// Evaluate one canonical host name.
    ///
    /// Precedence, from highest to lowest:
    /// 1. upstream `@@||host^$important` exception, reported as `AllowException`;
    /// 2. upstream `$important` block from an ABP source;
    /// 3. a selected service domain set (lexicographically first id on overlap);
    /// 4. an ordinary upstream `@@` exception, reported as `AllowException`;
    /// 5. a plain ABP block;
    /// 6. a hosts/bare/wildcard list block (lexicographically first id);
    /// 7. `NoMatch`.
    ///
    /// `AllowException` is a list-layer outcome. It never grants an allow
    /// against the household baseline policy owned by the DNS worker.
    pub fn evaluate(&self, qname: &Name, qtype: RecordType) -> FilterOutcome {
        if !Self::supported_query_type(qtype) {
            return FilterOutcome::NoMatch;
        }
        let canonical = match canonical::canonical_query(&qname.to_string()) {
            Ok(name) => name,
            Err(_) => return FilterOutcome::NoMatch,
        };
        #[cfg(feature = "abp")]
        let host = canonical::hostname_of(&canonical);

        #[cfg(feature = "abp")]
        let mut abp_exception = None;
        #[cfg(feature = "abp")]
        let mut abp_block = None;
        #[cfg(feature = "abp")]
        if let Some(engine) = &self.abp {
            match engine.check(&host) {
                AbpVerdict::ImportantException(evidence) => {
                    // `@@||host^$important` outranks every block, including an
                    // important block from the separate regex family.
                    return FilterOutcome::AllowException { evidence };
                }
                AbpVerdict::ImportantBlock(evidence) => {
                    return FilterOutcome::Block { evidence };
                }
                AbpVerdict::Exception(evidence) => abp_exception = Some(evidence),
                AbpVerdict::Block(evidence) => abp_block = Some(evidence),
                AbpVerdict::NoMatch => {}
            }
        }

        for engine in &self.service_engines {
            if hosts::matches(&engine.inner, &canonical, qtype) {
                return FilterOutcome::Block {
                    evidence: service::evidence(&engine.id),
                };
            }
        }
        #[cfg(feature = "abp")]
        if let Some(evidence) = abp_exception {
            return FilterOutcome::AllowException { evidence };
        }
        #[cfg(feature = "abp")]
        if let Some(evidence) = abp_block {
            return FilterOutcome::Block { evidence };
        }
        for engine in &self.hosts_engines {
            if hosts::matches(engine, &canonical, qtype) {
                return FilterOutcome::Block {
                    evidence: Evidence {
                        source_id: engine.source_id.clone(),
                        source_kind: SourceKind::List,
                        rule: None,
                        note:
                            "upstream blocklist exposes no matched entry; list id is authoritative",
                    },
                };
            }
        }
        FilterOutcome::NoMatch
    }
}
