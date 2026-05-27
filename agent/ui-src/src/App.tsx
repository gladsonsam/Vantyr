/**
 * Sentinel Agent – Settings webview using Cloudscape (same stack as the server dashboard).
 */

import { useState, useEffect, useCallback, useRef, useMemo } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { applyMode, Mode } from "@cloudscape-design/global-styles";
import AppLayout from "@cloudscape-design/components/app-layout";
import TopNavigation from "@cloudscape-design/components/top-navigation";
import type { TopNavigationProps } from "@cloudscape-design/components/top-navigation";
import SideNavigation from "@cloudscape-design/components/side-navigation";
import type { SideNavigationProps } from "@cloudscape-design/components/side-navigation";
import Box from "@cloudscape-design/components/box";
import Button from "@cloudscape-design/components/button";
import SpaceBetween from "@cloudscape-design/components/space-between";
import Header from "@cloudscape-design/components/header";
import Container from "@cloudscape-design/components/container";
import ColumnLayout from "@cloudscape-design/components/column-layout";
import FormField from "@cloudscape-design/components/form-field";
import Input from "@cloudscape-design/components/input";
import Select from "@cloudscape-design/components/select";
import type { SelectProps } from "@cloudscape-design/components/select";
import Toggle from "@cloudscape-design/components/toggle";
import Modal from "@cloudscape-design/components/modal";
import StatusIndicator from "@cloudscape-design/components/status-indicator";
import Alert from "@cloudscape-design/components/alert";
import Spinner from "@cloudscape-design/components/spinner";
import KeyValuePairs from "@cloudscape-design/components/key-value-pairs";

// ── Types ─────────────────────────────────────────────────────────────────────

interface AgentConfig {
  server_url: string;
  agent_name: string;
  agent_token: string;
  install_id: string;
  ui_password_hash: string;
  auto_update_enabled: boolean;
  tray_icon_enabled: boolean;
}

type ConnectionStatus = "Connected" | "Connecting" | "Disconnected" | "Error";

interface StatusResponse {
  status: ConnectionStatus;
  message?: string;
}

interface ManualUpdateCheckResponse {
  update_available: boolean;
  published_version?: string;
  running_version: string;
}

interface ManualApplyUpdateResponse {
  outcome: string;
}

interface LogSourceDesc {
  id: string;
  label: string;
  path: string;
}

interface DiscoveredServer {
  instanceName: string;
  wssUrl: string;
}

type UpdateDialogState =
  | null
  | { phase: "checking" }
  | { phase: "uptodate" }
  | { phase: "available"; publishedVersion: string }
  | { phase: "error"; message: string }
  | { phase: "installing" };

type NavId = "dashboard" | "connection" | "security" | "logs";

/** Cloudscape + Tailwind auth shell: follow OS light/dark (prefers-color-scheme). */
function useSystemColorScheme() {
  useEffect(() => {
    const sync = () => {
      const dark = window.matchMedia("(prefers-color-scheme: dark)").matches;
      const mode = dark ? Mode.Dark : Mode.Light;
      applyMode(mode);
      document.documentElement.classList.toggle("dark", dark);
      document.documentElement.style.colorScheme = dark ? "dark" : "light";
    };

    sync();
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    mq.addEventListener("change", sync);
    return () => mq.removeEventListener("change", sync);
  }, []);
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function ConnectionStatusIndicator({ status, message }: StatusResponse) {
  const map: Record<
    ConnectionStatus,
    { type: NonNullable<React.ComponentProps<typeof StatusIndicator>["type"]>; children: string }
  > = {
    Connected: { type: "success", children: "Connected" },
    Connecting: { type: "in-progress", children: "Connecting" },
    Disconnected: { type: "stopped", children: "Disconnected" },
    Error: { type: "error", children: message ? `Error: ${message}` : "Error" },
  };
  const m = map[status];
  return (
    <StatusIndicator type={m.type} wrapText={false}>
      {m.children}
    </StatusIndicator>
  );
}

// ── Password Gate ─────────────────────────────────────────────────────────────

function PasswordGate({ onUnlock }: { onUnlock: () => void }) {
  const [pw, setPw] = useState("");
  const [error, setError] = useState(false);
  const [checking, setChecking] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!pw) return;
    setChecking(true);
    try {
      await invoke("verify_ui_password", { password: pw });
      setError(false);
      onUnlock();
    } catch {
      setError(true);
      setPw("");
    } finally {
      setChecking(false);
    }
  };

  return (
    <div className="sentinel-agent-auth-shell animate-fade-in">
      <div className="sentinel-agent-auth-card">
        <div className="sentinel-agent-auth-card-content">
          <div className="sentinel-agent-auth-card-brand">
            <img src="/favicon.svg" alt="" className="sentinel-agent-auth-logo" />
            <h1 className="sentinel-agent-auth-title">Sentinel Agent</h1>
            <p className="sentinel-agent-auth-subtitle">Sign in to continue</p>
          </div>

          <p className="sentinel-agent-auth-hint">Enter the UI access password for this agent.</p>

          <form onSubmit={handleSubmit}>
            <SpaceBetween size="m" direction="vertical">
              {error ? (
                <Alert type="error" header="Wrong password">
                  Try again.
                </Alert>
              ) : null}
              <FormField label="Password">
                <Input
                  value={pw}
                  onChange={({ detail }) => setPw(detail.value)}
                  type="password"
                  placeholder="Password"
                  autoComplete="current-password"
                  autoFocus
                />
              </FormField>
              <Button variant="primary" disabled={checking || !pw} loading={checking} formAction="submit">
                Unlock
              </Button>
            </SpaceBetween>
          </form>
        </div>
      </div>
    </div>
  );
}

const NAV_HREF: Record<NavId, string> = {
  dashboard: "#dashboard",
  connection: "#connection",
  security: "#security",
  logs: "#logs",
};

// ── Settings shell ───────────────────────────────────────────────────────────

function SettingsPanel() {
  const [nav, setNav] = useState<NavId>("dashboard");
  const [navOpen, setNavOpen] = useState(true);
  const [config, setConfig] = useState<AgentConfig>({
    server_url: "",
    agent_name: "",
    agent_token: "",
    install_id: "",
    ui_password_hash: "",
    auto_update_enabled: false,
    tray_icon_enabled: true,
  });
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
  const serverUrlInputRef = useRef<HTMLInputElement | null>(null);

  const saveMsgTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const [appVersion, setAppVersion] = useState<string>("");

  const [logSources, setLogSources] = useState<LogSourceDesc[]>([]);
  const [logSourceId, setLogSourceId] = useState("");
  const [logText, setLogText] = useState("");
  const [logsManualRefresh, setLogsManualRefresh] = useState(false);
  const [logAutoRefresh, setLogAutoRefresh] = useState(true);
  const [logClearing, setLogClearing] = useState(false);
  const [logClearMsg, setLogClearMsg] = useState<string | null>(null);
  const [clearAllConfirmOpen, setClearAllConfirmOpen] = useState(false);
  const logViewportRef = useRef<HTMLTextAreaElement | null>(null);
  const logStickToBottomRef = useRef(true);
  const logInitialScrollDoneRef = useRef(false);

  const sideNavItems: SideNavigationProps.Item[] = useMemo(
    () => [
      { type: "link", text: "Dashboard", href: NAV_HREF.dashboard },
      { type: "link", text: "Connection", href: NAV_HREF.connection },
      { type: "link", text: "Security", href: NAV_HREF.security },
      { type: "link", text: "Logs", href: NAV_HREF.logs },
    ],
    [],
  );

  const lanOptions: SelectProps.Options = useMemo(() => {
    const opts: SelectProps.Options = [
      { label: "Select discovered server…", value: "", disabled: false },
      ...discovered.map((d) => ({
        label: d.instanceName?.trim() || d.wssUrl,
        value: d.wssUrl,
        description: d.instanceName?.trim() ? d.wssUrl : undefined,
      })),
    ];
    return opts;
  }, [discovered]);

  useEffect(() => {
    invoke<AgentConfig>("get_config").then((cfg) => {
      setConfig(cfg);
      setLoading(false);
    });
  }, []);

  useEffect(() => {
    if (nav !== "connection") return;
    // When opening settings, make it easy to type/paste immediately.
    const id = setTimeout(() => serverUrlInputRef.current?.focus(), 0);
    return () => clearTimeout(id);
  }, [nav]);

  useEffect(() => {
    const poll = async () => {
      try {
        const s = await invoke<StatusResponse>("get_status");
        setStatus(s);
      } catch {
        setStatus({ status: "Error", message: "IPC unavailable" });
      }
    };
    poll();
    const id = setInterval(poll, 2000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    invoke<string>("get_app_version")
      .then((v) => setAppVersion(v))
      .catch(() => setAppVersion(""));
  }, []);

  useEffect(() => {
    void invoke<LogSourceDesc[]>("list_log_sources").then(setLogSources).catch(() => setLogSources([]));
  }, []);

  const currentLogSourceId = useMemo(() => {
    if (logSources.length === 0) return logSourceId;
    if (logSources.some((s) => s.id === logSourceId)) return logSourceId;
    return logSources[0].id;
  }, [logSources, logSourceId]);

  const refreshLogs = useCallback(async (manual: boolean) => {
    if (manual) setLogsManualRefresh(true);
    try {
      const text = await invoke<string>("read_log_file_tail", {
        kind: currentLogSourceId,
        maxKb: 512,
      });
      setLogText(text);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      setLogText(`(Could not read log: ${msg})`);
    } finally {
      if (manual) setLogsManualRefresh(false);
    }
  }, [currentLogSourceId]);

  const clearLogs = useCallback(async () => {
    setLogClearing(true);
    setLogClearMsg(null);
    try {
      await invoke("clear_log_file", { kind: currentLogSourceId });
      setLogText("");
      setLogClearMsg("Cleared.");
    } catch (e: unknown) {
      setLogClearMsg(e instanceof Error ? e.message : String(e));
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
      await Promise.allSettled(logSources.map((s) => invoke("clear_log_file", { kind: s.id })));
      // Refresh current view (selected source).
      void refreshLogs(false);
      setLogClearMsg("All logs cleared.");
    } catch (e: unknown) {
      setLogClearMsg(e instanceof Error ? e.message : String(e));
    } finally {
      setLogClearing(false);
      setTimeout(() => setLogClearMsg(null), 3000);
    }
  }, [logSources, refreshLogs]);

  const openLogLocation = useCallback(() => {
    void invoke("open_log_location", { kind: currentLogSourceId }).catch(() => {});
  }, [currentLogSourceId]);

  useEffect(() => {
    if (nav !== "logs") return;
    // When entering logs, start pinned to bottom.
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

    // First render after (re-)entering logs: jump to bottom once.
    if (!logInitialScrollDoneRef.current) {
      el.scrollTop = el.scrollHeight;
      logInitialScrollDoneRef.current = true;
      return;
    }

    // Only keep auto-scrolling if auto-refresh is enabled AND the user is already at bottom.
    if (logAutoRefresh && logStickToBottomRef.current) {
      el.scrollTop = el.scrollHeight;
    }
  }, [logText, logAutoRefresh]);

  const logSourceOptions: SelectProps.Options = useMemo(
    () =>
      logSources.map((s) => ({
        label: s.label,
        value: s.id,
        description: s.path,
      })),
    [logSources],
  );

  const selectedLogSourceOption = useMemo(
    () => logSourceOptions.find((o) => o.value === currentLogSourceId) ?? null,
    [logSourceOptions, currentLogSourceId],
  );

  const handleSave = useCallback(async () => {
    if (newPw && newPw !== confirmPw) {
      setSaveMsg({ text: "Passwords don't match", ok: false });
      return;
    }
    setSaving(true);

    try {
      const payload: AgentConfig & { new_password?: string } = {
        ...config,
        ...(newPw ? { new_password: newPw } : {}),
      };
      await invoke("save_config", { config: payload });
      setSaveMsg({ text: "Settings saved.", ok: true });
      setNewPw("");
      setConfirmPw("");
      const fresh = await invoke<AgentConfig>("get_config");
      setConfig(fresh);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      setSaveMsg({ text: `Save failed: ${msg}`, ok: false });
    } finally {
      setSaving(false);
      if (saveMsgTimer.current) clearTimeout(saveMsgTimer.current);
      saveMsgTimer.current = setTimeout(() => setSaveMsg(null), 4000);
    }
  }, [config, newPw, confirmPw]);

  const handleClose = useCallback(() => {
    invoke("hide_window").catch(() => {});
  }, []);

  const [exitDialog, setExitDialog] = useState<{ visible: boolean }>({ visible: false });
  const [exitPw, setExitPw] = useState("");
  const [exitBusy, setExitBusy] = useState(false);
  const [exitError, setExitError] = useState<string | null>(null);

  const handleExit = useCallback(() => {
    void (async () => {
      try {
        const has = await invoke<boolean>("has_ui_password");
        if (has) {
          setExitDialog({ visible: true });
          return;
        }
        await invoke("exit_agent");
      } catch {
        // ignore
      }
    })();
  }, []);

  const confirmExit = useCallback(async () => {
    setExitBusy(true);
    setExitError(null);
    try {
      await invoke("verify_ui_password", { password: exitPw });
      await invoke("exit_agent");
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      setExitError(msg || "Authentication required");
      setExitPw("");
    } finally {
      setExitBusy(false);
    }
  }, [exitPw]);

  const openUpdateCheck = useCallback(async () => {
    setUpdateDialog({ phase: "checking" });
    try {
      const r = await invoke<ManualUpdateCheckResponse>("check_manual_update");
      if (r.update_available && r.published_version) {
        setUpdateDialog({ phase: "available", publishedVersion: r.published_version });
      } else {
        setUpdateDialog({ phase: "uptodate" });
      }
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : String(e);
      setUpdateDialog({ phase: "error", message });
    }
  }, []);

  const applyManualUpdate = useCallback(async () => {
    setUpdateDialog({ phase: "installing" });
    try {
      const r = await invoke<ManualApplyUpdateResponse>("apply_manual_update");
      if (r.outcome === "install_started") {
        return;
      }
      if (r.outcome === "up_to_date") {
        setUpdateDialog({ phase: "uptodate" });
      }
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : String(e);
      setUpdateDialog({ phase: "error", message });
    }
  }, []);

  const closeUpdateDialog = useCallback(() => {
    setUpdateDialog((d) => {
      if (d?.phase === "installing") return d;
      return null;
    });
  }, []);

  const scanLanServers = useCallback(async () => {
    setScanning(true);
    setAdoptMsg(null);
    try {
      const list = await invoke<DiscoveredServer[]>("discover_sentinel_mdns_servers", {
        opts: { timeoutMs: 4000 },
      });
      setDiscovered(list);
      if (list.length === 1) {
        setConfig((c) => ({ ...c, server_url: list[0].wssUrl }));
        setAdoptMsg({ text: "Filled server URL from LAN discovery.", ok: true });
      } else if (list.length === 0) {
        setAdoptMsg({
          text: "No servers found on LAN (Docker/host mDNS limits apply). Use your server wss:// URL.",
          ok: false,
        });
      } else {
        setAdoptMsg({
          text: `Found ${list.length} servers — pick one in the list.`,
          ok: true,
        });
      }
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : String(e);
      setAdoptMsg({ text: `Discovery failed: ${message}`, ok: false });
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
        payload: {
          serverUrl: url,
          enrollmentCode: adoptCode.trim(),
          agentName: agentName.length > 0 ? agentName : null,
        },
      });
      setAdoptCode("");
      const fresh = await invoke<AgentConfig>("get_config");
      setConfig(fresh);
      setAdoptMsg({
        text: "Request approved. Per-device token saved.",
        ok: true,
      });
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : String(e);
      setAdoptMsg({ text: message, ok: false });
    } finally {
      setAdoptBusy(false);
    }
  }, [config.server_url, config.agent_name, adoptCode]);

  const onSideNavFollow: SideNavigationProps["onFollow"] = (event) => {
    event.preventDefault();
    const href = event.detail.href;
    if (href === "#") return;
    if (href === NAV_HREF.dashboard) setNav("dashboard");
    else if (href === NAV_HREF.connection) setNav("connection");
    else if (href === NAV_HREF.security) setNav("security");
    else if (href === NAV_HREF.logs) setNav("logs");
  };

  const topUtilities: TopNavigationProps.Utility[] = useMemo(
    () => [
      {
        type: "button",
        variant: "link",
        text: appVersion ? `v${appVersion}` : "Version",
        title: "Check for updates",
        onClick: () => {
          void openUpdateCheck();
        },
      },
    ],
    [appVersion, openUpdateCheck],
  );

  const pageDesc =
    nav === "dashboard"
      ? "Connection status and agent details."
      : nav === "connection"
        ? "Server URL, access request, and credentials."
        : nav === "security"
          ? "Local password for this settings window."
          : "Tracing output buffered in memory for this session.";

  const pageTitle =
    nav === "dashboard"
      ? "Dashboard"
      : nav === "connection"
        ? "Connection"
        : nav === "security"
          ? "Security"
          : "Logs";

  const dashboardPairs = useMemo(
    () =>
      [
        {
          label: "Connection",
          value: <ConnectionStatusIndicator {...status} />,
        },
        {
          label: "Agent name",
          value: (
            <Box variant="span" fontWeight="bold">
              {config.agent_name.trim() || "—"}
            </Box>
          ),
        },
        {
          label: "Server URL",
          value: (
            <Box variant="span" margin={{ right: "n" }} nativeAttributes={{ title: config.server_url }}>
              {config.server_url.trim() || "—"}
            </Box>
          ),
        },
        {
          label: "Updates",
          value: (
            <Box display="block" margin={{ top: "s" }}>
              <Button
                variant="normal"
                disabled={updateDialog?.phase === "checking" || updateDialog?.phase === "installing"}
                onClick={() => void openUpdateCheck()}
              >
                Check for updates
              </Button>
            </Box>
          ),
        },
      ] as const,
    [status, config.agent_name, config.server_url, updateDialog?.phase, openUpdateCheck],
  );

  if (loading) {
    return (
      <Box
        textAlign="center"
        padding="xxl"
        nativeAttributes={{
          style: { height: "100%", display: "flex", alignItems: "center", justifyContent: "center" },
        }}
      >
        <Spinner size="large" />
      </Box>
    );
  }

  return (
    <div
      className="animate-fade-in"
      style={{ height: "100%", display: "flex", flexDirection: "column", minHeight: 0 }}
    >
      <div id="sentinel-agent-top-nav" className="sentinel-agent-top-nav">
        <TopNavigation
          identity={{
            href: "#",
            title: "Sentinel Agent",
            logo: { src: `${import.meta.env.BASE_URL}favicon.svg`, alt: "" },
            onFollow: (e) => e.preventDefault(),
          }}
          utilities={topUtilities}
        />
      </div>

      <div style={{ flex: 1, minHeight: 0, minWidth: 0 }}>
          <AppLayout
            headerSelector="#sentinel-agent-top-nav"
            footerSelector="#sentinel-agent-settings-footer"
            navigationOpen={navOpen}
            onNavigationChange={({ detail }) => setNavOpen(detail.open)}
            navigation={
              <SideNavigation
                header={{ text: "Settings", href: "#" }}
                activeHref={NAV_HREF[nav]}
                items={sideNavItems}
                onFollow={onSideNavFollow}
              />
            }
            navigationWidth={260}
            maxContentWidth={Number.MAX_VALUE}
            contentType={nav === "logs" ? "table" : "default"}
            disableContentPaddings
            toolsHide
            content={
              /* Plain divs here — Cloudscape Box + nativeAttributes.style is unreliable for
                 flex height chains. contentType="table" on logs disables AppLayout's own
                 overflow:auto so our inner viewport is the sole scroll container. */
              <div
                style={{
                  height: "100%",
                  display: "flex",
                  flexDirection: "column",
                  padding: "16px 16px 8px",
                  boxSizing: "border-box",
                  minHeight: 0,
                }}
              >
                <div style={{ flexShrink: 0 }}>
                  <Header variant="h1" description={pageDesc}>
                    {pageTitle}
                  </Header>
                </div>

                <div
                  style={{
                    flex: 1,
                    minHeight: 0,
                    minWidth: 0,
                    marginTop: "20px",
                    overflow: nav === "logs" ? "hidden" : "auto",
                    display: "flex",
                    flexDirection: "column",
                  }}
                >
                  {nav === "dashboard" && (
                    <Container header={<Header variant="h2">Overview</Header>}>
                      <KeyValuePairs columns={2} minColumnWidth={200} items={[...dashboardPairs]} />
                    </Container>
                  )}

                  {nav === "connection" && (
                    <ColumnLayout columns={2} minColumnWidth={280} variant="default">
                      <Container header={<Header variant="h2">Enrollment</Header>}>
                        <SpaceBetween size="m" direction="vertical">
                          <Box variant="p" color="text-body-secondary" fontSize="body-s">
                            Find a server on the network, then request access. A six-digit dashboard code is optional.
                          </Box>
                          <FormField label="Server URL" description="WebSocket URL from the server.">
                            <Input
                              value={config.server_url}
                              onChange={({ detail }) => setConfig((c) => ({ ...c, server_url: detail.value }))}
                              placeholder="wss://host/ws/agent"
                              type="text"
                              ref={serverUrlInputRef}
                            />
                          </FormField>
                          {discovered.length > 1 ? (
                            <FormField label="LAN discovery">
                              <Select
                                selectedOption={null}
                                filteringType="manual"
                                options={lanOptions}
                                placeholder="Select discovered server"
                                onChange={({ detail }) => {
                                  const v = detail.selectedOption?.value;
                                  if (v) setConfig((c) => ({ ...c, server_url: v }));
                                }}
                              />
                            </FormField>
                          ) : null}
                          <div>
                            <Button onClick={() => void scanLanServers()} loading={scanning}>
                              Find on network
                            </Button>
                          </div>
                          <FormField
                            label="Pairing code (optional)"
                            description="Use only when the server operator gives you a six-digit code."
                          >
                            <Input
                              value={adoptCode}
                              onChange={({ detail }) => setAdoptCode(detail.value)}
                              placeholder="Optional"
                              inputMode="numeric"
                              autoComplete="one-time-code"
                            />
                          </FormField>
                          <Button variant="primary" onClick={() => void adoptWithCode()} loading={adoptBusy}>
                            Request access
                          </Button>
                          {adoptMsg ? (
                            <Alert type={adoptMsg.ok ? "success" : "error"} header={adoptMsg.ok ? "Done" : "Notice"}>
                              {adoptMsg.text}
                            </Alert>
                          ) : null}
                        </SpaceBetween>
                      </Container>

                      <Container header={<Header variant="h2">Credentials</Header>}>
                        <SpaceBetween size="m" direction="vertical">
                          <FormField label="Agent name">
                            <Input
                              value={config.agent_name}
                              onChange={({ detail }) => setConfig((c) => ({ ...c, agent_name: detail.value }))}
                              placeholder="My-PC"
                            />
                          </FormField>
                          <FormField label="Agent token" description="Per-device token issued after approval.">
                            <Input
                              value={config.agent_token}
                              onChange={({ detail }) =>
                                setConfig((c) => ({ ...c, agent_token: detail.value }))
                              }
                              type="password"
                              placeholder="Issued by approval"
                              autoComplete="new-password"
                            />
                          </FormField>
                          <Toggle
                            checked={config.auto_update_enabled}
                            onChange={({ detail }) =>
                              setConfig((c) => ({ ...c, auto_update_enabled: detail.checked }))
                            }
                          >
                            Auto-update agent
                          </Toggle>
                          <Toggle
                            checked={config.tray_icon_enabled}
                            onChange={({ detail }) =>
                              setConfig((c) => ({ ...c, tray_icon_enabled: detail.checked }))
                            }
                          >
                            Show tray icon
                          </Toggle>
                        </SpaceBetween>
                      </Container>
                    </ColumnLayout>
                  )}

                  {nav === "security" && (
                    <Container header={<Header variant="h2">UI access password</Header>}>
                      <SpaceBetween size="m" direction="vertical">
                        <Box variant="p" color="text-body-secondary" fontSize="body-s">
                          Required when reopening settings (after hide). Leave new fields blank to keep the current
                          password.
                        </Box>
                        <FormField label="New password">
                          <Input
                            value={newPw}
                            onChange={({ detail }) => setNewPw(detail.value)}
                            type="password"
                            placeholder="New password"
                            autoComplete="new-password"
                          />
                        </FormField>
                        <FormField label="Confirm password">
                          <Input
                            value={confirmPw}
                            onChange={({ detail }) => setConfirmPw(detail.value)}
                            type="password"
                            placeholder="Confirm"
                            autoComplete="new-password"
                          />
                        </FormField>
                      </SpaceBetween>
                    </Container>
                  )}

                  {nav === "logs" && (
                    <div
                      style={{
                        flex: 1,
                        minHeight: 0,
                        display: "flex",
                        flexDirection: "column",
                      }}
                    >
                      <div style={{ flexShrink: 0, marginBottom: "12px" }}>
                        <Container
                          header={
                            <Header
                              variant="h2"
                              actions={
                                <SpaceBetween direction="horizontal" size="xs" alignItems="center">
                                  {logClearMsg && (
                                    <Box variant="span" fontSize="body-s" color="text-body-secondary">
                                      {logClearMsg}
                                    </Box>
                                  )}
                                  <Toggle
                                    checked={logAutoRefresh}
                                    onChange={({ detail }) => setLogAutoRefresh(detail.checked)}
                                  >
                                    Auto-refresh
                                  </Toggle>
                                  <Button onClick={() => void refreshLogs(true)} loading={logsManualRefresh}>
                                    Refresh
                                  </Button>
                                  <Button onClick={() => void clearLogs()} loading={logClearing}>
                                    Clear
                                  </Button>
                                  <Button
                                    onClick={() => setClearAllConfirmOpen(true)}
                                    disabled={logClearing || logSources.length === 0}
                                  >
                                    Clear all
                                  </Button>
                                  <Button onClick={openLogLocation} iconName="folder-open">
                                    Open location
                                  </Button>
                                </SpaceBetween>
                              }
                            >
                              Agent logs
                            </Header>
                          }
                        >
                          <FormField label="Log file" description="Last ~512 KiB. Logs are in %ProgramData%\Sentinel.">
                            <Select
                              selectedOption={selectedLogSourceOption}
                              options={logSourceOptions}
                              placeholder="Choose a log"
                              empty="No log sources"
                              onChange={({ detail }) => {
                                const v = detail.selectedOption?.value;
                                if (v) setLogSourceId(v);
                              }}
                            />
                          </FormField>
                        </Container>
                      </div>
                      <div className="sentinel-agent-log-viewport" style={{ flex: 1, minHeight: 0 }}>
                        <textarea
                          ref={logViewportRef}
                          className="sentinel-agent-log-textarea"
                          aria-label="Agent log output"
                          value={logText || "Loading…"}
                          readOnly
                          spellCheck={false}
                          wrap="off"
                          onScroll={() => {
                            const el = logViewportRef.current;
                            if (!el) return;
                            const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
                            logStickToBottomRef.current = distanceFromBottom <= 8;
                          }}
                        />
                      </div>
                    </div>
                  )}
                </div>
              </div>
            }
          />
      </div>

      <Box
        padding={{ top: "m", bottom: "m", horizontal: "m" }}
        nativeAttributes={{
          id: "sentinel-agent-settings-footer",
          className: "sentinel-agent-settings-footer",
          style: {
            display: "flex",
            alignItems: "center",
            gap: "12px",
          },
        }}
      >
        <Button variant="primary" onClick={() => void handleSave()} loading={saving}>
          Save
        </Button>
        <Button variant="link" onClick={handleClose}>
          Hide
        </Button>
        {saveMsg ? (
          <Box
            variant="span"
            fontSize="body-s"
            color={saveMsg.ok ? "text-status-success" : "text-status-error"}
          >
            {saveMsg.text}
          </Box>
        ) : null}
        <div style={{ flex: 1, minWidth: 8 }} />
        <Box
          variant="span"
          fontSize="body-s"
          color="text-body-secondary"
          nativeAttributes={{
            className: "sentinel-agent-settings-footer__hint",
            style: { textAlign: "right" },
          }}
        >
          You can open this window anytime with <span className="sentinel-kbd">Ctrl+Shift+F12</span>.
        </Box>
        <Button variant="normal" onClick={handleExit}>
          Exit agent
        </Button>
      </Box>

      <Modal
        visible={exitDialog.visible}
        onDismiss={() => {
          if (exitBusy) return;
          setExitDialog({ visible: false });
          setExitPw("");
          setExitError(null);
        }}
        size="small"
        closeAriaLabel="Close"
        header="Exit agent"
        footer={
          <Box float="right">
            <SpaceBetween direction="horizontal" size="xs">
              <Button
                variant="link"
                disabled={exitBusy}
                onClick={() => {
                  setExitDialog({ visible: false });
                  setExitPw("");
                  setExitError(null);
                }}
              >
                Cancel
              </Button>
              <Button variant="primary" disabled={exitBusy || !exitPw} loading={exitBusy} onClick={() => void confirmExit()}>
                Exit
              </Button>
            </SpaceBetween>
          </Box>
        }
      >
        <SpaceBetween size="m" direction="vertical">
          {exitError ? (
            <Alert type="error" header="Can't exit">
              {exitError}
            </Alert>
          ) : (
            <Box color="text-body-secondary">Enter the UI access password to quit this agent.</Box>
          )}
          <FormField label="Password">
            <Input
              value={exitPw}
              onChange={({ detail }) => setExitPw(detail.value)}
              type="password"
              placeholder="Password"
              autoComplete="current-password"
            />
          </FormField>
        </SpaceBetween>
      </Modal>

      <Modal
        visible={clearAllConfirmOpen}
        onDismiss={() => {
          if (logClearing) return;
          setClearAllConfirmOpen(false);
        }}
        size="small"
        closeAriaLabel="Close"
        header="Clear all logs"
        footer={
          <Box float="right">
            <SpaceBetween direction="horizontal" size="xs">
              <Button variant="link" disabled={logClearing} onClick={() => setClearAllConfirmOpen(false)}>
                Cancel
              </Button>
              <Button
                variant="primary"
                disabled={logClearing || logSources.length === 0}
                loading={logClearing}
                onClick={() => {
                  setClearAllConfirmOpen(false);
                  void clearAllLogs();
                }}
              >
                Clear all
              </Button>
            </SpaceBetween>
          </Box>
        }
      >
        <SpaceBetween size="s">
          <Box>
            This clears <strong>all</strong> known agent log files from this machine (not just the currently selected log).
          </Box>
          {logSources.length > 0 ? (
            <Box color="text-body-secondary" fontSize="body-s">
              Includes: {logSources.map((s) => s.label).join(", ")}
            </Box>
          ) : null}
        </SpaceBetween>
      </Modal>

      <Modal
        visible={updateDialog !== null}
        onDismiss={() => {
          closeUpdateDialog();
        }}
        size="medium"
        closeAriaLabel="Close"
        header={
          updateDialog?.phase === "checking"
            ? "Checking for updates"
            : updateDialog?.phase === "uptodate"
              ? "Up to date"
              : updateDialog?.phase === "available"
                ? "Update available"
                : updateDialog?.phase === "installing"
                  ? "Installing update"
                  : updateDialog?.phase === "error"
                    ? "Update check failed"
                    : ""
        }
        footer={
          updateDialog?.phase === "checking" || updateDialog?.phase === "installing" ? null : (
            <Box float="right">
              <SpaceBetween direction="horizontal" size="xs">
                {updateDialog?.phase === "available" ? (
                  <Button variant="link" onClick={closeUpdateDialog}>
                    Not now
                  </Button>
                ) : null}
                {updateDialog?.phase === "available" ? (
                  <Button variant="primary" onClick={() => void applyManualUpdate()}>
                    Download and install
                  </Button>
                ) : (
                  <Button variant="primary" onClick={closeUpdateDialog}>
                    Close
                  </Button>
                )}
              </SpaceBetween>
            </Box>
          )
        }
      >
        {updateDialog?.phase === "checking" && (
          <SpaceBetween direction="horizontal" size="s" alignItems="center">
            <Spinner />
            <Box color="text-body-secondary">Contacting update server…</Box>
          </SpaceBetween>
        )}
        {updateDialog?.phase === "uptodate" && (
          <Box color="text-body-secondary">
            This build matches the latest published Sentinel agent version.
          </Box>
        )}
        {updateDialog?.phase === "available" && (
          <Box>
            Version <Box variant="strong">{updateDialog.publishedVersion}</Box> is available. The agent will download
            the installer and restart.
          </Box>
        )}
        {updateDialog?.phase === "installing" && (
          <SpaceBetween direction="horizontal" size="s" alignItems="center">
            <Spinner />
            <Box color="text-body-secondary">Downloading and starting the installer…</Box>
          </SpaceBetween>
        )}
        {updateDialog?.phase === "error" && (
          <Box color="text-body-secondary">{updateDialog.message}</Box>
        )}
      </Modal>
    </div>
  );
}

// ── Root App ──────────────────────────────────────────────────────────────────

type AppScreen = "loading" | "password" | "settings";

export default function App() {
  useSystemColorScheme();

  const [screen, setScreen] = useState<AppScreen>("loading");

  const checkLock = useCallback(() => {
    invoke<boolean>("has_ui_password")
      .then((has) => setScreen(has ? "password" : "settings"))
      .catch(() => setScreen("settings"));
  }, []);

  const forceRelock = useCallback(() => {
    setScreen("password");
    checkLock();
  }, [checkLock]);

  useEffect(() => {
    checkLock();

    const unlistenLock = listen("lock_ui", () => {
      forceRelock();
    });

    return () => {
      unlistenLock.then((unlisten: () => void) => unlisten());
    };
  }, [checkLock, forceRelock]);

  if (screen === "loading") {
    return (
      <Box
        textAlign="center"
        padding="xxl"
        nativeAttributes={{
          style: { height: "100%", display: "flex", alignItems: "center", justifyContent: "center" },
        }}
      >
        <Spinner size="large" />
      </Box>
    );
  }

  if (screen === "password") {
    return <PasswordGate onUnlock={() => setScreen("settings")} />;
  }

  return <SettingsPanel />;
}
