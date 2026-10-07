//! OIDC login (Authentik, etc.) for the dashboard.

use anyhow::Result;
use openidconnect::core::CoreProviderMetadata;
use openidconnect::IssuerUrl;

pub mod http_client;

/// Parsed from the `OIDC_*` environment variables by `config::ServerConfig::from_env`.
#[derive(Clone, Debug)]
pub struct OidcConfig {
    pub issuer_url: String,
    pub client_id: String,
    pub client_secret: String,
    pub redirect_url: String,
    pub scopes: Vec<String>,
    pub admin_group: Option<String>,
    pub operator_group: Option<String>,
    /// When non-empty, a login is only provisioned if the token's groups intersect this set.
    /// Empty = open provisioning (any successful IdP login creates a local user).
    pub allowed_groups: Vec<String>,
    /// When true, the SPA skips the login screen and goes straight to the IdP.
    /// Opt-in via `OIDC_AUTO_LOGIN=1` — off by default so local login keeps working.
    pub auto_login: bool,
}

pub async fn discover_provider_metadata(cfg: &OidcConfig) -> Result<CoreProviderMetadata> {
    let issuer = IssuerUrl::new(cfg.issuer_url.clone())?;
    let provider_metadata =
        CoreProviderMetadata::discover_async(issuer, &http_client::async_http_client).await?;
    Ok(provider_metadata)
}
