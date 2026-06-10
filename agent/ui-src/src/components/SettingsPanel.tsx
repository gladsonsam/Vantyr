import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Activity,
  Download,
  FolderOpen,
  KeyRound,
  Logs,
  Network,
  Power,
  RefreshCw,
  Save,
  Search,
  Shield,
} from "lucide-react";
import type {
  AgentConfig,
  DiscoveredServer,
  LogSourceDesc,
  ManualApplyUpdateResponse,
  ManualUpdateCheckResponse,
  NavId,
  StatusResponse,
  UpdateDialogState,
} from "../types";
import {
  Button,
  ConnectionStatusPill,
  Field,
  Notice,
  SelectInput,
  Spinner,
  StatCard,
  TextInput,
  Toggle,
} from "./AgentUi";
import { ClearAllLogsModal, ExitModal, UpdateModal } from "./SettingsModals";
import { invoke } from "../lib/tauri";
import { classNames, getErrorMessage } from "../lib/utils";

const NAV_ITEMS = [
  { id: "dashboard", label: "Dashboard", icon: <Activity size={16} />, description: "Connection status and agent details." },
  { id: "connection", label: "Connection", icon: <Network size={16} />, description: "Server URL, access request, and credentials." },
  { id: "security", label: "Security", icon: <Shield size={16} />, description: "Local password for this settings window." },
  { id: "logs", label: "Logs", icon: <Logs size={16} />, description: "Tracing output buffered in memory for this session." },
] satisfies Array<{ id: NavId; label: string; icon: React.ReactNode; description: string }>;

function defaultConfig(): AgentConfig {
  return {
    server_url: "",
    agent_name: "",
    agent_token: "",
    install_id: "",
    ui_password_hash: "",
    auto_update_enabled: false,
    tray_icon_enabled: true,
  };
}

export function SettingsPanel() {
  const [nav, setNav] = useState<NavId>("dashboard");
  const [config, setConfig] = useState<AgentConfig>(defaultConfig);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saveMsg, setSaveMsg] = useState<{ text: string; ok: boolean } | null>(null);
  const [status, setStatus] = useState<StatusResponse>({ status: "Disconnected" });
  const [newPw, setNewPw] = useState("");
  const [confirmPw, setConfirmPw] = useState("");
  const [updateDialog, setUpdateDialog] = useState<UpdateDialogState>(null);
  const [adoptCode, setAdoptCode] = useState("");
  const [adoptBusy, setAdoptBusy] = useState(false);
  const [adoptMsg, setAdoptMsg] = useState<{ text: string; ok: boolean } | null>(null);
  const [discovered, setDiscovered] = useState<DiscoveredServer[]>([]);
  const [scanning, setScanning] = useState(false);
  const [appVersion, setAppVersion] = useState("");
  const [logSources, setLogSources] = useState<LogSourceDesc[]>([]);
  const [logSourceId, setLogSourceId] = useState("");
  const [logText, setLogText] = useState("");
  const [logsManualRefresh, setLogsManualRefresh] = useState(false);
  const [logAutoRefresh, setLogAutoRefresh] = useState(true);
  const [logClearing, setLogClearing] = useState(false);
  const [logClearMsg, setLogClearMsg] = useState<string | null>(null);
  const [clearAllConfirmOpen, setClearAllConfirmOpen] = useState(false);
  const [exitDialogOpen, setExitDialogOpen] = useState(false);
  const [exitPw, setExitPw] = useState("");
  const [exitBusy, setExitBusy] = useState(false);
  const [exitError, setExitError] = useState<string | null>(null);

  const serverUrlInputRef = useRef<HTMLInputElement | null>(null);
  const saveMsgTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const logViewportRef = useRef<HTMLTextAreaElement | null>(null);
  const logStickToBottomRef = useRef(true);
  const logInitialScrollDoneRef = useRef(false);

  const activeNav = useMemo(() => NAV_ITEMS.find((item) => item.id === nav) ?? NAV_ITEMS[0], [nav]);
  const currentLogSourceId = useMemo(() => {
    if (logSources.length === 0) return logSourceId;
    if (logSources.some((source) => source.id === logSourceId)) return logSourceId;
    return logSources[0].id;
  }, [logSources, logSourceId]);
  const selectedLogSource = useMemo(
    () => logSources.find((source) => source.id === currentLogSourceId) ?? null,
    [logSources, currentLogSourceId],
  );

  useEffect(() => {
    invoke<AgentConfig>("get_config")
      .then((cfg) => setConfig(cfg))
      .catch(() => setConfig(defaultConfig()))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    if (nav !== "connection") return;
    const id = setTimeout(() => serverUrlInputRef.current?.focus(), 0);
    return () => clearTimeout(id);
  }, [nav]);

  useEffect(() => {
    const poll = async () => {
      try {
        setStatus(await invoke<StatusResponse>("get_status"));
      } catch {
        setStatus({ status: "Error", message: "IPC unavailable" });
      }
    };
    poll();
    const id = setInterval(poll, 2000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    invoke<string>("get_app_version").then(setAppVersion).catch(() => setAppVersion(""));
    void invoke<LogSourceDesc[]>("list_log_sources").then(setLogSources).catch(() => setLogSources([]));
  }, []);

  const refreshLogs = useCallback(
    async (manual: boolean) => {
      if (manual) setLogsManualRefresh(true);
      try {
        setLogText(await invoke<string>("read_log_file_tail", { kind: currentLogSourceId, maxKb: 512 }));
      } catch (error: unknown) {
        setLogText(`(Could not read log: ${getErrorMessage(error)})`);
      } finally {
        if (manual) setLogsManualRefresh(false);
      }
    },
    [currentLogSourceId],
  );

  useEffect(() => {
    if (nav !== "logs") return;
    logStickToBottomRef.current = true;
    logInitialScrollDoneRef.current = false;
    void refreshLogs(false);
  }, [nav, currentLogSourceId, refreshLogs]);

  useEffect(() => {
    if (nav !== "logs" || !logAutoRefresh) return;
    const id = setInterval(() => void refreshLogs(false), 2000);
    return () => clearInterval(id);
  }, [nav, logAutoRefresh, refreshLogs]);

  useEffect(() => {
    const el = logViewportRef.current;
    if (!el) return;
    if (!logInitialScrollDoneRef.current) {
      el.scrollTop = el.scrollHeight;
      logInitialScrollDoneRef.current = true;
      return;
    }
    if (logAutoRefresh && logStickToBottomRef.current) el.scrollTop = el.scrollHeight;
  }, [logText, logAutoRefresh]);

  const handleSave = useCallback(async () => {
    if (newPw && newPw !== confirmPw) {
      setSaveMsg({ text: "Passwords don't match", ok: false });
      return;
    }
    setSaving(true);
    try {
      const payload: AgentConfig & { new_password?: string } = { ...config, ...(newPw ? { new_password: newPw } : {}) };
      await invoke("save_config", { config: payload });
      setSaveMsg({ text: "Settings saved.", ok: true });
      setNewPw("");
      setConfirmPw("");
      setConfig(await invoke<AgentConfig>("get_config"));
    } catch (error: unknown) {
      setSaveMsg({ text: `Save failed: ${getErrorMessage(error)}`, ok: false });
    } finally {
      setSaving(false);
      if (saveMsgTimer.current) clearTimeout(saveMsgTimer.current);
      saveMsgTimer.current = setTimeout(() => setSaveMsg(null), 4000);
    }
  }, [config, newPw, confirmPw]);

  const handleRemovePassword = useCallback(async () => {
    setSaving(true);
    try {
      const payload: AgentConfig & { new_password?: string } = { ...config, new_password: "" };
      await invoke("save_config", { config: payload });
      setSaveMsg({ text: "Password protection removed.", ok: true });
      setNewPw("");
      setConfirmPw("");
      setConfig(await invoke<AgentConfig>("get_config"));
    } catch (error: unknown) {
      setSaveMsg({ text: `Failed to remove password: ${getErrorMessage(error)}`, ok: false });
    } finally {
      setSaving(false);
      if (saveMsgTimer.current) clearTimeout(saveMsgTimer.current);
      saveMsgTimer.current = setTimeout(() => setSaveMsg(null), 4000);
    }
  }, [config]);

  const clearLogs = useCallback(async () => {
    setLogClearing(true);
    setLogClearMsg(null);
    try {
      await invoke("clear_log_file", { kind: currentLogSourceId });
      setLogText("");
      setLogClearMsg("Cleared.");
    } catch (error: unknown) {
      setLogClearMsg(getErrorMessage(error));
    } finally {
      setLogClearing(false);
      setTimeout(() => setLogClearMsg(null), 3000);
    }
  }, [currentLogSourceId]);

  const clearAllLogs = useCallback(async () => {
    if (logSources.length === 0) return;
    setLogClearing(true);
    setLogClearMsg(null);
    try {
      await Promise.allSettled(logSources.map((source) => invoke("clear_log_file", { kind: source.id })));
      void refreshLogs(false);
      setLogClearMsg("All logs cleared.");
    } finally {
      setLogClearing(false);
      setTimeout(() => setLogClearMsg(null), 3000);
    }
  }, [logSources, refreshLogs]);

  const openUpdateCheck = useCallback(async () => {
    setUpdateDialog({ phase: "checking" });
    try {
      const result = await invoke<ManualUpdateCheckResponse>("check_manual_update");
      setUpdateDialog(
        result.update_available && result.published_version
          ? { phase: "available", publishedVersion: result.published_version }
          : { phase: "uptodate" },
      );
    } catch (error: unknown) {
      setUpdateDialog({ phase: "error", message: getErrorMessage(error) });
    }
  }, []);

  const applyManualUpdate = useCallback(async () => {
    setUpdateDialog({ phase: "installing" });
    try {
      const result = await invoke<ManualApplyUpdateResponse>("apply_manual_update");
      if (result.outcome === "up_to_date") setUpdateDialog({ phase: "uptodate" });
    } catch (error: unknown) {
      setUpdateDialog({ phase: "error", message: getErrorMessage(error) });
    }
  }, []);

  const scanLanServers = useCallback(async () => {
    setScanning(true);
    setAdoptMsg(null);
    try {
      const list = await invoke<DiscoveredServer[]>("discover_vantyr_mdns_servers", { opts: { timeoutMs: 4000 } });
      setDiscovered(list);
      if (list.length === 1) {
        setConfig((current) => ({ ...current, server_url: list[0].wssUrl }));
        setAdoptMsg({ text: "Filled server URL from LAN discovery.", ok: true });
      } else if (list.length === 0) {
        setAdoptMsg({ text: "No servers found on LAN. Use your server wss:// URL.", ok: false });
      } else {
        setAdoptMsg({ text: `Found ${list.length} servers. Pick one in the list.`, ok: true });
      }
    } catch (error: unknown) {
      setAdoptMsg({ text: `Discovery failed: ${getErrorMessage(error)}`, ok: false });
    } finally {
      setScanning(false);
    }
  }, []);

  const adoptWithCode = useCallback(async () => {
    const url = config.server_url.trim();
    if (!url.startsWith("wss://")) {
      setAdoptMsg({ text: "Server URL must start with wss://", ok: false });
      return;
    }
    setAdoptBusy(true);
    setAdoptMsg(null);
    try {
      const agentName = config.agent_name.trim();
      await invoke("adopt_with_enrollment_code", {
        payload: { serverUrl: url, enrollmentCode: adoptCode.trim(), agentName: agentName.length > 0 ? agentName : null },
      });
      setAdoptCode("");
      setConfig(await invoke<AgentConfig>("get_config"));
      setAdoptMsg({ text: "Request approved. Per-device token saved.", ok: true });
    } catch (error: unknown) {
      setAdoptMsg({ text: getErrorMessage(error), ok: false });
    } finally {
      setAdoptBusy(false);
    }
  }, [config.server_url, config.agent_name, adoptCode]);

  const handleExit = useCallback(() => {
    void (async () => {
      try {
        if (await invoke<boolean>("has_ui_password")) {
          setExitDialogOpen(true);
          return;
        }
        await invoke("exit_agent");
      } catch {
        // Ignore exit failures in the UI shell.
      }
    })();
  }, []);

  const confirmExit = useCallback(async () => {
    setExitBusy(true);
    setExitError(null);
    try {
      await invoke("verify_ui_password", { password: exitPw });
      await invoke("exit_agent");
    } catch (error: unknown) {
      setExitError(getErrorMessage(error) || "Authentication required");
      setExitPw("");
    } finally {
      setExitBusy(false);
    }
  }, [exitPw]);

  if (loading) {
    return (
      <main className="agent-loading">
        <Spinner size={26} />
      </main>
    );
  }

  return (
    <main className="agent-shell animate-fade-in">
      <header className="agent-topbar">
        <div className="agent-brand">
          <img src="/favicon.svg" alt="" />
          <div>
            <h1>Vantyr Agent</h1>
            <p>{appVersion ? `v${appVersion}` : "Local settings"}</p>
          </div>
        </div>
        <Button variant="ghost" icon={<Download size={16} />} onClick={() => void openUpdateCheck()}>
          Updates
        </Button>
      </header>

      <div className="agent-body">
        <nav className="agent-sidebar" aria-label="Settings sections">
          {NAV_ITEMS.map((item) => (
            <button
              key={item.id}
              type="button"
              className={classNames("agent-nav-item", nav === item.id && "agent-nav-item--active")}
              onClick={() => setNav(item.id)}
            >
              {item.icon}
              <span>{item.label}</span>
            </button>
          ))}
        </nav>

        <section className={classNames("agent-content", nav === "logs" && "agent-content--logs")}>
          <div className="agent-page-heading">
            <div>
              <h2>{activeNav.label}</h2>
              <p>{activeNav.description}</p>
            </div>
          </div>

          {nav === "dashboard" && (
            <div className="agent-grid agent-grid--stats">
              <StatCard label="Connection" value={<ConnectionStatusPill {...status} />} />
              <StatCard label="Agent name" value={config.agent_name.trim() || "-"} />
              <StatCard label="Server URL" value={config.server_url.trim() || "-"} />
              <StatCard
                label="Updates"
                value={
                  <Button icon={<RefreshCw size={16} />} onClick={() => void openUpdateCheck()}>
                    Check for updates
                  </Button>
                }
              />
            </div>
          )}

          {nav === "connection" && (
            <div className="agent-grid">
              <section className="agent-panel">
                <div className="agent-panel__header">
                  <h3>Enrollment</h3>
                  <p>Find a server on the network, then request access. A six-digit dashboard code is optional.</p>
                </div>
                <div className="agent-stack">
                  <Field label="Server URL" description="WebSocket URL from the server.">
                    <TextInput
                      ref={serverUrlInputRef}
                      value={config.server_url}
                      onChange={(event) => setConfig((current) => ({ ...current, server_url: event.currentTarget.value }))}
                      placeholder="wss://host/ws/agent"
                    />
                  </Field>
                  {discovered.length > 1 && (
                    <Field label="LAN discovery">
                      <SelectInput
                        value=""
                        onChange={(event) => {
                          if (event.currentTarget.value) {
                            setConfig((current) => ({ ...current, server_url: event.currentTarget.value }));
                          }
                        }}
                      >
                        <option value="">Select discovered server</option>
                        {discovered.map((server) => (
                          <option key={server.wssUrl} value={server.wssUrl}>
                            {(server.instanceName?.trim() || server.wssUrl) +
                              (server.instanceName?.trim() ? ` - ${server.wssUrl}` : "")}
                          </option>
                        ))}
                      </SelectInput>
                    </Field>
                  )}
                  <Button icon={<Search size={16} />} loading={scanning} onClick={() => void scanLanServers()}>
                    Find on network
                  </Button>
                  <Field label="Pairing code" description="Use only when the server operator gives you a six-digit code.">
                    <TextInput
                      value={adoptCode}
                      onChange={(event) => setAdoptCode(event.currentTarget.value)}
                      placeholder="Optional"
                      inputMode="numeric"
                      autoComplete="one-time-code"
                    />
                  </Field>
                  <Button variant="primary" icon={<KeyRound size={16} />} loading={adoptBusy} onClick={() => void adoptWithCode()}>
                    Request access
                  </Button>
                  {adoptMsg && (
                    <Notice tone={adoptMsg.ok ? "success" : "error"} title={adoptMsg.ok ? "Done" : "Notice"}>
                      {adoptMsg.text}
                    </Notice>
                  )}
                </div>
              </section>

              <section className="agent-panel">
                <div className="agent-panel__header">
                  <h3>Credentials</h3>
                  <p>These values are saved locally and used by the background agent.</p>
                </div>
                <div className="agent-stack">
                  <Field label="Agent name">
                    <TextInput
                      value={config.agent_name}
                      onChange={(event) => setConfig((current) => ({ ...current, agent_name: event.currentTarget.value }))}
                      placeholder="My-PC"
                    />
                  </Field>
                  <Field label="Agent token" description="Per-device token issued after approval.">
                    <TextInput
                      value={config.agent_token}
                      onChange={(event) => setConfig((current) => ({ ...current, agent_token: event.currentTarget.value }))}
                      type="password"
                      placeholder="Issued by approval"
                      autoComplete="new-password"
                    />
                  </Field>
                  <Toggle checked={config.auto_update_enabled} onChange={(checked) => setConfig((c) => ({ ...c, auto_update_enabled: checked }))}>
                    Auto-update agent
                  </Toggle>
                  <Toggle checked={config.tray_icon_enabled} onChange={(checked) => setConfig((c) => ({ ...c, tray_icon_enabled: checked }))}>
                    Show tray icon
                  </Toggle>
                </div>
              </section>
            </div>
          )}

          {nav === "security" && (
            <section className="agent-panel agent-panel--narrow">
              <div className="agent-panel__header">
                <h3>UI access password</h3>
                <p>Required when reopening settings after hide. Leave new fields blank to keep the current password.</p>
              </div>
              <div className="agent-stack">
                <Field label="New password">
                  <TextInput value={newPw} onChange={(event) => setNewPw(event.currentTarget.value)} type="password" />
                </Field>
                <Field label="Confirm password">
                  <TextInput value={confirmPw} onChange={(event) => setConfirmPw(event.currentTarget.value)} type="password" />
                </Field>
                {config.ui_password_hash && (
                  <div style={{ marginTop: 8, display: "flex", justifyContent: "flex-start" }}>
                    <Button variant="danger" onClick={() => void handleRemovePassword()} disabled={saving}>
                      Remove password protection
                    </Button>
                  </div>
                )}
              </div>
            </section>
          )}

          {nav === "logs" && (
            <section className="agent-logs">
              <div className="agent-panel agent-logs__controls">
                <div className="agent-panel__header">
                  <h3>Agent logs</h3>
                  <p>Last ~512 KiB. Logs are in %ProgramData%\Vantyr.</p>
                </div>
                <div className="agent-toolbar">
                  <Field label="Log file">
                    <SelectInput value={currentLogSourceId} onChange={(event) => setLogSourceId(event.currentTarget.value)}>
                      {logSources.length === 0 && <option value="">No log sources</option>}
                      {logSources.map((source) => (
                        <option key={source.id} value={source.id}>
                          {source.label}
                        </option>
                      ))}
                    </SelectInput>
                  </Field>
                  {selectedLogSource && <span className="agent-log-path">{selectedLogSource.path}</span>}
                  <Toggle checked={logAutoRefresh} onChange={setLogAutoRefresh}>
                    Auto-refresh
                  </Toggle>
                  <Button icon={<RefreshCw size={16} />} loading={logsManualRefresh} onClick={() => void refreshLogs(true)}>
                    Refresh
                  </Button>
                  <Button loading={logClearing} onClick={() => void clearLogs()}>
                    Clear
                  </Button>
                  <Button disabled={logClearing || logSources.length === 0} onClick={() => setClearAllConfirmOpen(true)}>
                    Clear all
                  </Button>
                  <Button icon={<FolderOpen size={16} />} onClick={() => void invoke("open_log_location", { kind: currentLogSourceId }).catch(() => {})}>
                    Open location
                  </Button>
                  {logClearMsg && <span className="agent-inline-message">{logClearMsg}</span>}
                </div>
              </div>
              <textarea
                ref={logViewportRef}
                className="vantyr-agent-log-textarea"
                aria-label="Agent log output"
                value={logText || "Loading..."}
                readOnly
                spellCheck={false}
                wrap="off"
                onScroll={() => {
                  const el = logViewportRef.current;
                  if (!el) return;
                  logStickToBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight <= 8;
                }}
              />
            </section>
          )}
        </section>
      </div>

      <footer className="agent-footer">
        <Button variant="primary" icon={<Save size={16} />} loading={saving} onClick={() => void handleSave()}>
          Save
        </Button>
        <Button variant="ghost" onClick={() => void invoke("hide_window").catch(() => {})}>
          Hide
        </Button>
        {saveMsg && (
          <span className={classNames("agent-save-message", saveMsg.ok ? "agent-save-message--ok" : "agent-save-message--error")}>
            {saveMsg.text}
          </span>
        )}
        <span className="agent-footer__hint">
          You can open this window anytime with <span className="vantyr-kbd">Ctrl+Shift+F12</span>.
        </span>
        <Button variant="secondary" icon={<Power size={16} />} onClick={handleExit}>
          Exit agent
        </Button>
      </footer>

      <ExitModal
        open={exitDialogOpen}
        busy={exitBusy}
        error={exitError}
        password={exitPw}
        onPassword={setExitPw}
        onClose={() => {
          setExitDialogOpen(false);
          setExitPw("");
          setExitError(null);
        }}
        onConfirm={() => void confirmExit()}
      />
      <ClearAllLogsModal
        open={clearAllConfirmOpen}
        busy={logClearing}
        sources={logSources}
        onClose={() => setClearAllConfirmOpen(false)}
        onConfirm={() => {
          setClearAllConfirmOpen(false);
          void clearAllLogs();
        }}
      />
      <UpdateModal
        dialog={updateDialog}
        onClose={() => setUpdateDialog((dialog) => (dialog?.phase === "installing" ? dialog : null))}
        onApply={() => void applyManualUpdate()}
      />
    </main>
  );
}
