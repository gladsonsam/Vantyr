//! Canonicalisation delegated to Hickory's maintained `Name` parser.
//!
//! Hickory supplies label boundaries, case folding, trailing-dot handling and
//! IDNA (via its `idna` dependency). This module only applies the small policy
//! decisions this adapter needs; it does not parse DNS wire data.

use hickory_server::proto::rr::Name;
use std::str::FromStr;

use crate::limits::MAX_NAME_LEN;

/// Canonicalise a query name. Queries may not contain wildcards.
pub fn canonical_query(input: &str) -> Result<Name, String> {
    let parsed = parse(input, false)?;
    Ok(parsed)
}

/// Canonicalise one list entry to an ASCII, fully-qualified presentation
/// suitable for Hickory's blocklist `add(Read)`. A single leading wildcard
/// label is permitted; Hickory's `min_wildcard_depth = 2` still guards broad
/// entries such as `*.com`.
pub fn canonical_entry(input: &str) -> Result<String, String> {
    let mut name = parse(input, true)?;
    name.set_fqdn(true);
    // `Display`/`to_string` decodes IDNA back to Unicode, which would break
    // the ASCII promise above. `to_ascii` keeps internationalised labels in
    // their `xn--` punycode form, matching upstream parsers.
    Ok(name.to_ascii().to_ascii_lowercase())
}

/// Host form used for the minimal synthetic ABP request carrier. It is the
/// same ASCII/punycode presentation as `canonical_entry`, without the trailing
/// dot. No path, scheme or query component is ever derived from this string,
/// so a Unicode query and its punycode spelling produce the same carrier.
#[cfg(feature = "abp")]
pub fn hostname_of(name: &Name) -> String {
    name.to_ascii().trim_end_matches('.').to_ascii_lowercase()
}

fn parse(input: &str, allow_leading_wildcard: bool) -> Result<Name, String> {
    let trimmed = input.trim();
    if trimmed.is_empty() || trimmed == "." {
        return Err("empty or root name is not a host domain".to_owned());
    }
    if trimmed.len() > MAX_NAME_LEN {
        return Err("name exceeds the bounded presentation length".to_owned());
    }
    let mut name = Name::from_str(trimmed).map_err(|err| format!("invalid DNS name: {err}"))?;
    let labels: Vec<&[u8]> = name.iter().collect();
    if labels.is_empty() {
        return Err("name has no labels".to_owned());
    }
    if labels.iter().any(|label| label.len() > 63) {
        return Err("label exceeds 63 bytes".to_owned());
    }
    for (index, label) in labels.iter().enumerate() {
        if *label == b"*" && (!allow_leading_wildcard || index != 0 || labels.len() < 3) {
            return Err(
                "wildcard is only allowed as a leading label with two static labels".to_owned(),
            );
        }
    }
    name.set_fqdn(true);
    Ok(name)
}
