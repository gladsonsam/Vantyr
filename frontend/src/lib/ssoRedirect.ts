/** Client-side escape hatch for the `OIDC_AUTO_REDIRECT` server option.
 *
 *  When the server auto-redirects the sign-in page to the IdP, two cases must
 *  still be able to reach the local username/password form:
 *    - signing out (otherwise the live IdP session bounces straight back in), and
 *    - an admin deliberately asking for local login via `?local=1`.
 *  Both set a per-tab flag that suppresses the automatic redirect; the
 *  "Sign in with Authentik" button stays available for a manual retry. */

const SKIP_KEY = "vantyr.sso.skip-auto-redirect";

function session(): Storage | null {
  try {
    return window.sessionStorage;
  } catch {
    return null; // storage disabled (private mode / blocked cookies)
  }
}

export function suppressSsoAutoRedirect(): void {
  session()?.setItem(SKIP_KEY, "1");
}

/** True when this tab should show the local form instead of bouncing to the IdP. */
export function ssoAutoRedirectSuppressed(): boolean {
  if (session()?.getItem(SKIP_KEY) === "1") return true;
  const params = new URLSearchParams(window.location.search);
  if (params.get("local") === "1") {
    // Persist it so the flag survives the SPA stripping/replacing the query.
    suppressSsoAutoRedirect();
    return true;
  }
  return false;
}
