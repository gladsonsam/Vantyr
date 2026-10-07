//! Enrollment persistence: pairing codes (invites), pending claims and their approval,
//! token-use history, and per-device credential revocation / replacement. Callers import the
//! submodule they need (`db::claims`, `db::invites`).

use sha2::{Digest, Sha256};

pub mod claims;
pub mod invites;

fn sha256_hex(raw: &str) -> String {
    let digest = Sha256::digest(raw.as_bytes());
    digest.iter().map(|b| format!("{b:02x}")).collect()
}

#[cfg(test)]
mod lifecycle_db_tests {
    use anyhow::Result;
    use sqlx::PgPool;
    use uuid::Uuid;

    use super::claims::{
        approve_agent_enrollment_claim, create_agent_enrollment_claim, AgentEnrollmentClaimInput,
        ClaimCreateReject,
    };
    use super::invites::{create_agent_replacement_token, revoke_agent_credentials};
    use crate::agents::db::{delete_agents_by_ids, get_agent_auth_by_name};

    /// Touch an enrolled identity by name. A delayed WebSocket upgrade must never recreate a
    /// deleted device or connect a device whose credentials have been revoked.
    async fn upsert_agent(pool: &PgPool, name: &str) -> Result<Uuid> {
        let id = sqlx::query_scalar(
            "UPDATE agents SET last_seen = NOW() WHERE name = $1 AND api_token_hash IS NOT NULL RETURNING id",
        )
        .bind(name)
        .fetch_one(pool)
        .await?;
        Ok(id)
    }

    #[sqlx::test]
    async fn replacement_preserves_identity_and_unbound_claims_never_merge(
        pool: PgPool,
    ) -> Result<()> {
        let id: Uuid = sqlx::query_scalar("INSERT INTO agents (name, api_token_hash) VALUES ('original-host', 'old-credential') RETURNING id")
            .fetch_one(&pool).await?;
        // A history row with a real FK verifies that replacement keeps identity.
        sqlx::query("INSERT INTO agent_sessions (agent_id) VALUES ($1)")
            .bind(id)
            .execute(&pool)
            .await?;
        revoke_agent_credentials(&pool, id).await?;
        assert!(upsert_agent(&pool, "original-host").await.is_err());
        let unbound = create_agent_enrollment_claim(
            &pool,
            AgentEnrollmentClaimInput {
                pairing_code: None,
                requested_name: "original-host",
                hostname: None,
                os: None,
                agent_version: None,
                install_id: "new-unbound-install",
                discovered_server: None,
                client_ip: None,
            },
        )
        .await?;
        assert!(matches!(unbound, Err(ClaimCreateReject::AlreadyEnrolled)));
        let (_, first_code, _) = create_agent_replacement_token(&pool, id).await?.unwrap();
        let (_, code, _) = create_agent_replacement_token(&pool, id).await?.unwrap();
        let stale = create_agent_enrollment_claim(
            &pool,
            AgentEnrollmentClaimInput {
                pairing_code: Some(&first_code),
                requested_name: "different-host",
                hostname: None,
                os: None,
                agent_version: None,
                install_id: "stale-install",
                discovered_server: None,
                client_ip: None,
            },
        )
        .await?;
        assert!(matches!(
            stale,
            Err(ClaimCreateReject::InvalidOrExpiredCode)
        ));
        let outcome = create_agent_enrollment_claim(
            &pool,
            AgentEnrollmentClaimInput {
                pairing_code: Some(&code),
                requested_name: "different-host",
                hostname: None,
                os: None,
                agent_version: None,
                install_id: "replacement-install",
                discovered_server: None,
                client_ip: None,
            },
        )
        .await?
        .map_err(|_| anyhow::anyhow!("bound claim rejected"))?;
        assert!(outcome.auto_approve);
        let (replacement_id, token, name) =
            approve_agent_enrollment_claim(&pool, outcome.claim.id, "test", None, None)
                .await?
                .map_err(|_| anyhow::anyhow!("bound approval rejected"))?;
        assert_eq!(replacement_id, id);
        assert_eq!(name, "original-host");
        let (_, hash) = get_agent_auth_by_name(&pool, &name).await?.unwrap();
        assert!(crate::auth::secrets::verify_dashboard_password(
            &hash.unwrap(),
            &token
        ));
        let count: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM agent_sessions WHERE agent_id = $1")
                .bind(id)
                .fetch_one(&pool)
                .await?;
        assert_eq!(count, 1);
        delete_agents_by_ids(&pool, &[id]).await?;
        assert!(upsert_agent(&pool, &name).await.is_err());
        let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM agents")
            .fetch_one(&pool)
            .await?;
        assert_eq!(count, 0);
        Ok(())
    }
}
