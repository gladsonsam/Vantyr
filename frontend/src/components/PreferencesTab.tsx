import { useEffect, useMemo, useState } from "react";
import type { ThemePreference } from "../lib/preferences";
import {
  saveNetworkIncludeIpv6,
  saveActivityCorrectedKeysDefault,
} from "../lib/preferences";
import { cn } from "../lib/utils";
import type { RetentionPolicy } from "../lib/types";
import { api } from "../lib/api";
import { Loader2 } from "lucide-react";
import {
  daysToField,
  fieldToDays,
  fmtRetentionBrief,
  parseRetentionField,
  RETENTION_INPUT_CLASS,
} from "../lib/retentionForm";
import { TwoFactorSettings } from "./settings/TwoFactorSettings";

interface Props {
  themePref: ThemePreference;
  onThemePrefChange: (t: ThemePreference) => void;
  networkIncludeIpv6: boolean;
  onNetworkIncludeIpv6Change: (v: boolean) => void;
  activityCorrectedKeysDefault: boolean;
  onActivityCorrectedKeysDefaultChange: (v: boolean) => void;
}

export function PreferencesTab({
  themePref,
  onThemePrefChange,
  networkIncludeIpv6,
  onNetworkIncludeIpv6Change,
  activityCorrectedKeysDefault,
  onActivityCorrectedKeysDefaultChange,
}: Props) {
  const [gKey, setGKey] = useState("");
  const [gWin, setGWin] = useState("");
  const [gUrl, setGUrl] = useState("");
  const [prefsLoad, setPrefsLoad] = useState(true);
  const [gSave, setGSave] = useState(false);
  const [gErr, setGErr] = useState<string | null>(null);
  const [gOk, setGOk] = useState<string | null>(null);

  const [localUiPwd, setLocalUiPwd] = useState("");
  const [localUiPwd2, setLocalUiPwd2] = useState("");
  const [localUiPasswordSet, setLocalUiPasswordSet] = useState(false);
  const [localUiSave, setLocalUiSave] = useState(false);
  const [localUiErr, setLocalUiErr] = useState<string | null>(null);
  const [localUiOk, setLocalUiOk] = useState<string | null>(null);

  const parsedKey = useMemo(() => parseRetentionField(gKey, "global"), [gKey]);
  const parsedWin = useMemo(() => parseRetentionField(gWin, "global"), [gWin]);
  const parsedUrl = useMemo(() => parseRetentionField(gUrl, "global"), [gUrl]);
  const hasRetentionErrors = !!parsedKey.error || !!parsedWin.error || !!parsedUrl.error;

  useEffect(() => {
    let cancelled = false;
    setPrefsLoad(true);
    setGErr(null);
    Promise.all([api.retentionGlobalGet(), api.localUiPasswordGlobalGet()])
      .then(([p, ui]) => {
        if (cancelled) return;
        setGKey(daysToField(p.keylog_days, "global"));
        setGWin(daysToField(p.window_days, "global"));
        setGUrl(daysToField(p.url_days, "global"));
        setLocalUiPasswordSet(ui.password_set);
        setLocalUiPwd("");
        setLocalUiPwd2("");
      })
      .catch((e) => {
        if (!cancelled) setGErr(String(e));
      })
      .finally(() => {
        if (!cancelled) setPrefsLoad(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const saveGlobal = () => {
    setGErr(null);
    setGOk(null);
    let body: RetentionPolicy;
    try {
      body = {
        keylog_days: fieldToDays(gKey, "global"),
        window_days: fieldToDays(gWin, "global"),
        url_days: fieldToDays(gUrl, "global"),
      };
    } catch (e) {
      setGErr(e instanceof Error ? e.message : String(e));
      return;
    }
    setGSave(true);
    api
      .retentionGlobalPut(body)
      .then((p) => {
        setGKey(daysToField(p.keylog_days, "global"));
        setGWin(daysToField(p.window_days, "global"));
        setGUrl(daysToField(p.url_days, "global"));
        setGOk("Saved.");
      })
      .catch((e) => setGErr(String(e)))
      .finally(() => setGSave(false));
  };

  const saveLocalUiPassword = () => {
    setLocalUiErr(null);
    setLocalUiOk(null);
    const a = localUiPwd.trim();
    const b = localUiPwd2.trim();
    if (a !== b) {
      setLocalUiErr("Passwords do not match.");
      return;
    }
    if (a.length > 0 && a.length < 4) {
      setLocalUiErr("Use at least 4 characters, or leave both fields empty to remove the password.");
      return;
    }
    setLocalUiSave(true);
    api
      .localUiPasswordGlobalPut({ password: a.length ? a : null })
      .then((ui) => {
        setLocalUiPasswordSet(ui.password_set);
        setLocalUiPwd("");
        setLocalUiPwd2("");
        setLocalUiOk(
          ui.password_set
            ? "Saved. Connected agents will receive the new lock password."
            : "Saved. Agents will use an open settings window (no password) unless overridden per PC.",
        );
      })
      .catch((e) => setLocalUiErr(String(e)))
      .finally(() => setLocalUiSave(false));
  };

  const clearLocalUiPassword = () => {
    setLocalUiErr(null);
    setLocalUiOk(null);
    setLocalUiSave(true);
    api
      .localUiPasswordGlobalPut({ password: null })
      .then((ui) => {
        setLocalUiPasswordSet(ui.password_set);
        setLocalUiPwd("");
        setLocalUiPwd2("");
        setLocalUiOk(
          "Removed. Connected agents will unlock the local settings window without a password (unless overridden per PC).",
        );
      })
      .catch((e) => setLocalUiErr(String(e)))
      .finally(() => setLocalUiSave(false));
  };

  return (
    <div className="max-w-2xl flex flex-col gap-8">
      <div>
        <h2 className="text-sm font-semibold text-primary mb-1">Appearance</h2>
        <p className="text-xs text-muted mb-3">
          Theme is saved in this browser only.
        </p>
        <div className="flex flex-wrap gap-2">
          {(
            [
              { value: "light" as const, label: "Light" },
              { value: "dark" as const, label: "Dark" },
              { value: "system" as const, label: "Match system" },
            ] as const
          ).map(({ value, label }) => (
            <button
              key={value}
              type="button"
              onClick={() => onThemePrefChange(value)}
              className={cn(
                "px-3 py-1.5 rounded-md text-xs font-medium border transition-colors",
                themePref === value
                  ? "border-accent text-primary bg-accent/10"
                  : "border-border text-muted hover:text-primary hover:bg-border/30",
              )}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      <TwoFactorSettings />

      {prefsLoad ? (
        <div className="flex items-center gap-2 text-sm text-muted py-6">
          <Loader2 size={14} className="animate-spin" />
          Loading preferences…
        </div>
      ) : (
        <div className="flex flex-col gap-8">
      <div>
        <h2 className="text-sm font-semibold text-primary mb-1">
          Default data retention
        </h2>
        <p className="text-sm text-muted mb-2">
          How long to keep keylogs, window history, and URLs for <strong>all</strong>{" "}
          computers by default. Use <strong>0</strong> or leave a box empty for unlimited
          retention (no automatic delete).
        </p>
        <p className="text-xs text-muted mb-4">
          Per-computer overrides live on each agent’s <span className="text-primary font-medium">Overrides</span> tab.
        </p>

          <div className="flex flex-col gap-3 max-w-md">
            <label className="flex flex-col gap-1">
              <span className="text-sm font-medium text-primary">Keylogs</span>
              <input
                type="number"
                min={0}
                max={36500}
                step={1}
                className={RETENTION_INPUT_CLASS}
                value={gKey}
                onChange={(e) => setGKey(e.target.value)}
                placeholder="0 or blank = unlimited"
                disabled={gSave}
              />
              {parsedKey.error ? (
                <span className="text-xs text-danger">{parsedKey.error}</span>
              ) : (
                <span className="text-xs text-muted">
                  Effective: {fmtRetentionBrief(parsedKey.value)}
                </span>
              )}
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-sm font-medium text-primary">
                Windows &amp; activity
              </span>
              <span className="text-xs text-muted">
                Includes focus changes and AFK / active events
              </span>
              <input
                type="number"
                min={0}
                max={36500}
                step={1}
                className={RETENTION_INPUT_CLASS}
                value={gWin}
                onChange={(e) => setGWin(e.target.value)}
                placeholder="0 or blank = unlimited"
                disabled={gSave}
              />
              {parsedWin.error ? (
                <span className="text-xs text-danger">{parsedWin.error}</span>
              ) : (
                <span className="text-xs text-muted">
                  Effective: {fmtRetentionBrief(parsedWin.value)}
                </span>
              )}
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-sm font-medium text-primary">URLs</span>
              <input
                type="number"
                min={0}
                max={36500}
                step={1}
                className={RETENTION_INPUT_CLASS}
                value={gUrl}
                onChange={(e) => setGUrl(e.target.value)}
                placeholder="0 or blank = unlimited"
                disabled={gSave}
              />
              {parsedUrl.error ? (
                <span className="text-xs text-danger">{parsedUrl.error}</span>
              ) : (
                <span className="text-xs text-muted">
                  Effective: {fmtRetentionBrief(parsedUrl.value)}
                </span>
              )}
            </label>
            <div className="pt-1">
              <button
                type="button"
                onClick={saveGlobal}
                disabled={gSave || hasRetentionErrors}
                className="px-4 py-2 rounded-md text-sm font-medium border border-accent bg-accent/10 text-primary hover:bg-accent/20 disabled:opacity-50"
              >
                {gSave ? "Saving…" : "Save defaults"}
              </button>
            </div>
            {gErr ? <p className="text-sm text-danger">{gErr}</p> : null}
            {!gErr && gOk ? <p className="text-sm text-ok">{gOk}</p> : null}
          </div>
      </div>

      <div>
        <h2 className="text-sm font-semibold text-primary mb-1">
          Agent local settings password
        </h2>
        <p className="text-sm text-muted mb-2">
          Default lock for the <strong>Windows Vantyr agent’s local settings window</strong>{" "}
          (not this dashboard). When an agent connects, the server sends this password hash so
          operators can set or rotate the lock from here instead of on each machine.
        </p>
        <p className="text-xs text-muted mb-4">
          Per-computer overrides live on each agent’s <span className="text-primary font-medium">Overrides</span> tab.
        </p>

          <form
            onSubmit={(e) => {
              e.preventDefault();
              saveLocalUiPassword();
            }}
            className="flex flex-col gap-3 max-w-md"
          >
            <p className="text-sm text-primary">
              Status:{" "}
              <span className="font-medium">
                {localUiPasswordSet ? "Password is set (agents use this lock)" : "No password (open)"}
              </span>
            </p>
            <label className="flex flex-col gap-1">
              <span className="text-sm font-medium text-primary">New password</span>
              <span className="text-xs text-muted">
                Leave both fields empty and click “Remove password” to open the local settings without a lock.
              </span>
              <input
                type="password"
                autoComplete="new-password"
                className={RETENTION_INPUT_CLASS}
                value={localUiPwd}
                onChange={(e) => setLocalUiPwd(e.target.value)}
                disabled={localUiSave}
                placeholder="••••••••"
              />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-sm font-medium text-primary">Confirm</span>
              <input
                type="password"
                autoComplete="new-password"
                className={RETENTION_INPUT_CLASS}
                value={localUiPwd2}
                onChange={(e) => setLocalUiPwd2(e.target.value)}
                disabled={localUiSave}
                placeholder="••••••••"
              />
            </label>
            <div className="flex flex-wrap gap-2 pt-1">
              <button
                type="submit"
                disabled={localUiSave}
                className="px-4 py-2 rounded-md text-sm font-medium border border-accent bg-accent/10 text-primary hover:bg-accent/20 disabled:opacity-50"
              >
                {localUiSave ? "Saving…" : "Save password"}
              </button>
              <button
                type="button"
                onClick={clearLocalUiPassword}
                disabled={localUiSave}
                className="px-4 py-2 rounded-md text-sm font-medium border border-border text-muted hover:text-primary hover:bg-border/30 disabled:opacity-50"
              >
                Remove password
              </button>
            </div>
            {localUiErr ? <p className="text-sm text-danger">{localUiErr}</p> : null}
            {!localUiErr && localUiOk ? <p className="text-sm text-ok">{localUiOk}</p> : null}
          </form>
      </div>
        </div>
      )}

      <div>
        <h2 className="text-sm font-semibold text-primary mb-1">Agent details</h2>
        <p className="text-xs text-muted mb-3">
          What to show in the Specs tab for each machine.
        </p>
        <label className="flex items-start gap-3 cursor-pointer group">
          <input
            type="checkbox"
            className="mt-0.5 rounded border-border"
            checked={networkIncludeIpv6}
            onChange={(e) => {
              const v = e.target.checked;
              saveNetworkIncludeIpv6(v);
              onNetworkIncludeIpv6Change(v);
            }}
          />
          <span>
            <span className="text-sm text-primary group-hover:underline">
              Show IPv6 addresses
            </span>
            <span className="block text-xs text-muted mt-0.5">
              Off by default — IPv6 lists are often long. Useful if you use IPv6 on
              your network.
            </span>
          </span>
        </label>
      </div>

      <div>
        <h2 className="text-sm font-semibold text-primary mb-1">Activity tab</h2>
        <p className="text-xs text-muted mb-3">
          Default for the “Corrected / Raw” keystroke toggle.
        </p>
        <label className="flex items-start gap-3 cursor-pointer group">
          <input
            type="checkbox"
            className="mt-0.5 rounded border-border"
            checked={activityCorrectedKeysDefault}
            onChange={(e) => {
              const v = e.target.checked;
              saveActivityCorrectedKeysDefault(v);
              onActivityCorrectedKeysDefaultChange(v);
            }}
          />
          <span>
            <span className="text-sm text-primary group-hover:underline">
              Apply keyboard corrections by default
            </span>
            <span className="block text-xs text-muted mt-0.5">
              When on, backspaces in captured keystrokes are applied so text reads
              more naturally. You can still toggle per session in the Activity tab.
            </span>
          </span>
        </label>
      </div>
    </div>
  );
}
