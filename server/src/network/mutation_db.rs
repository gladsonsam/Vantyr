//! SQL for bounded household/gateway edits and conservative inventory deletes.
//!
//! Every statement is bound to the household from the URL path. Mutators take a
//! household row lock, then lock the TARGET row `FOR UPDATE`: a concurrent FK
//! insert takes `FOR KEY SHARE` on that parent and therefore blocks until our
//! decision commits, so a household lock alone is not the only protection.
//! Reference counts are re-read in the same transaction immediately before a
//! delete. Nothing here cascades into enrollment, assignments, sessions,
//! policy history, audit or credentials.

use sqlx::{PgConnection, QueryBuilder};
use uuid::Uuid;

use super::dto::{Household, Person};
use super::gateway_dto::Gateway;

pub async fn household_on_conn(
    conn: &mut PgConnection,
    household_id: Uuid,
) -> sqlx::Result<Option<Household>> {
    sqlx::query_as::<_, Household>(
        "SELECT id, name, timezone, is_default, created_at FROM network_households WHERE id = $1",
    )
    .bind(household_id)
    .fetch_optional(conn)
    .await
}

pub async fn update_household_on_conn(
    conn: &mut PgConnection,
    household_id: Uuid,
    name: Option<&str>,
    timezone: Option<&str>,
) -> sqlx::Result<bool> {
    let mut qb = QueryBuilder::new("UPDATE network_households SET ");
    let mut fields = qb.separated(", ");
    if let Some(name) = name {
        fields.push("name = ").push_bind_unseparated(name);
    }
    if let Some(timezone) = timezone {
        fields.push("timezone = ").push_bind_unseparated(timezone);
    }
    qb.push(" WHERE id = ").push_bind(household_id);
    Ok(qb.build().execute(conn).await?.rows_affected() == 1)
}

pub async fn gateway_on_conn(
    conn: &mut PgConnection,
    household_id: Uuid,
    gateway_id: Uuid,
) -> sqlx::Result<Option<Gateway>> {
    sqlx::query_as::<_, Gateway>(
        r"
        SELECT id, household_id, kind, label, enabled, capabilities, last_seen_at,
               revoked_at, created_at, updated_at
        FROM network_gateways
        WHERE household_id = $1 AND id = $2
        ",
    )
    .bind(household_id)
    .bind(gateway_id)
    .fetch_optional(conn)
    .await
}

/// `enabled` is written only when present. Re-enabling additionally requires
/// `revoked_at IS NULL` in the statement itself, so a revoked gateway cannot be
/// revived even if a caller races a revoke.
pub async fn update_gateway_on_conn(
    conn: &mut PgConnection,
    household_id: Uuid,
    gateway_id: Uuid,
    label: Option<&str>,
    enabled: Option<bool>,
) -> sqlx::Result<bool> {
    let mut qb = QueryBuilder::new("UPDATE network_gateways SET ");
    let mut fields = qb.separated(", ");
    if let Some(label) = label {
        fields.push("label = ").push_bind_unseparated(label);
    }
    if let Some(enabled) = enabled {
        if enabled {
            fields.push("enabled = true");
        } else {
            fields.push("enabled = false");
        }
    }
    fields.push("updated_at = NOW()");
    qb.push(" WHERE household_id = ")
        .push_bind(household_id)
        .push(" AND id = ")
        .push_bind(gateway_id);
    if enabled == Some(true) {
        qb.push(" AND revoked_at IS NULL");
    }
    Ok(qb.build().execute(conn).await?.rows_affected() == 1)
}

// ─── Atomic default-profile selection ───────────────────────────────────────

/// Insert without claiming the default first: clearing the old default then
/// setting this row happens in the same transaction, so the partial unique
/// index never sees two defaults.
pub async fn insert_person_on_conn(
    conn: &mut PgConnection,
    household_id: Uuid,
    display_name: &str,
    note: Option<&str>,
) -> sqlx::Result<Uuid> {
    sqlx::query_scalar::<_, Uuid>(
        r"
        INSERT INTO network_persons (household_id, display_name, note, is_default_profile)
        VALUES ($1, $2, $3, false)
        RETURNING id
        ",
    )
    .bind(household_id)
    .bind(display_name)
    .bind(note)
    .fetch_one(conn)
    .await
}

/// Locks the target row and proves it is in this household before any default
/// is cleared. A missing/foreign target leaves every existing default intact.
pub async fn person_for_update_on_conn(
    conn: &mut PgConnection,
    household_id: Uuid,
    person_id: Uuid,
) -> sqlx::Result<bool> {
    let found: Option<Uuid> = sqlx::query_scalar(
        "SELECT id FROM network_persons WHERE household_id = $1 AND id = $2 FOR UPDATE",
    )
    .bind(household_id)
    .bind(person_id)
    .fetch_optional(conn)
    .await?;
    Ok(found.is_some())
}

pub async fn clear_default_profile_on_conn(
    conn: &mut PgConnection,
    household_id: Uuid,
    except_person_id: Uuid,
) -> sqlx::Result<()> {
    sqlx::query(
        "UPDATE network_persons SET is_default_profile = false \
         WHERE household_id = $1 AND is_default_profile AND id <> $2",
    )
    .bind(household_id)
    .bind(except_person_id)
    .execute(conn)
    .await?;
    Ok(())
}

pub async fn set_default_profile_on_conn(
    conn: &mut PgConnection,
    household_id: Uuid,
    person_id: Uuid,
    value: bool,
) -> sqlx::Result<()> {
    sqlx::query(
        "UPDATE network_persons SET is_default_profile = $3 \
         WHERE household_id = $1 AND id = $2",
    )
    .bind(household_id)
    .bind(person_id)
    .bind(value)
    .execute(conn)
    .await?;
    Ok(())
}

/// Applies the non-default fields of a person PATCH inside the same transaction.
/// `Some(None)` clears the note; `None` keeps it (accepted nullable semantics).
pub async fn update_person_on_conn(
    conn: &mut PgConnection,
    household_id: Uuid,
    person_id: Uuid,
    display_name: Option<&str>,
    note: Option<Option<&str>>,
) -> sqlx::Result<()> {
    let mut qb = QueryBuilder::new("UPDATE network_persons SET ");
    let mut fields = qb.separated(", ");
    if let Some(name) = display_name {
        fields.push("display_name = ").push_bind_unseparated(name);
    }
    match note {
        Some(Some(n)) => {
            fields.push("note = ").push_bind_unseparated(n);
        }
        Some(None) => {
            fields.push("note = NULL");
        }
        None => {}
    }
    qb.push(" WHERE household_id = ")
        .push_bind(household_id)
        .push(" AND id = ")
        .push_bind(person_id);
    qb.build().execute(conn).await?;
    Ok(())
}

pub async fn person_on_conn(
    conn: &mut PgConnection,
    household_id: Uuid,
    person_id: Uuid,
) -> sqlx::Result<Option<Person>> {
    sqlx::query_as::<_, Person>(
        "SELECT id, household_id, display_name, is_default_profile, note, created_at \
         FROM network_persons WHERE household_id = $1 AND id = $2",
    )
    .bind(household_id)
    .bind(person_id)
    .fetch_optional(conn)
    .await
}

// ─── Conservative delete reference checks ───────────────────────────────────

#[derive(Debug, Clone, Copy, Default)]
pub struct PersonRefs {
    pub assignments: i64,
    pub bindings: i64,
    pub enrollment_grants: i64,
    pub verified_sessions: i64,
}

impl PersonRefs {
    pub fn reason(self) -> Option<&'static str> {
        if self.assignments > 0 {
            Some("person has assignments; remove or reassign them first")
        } else if self.bindings > 0 {
            Some("person has a principal binding; remap or revoke it first")
        } else if self.enrollment_grants > 0 {
            Some("person has enrollment grants; retire them first")
        } else if self.verified_sessions > 0 {
            Some("person has verified sessions; end them first")
        } else {
            None
        }
    }
}

#[derive(Debug, Clone, Copy, Default)]
pub struct DeviceRefs {
    pub assignments: i64,
    pub connections: i64,
    pub enrollments: i64,
    pub enrollment_grants: i64,
    pub verified_sessions: i64,
}

impl DeviceRefs {
    pub fn reason(self) -> Option<&'static str> {
        if self.assignments > 0 {
            Some("device has assignments; remove them first")
        } else if self.connections > 0 {
            Some("device has connections; remove them first")
        } else if self.enrollments > 0 {
            Some("device has enrollments; end them first")
        } else if self.enrollment_grants > 0 {
            Some("device has enrollment grants; retire them first")
        } else if self.verified_sessions > 0 {
            Some("device has verified sessions; end them first")
        } else {
            None
        }
    }
}

macro_rules! count_ref {
    ($conn:expr, $sql:literal, $household_id:expr, $id:expr) => {
        sqlx::query_scalar::<_, i64>($sql)
            .bind($household_id)
            .bind($id)
            .fetch_one(&mut *($conn))
            .await?
    };
}

pub async fn person_refs_on_conn(
    conn: &mut PgConnection,
    household_id: Uuid,
    person_id: Uuid,
) -> sqlx::Result<PersonRefs> {
    Ok(PersonRefs {
        assignments: count_ref!(
            conn,
            "SELECT COUNT(*)::bigint FROM network_assignments WHERE household_id = $1 AND person_id = $2",
            household_id,
            person_id
        ),
        bindings: count_ref!(
            conn,
            "SELECT COUNT(*)::bigint FROM network_principal_bindings WHERE household_id = $1 AND person_id = $2",
            household_id,
            person_id
        ),
        enrollment_grants: count_ref!(
            conn,
            "SELECT COUNT(*)::bigint FROM network_enrollment_grants WHERE household_id = $1 AND person_id = $2",
            household_id,
            person_id
        ),
        verified_sessions: count_ref!(
            conn,
            "SELECT COUNT(*)::bigint FROM network_verified_sessions WHERE household_id = $1 AND person_id = $2",
            household_id,
            person_id
        ),
    })
}

pub async fn device_refs_on_conn(
    conn: &mut PgConnection,
    household_id: Uuid,
    device_id: Uuid,
) -> sqlx::Result<DeviceRefs> {
    Ok(DeviceRefs {
        assignments: count_ref!(
            conn,
            "SELECT COUNT(*)::bigint FROM network_assignments WHERE household_id = $1 AND device_id = $2",
            household_id,
            device_id
        ),
        connections: count_ref!(
            conn,
            "SELECT COUNT(*)::bigint FROM network_connections WHERE household_id = $1 AND device_id = $2",
            household_id,
            device_id
        ),
        enrollments: count_ref!(
            conn,
            "SELECT COUNT(*)::bigint FROM network_device_enrollments WHERE household_id = $1 AND device_id = $2",
            household_id,
            device_id
        ),
        enrollment_grants: count_ref!(
            conn,
            "SELECT COUNT(*)::bigint FROM network_enrollment_grants WHERE household_id = $1 AND device_id = $2",
            household_id,
            device_id
        ),
        verified_sessions: count_ref!(
            conn,
            "SELECT COUNT(*)::bigint FROM network_verified_sessions WHERE household_id = $1 AND device_id = $2",
            household_id,
            device_id
        ),
    })
}

pub async fn assignment_refs_on_conn(
    conn: &mut PgConnection,
    household_id: Uuid,
    assignment_id: Uuid,
) -> sqlx::Result<i64> {
    Ok(count_ref!(
        conn,
        "SELECT COUNT(*)::bigint FROM network_connections WHERE household_id = $1 AND assignment_id = $2",
        household_id,
        assignment_id
    ))
}

pub async fn connection_status_on_conn(
    conn: &mut PgConnection,
    household_id: Uuid,
    connection_id: Uuid,
) -> sqlx::Result<Option<String>> {
    sqlx::query_scalar::<_, String>(
        "SELECT status FROM network_connections WHERE household_id = $1 AND id = $2 FOR UPDATE",
    )
    .bind(household_id)
    .bind(connection_id)
    .fetch_optional(conn)
    .await
}

macro_rules! locker {
    ($name:ident, $sql:literal) => {
        pub async fn $name(
            conn: &mut PgConnection,
            household_id: Uuid,
            id: Uuid,
        ) -> sqlx::Result<bool> {
            let found: Option<Uuid> = sqlx::query_scalar($sql)
                .bind(household_id)
                .bind(id)
                .fetch_optional(conn)
                .await?;
            Ok(found.is_some())
        }
    };
}

locker!(
    person_for_delete_on_conn,
    "SELECT id FROM network_persons WHERE household_id = $1 AND id = $2 FOR UPDATE"
);
locker!(
    device_for_delete_on_conn,
    "SELECT id FROM network_devices WHERE household_id = $1 AND id = $2 FOR UPDATE"
);
locker!(
    assignment_for_delete_on_conn,
    "SELECT id FROM network_assignments WHERE household_id = $1 AND id = $2 FOR UPDATE"
);

macro_rules! deleter {
    ($name:ident, $sql:literal) => {
        pub async fn $name(
            conn: &mut PgConnection,
            household_id: Uuid,
            id: Uuid,
        ) -> sqlx::Result<bool> {
            Ok(sqlx::query($sql)
                .bind(household_id)
                .bind(id)
                .execute(conn)
                .await?
                .rows_affected()
                == 1)
        }
    };
}

deleter!(
    delete_person_on_conn,
    "DELETE FROM network_persons WHERE household_id = $1 AND id = $2"
);
deleter!(
    delete_device_on_conn,
    "DELETE FROM network_devices WHERE household_id = $1 AND id = $2"
);
deleter!(
    delete_assignment_on_conn,
    "DELETE FROM network_assignments WHERE household_id = $1 AND id = $2"
);
deleter!(
    delete_connection_on_conn,
    "DELETE FROM network_connections WHERE household_id = $1 AND id = $2"
);
