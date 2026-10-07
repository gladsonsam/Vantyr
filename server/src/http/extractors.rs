//! The signed-in dashboard user and role-gated extractors.
//!
//! `auth::middleware::require_auth` inserts an [`AuthUser`] into the request extensions of
//! every protected route; handlers read it directly or through [`RequireAdmin`] /
//! [`RequireOperator`].

use axum::{
    async_trait,
    extract::{Extension, FromRequestParts},
    http::request::Parts,
    response::{IntoResponse, Response},
};

use crate::error::ApiError;

#[derive(Clone, Debug)]
pub struct AuthUser {
    pub user_id: uuid::Uuid,
    pub username: String,
    pub role: String, // 'admin' | 'operator' | 'viewer'
    /// Optional full name shown in the UI; sign-in uses `username`.
    pub display_name: String,
    /// Optional avatar glyph (e.g. emoji) for the dashboard UI.
    pub display_icon: Option<String>,
    /// Per-session secret; sent to the SPA for `X-CSRF-Token` on mutating requests.
    pub csrf_token: String,
}

impl AuthUser {
    pub fn is_admin(&self) -> bool {
        self.role == "admin"
    }
    pub fn is_operator(&self) -> bool {
        self.role == "operator" || self.role == "admin"
    }
}

/// The signed-in [`AuthUser`], rejecting non-admins with 403 `{ "error": "Forbidden" }`.
pub struct RequireAdmin(pub AuthUser);

/// The signed-in [`AuthUser`], rejecting viewers with 403 `{ "error": "Forbidden" }`.
pub struct RequireOperator(pub AuthUser);

async fn auth_user_from_parts<S: Send + Sync>(
    parts: &mut Parts,
    state: &S,
    allowed: fn(&AuthUser) -> bool,
) -> Result<AuthUser, Response> {
    let Extension(user) = Extension::<AuthUser>::from_request_parts(parts, state)
        .await
        .map_err(IntoResponse::into_response)?;
    if !allowed(&user) {
        return Err(ApiError::forbidden().into_response());
    }
    Ok(user)
}

#[async_trait]
impl<S: Send + Sync> FromRequestParts<S> for RequireAdmin {
    type Rejection = Response;

    async fn from_request_parts(parts: &mut Parts, state: &S) -> Result<Self, Self::Rejection> {
        auth_user_from_parts(parts, state, AuthUser::is_admin)
            .await
            .map(Self)
    }
}

#[async_trait]
impl<S: Send + Sync> FromRequestParts<S> for RequireOperator {
    type Rejection = Response;

    async fn from_request_parts(parts: &mut Parts, state: &S) -> Result<Self, Self::Rejection> {
        auth_user_from_parts(parts, state, AuthUser::is_operator)
            .await
            .map(Self)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::http::StatusCode;

    fn parts_with_role(role: &str) -> Parts {
        let (mut parts, _) = axum::http::Request::new(()).into_parts();
        parts.extensions.insert(AuthUser {
            user_id: uuid::Uuid::nil(),
            username: "u".into(),
            role: role.into(),
            display_name: String::new(),
            display_icon: None,
            csrf_token: String::new(),
        });
        parts
    }

    #[tokio::test]
    async fn require_admin_rejects_other_roles_with_forbidden() {
        assert!(
            RequireAdmin::from_request_parts(&mut parts_with_role("admin"), &())
                .await
                .is_ok()
        );
        for role in ["operator", "viewer"] {
            let Err(res) = RequireAdmin::from_request_parts(&mut parts_with_role(role), &()).await
            else {
                panic!("{role} should be rejected");
            };
            assert_eq!(res.status(), StatusCode::FORBIDDEN);
            let body = axum::body::to_bytes(res.into_body(), usize::MAX)
                .await
                .unwrap();
            assert_eq!(
                serde_json::from_slice::<serde_json::Value>(&body).unwrap(),
                serde_json::json!({ "error": "Forbidden" })
            );
        }
    }

    #[tokio::test]
    async fn require_operator_admits_operators_and_admins_only() {
        for role in ["admin", "operator"] {
            assert!(
                RequireOperator::from_request_parts(&mut parts_with_role(role), &())
                    .await
                    .is_ok()
            );
        }
        let Err(res) =
            RequireOperator::from_request_parts(&mut parts_with_role("viewer"), &()).await
        else {
            panic!("viewer should be rejected");
        };
        assert_eq!(res.status(), StatusCode::FORBIDDEN);
    }
}
