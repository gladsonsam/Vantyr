import { useEffect, useRef, useState } from "react";
import { api, isApiError } from "@/api";
import { isDemoMode } from "@/demo/mode";
import type { DeviceModuleStatus } from "@/api/types";

import { CLIPBOARD_TIMEOUT_MS, clipboardTextFits } from "@/features/remote/lib/remoteClipboard";
import { onSessionExpired } from "@/api/sessionExpiry";
import { useWsBus } from "@/app/providers/useWsEvent";
import type { WsEvent } from "@/api/types";

function authorized(status: DeviceModuleStatus): boolean {
  return status.online && status.authorization_current !== false && Boolean(status.state?.modules.some(module => module.module === "clipboard" && module.available && module.enabled && !module.authorization_required));
}
/** Never display arbitrary transport errors: clipboard providers may echo content. */
function operationError(error: unknown): string {
  if (isApiError(error)) {
    if (error.status === 413) return "Text exceeds 64 KiB.";
    if (error.status === 403 || error.status === 409) return "Access denied or control ended.";
    if (error.status === 501 || error.status === 503) return "Device clipboard unavailable.";
  }
  return "Clipboard request failed.";
}

/** Mounted only for one active lease. Text lives in component memory only. */
interface ClipboardPanelProps { agentId: string; controlToken: string; supported: boolean }
export function RemoteClipboardPanel(props: ClipboardPanelProps) {
  return <ClipboardContent key={`${props.agentId}:${props.controlToken}:${props.supported}`} {...props} />;
}
function ClipboardContent({ agentId, controlToken, supported }: ClipboardPanelProps) {
  const wsBus = useWsBus();
  const [draft, setDraft] = useState("");
  const [received, setReceived] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const alive = useRef(false);
  const generation = useRef(0);
  const operation = useRef<AbortController | null>(null);
  const owner = useRef<string | null>(null);
  const allowed = useRef(false);
  const composing = useRef(false);
  const [isComposing, setIsComposing] = useState(false);
  const resultRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    alive.current = true;
    const abortOperation = () => { ++generation.current; operation.current?.abort(); operation.current = null; };
    const invalidate = () => {
      abortOperation();
      allowed.current = false; owner.current = null; composing.current = false;
      setReady(false); setBusy(null); setDraft(""); setReceived(null); setMessage(""); setError(""); setIsComposing(false);
    };
    let verifying = false;
    let verificationTimer: number | null = null;
    const verify = async () => {
      if (!supported || !alive.current || verifying) return;
      verifying = true;
      const request = generation.current;
      verificationTimer = window.setTimeout(() => {
        if (alive.current && request === generation.current) { invalidate(); setError("Permission verification timed out. Reopen to retry."); }
      }, CLIPBOARD_TIMEOUT_MS);
      try {
        const [user, status] = await Promise.all([api.me(), api.agentModules(agentId)]);
        if (!alive.current || request !== generation.current) return;
        if (owner.current !== null && owner.current !== user.id) { invalidate(); return; }
        if (!user.id || !["operator", "admin"].includes(user.role) || !authorized(status)) { invalidate(); setMessage("Authorize the Clipboard text module on the device."); return; }
        owner.current = user.id; allowed.current = true; setReady(true);
      } catch {
        if (alive.current && request === generation.current) { invalidate(); setError("Couldn't verify permission. Reopen to retry."); }
      } finally {
        if (verificationTimer !== null) window.clearTimeout(verificationTimer);
        verificationTimer = null; verifying = false;
      }
    };
    const hidden = () => { if (document.hidden) invalidate(); };
    const storage = (event: StorageEvent) => { if (event.key === null || event.key === "vantyr-server-settings") invalidate(); };
    const serverEvent = (event: WsEvent) => {
      if (event.event === "command_rejected" && event.agent_id === agentId && event.module === "clipboard") invalidate();
    };
    void verify();
    const timer = window.setInterval(() => { if (!document.hidden) void verify(); }, 5000);
    window.addEventListener("focus", verify); window.addEventListener("blur", invalidate);
    window.addEventListener("storage", storage); const unsubscribeExpiry = onSessionExpired(invalidate);
    const unsubscribeWs = wsBus.subscribe(serverEvent); document.addEventListener("visibilitychange", hidden);
    return () => {
      alive.current = false; abortOperation(); allowed.current = false;
      window.clearInterval(timer); if (verificationTimer !== null) window.clearTimeout(verificationTimer); window.removeEventListener("focus", verify); window.removeEventListener("blur", invalidate);
      window.removeEventListener("storage", storage); unsubscribeExpiry();
      unsubscribeWs(); document.removeEventListener("visibilitychange", hidden);
    };
  }, [agentId, controlToken, supported, wsBus]);

  const run = async (label: string, task: (signal: AbortSignal, current: () => boolean) => Promise<void>) => {
    if (!allowed.current || operation.current || document.hidden) return;
    const controller = new AbortController(), request = ++generation.current;
    operation.current = controller; setBusy(label); setMessage(""); setError("");
    const current = () => alive.current && allowed.current && generation.current === request && !controller.signal.aborted;
    const timer = window.setTimeout(() => {
      if (!current()) return;
      controller.abort(); ++generation.current; operation.current = null; setBusy(null);
      setError("Request timed out. Check the device before retrying.");
    }, CLIPBOARD_TIMEOUT_MS);
    controller.signal.addEventListener("abort", () => window.clearTimeout(timer), { once: true });
    try { await task(controller.signal, current); }
    catch (failure) { if (current()) setError(operationError(failure)); }
    finally {
      window.clearTimeout(timer);
      if (current()) { operation.current = null; setBusy(null); }
    }
  };
  const verifyOperation = async (current: () => boolean) => {
    const [user, status] = await Promise.all([api.me(), api.agentModules(agentId)]);
    if (!current()) return false;
    if (user.id !== owner.current || !["operator", "admin"].includes(user.role) || !authorized(status)) {
      allowed.current = false; ++generation.current; operation.current?.abort(); operation.current = null;
      setDraft(""); setReceived(null); setReady(false); setBusy(null); setError("Permission changed. Take control again.");
      return false;
    }
    return true;
  };
  const oversized = () => setError("Text exceeds 64 KiB.");
  const loadBrowser = () => void run("Reading…", async (_signal, current) => {
    try {
      if (!navigator.clipboard?.readText) throw new Error("Unavailable");
      const text = await navigator.clipboard.readText();
      if (!current() || !await verifyOperation(current)) return;
      if (!clipboardTextFits(text)) { oversized(); return; }
      setDraft(text); setMessage("Loaded. Send it to the device.");
    } catch {
      if (current()) setMessage("Browser clipboard denied. Paste or type text instead.");
    }
  });
  const send = () => {
    if (composing.current) return;
    if (!clipboardTextFits(draft)) { oversized(); return; }
    void run("Sending…", async (signal, current) => {
      if (!await verifyOperation(current)) return;
      const reply = await api.agentClipboard(agentId, { action: "write", control_token: controlToken, text: draft }, signal);
      if (current() && await verifyOperation(current)) {
        if (reply.ok !== true) throw new Error("Invalid reply");
        setMessage(isDemoMode ? "Sent to simulated clipboard." : "Sent to device clipboard.");
      }
    });
  };
  const fetchDevice = () => {
    setReceived(null);
    void run("Fetching…", async (signal, current) => {
      if (!await verifyOperation(current)) return;
      const reply = await api.agentClipboard(agentId, { action: "read", control_token: controlToken }, signal);
      if (!current() || !await verifyOperation(current)) return;
      if (reply.ok !== true || typeof reply.text !== "string") throw new Error("Invalid reply");
      if (!clipboardTextFits(reply.text)) { oversized(); return; }
      setReceived(reply.text); setMessage("Fetched.");
    });
  };
  const copyBrowser = () => void run("Copying…", async (_signal, current) => {
    if (received === null || !await verifyOperation(current)) return;
    try {
      if (!navigator.clipboard?.writeText) throw new Error("Unavailable");
      await navigator.clipboard.writeText(received);
      if (current()) setMessage("Copied to browser.");
    } catch {
      if (current()) { setMessage("Copy denied. Select and copy manually."); resultRef.current?.focus(); resultRef.current?.select(); }
    }
  });
  const disabled = !ready || busy !== null;
  return <section className="remote-clipboard-panel" aria-label="Text clipboard">
    <p>64 KiB max. Nothing transfers automatically.</p>
    {isDemoMode && <p role="note">Demo: clipboard is simulated.</p>}
    {!supported && <p role="status">Clipboard not supported on this device.</p>}
    {supported && !ready && !message && !error && <p role="status">Verifying permission…</p>}
    <button type="button" disabled={disabled || isComposing} onClick={loadBrowser}>Paste from browser</button>
    <label>Text to send <textarea aria-label="Text to send to device clipboard" rows={3} value={draft} disabled={disabled}
      autoCapitalize="off" autoCorrect="off" spellCheck={false}
      onChange={event => { if (allowed.current) setDraft(event.target.value); }}
      onCompositionStart={() => { composing.current = true; setIsComposing(true); }}
      onCompositionEnd={() => { composing.current = false; setIsComposing(false); }} /></label>
    <button type="button" disabled={disabled || isComposing} onClick={send}>Send to device</button>
    <button type="button" disabled={disabled} onClick={fetchDevice}>Fetch from device</button>
    {received !== null && <>
      <label>Device clipboard text <textarea ref={resultRef} aria-label="Device clipboard text" readOnly rows={3} value={received} /></label>
      <button type="button" disabled={disabled} onClick={copyBrowser}>Copy to browser</button>
      <button type="button" disabled={disabled} onClick={() => { resultRef.current?.focus(); resultRef.current?.select(); }}>Select all</button>
    </>}
    {busy && <p role="status" aria-live="polite">{busy}</p>}
    {message && <p role="status" aria-live="polite">{message}</p>}
    {error && <p role="alert">{error}</p>}
  </section>;
}
