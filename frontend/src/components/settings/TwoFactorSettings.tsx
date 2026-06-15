import { useEffect, useState } from "react";
import { api } from "../../lib/api";
import { RETENTION_INPUT_CLASS } from "../../lib/retentionForm";

function RecoveryCodes({ codes }: { codes: string[] }) {
  return (
    <div className="rounded-md border border-accent/40 bg-accent/5 p-3">
      <p className="text-sm font-medium text-primary mb-1">Save your recovery codes</p>
      <p className="text-xs text-muted mb-2">
        Each can be used once if you lose access to your authenticator. They will not be shown again.
      </p>
      <div className="grid grid-cols-2 gap-1 font-mono text-xs text-primary select-all">
        {codes.map((c) => (
          <span key={c}>{c}</span>
        ))}
      </div>
    </div>
  );
}

export function TwoFactorSettings() {
  const [loading, setLoading] = useState(true);
  const [enabled, setEnabled] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // enrollment
  const [setup, setSetup] = useState<{ secret: string; otpauth_uri: string } | null>(null);
  const [enrollCode, setEnrollCode] = useState("");
  const [recoveryCodes, setRecoveryCodes] = useState<string[] | null>(null);

  // disable
  const [disableCode, setDisableCode] = useState("");

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    api
      .twofaStatus()
      .then((s) => {
        if (!cancelled) setEnabled(s.enabled);
      })
      .catch((e) => {
        if (!cancelled) setErr(String(e));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const startSetup = () => {
    setErr(null);
    setBusy(true);
    setRecoveryCodes(null);
    api
      .twofaSetup()
      .then((s) => setSetup(s))
      .catch((e) => setErr(String(e)))
      .finally(() => setBusy(false));
  };

  const enable = () => {
    setErr(null);
    setBusy(true);
    api
      .twofaEnable(enrollCode.trim())
      .then((r) => {
        setEnabled(true);
        setSetup(null);
        setEnrollCode("");
        setRecoveryCodes(r.recovery_codes);
      })
      .catch((e) => setErr(String(e)))
      .finally(() => setBusy(false));
  };

  const disable = () => {
    setErr(null);
    setBusy(true);
    api
      .twofaDisable(disableCode.trim())
      .then(() => {
        setEnabled(false);
        setDisableCode("");
        setRecoveryCodes(null);
      })
      .catch((e) => setErr(String(e)))
      .finally(() => setBusy(false));
  };

  return (
    <div>
      <h2 className="text-sm font-semibold text-primary mb-1">Two-factor authentication</h2>
      <p className="text-sm text-muted mb-3">
        Protect <strong>your</strong> dashboard sign-in with a time-based code from an authenticator
        app (Google Authenticator, Authy, 1Password, …). Optional and per-account.
      </p>

      {loading ? (
        <p className="text-sm text-muted">Loading…</p>
      ) : enabled ? (
        <div className="flex flex-col gap-3 max-w-md">
          <p className="text-sm text-primary">
            Status: <span className="font-medium text-ok">Enabled</span>
          </p>
          {recoveryCodes && <RecoveryCodes codes={recoveryCodes} />}
          <label className="flex flex-col gap-1">
            <span className="text-sm font-medium text-primary">Disable two-factor auth</span>
            <span className="text-xs text-muted">
              Enter a current authenticator code (or a recovery code) to turn it off.
            </span>
            <input
              className={RETENTION_INPUT_CLASS}
              value={disableCode}
              onChange={(e) => setDisableCode(e.target.value)}
              placeholder="123456"
              disabled={busy}
            />
          </label>
          <div>
            <button
              type="button"
              onClick={disable}
              disabled={busy || !disableCode.trim()}
              className="px-4 py-2 rounded-md text-sm font-medium border border-border text-muted hover:text-primary hover:bg-border/30 disabled:opacity-50"
            >
              {busy ? "Working…" : "Disable 2FA"}
            </button>
          </div>
        </div>
      ) : setup ? (
        <div className="flex flex-col gap-3 max-w-md">
          <p className="text-sm text-muted">
            1. Add this secret key to your authenticator app (or open the link on a device with the
            app installed):
          </p>
          <code className="text-xs break-all rounded bg-border/30 px-2 py-1 text-primary select-all">
            {setup.secret}
          </code>
          <a href={setup.otpauth_uri} className="text-xs text-accent underline break-all">
            {setup.otpauth_uri}
          </a>
          <label className="flex flex-col gap-1">
            <span className="text-sm font-medium text-primary">2. Enter the 6-digit code to confirm</span>
            <input
              className={RETENTION_INPUT_CLASS}
              value={enrollCode}
              onChange={(e) => setEnrollCode(e.target.value)}
              placeholder="123456"
              disabled={busy}
              autoFocus
            />
          </label>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={enable}
              disabled={busy || enrollCode.trim().length < 6}
              className="px-4 py-2 rounded-md text-sm font-medium border border-accent bg-accent/10 text-primary hover:bg-accent/20 disabled:opacity-50"
            >
              {busy ? "Verifying…" : "Enable 2FA"}
            </button>
            <button
              type="button"
              onClick={() => setSetup(null)}
              disabled={busy}
              className="px-4 py-2 rounded-md text-sm font-medium border border-border text-muted hover:text-primary hover:bg-border/30 disabled:opacity-50"
            >
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <div className="flex flex-col gap-3 max-w-md">
          <p className="text-sm text-primary">
            Status: <span className="font-medium">Not enabled</span>
          </p>
          {recoveryCodes && <RecoveryCodes codes={recoveryCodes} />}
          <div>
            <button
              type="button"
              onClick={startSetup}
              disabled={busy}
              className="px-4 py-2 rounded-md text-sm font-medium border border-accent bg-accent/10 text-primary hover:bg-accent/20 disabled:opacity-50"
            >
              {busy ? "…" : "Set up 2FA"}
            </button>
          </div>
        </div>
      )}

      {err && <p className="text-sm text-danger mt-2">{err}</p>}
    </div>
  );
}
