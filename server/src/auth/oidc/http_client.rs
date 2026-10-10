//! Minimal async HTTP client adapter for oauth2/openidconnect.
//!
//! We avoid relying on oauth2's optional `reqwest` helpers since they may differ
//! across versions/features; this adapter is stable and explicit.

use oauth2::{HttpRequest, HttpResponse};

pub async fn async_http_client(req: HttpRequest) -> Result<HttpResponse, reqwest::Error> {
    let client = reqwest::Client::builder()
        // Security: never follow redirects (prevents SSRF via OIDC discovery).
        .redirect(reqwest::redirect::Policy::none())
        .build()?;

    let url = req.uri().to_string();
    let mut r = client.request(req.method().clone(), url);
    for (name, value) in req.headers() {
        r = r.header(name, value);
    }
    if !req.body().is_empty() {
        r = r.body(req.body().clone());
    }

    let resp = r.send().await?;
    let status = resp.status();
    let hdrs = resp.headers().clone();
    let body = resp.bytes().await?.to_vec();

    let mut out = axum::http::Response::builder().status(status);
    {
        if let Some(headers_mut) = out.headers_mut() {
            for (k, v) in &hdrs {
                headers_mut.insert(k, v.clone());
            }
        }
    }
    Ok(out
        .body(body)
        .unwrap_or_else(|_| axum::http::Response::new(Vec::new())))
}
