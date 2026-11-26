//! Thin pre-200 adapter that turns one CONNECT into an inspected session.
//!
//! The only glue around maintained Rama services: issue a leaf bound to the
//! CONNECT authority, build the SNI-guarded server config, then let the eager
//! connector establish and verify upstream TLS before the 200. Any issuance or
//! config failure returns an error response **before** the inner service runs,
//! so there is never a 200 tunnel or an opaque fallback.

use std::sync::Arc;

use rama::extensions::ExtensionsRef as _;
use rama::http::layer::upgrade::UpgradeOutput;
use rama::http::{Body, Request, Response, StatusCode};
use rama::net::ConnectorTargetInputExt as _;
use rama::Service;
use vantyr_network_pki::CaSigner;

use super::leaf::{issue_leaf, server_config};
use super::relay::PreparedInspect;
use super::{InspectionMode, InspectionModeMarker};

#[derive(Clone)]
pub(crate) struct PrepareInspection<C> {
    inner: C,
    signer: Arc<CaSigner>,
    leaf_validity_secs: u64,
}

impl<C> PrepareInspection<C> {
    pub(crate) fn new(inner: C, signer: Arc<CaSigner>, leaf_validity_secs: u64) -> Self {
        Self {
            inner,
            signer,
            leaf_validity_secs,
        }
    }
}

impl<C> Service<Request> for PrepareInspection<C>
where
    C: Service<Request, Output = UpgradeOutput<Request, Response>, Error = Response> + Clone,
{
    type Output = C::Output;
    type Error = Response;

    async fn serve(&self, request: Request) -> Result<Self::Output, Self::Error> {
        // The request-level service is the only place allowed to select this
        // path; an absent or wrong marker fails closed.
        if request
            .extensions()
            .get_ref::<InspectionModeMarker>()
            .map(|m| m.0)
            != Some(InspectionMode::Inspect)
        {
            return Err(status(
                StatusCode::INTERNAL_SERVER_ERROR,
                "inspection path reached without an inspect decision",
            ));
        }
        let Some(target) = request.connector_target_with_default_port(443) else {
            return Err(status(
                StatusCode::BAD_REQUEST,
                "missing CONNECT authority for inspection",
            ));
        };
        let leaf = issue_leaf(&self.signer, &target, self.leaf_validity_secs).map_err(|error| {
            tracing::warn!(error = ?error, "inspection leaf issuance failed");
            status(
                StatusCode::BAD_GATEWAY,
                "inspection certificate could not be issued",
            )
        })?;
        let config = server_config(leaf, &target).map_err(|error| {
            tracing::warn!(error = ?error, "inspection TLS config failed");
            status(
                StatusCode::BAD_GATEWAY,
                "inspection TLS configuration failed",
            )
        })?;

        // Eager connector may fail (bad cert / hostname / timeout) with a
        // pre-200 502/504. Only on success do we attach the prepared leaf;
        // `UpgradeOutput.extensions` is public and reaches `Upgraded`.
        let output = self.inner.serve(request).await?;
        output.extensions.insert(PreparedInspect { config });
        Ok(output)
    }
}

fn status(code: StatusCode, message: &str) -> Response {
    let mut response = Response::new(Body::from(message.to_owned()));
    *response.status_mut() = code;
    response
}
