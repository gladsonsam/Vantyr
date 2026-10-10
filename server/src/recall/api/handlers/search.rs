//! OCR full-text search over an agent's captured screens.

use std::net::SocketAddr;
use std::sync::Arc;

use axum::extract::ConnectInfo;
use axum::{
    extract::{Path, Query, State},
    http::HeaderMap,
    Json,
};
use serde::Deserialize;
use serde_json::Value;
use uuid::Uuid;

use crate::error::{ApiError, ApiResult};
use crate::http::audit_ip;
use crate::http::RequireOperator;
use crate::platform::audit;
use crate::recall::api::cursor::{filtered_page_context, next_cursor, ContextFilterQuery};
use crate::recall::api::AUDIT_SEARCH;
use crate::recall::db;
use crate::state::AppState;

#[derive(Debug, Deserialize)]
pub struct SearchQuery {
    #[serde(flatten)]
    filters: ContextFilterQuery,
    cursor: Option<String>,
    /// range (default, last day) or retained (all currently retained rows).
    scope: Option<String>,
    /// ranked (default) or newest.
    sort: Option<String>,
    q: Option<String>,
    from: Option<String>,
    to: Option<String>,
    monitor: Option<i32>,
    #[serde(default = "default_search_limit")]
    limit: i64,
}

const fn default_search_limit() -> i64 {
    100
}

/// `GET /agents/:id/history/search?q=&from&to&limit&cursor&scope&sort`.
/// Defaults: scope=range (last day), sort=ranked (rank/time/id DESC).
/// sort=newest uses time/id DESC. scope=retained removes the lower time bound
/// and rejects `from`; `to` still freezes the upper bound (default now).
/// Repeat `q` on every page; other omitted filters inherit the cursor.
/// Completeness is relative to currently retained, OCR-indexed matching rows.
pub async fn history_search(
    Path(id): Path<Uuid>,
    Query(q): Query<SearchQuery>,
    State(s): State<Arc<AppState>>,
    RequireOperator(user): RequireOperator,
    headers: HeaderMap,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
) -> ApiResult<Json<Value>> {
    let query = q.q.as_deref().map(str::trim).unwrap_or("");
    if query.len() > 4_096 {
        return Err(ApiError::bad_request(
            "search query 'q' is too long (maximum 4096 bytes)",
        ));
    }
    let context = filtered_page_context(
        id,
        Some(query),
        q.from,
        q.to,
        q.monitor,
        q.scope.as_deref(),
        q.sort.as_deref(),
        q.cursor.as_deref(),
        &q.filters,
    )
    .map_err(ApiError::bad_request)?;
    let filters = context.filters.clone();
    let from = context.from;
    let to = context.to;
    let monitor = context.monitor;
    let scope = context.scope.clone();
    let sort = context.sort.clone();
    // Always logged, never throttled: unlike replay volume, *what* was searched for
    // across someone's screen contents is exactly what an audit needs to show.
    audit::insert_audit_log_traced(
        &s.db,
        user.username.as_str(),
        Some(id),
        AUDIT_SEARCH,
        "ok",
        &serde_json::json!({ "role": user.role, "q": query, "filters": filters, "scope": scope, "sort": sort }),
        audit_ip(&headers, addr).as_deref(),
    )
    .await;
    let limit = q.limit.clamp(1, 500);
    let page = db::search::search_screen_frames_filtered_page(
        &s.db,
        id,
        query,
        from,
        to,
        monitor,
        limit,
        sort == "newest",
        q.cursor.as_ref().map(|_| &context.position),
        &filters,
    )
    .await?;
    let next_cursor = next_cursor(context, page.next);
    Ok(Json(serde_json::json!({
        "query": query, "from": from, "to": to, "filters": filters,
        "count": page.items.len(), "results": page.items,
        "monitor": monitor, "scope": scope, "sort": sort, "limit": limit,
        "has_more": next_cursor.is_some(), "complete": next_cursor.is_none(),
        "next_cursor": next_cursor,
    })))
}

#[cfg(test)]
mod context_handler_tests {
    use super::*;
    use crate::test_support::recall::{fixture, frame_header as header};
    use axum::extract::FromRequestParts;
    use axum::http::StatusCode;
    use axum::response::IntoResponse;
    use chrono::{TimeZone, Utc};
    async fn get(
        s: Arc<AppState>,
        id: Uuid,
        params: serde_json::Value,
        role: &str,
    ) -> (StatusCode, serde_json::Value) {
        let q: SearchQuery = serde_json::from_value(params).unwrap();
        let mut user = crate::test_support::admin();
        user.role = role.into();
        // Run the role extractor too, so RBAC is exercised as the router would.
        let (mut parts, _) = axum::http::Request::new(()).into_parts();
        parts.extensions.insert(user);
        let r = match RequireOperator::from_request_parts(&mut parts, &()).await {
            Ok(operator) => history_search(
                Path(id),
                Query(q),
                State(s),
                operator,
                HeaderMap::new(),
                ConnectInfo("127.0.0.1:1234".parse().unwrap()),
            )
            .await
            .into_response(),
            Err(rejection) => rejection.into_response(),
        };
        let status = r.status();
        let b = axum::body::to_bytes(r.into_body(), 1024 * 1024)
            .await
            .unwrap();
        (status, serde_json::from_slice(&b).unwrap())
    }
    #[sqlx::test(migrations = false)]
    async fn recall_context_handler_filters_cursor_rbac_audit_and_bad_inputs(db: sqlx::PgPool) {
        let (s, id, _, _) = fixture(db).await;
        let at = Utc.with_ymd_and_hms(2026, 1, 1, 0, 0, 0).unwrap();
        let m = crate::recall::context::sanitize(&header(), Some(12), Some(9));
        for _ in 0..3 {
            db::frames::insert_screen_frame(
                &s.db,
                id,
                at,
                0,
                100,
                100,
                0,
                "fixture.jpg",
                Some("needle"),
                None,
                Some(Uuid::new_v4()),
                &m,
            )
            .await
            .unwrap();
        }
        let params = serde_json::json!({"app":"EDITOR.EXE","title":"100%_done","url_host":"EXAMPLE.COM.","scope":"retained","limit":2});
        let (status, first) = get(s.clone(), id, params, "operator").await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(first["query"], "");
        assert_eq!(first["sort"], "newest");
        assert_eq!(first["filters"]["url_host"], "example.com");
        assert_eq!(first["filters"]["app"], "editor.exe");
        assert_eq!(first["count"], 2);
        assert_eq!(first["has_more"], true);
        let next = first["next_cursor"].clone();
        let (status, last) = get(
            s.clone(),
            id,
            serde_json::json!({"cursor":next}),
            "operator",
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(last["count"], 1);
        assert_eq!(last["complete"], true);
        assert_eq!(first["filters"], last["filters"]);
        assert_eq!(
            get(
                s.clone(),
                id,
                serde_json::json!({"cursor":next,"title":""}),
                "operator"
            )
            .await
            .0,
            StatusCode::BAD_REQUEST
        );
        assert_eq!(
            get(
                s.clone(),
                Uuid::new_v4(),
                serde_json::json!({"cursor":next}),
                "operator"
            )
            .await
            .0,
            StatusCode::BAD_REQUEST
        );
        assert_eq!(
            get(s.clone(), id, serde_json::json!({"q":"needle"}), "viewer")
                .await
                .0,
            StatusCode::FORBIDDEN
        );
        for params in [
            serde_json::json!({}),
            serde_json::json!({"app":"editor","sort":"ranked"}),
            serde_json::json!({"context":"unknown","app":"editor"}),
            serde_json::json!({"url_host":"example.com:80"}),
            serde_json::json!({"title":"x".repeat(1025)}),
            serde_json::json!({"app_mode":"prefix"}),
            serde_json::json!({"title":"bad\ninput"}),
        ] {
            assert_eq!(
                get(s.clone(), id, params, "admin").await.0,
                StatusCode::BAD_REQUEST
            );
        }
        let detail: serde_json::Value =
            sqlx::query_scalar("SELECT detail FROM audit_log WHERE action='recall_search' LIMIT 1")
                .fetch_one(&s.db)
                .await
                .unwrap();
        assert_eq!(detail["filters"]["app"], "editor.exe");
    }
}
