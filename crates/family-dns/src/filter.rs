//! Bounded list material and its compile/persist/publish seam.
//!
//! Small settings live in `Config` (ids, formats, bounded regular-file paths,
//! an operator catalog and selected service ids). The *validated bytes* live
//! here as [`FilterMaterial`], inside the one durable bundle. Nothing in a
//! query re-reads a source file: a restart recompiles the snapshot from the
//! persisted bytes, so a changed, missing or corrupt source file cannot change
//! the filter that was actually applied.
//!
//! This module performs file IO only at bootstrap/reload, on the updates-only
//! path. It never fetches a URL and never runs on the query path. `source_url`
//! is attribution metadata carried with the material, never dereferenced.
//!
//! [`apply_material`](crate::DnsServer::apply_filter_material) is the small
//! typed seam a future fetch layer can use: hand it validated material and it
//! goes through the same compile -> persist -> publish path as a local reload.

use std::collections::BTreeSet;
use std::fmt;
use std::fs;
use std::io::Read;
use std::path::Path;
use std::sync::Arc;

use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use vantyr_network_filter::{
    compile_with_limits, DiagnosticKind, FilterSnapshot, Limits, ListFormat, ListSource,
    ServiceCatalog, ServiceDefinition, ServiceDomain, MAX_DIAGNOSTICS, MAX_LISTS, MAX_RULES,
    MAX_TOTAL_SOURCE_BYTES,
};

use crate::config::{
    FilterConfig, ListFormatSpec, ServiceCatalogSpec, SourceOrigin, MAX_FILTER_FIELD_LEN,
    MAX_SELECTED_SERVICES,
};

/// Serialization ceiling for the one durable bundle *when it carries filter
/// material*. The filter compiler bounds raw input at 8 MiB; base64 inflates
/// that to about 10.7 MiB and JSON adds bounded metadata. 16 MiB leaves room
/// for both without ever being unbounded, and matches the accepted
/// subscription cache's snapshot ceiling.
pub const MAX_FILTER_BUNDLE_BYTES: u64 = 16 * 1024 * 1024;
/// Reject an implausible base64 field before decoding/allocating from it.
const MAX_BASE64_FIELD_BYTES: usize = 12 * 1024 * 1024;

/// Why a candidate's list material could not be prepared or recompiled. Every
/// variant maps to a rejected candidate: the old whole runtime and disk stay.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum FilterError {
    Io(String),
    Invalid(String),
    Filter(String),
}

impl fmt::Display for FilterError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Io(detail) => write!(f, "list source IO failed: {detail}"),
            Self::Invalid(detail) => write!(f, "invalid filter material: {detail}"),
            Self::Filter(detail) => write!(f, "filter candidate rejected: {detail}"),
        }
    }
}

impl std::error::Error for FilterError {}

impl From<vantyr_network_filter::CompileError> for FilterError {
    fn from(error: vantyr_network_filter::CompileError) -> Self {
        Self::Filter(error.to_string())
    }
}

/// One list's durable, self-contained material. `bytes_b64` is the exact
/// validated source content — there is deliberately no path to re-read.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct StoredList {
    pub id: String,
    pub format: ListFormatSpec,
    /// Local file or operator subscription. Defaults to local for old bundles.
    #[serde(default)]
    pub origin: SourceOrigin,
    pub bytes_b64: String,
    pub sha256_hex: String,
    pub byte_len: usize,
    /// Attribution metadata only; never fetched and never exposed per query.
    pub source_url: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct StoredListDerivation {
    pub id: String,
    pub accepted_rules: usize,
    pub rejected_rules: usize,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct StoredServiceDerivation {
    pub id: String,
    pub accepted_rules: usize,
}

/// What the accepted compiler derived from the material. Kept in the durable
/// snapshot so restart can prove it reproduced the same filter rather than
/// silently inventing a new one.
#[derive(Clone, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct FilterDerivation {
    pub revision: u64,
    pub selected_services: Vec<String>,
    pub catalog_version: String,
    pub lists: Vec<StoredListDerivation>,
    pub services: Vec<StoredServiceDerivation>,
    pub total_rules: usize,
    pub total_bytes: usize,
    pub diagnostic_notes: usize,
}

/// Durable filter material: bytes plus their compiled derivation metadata.
#[derive(Clone, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct FilterMaterial {
    pub lists: Vec<StoredList>,
    pub derivation: FilterDerivation,
}

struct LoadedList {
    id: String,
    format: ListFormatSpec,
    origin: SourceOrigin,
    bytes: Vec<u8>,
    sha256_hex: String,
    source_url: Option<String>,
}

/// Remote material provider. It returns already validated bytes from a cache;
/// no URL is fetched here. A `None` for an enabled subscription fails closed.
pub type RemoteMaterial<'a> = dyn Fn(&str) -> Result<Option<Vec<u8>>, FilterError> + 'a;

/// Default provider for workers with no subscription runtime.
pub fn no_remote(_id: &str) -> Result<Option<Vec<u8>>, FilterError> {
    Ok(None)
}

/// Build the filter snapshot and its durable material from configured local
/// regular files and/or already validated subscription cache bytes. Called at
/// bootstrap/reload only, never per query.
pub fn prepare(
    config: &FilterConfig,
    revision: u64,
    remote: &RemoteMaterial<'_>,
) -> Result<Option<(FilterMaterial, Arc<FilterSnapshot>)>, FilterError> {
    let ids = config.enabled_source_ids();
    let selected = config.selected_service_ids();
    if ids.is_empty() && selected.is_empty() {
        return Ok(None);
    }
    let catalog = config.catalog.as_ref().map(catalog_from_config);
    let catalog_version = catalog
        .as_ref()
        .map(|catalog| catalog.version.clone())
        .unwrap_or_default();

    let mut loaded: Vec<LoadedList> = Vec::with_capacity(ids.len());
    let mut total = 0usize;
    for id in &ids {
        let remaining = MAX_TOTAL_SOURCE_BYTES.saturating_sub(total);
        let format = config
            .source_format(id)
            .ok_or_else(|| FilterError::Invalid(format!("source {id} is not enabled")))?;
        let origin = config
            .source_origin(id)
            .ok_or_else(|| FilterError::Invalid(format!("source {id} has unknown origin")))?;
        let (bytes, source_url) = match origin {
            SourceOrigin::Local => {
                let spec = config
                    .sources
                    .iter()
                    .find(|source| source.enabled && source.id == *id)
                    .ok_or_else(|| {
                        FilterError::Invalid(format!("source {id} is not configured"))
                    })?;
                (
                    read_bounded_regular(&spec.path, remaining)?,
                    spec.source_url.clone(),
                )
            }
            SourceOrigin::Subscription => {
                let bytes = remote(id)?.ok_or_else(|| {
                    FilterError::Invalid(format!(
                        "enabled subscription {id} has no cached material; failing closed"
                    ))
                })?;
                if bytes.len() > remaining {
                    return Err(FilterError::Invalid(format!(
                        "subscription {id} exceeds the remaining aggregate byte bound"
                    )));
                }
                let settings = config.subscriptions.as_ref().and_then(|settings| {
                    settings
                        .sources
                        .iter()
                        .find(|source| source.enabled && source.id == *id)
                });
                // Attribution only; the full URL is never fetched here and a
                // safe display form is used when one is available.
                let url = settings.map(|source| source.url.clone());
                (bytes, url)
            }
        };
        total = total.saturating_add(bytes.len());
        loaded.push(LoadedList {
            id: id.clone(),
            format,
            origin,
            sha256_hex: hex(&Sha256::digest(&bytes)),
            bytes,
            source_url,
        });
    }

    let snapshot = compile_loaded(&loaded, catalog.as_ref(), &selected, revision)?;
    let material = FilterMaterial {
        lists: loaded
            .iter()
            .map(|list| StoredList {
                id: list.id.clone(),
                format: list.format,
                origin: list.origin,
                bytes_b64: BASE64.encode(&list.bytes),
                sha256_hex: list.sha256_hex.clone(),
                byte_len: list.bytes.len(),
                source_url: list.source_url.clone(),
            })
            .collect(),
        derivation: derive(&snapshot, &selected, &catalog_version),
    };
    Ok(Some((material, snapshot)))
}

/// Recompile an immutable snapshot from already validated durable material.
/// No file IO and no fetch. The persisted identity and derivation are checked
/// against the current settings and against a fresh compile; a mismatch is a
/// hard failure, never a silently weaker filter.
pub fn compile_from_material(
    material: Option<&FilterMaterial>,
    config: &FilterConfig,
) -> Result<Option<Arc<FilterSnapshot>>, FilterError> {
    let Some(material) = material else {
        if !config.enabled_source_ids().is_empty() || !config.selected_service_ids().is_empty() {
            return Err(FilterError::Invalid(
                "filter settings have no persisted material".to_owned(),
            ));
        }
        return Ok(None);
    };
    validate_material_shape(material)?;

    let ids = config.enabled_source_ids();
    let material_ids: Vec<String> = material.lists.iter().map(|list| list.id.clone()).collect();
    let material_formats: Vec<ListFormatSpec> =
        material.lists.iter().map(|list| list.format).collect();
    let config_formats: Vec<ListFormatSpec> = ids
        .iter()
        .map(|id| {
            config.source_format(id).ok_or_else(|| {
                FilterError::Invalid(format!("persisted list {id} is not enabled in config"))
            })
        })
        .collect::<Result<_, _>>()?;
    let material_origins: Vec<SourceOrigin> =
        material.lists.iter().map(|list| list.origin).collect();
    let config_origins: Vec<SourceOrigin> = ids
        .iter()
        .map(|id| {
            config.source_origin(id).ok_or_else(|| {
                FilterError::Invalid(format!("persisted list {id} has no configured origin"))
            })
        })
        .collect::<Result<_, _>>()?;
    if material_ids != ids
        || material_formats != config_formats
        || material_origins != config_origins
    {
        return Err(FilterError::Invalid(
            "persisted list ids/formats/origins differ from local settings".to_owned(),
        ));
    }
    let selected = config.selected_service_ids();
    if material.derivation.selected_services != selected {
        return Err(FilterError::Invalid(
            "persisted selected services differ from local settings".to_owned(),
        ));
    }

    let mut loaded: Vec<LoadedList> = Vec::with_capacity(material.lists.len());
    for list in &material.lists {
        let bytes = BASE64.decode(&list.bytes_b64).map_err(|error| {
            FilterError::Invalid(format!("list {} has invalid base64: {error}", list.id))
        })?;
        loaded.push(LoadedList {
            id: list.id.clone(),
            format: list.format,
            origin: list.origin,
            sha256_hex: list.sha256_hex.clone(),
            bytes,
            source_url: list.source_url.clone(),
        });
    }
    let catalog = config.catalog.as_ref().map(catalog_from_config);
    let catalog_version = catalog
        .as_ref()
        .map(|catalog| catalog.version.clone())
        .unwrap_or_default();
    let snapshot = compile_loaded(
        &loaded,
        catalog.as_ref(),
        &selected,
        material.derivation.revision,
    )?;
    if derive(&snapshot, &selected, &catalog_version) != material.derivation {
        return Err(FilterError::Invalid(
            "recompiled filter does not match the persisted derivation".to_owned(),
        ));
    }
    Ok(Some(snapshot))
}

/// Shape, bounds and content-integrity checks that need no file IO. Called by
/// the bundle validator on both disk loads and new candidates so corrupt or
/// forged material never becomes last-known-good.
pub fn validate_material_shape(material: &FilterMaterial) -> Result<(), FilterError> {
    if material.lists.len() > MAX_LISTS {
        return Err(FilterError::Invalid(format!(
            "{} lists exceed bound {MAX_LISTS}",
            material.lists.len()
        )));
    }
    let mut ids = BTreeSet::new();
    let mut total = 0usize;
    for list in &material.lists {
        check_field(&list.id, "list id")?;
        if !ids.insert(list.id.clone()) {
            return Err(FilterError::Invalid(format!(
                "duplicate list id {}",
                list.id
            )));
        }
        if list.byte_len > MAX_TOTAL_SOURCE_BYTES {
            return Err(FilterError::Invalid(format!(
                "list {} exceeds the aggregate byte bound",
                list.id
            )));
        }
        total = total.saturating_add(list.byte_len);
        if total > MAX_TOTAL_SOURCE_BYTES {
            return Err(FilterError::Invalid(
                "aggregate list bytes exceed the bound".to_owned(),
            ));
        }
        if list.bytes_b64.len() > MAX_BASE64_FIELD_BYTES {
            return Err(FilterError::Invalid(format!(
                "list {} base64 field is unbounded",
                list.id
            )));
        }
        let bytes = BASE64.decode(&list.bytes_b64).map_err(|error| {
            FilterError::Invalid(format!("list {} has invalid base64: {error}", list.id))
        })?;
        if bytes.len() != list.byte_len || hex(&Sha256::digest(&bytes)) != list.sha256_hex {
            return Err(FilterError::Invalid(format!(
                "list {} bytes disagree with its length or digest",
                list.id
            )));
        }
        if let Some(url) = &list.source_url {
            check_field(url, "list source_url")?;
        }
    }

    let derivation = &material.derivation;
    if derivation.selected_services.len() > MAX_SELECTED_SERVICES
        || derivation.services.len() > MAX_SELECTED_SERVICES
        || derivation.lists.len() != material.lists.len()
    {
        return Err(FilterError::Invalid(
            "derivation counts disagree with the material".to_owned(),
        ));
    }
    if derivation.total_rules > MAX_RULES || derivation.total_bytes > MAX_TOTAL_SOURCE_BYTES {
        return Err(FilterError::Invalid(
            "derivation exceeds a compiler bound".to_owned(),
        ));
    }
    if derivation.diagnostic_notes > MAX_DIAGNOSTICS {
        return Err(FilterError::Invalid(
            "derivation retains too many diagnostics".to_owned(),
        ));
    }
    let mut derived_ids = BTreeSet::new();
    for entry in &derivation.lists {
        check_field(&entry.id, "derived list id")?;
        if !derived_ids.insert(entry.id.clone()) || !ids.contains(&entry.id) {
            return Err(FilterError::Invalid(
                "derivation names an unknown or duplicated list".to_owned(),
            ));
        }
    }
    Ok(())
}

/// Content identity of the applied material. It is derived only from persisted
/// fields, so a byte-for-byte identical refresh never creates a phantom new
/// filter generation or whole-bundle generation.
pub fn material_identity(material: Option<&FilterMaterial>) -> String {
    let Some(material) = material else {
        return String::new();
    };
    let mut hasher = Sha256::new();
    for list in &material.lists {
        hasher.update(list.id.as_bytes());
        hasher.update(match list.format {
            ListFormatSpec::Hosts => b"hosts".as_slice(),
            ListFormatSpec::Abp => b"abp".as_slice(),
        });
        hasher.update(list.sha256_hex.as_bytes());
        hasher.update(list.byte_len.to_le_bytes());
        if let Some(url) = &list.source_url {
            hasher.update(url.as_bytes());
        }
    }
    for id in &material.derivation.selected_services {
        hasher.update(id.as_bytes());
    }
    hasher.update(material.derivation.catalog_version.as_bytes());
    hex(&hasher.finalize())
}

/// An immutable empty snapshot for workers with no configured lists/services.
pub fn empty_filter() -> Arc<FilterSnapshot> {
    Arc::new(
        compile_with_limits(0, &[], None, &[], &Limits::default())
            .expect("an empty filter candidate cannot fail"),
    )
}

fn compile_loaded(
    loaded: &[LoadedList],
    catalog: Option<&ServiceCatalog>,
    selected: &[String],
    revision: u64,
) -> Result<Arc<FilterSnapshot>, FilterError> {
    let sources: Vec<ListSource<'_>> = loaded
        .iter()
        .map(|list| ListSource {
            id: list.id.clone(),
            format: list_format(list.format),
            bytes: &list.bytes,
            source_url: list.source_url.clone(),
        })
        .collect();
    let snapshot = compile_with_limits(revision, &sources, catalog, selected, &Limits::default())?;
    Ok(Arc::new(snapshot))
}

fn derive(
    snapshot: &FilterSnapshot,
    selected: &[String],
    catalog_version: &str,
) -> FilterDerivation {
    FilterDerivation {
        revision: snapshot.revision(),
        selected_services: selected.to_vec(),
        catalog_version: catalog_version.to_owned(),
        lists: snapshot
            .lists()
            .iter()
            .map(|meta| StoredListDerivation {
                id: meta.id.clone(),
                accepted_rules: meta.accepted_rules,
                rejected_rules: meta.rejected_rules,
            })
            .collect(),
        services: snapshot
            .services()
            .iter()
            .map(|meta| StoredServiceDerivation {
                id: meta.id.clone(),
                accepted_rules: meta.accepted_rules,
            })
            .collect(),
        total_rules: snapshot.total_rules(),
        total_bytes: snapshot.total_bytes(),
        diagnostic_notes: snapshot
            .diagnostics()
            .iter()
            .filter(|diagnostic| diagnostic.kind == DiagnosticKind::Note)
            .count(),
    }
}

fn catalog_from_config(spec: &ServiceCatalogSpec) -> ServiceCatalog {
    ServiceCatalog {
        version: spec.version.clone(),
        services: spec
            .services
            .iter()
            .map(|service| ServiceDefinition {
                id: service.id.clone(),
                label: service.label.clone(),
                version: service.version.clone(),
                domains: service
                    .domains
                    .iter()
                    .map(|domain| match domain {
                        crate::config::ServiceDomainSpec::Exact { value } => {
                            ServiceDomain::Exact(value.clone())
                        }
                        crate::config::ServiceDomainSpec::Suffix { value } => {
                            ServiceDomain::Suffix(value.clone())
                        }
                    })
                    .collect(),
                source: service.source.clone(),
                evidence: service.evidence.clone(),
            })
            .collect(),
    }
}

fn list_format(format: ListFormatSpec) -> ListFormat {
    match format {
        ListFormatSpec::Hosts => ListFormat::Hosts,
        ListFormatSpec::Abp => ListFormat::Abp,
    }
}

fn read_bounded_regular(path: &str, limit: usize) -> Result<Vec<u8>, FilterError> {
    let path = Path::new(path);
    let meta = fs::symlink_metadata(path)
        .map_err(|error| FilterError::Io(format!("{}: {error}", path.display())))?;
    if meta.file_type().is_symlink() || !meta.file_type().is_file() {
        return Err(FilterError::Io(format!(
            "{} is not a regular, non-symlink file",
            path.display()
        )));
    }
    if meta.len() as usize > limit {
        return Err(FilterError::Invalid(format!(
            "{} exceeds its remaining byte bound",
            path.display()
        )));
    }
    let mut options = fs::OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW);
    }
    let file = options
        .open(path)
        .map_err(|error| FilterError::Io(format!("{}: {error}", path.display())))?;
    // Allocate from metadata, then read at most one byte beyond the bound.
    let mut bytes = Vec::with_capacity(meta.len() as usize);
    file.take(limit.saturating_add(1) as u64)
        .read_to_end(&mut bytes)
        .map_err(|error| FilterError::Io(format!("{}: {error}", path.display())))?;
    if bytes.len() > limit {
        return Err(FilterError::Invalid(format!(
            "{} grew beyond its byte bound",
            path.display()
        )));
    }
    Ok(bytes)
}

fn check_field(value: &str, what: &str) -> Result<(), FilterError> {
    if value.is_empty() || value.len() > MAX_FILTER_FIELD_LEN || value.chars().any(char::is_control)
    {
        return Err(FilterError::Invalid(format!(
            "{what} is empty, unbounded or malformed"
        )));
    }
    Ok(())
}

fn hex(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        out.push_str(&format!("{byte:02x}"));
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};

    static COUNTER: AtomicU64 = AtomicU64::new(0);

    fn temp_file(name: &str) -> std::path::PathBuf {
        let serial = COUNTER.fetch_add(1, Ordering::SeqCst);
        std::env::temp_dir().join(format!(
            "vantyr-filter-{}-{name}-{serial}.txt",
            std::process::id()
        ))
    }

    #[test]
    fn empty_settings_have_no_material() {
        let config = FilterConfig::default();
        assert!(prepare(&config, 3, &no_remote).unwrap().is_none());
        assert!(compile_from_material(None, &config).unwrap().is_none());
    }

    #[test]
    fn material_round_trips_from_bounded_regular_files() {
        let hosts = temp_file("hosts");
        fs::write(&hosts, "blocked.test.example\n").unwrap();
        let config: FilterConfig = serde_json::from_str(&format!(
            r#"{{"sources":[{{"id":"local","format":"hosts","path":"{}"}}]}}"#,
            hosts.display()
        ))
        .unwrap();
        let (material, snapshot) = prepare(&config, 4, &no_remote).unwrap().unwrap();
        assert_eq!(snapshot.total_rules(), 1);
        assert_eq!(material.derivation.revision, 4);
        assert_eq!(material.lists[0].sha256_hex.len(), 64);
        assert!(validate_material_shape(&material).is_ok());

        // Recompiling from the persisted bytes (with the file gone) yields the
        // same derivation.
        fs::remove_file(&hosts).unwrap();
        let again = compile_from_material(Some(&material), &config)
            .unwrap()
            .unwrap();
        assert_eq!(again.revision(), 4);
        assert_eq!(again.total_rules(), 1);
    }
}
