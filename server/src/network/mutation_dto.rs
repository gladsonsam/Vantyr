//! Bounded request bodies and typed responses for the household configuration,
//! gateway enablement and conservative inventory deletion slice.
//!
//! Ids always come from the URL path. A body may only carry the fields named
//! here: unknown fields are rejected and `absent` means "keep unchanged". None
//! of these edits publishes policy, assigns a desired revision, changes worker
//! credentials or claims that a gateway is enforcing anything.

use serde::{Deserialize, Serialize};
use uuid::Uuid;

use super::dto::Household;
use super::gateway_dto::Gateway;

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PatchHouseholdBody {
    pub name: Option<String>,
    pub timezone: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PatchGatewayBody {
    pub label: Option<String>,
    pub enabled: Option<bool>,
}

/// Only fields actually changed are named; the audit detail carries exactly
/// this list, never a secret, credential digest or foreign identifier.
#[derive(Debug, Serialize)]
pub struct HouseholdPatchResult {
    pub household: Household,
    pub changed_fields: Vec<&'static str>,
}

#[derive(Debug, Serialize)]
pub struct GatewayPatchResult {
    pub gateway: Gateway,
    pub changed_fields: Vec<&'static str>,
}

#[derive(Debug, Serialize)]
pub struct DeleteResult {
    pub ok: bool,
    pub kind: &'static str,
    pub id: Uuid,
}

impl PatchHouseholdBody {
    pub fn is_empty(&self) -> bool {
        self.name.is_none() && self.timezone.is_none()
    }
}

impl PatchGatewayBody {
    pub fn is_empty(&self) -> bool {
        self.label.is_none() && self.enabled.is_none()
    }
}
