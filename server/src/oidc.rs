//! OIDC login (Authentik, etc.) for the dashboard.

use anyhow::Result;
use openidconnect::core::CoreProviderMetadata;
use openidconnect::IssuerUrl;

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
}

impl OidcConfig {
    pub fn from_env() -> Option<Self> {
        let issuer_url = std::env::var("OIDC_ISSUER_URL").ok()?.trim().to_string();
        let client_id = std::env::var("OIDC_CLIENT_ID").ok()?.trim().to_string();
        let client_secret = std::env::var("OIDC_CLIENT_SECRET").ok()?.trim().to_string();
        let redirect_url = std::env::var("OIDC_REDIRECT_URL").ok()?.trim().to_string();
        if issuer_url.is_empty()
            || client_id.is_empty()
            || client_secret.is_empty()
            || redirect_url.is_empty()
        {
            return None;
        }
        let scopes_raw = std::env::var("OIDC_SCOPES")
            .ok()
            .unwrap_or_else(|| "openid profile email".to_string());
        let scopes = scopes_raw
            .split_whitespace()
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
            .collect::<Vec<_>>();
        Some(Self {
            issuer_url,
            client_id,
            client_secret,
            redirect_url,
            scopes,
            admin_group: std::env::var("OIDC_ADMIN_GROUP")
                .ok()
                .filter(|s| !s.trim().is_empty()),
            operator_group: std::env::var("OIDC_OPERATOR_GROUP")
                .ok()
                .filter(|s| !s.trim().is_empty()),
            allowed_groups: std::env::var("OIDC_ALLOWED_GROUPS")
                .ok()
                .map(|raw| {
                    raw.split([',', ' '])
                        .map(str::trim)
                        .filter(|s| !s.is_empty())
                        .map(str::to_string)
                        .collect::<Vec<_>>()
                })
                .unwrap_or_default(),
        })
    }
}

pub async fn discover_provider_metadata(cfg: &OidcConfig) -> Result<CoreProviderMetadata> {
    let issuer = IssuerUrl::new(cfg.issuer_url.clone())?;
    let provider_metadata =
        CoreProviderMetadata::discover_async(issuer, &crate::oidc_http::async_http_client).await?;
    Ok(provider_metadata)
}
