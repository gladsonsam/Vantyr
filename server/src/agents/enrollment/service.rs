//! Enrollment claim approval: mints the agent token, hashes it and drives the approval
//! transaction over the `db::claims` statements.

use anyhow::Result;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine as _;
use rand::RngCore;
use sqlx::PgPool;
use uuid::Uuid;

use super::db::claims::{self, ClaimApproveReject};
use crate::auth::secrets::hash_dashboard_password;

/// A fresh plaintext agent token: 32 random bytes, URL-safe base64.
fn new_agent_token_plain() -> String {
    let mut raw = [0u8; 32];
    rand::thread_rng().fill_bytes(&mut raw);
    URL_SAFE_NO_PAD.encode(raw)
}

/// Name the approved agent gets: the admin's override when given, else what the agent
/// asked for, trimmed and capped at 128 characters.
fn final_agent_name(override_name: Option<&str>, requested_name: &str) -> String {
    override_name
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or(requested_name)
        .chars()
        .take(128)
        .collect()
}

/// Approve a pending claim in one transaction. `Ok((agent_id, plaintext_token, name))` on
/// success. Rejects a claim whose binding changed from `expected_bound_agent_id` while the
/// caller's lifecycle gate was acquired.
pub async fn approve_claim_with_binding(
    pool: &PgPool,
    claim_id: Uuid,
    approved_by: &str,
    agent_name: Option<&str>,
    group_id: Option<Uuid>,
    expected_bound_agent_id: Option<Uuid>,
) -> Result<Result<(Uuid, String, String), ClaimApproveReject>> {
    let mut tx = pool.begin().await?;
    let locked =
        match claims::lock_claim_for_approval(&mut tx, claim_id, expected_bound_agent_id).await? {
            Ok(locked) => locked,
            Err(reject) => {
                tx.rollback().await?;
                return Ok(Err(reject));
            }
        };
    let final_name = final_agent_name(agent_name, &locked.requested_name);

    let token_plain = new_agent_token_plain();
    let api_hash = hash_dashboard_password(&token_plain)?;
    let (agent_id, final_name) = match claims::issue_agent_credentials(
        &mut tx,
        locked.bound_agent_id,
        &final_name,
        &api_hash,
    )
    .await?
    {
        Ok(issued) => issued,
        Err(reject) => {
            tx.rollback().await?;
            return Ok(Err(reject));
        }
    };

    claims::mark_claim_approved(
        &mut tx,
        claim_id,
        approved_by,
        agent_id,
        group_id,
        &api_hash,
    )
    .await?;
    tx.commit().await?;
    Ok(Ok((agent_id, token_plain, final_name)))
}

/// Approve a claim, looking up its current binding first.
#[cfg(test)]
pub async fn approve_agent_enrollment_claim(
    pool: &PgPool,
    claim_id: Uuid,
    approved_by: &str,
    agent_name: Option<&str>,
    group_id: Option<Uuid>,
) -> Result<Result<(Uuid, String, String), ClaimApproveReject>> {
    let bound = claims::enrollment_claim_bound_agent_id(pool, claim_id).await?;
    approve_claim_with_binding(pool, claim_id, approved_by, agent_name, group_id, bound).await
}

#[cfg(test)]
mod tests;

#[cfg(test)]
mod unit_tests {
    use super::*;
    use crate::auth::secrets::verify_dashboard_password;

    #[test]
    fn agent_tokens_are_long_url_safe_and_unique() {
        let a = new_agent_token_plain();
        let b = new_agent_token_plain();
        assert_ne!(a, b);
        // 32 bytes -> 43 unpadded base64 characters.
        assert_eq!(a.len(), 43);
        assert!(a
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_'));
    }

    #[test]
    fn agent_token_hash_verifies_only_the_token() {
        let token = new_agent_token_plain();
        let hash = hash_dashboard_password(&token).unwrap();
        assert!(verify_dashboard_password(&hash, &token));
        assert!(!verify_dashboard_password(&hash, "other"));
    }

    #[test]
    fn final_name_prefers_a_non_blank_override() {
        assert_eq!(
            final_agent_name(Some("  front-desk "), "pc-01"),
            "front-desk"
        );
        assert_eq!(final_agent_name(Some("   "), "pc-01"), "pc-01");
        assert_eq!(final_agent_name(None, "pc-01"), "pc-01");
    }

    #[test]
    fn final_name_is_capped_at_128_chars() {
        let long = "x".repeat(300);
        assert_eq!(final_agent_name(None, &long).chars().count(), 128);
        assert_eq!(final_agent_name(Some(&long), "pc").chars().count(), 128);
    }
}
