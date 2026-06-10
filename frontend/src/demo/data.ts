import type {
  ActivityEvent,
  Agent,
  AgentGroup,
  AgentInfo,
  AgentLiveStatus,
  AgentSoftwareRow,
  AlertRule,
  AppBlockEvent,
  AppBlockRule,
  DashboardSessionUser,
  DashboardUser,
  InternetBlockRule,
  KeySession,
  ScheduledScript,
  ScheduledScriptEvent,
  UrlVisit,
  WindowEvent,
} from "../lib/types";

const now = Date.now();

export const demoUser: DashboardSessionUser = {
  id: "demo-user-admin",
  username: "admin",
  display_name: "Demo Admin",
  role: "admin",
  display_icon: "icon:lucide:ShieldCheck",
  csrf_token: "demo-csrf-token",
};

export const demoUsers: DashboardUser[] = [
  {
    id: demoUser.id,
    username: demoUser.username,
    display_name: demoUser.display_name,
    role: demoUser.role,
    display_icon: demoUser.display_icon,
    created_at: isoHoursAgo(240),
  },
  {
    id: "demo-user-operator",
    username: "operator",
    display_name: "Ops User",
    role: "operator",
    display_icon: "icon:lucide:MonitorCog",
    created_at: isoHoursAgo(120),
  },
];

export const demoAgents: Agent[] = [
  agent("win11dev", "WIN11DEV", true, 0.25, "0.1.6"),
  agent("build-srv-02", "BUILD-SRV-02", true, 0.75, "0.2.9"),
  agent("mbp-design", "MBP-DESIGN", true, 1.4, "0.2.9"),
  agent("reception-pc", "RECEPTION-PC", true, 2.1, "0.2.7"),
  agent("kiosk-lobby", "KIOSK-LOBBY", false, 6.5, "0.2.9"),
  agent("sitting-room", "SITTING-ROOM", false, 96, "0.2.9"),
  agent("lab-laptop-07", "LAB-LAPTOP-07", true, 0.1, "0.2.9"),
  agent("warehouse-03", "WAREHOUSE-03", false, 28, "0.2.8"),
];

export const demoLiveStatus: Record<string, AgentLiveStatus> = {
  win11dev: {
    activity: "active",
    app: "explorer.exe",
    window: "This PC - File Explorer",
    url: "https://github.com/example/sentinel/pull/482",
  },
  "build-srv-02": {
    activity: "active",
    app: "WindowsTerminal.exe",
    window: "ssh - build pipeline #2291",
    url: "https://ci.example.local/builds/2291",
  },
  "mbp-design": {
    activity: "afk",
    idleSecs: 940,
    idleSinceMs: now - 940_000,
    app: "Figma.exe",
    window: "Figma - Sentinel UI",
    url: "https://figma.com/file/demo",
  },
  "reception-pc": {
    activity: "afk",
    idleSecs: 320,
    idleSinceMs: now - 320_000,
    app: "outlook.exe",
    window: "Inbox - Outlook",
    url: "https://outlook.office.com/mail/",
  },
  "lab-laptop-07": {
    activity: "active",
    app: "Code.exe",
    window: "Sentinel - Visual Studio Code",
    url: "http://localhost:5173/",
  },
};

export const demoAgentInfo: Record<string, AgentInfo> = Object.fromEntries(
  demoAgents.map((a, index) => [
    a.id,
    {
      agent_version: a.agent_version ?? "0.2.9",
      hostname: a.name,
      uptime_secs: a.online ? (index + 2) * 36_200 : undefined,
      system_model: index % 2 === 0 ? "ThinkPad T14" : "OptiPlex 7090",
      system_manufacturer: index % 2 === 0 ? "Lenovo" : "Dell Inc.",
      os_name: a.name.includes("MBP") ? "macOS" : a.name.includes("BUILD") ? "Ubuntu" : "Windows 11 Pro",
      os_version: a.name.includes("BUILD") ? "24.04" : "23H2",
      cpu_brand: index % 2 === 0 ? "Intel Core i7-12700" : "AMD Ryzen 7 5700G",
      cpu_cores: index % 2 === 0 ? 12 : 8,
      memory_total_mb: 32768,
      memory_used_mb: 11800 + index * 720,
      current_user: demoUserFor(a.id),
      adapters: [
        {
          name: "Ethernet",
          description: "Intel Ethernet Controller",
          mac: `02-00-5E-10-00-0${index}`,
          ips: [`10.0.${index + 2}.${20 + index}`],
          gateways: [`10.0.${index + 2}.1`],
          dns: ["1.1.1.1", "8.8.8.8"],
        },
      ],
      drives: [
        {
          name: "C:",
          mount_point: "C:\\",
          file_system: "NTFS",
          total_gb: 512,
          available_gb: 180 - index * 8,
        },
      ],
      config_agent_name: a.name,
      config_server_url: "wss://demo.sentinel.local/ws/agent",
      config_ui_password_set: true,
      ts: Math.floor(now / 1000),
    },
  ]),
);

export const demoGroups: AgentGroup[] = [
  { id: "grp-workstations", name: "Workstations", description: "Employee laptops and desktops", created_at: isoHoursAgo(900), member_count: 5 },
  { id: "grp-kiosks", name: "Kiosks", description: "Shared unattended machines", created_at: isoHoursAgo(720), member_count: 2 },
  { id: "grp-build", name: "Build fleet", description: "CI and automation hosts", created_at: isoHoursAgo(480), member_count: 1 },
];

export const demoAlertRules: AlertRule[] = [
  {
    id: 1,
    name: "Social media during work hours",
    channel: "url",
    pattern: "facebook.com",
    match_mode: "substring",
    case_insensitive: true,
    cooldown_secs: 300,
    enabled: true,
    take_screenshot: false,
    scopes: [{ kind: "all" }],
  },
  {
    id: 2,
    name: "Credential keywords",
    channel: "keys",
    pattern: "password|token|secret",
    match_mode: "regex",
    case_insensitive: true,
    cooldown_secs: 900,
    enabled: true,
    take_screenshot: true,
    scopes: [{ kind: "group", group_id: "grp-workstations" }],
  },
];

export const demoAppBlockRules: AppBlockRule[] = [
  {
    id: 10,
    name: "Block games",
    exe_pattern: "steam.exe",
    match_mode: "exact",
    enabled: true,
    created_at: isoHoursAgo(48),
    scopes: [{ kind: "all" }],
    schedules: [],
  },
  {
    id: 11,
    name: "Block portable browsers",
    exe_pattern: "tor",
    match_mode: "contains",
    enabled: true,
    created_at: isoHoursAgo(24),
    scopes: [{ kind: "group", group_id: "grp-workstations" }],
    schedules: [],
  },
];

export const demoInternetBlockRules: InternetBlockRule[] = [
  {
    id: 20,
    name: "Kiosk after-hours block",
    enabled: true,
    created_at: isoHoursAgo(72),
    scopes: [{ kind: "group", group_id: "grp-kiosks" }],
    schedules: [{ day_of_week: 1, start_minute: 18 * 60, end_minute: 23 * 60 + 59 }],
  },
];

export const demoScheduledScripts: ScheduledScript[] = [
  {
    id: 30,
    name: "Collect diagnostics",
    shell: "powershell",
    script: "Get-ComputerInfo | Select-Object OsName, OsVersion",
    timeout_secs: 60,
    enabled: true,
    created_at: isoHoursAgo(24),
    updated_at: isoHoursAgo(4),
    scopes: [{ kind: "all" }],
    schedules: [{ frequency: "daily", day_of_week: null, fire_minute: 3 * 60 }],
  },
];

export function demoWindows(agentId: string, count = 24): WindowEvent[] {
  const titles = [
    "Sentinel - Visual Studio Code",
    "This PC - File Explorer",
    "Inbox - Outlook",
    "Pull request #482 - GitHub",
    "Task Manager",
  ];
  return range(count).map((i) => ({
    title: titles[(i + agentId.length) % titles.length],
    app: ["Code.exe", "explorer.exe", "outlook.exe", "chrome.exe", "Taskmgr.exe"][i % 5],
    app_display: ["Code", "File Explorer", "Outlook", "Chrome", "Task Manager"][i % 5],
    hwnd: 1000 + i,
    ts: isoMinutesAgo(i * 11 + 2),
    created: isoMinutesAgo(i * 11 + 2),
    user: demoUserFor(agentId),
  }));
}

export function demoUrls(agentId: string, count = 24): UrlVisit[] {
  const urls = [
    "https://github.com/example/sentinel",
    "https://docs.rs/tokio/latest/tokio/",
    "https://cloudscape.design/components/",
    "https://news.ycombinator.com/",
    "https://outlook.office.com/mail/",
  ];
  return range(count).map((i) => ({
    id: i + 1,
    url: urls[(i + agentId.length) % urls.length],
    title: ["GitHub", "Tokio docs", "Cloudscape", "Hacker News", "Outlook"][i % 5],
    browser: i % 2 === 0 ? "Chrome" : "Edge",
    ts: isoMinutesAgo(i * 13 + 4),
    user: demoUserFor(agentId),
    category_key: i % 4 === 0 ? "productivity" : "information",
    category: i % 4 === 0 ? "Productivity" : "Information",
  }));
}

export function demoKeys(agentId: string, count = 12): KeySession[] {
  return range(count).map((i) => ({
    app: i % 2 === 0 ? "Code.exe" : "WindowsTerminal.exe",
    app_display: i % 2 === 0 ? "Visual Studio Code" : "Terminal",
    window_title: i % 2 === 0 ? "Sentinel - Visual Studio Code" : "PowerShell",
    text: "[demo keystroke session redacted]",
    started_at: isoMinutesAgo(i * 17 + 5),
    updated_at: isoMinutesAgo(i * 17 + 2),
    user: demoUserFor(agentId),
  }));
}

export function demoActivity(agentId: string, count = 18): ActivityEvent[] {
  return range(count).map((i) => ({
    kind: i % 4 === 0 ? "afk" : "active",
    idle_secs: i % 4 === 0 ? 300 + i * 20 : undefined,
    ts: isoMinutesAgo(i * 9 + agentId.length),
    user: demoUserFor(agentId),
  }));
}

export function demoSoftware(agentId: string): AgentSoftwareRow[] {
  return ["Sentinel Agent", "Microsoft Edge", "Visual Studio Code", "7-Zip", "PowerShell 7"].map((name, i) => ({
    name,
    version: i === 0 ? demoAgentInfo[agentId]?.agent_version ?? "0.2.9" : `${1 + i}.${12 + i}.0`,
    publisher: i === 0 ? "Sentinel" : "Demo Publisher",
    install_location: `C:\\Program Files\\${name}`,
    install_date: "20260601",
    captured_at: isoMinutesAgo(i * 8),
  }));
}

export function demoScheduledEvents(): ScheduledScriptEvent[] {
  return demoAgents.slice(0, 5).map((a, i) => ({
    script_id: demoScheduledScripts[0].id,
    agent_id: a.id,
    agent_name: a.name,
    rule_name: demoScheduledScripts[0].name,
    status: i % 4 === 0 ? "failed" : "ok",
    expected_fire_time: isoHoursAgo(i + 1),
    output: i % 4 === 0 ? "Timed out in demo mode" : "Diagnostics collected",
    is_manual: i === 0,
  }));
}

export function demoAppBlockEvents(): AppBlockEvent[] {
  return demoAgents.slice(0, 4).map((a, i) => ({
    id: i + 1,
    agent_id: a.id,
    agent_name: a.name,
    rule_id: demoAppBlockRules[i % demoAppBlockRules.length].id,
    rule_name: demoAppBlockRules[i % demoAppBlockRules.length].name,
    exe_name: i % 2 === 0 ? "steam.exe" : "tor-browser.exe",
    killed_at: isoMinutesAgo(i * 21 + 3),
  }));
}

export function demoUserFor(agentId: string): string {
  const short = agentId.replace(/[^a-z0-9]+/gi, "").slice(0, 10).toLowerCase();
  return `${short || "demo"}\\user`;
}

function agent(id: string, name: string, online: boolean, lastSeenHoursAgo: number, version: string): Agent {
  const seen = isoHoursAgo(lastSeenHoursAgo);
  return {
    id,
    name,
    icon: null,
    agent_version: version,
    online,
    first_seen: isoHoursAgo(500 + lastSeenHoursAgo),
    last_seen: seen,
    connected_at: online ? isoHoursAgo(lastSeenHoursAgo) : null,
    last_connected_at: isoHoursAgo(lastSeenHoursAgo + 2),
    last_disconnected_at: online ? null : seen,
  };
}

function range(count: number): number[] {
  return Array.from({ length: count }, (_, i) => i);
}

export function isoMinutesAgo(minutes: number): string {
  return new Date(now - minutes * 60_000).toISOString();
}

export function isoHoursAgo(hours: number): string {
  return new Date(now - hours * 3_600_000).toISOString();
}
