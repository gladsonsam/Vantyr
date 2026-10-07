//! Shared HTTP error responses.

use std::sync::OnceLock;

use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::Json;

/// `EXPOSE_INTERNAL_ERRORS`, set once at startup. Unset (tests) means generic bodies.
static EXPOSE_INTERNAL_ERRORS: OnceLock<bool> = OnceLock::new();

/// Record whether 500 bodies carry the underlying error text. Call once at startup;
/// later calls are ignored.
pub fn set_expose_internal_errors(expose: bool) {
    let _ = EXPOSE_INTERNAL_ERRORS.set(expose);
}

/// JSON error body shape for dashboard API clients (`error` + optional `code`).
pub fn api_json_error(status: StatusCode, code: &str, message: &str) -> Response {
    (
        status,
        Json(serde_json::json!({
            "error": message,
            "code": code,
        })),
    )
        .into_response()
}

/// Return 500 JSON. By default the body is generic; set `EXPOSE_INTERNAL_ERRORS=true` for details.
pub fn internal_error(err: anyhow::Error) -> Response {
    let expose = EXPOSE_INTERNAL_ERRORS.get().copied().unwrap_or(false);
    if expose {
        tracing::error!(error = %err, "internal error");
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({ "error": err.to_string() })),
        )
            .into_response()
    } else {
        tracing::error!(error = %err, "internal error");
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({ "error": "Internal server error" })),
        )
            .into_response()
    }
}

/// Error returned by dashboard API handlers. Renders the same bodies handlers used to build
/// by hand: `{ "error": message }`, `{ "error", "code" }` for [`ApiError::Coded`], and
/// [`internal_error`] for [`ApiError::Internal`].
#[derive(Debug)]
pub enum ApiError {
    /// 400 `{ "error": message }`.
    BadRequest(String),
    /// 403 `{ "error": message }`; see [`ApiError::forbidden`] for the usual body.
    Forbidden(String),
    /// 404 `{ "error": message }`.
    NotFound(String),
    /// 409 `{ "error": message }`.
    Conflict(String),
    /// Any other status with `{ "error": message }`.
    Status(StatusCode, String),
    /// `{ "error": message, "code": code }`, as built by [`api_json_error`].
    Coded {
        status: StatusCode,
        code: &'static str,
        message: String,
    },
    /// 500 via [`internal_error`] (logged; generic body unless `EXPOSE_INTERNAL_ERRORS`).
    Internal(anyhow::Error),
    /// Bare status with an empty body.
    Empty(StatusCode),
    /// Pre-built response for the few errors whose body carries extra fields.
    Custom(Response),
}

pub type ApiResult<T> = Result<T, ApiError>;

impl ApiError {
    /// 403 `{ "error": "Forbidden" }`, the body role checks return.
    pub fn forbidden() -> Self {
        Self::Forbidden("Forbidden".to_string())
    }

    pub fn bad_request(message: impl Into<String>) -> Self {
        Self::BadRequest(message.into())
    }

    pub fn not_found(message: impl Into<String>) -> Self {
        Self::NotFound(message.into())
    }

    pub fn conflict(message: impl Into<String>) -> Self {
        Self::Conflict(message.into())
    }

    pub fn status(status: StatusCode, message: impl Into<String>) -> Self {
        Self::Status(status, message.into())
    }

    pub fn coded(status: StatusCode, code: &'static str, message: impl Into<String>) -> Self {
        Self::Coded {
            status,
            code,
            message: message.into(),
        }
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        let (status, message) = match self {
            Self::BadRequest(m) => (StatusCode::BAD_REQUEST, m),
            Self::Forbidden(m) => (StatusCode::FORBIDDEN, m),
            Self::NotFound(m) => (StatusCode::NOT_FOUND, m),
            Self::Conflict(m) => (StatusCode::CONFLICT, m),
            Self::Status(status, m) => (status, m),
            Self::Coded {
                status,
                code,
                message,
            } => return api_json_error(status, code, &message),
            Self::Internal(err) => return internal_error(err),
            Self::Empty(status) => return status.into_response(),
            Self::Custom(res) => return res,
        };
        (status, Json(serde_json::json!({ "error": message }))).into_response()
    }
}

impl From<anyhow::Error> for ApiError {
    fn from(err: anyhow::Error) -> Self {
        Self::Internal(err)
    }
}

impl From<sqlx::Error> for ApiError {
    fn from(err: sqlx::Error) -> Self {
        Self::Internal(err.into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    async fn parts(err: ApiError) -> (StatusCode, serde_json::Value) {
        let res = err.into_response();
        let status = res.status();
        let body = axum::body::to_bytes(res.into_body(), usize::MAX)
            .await
            .unwrap();
        (status, serde_json::from_slice(&body).unwrap())
    }

    #[tokio::test]
    async fn api_error_bodies_match_hand_built_responses() {
        assert_eq!(
            parts(ApiError::forbidden()).await,
            (
                StatusCode::FORBIDDEN,
                serde_json::json!({ "error": "Forbidden" })
            )
        );
        assert_eq!(
            parts(ApiError::bad_request("bad")).await,
            (
                StatusCode::BAD_REQUEST,
                serde_json::json!({ "error": "bad" })
            )
        );
        assert_eq!(
            parts(ApiError::status(StatusCode::TOO_MANY_REQUESTS, "slow")).await,
            (
                StatusCode::TOO_MANY_REQUESTS,
                serde_json::json!({ "error": "slow" })
            )
        );
        assert_eq!(
            parts(ApiError::coded(StatusCode::CONFLICT, "c", "m")).await,
            (
                StatusCode::CONFLICT,
                serde_json::json!({ "error": "m", "code": "c" })
            )
        );
        assert_eq!(
            parts(ApiError::from(anyhow::anyhow!("boom"))).await.0,
            StatusCode::INTERNAL_SERVER_ERROR
        );
        let empty = ApiError::Empty(StatusCode::FORBIDDEN).into_response();
        assert_eq!(empty.status(), StatusCode::FORBIDDEN);
        assert!(axum::body::to_bytes(empty.into_body(), usize::MAX)
            .await
            .unwrap()
            .is_empty());
    }
}
