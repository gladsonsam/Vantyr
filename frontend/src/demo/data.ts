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
} from "@/api/types";

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
    url: "https://github.com/example/vantyr/pull/482",
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
    window: "Figma - Vantyr UI",
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
    window: "Vantyr - Visual Studio Code",
    url: "http://localhost:5173/",
  },
};

export const demoAgentInfo: Record<string, AgentInfo> = Object.fromEntries(
  demoAgents.map((a, index) => [
    a.id,
    {
      agent_version: a.agent_version ?? "0.2.9",
      // Demo input stays inside the synthetic WebSocket; expose it so the
      // confirmed-lease controls can be exercised without a real device.
      capabilities: { remote_input: "supported", clipboard: "supported" },
      hostname: a.name,
      uptime_secs: a.online ? (index + 2) * 36_200 : undefined,
      system_model: index % 2 === 0 ? "ThinkPad T14" : "OptiPlex 7090",
      system_manufacturer: index % 2 === 0 ? "Lenovo" : "Dell Inc.",
      os_name: a.name.includes("MBP")
        ? "macOS"
        : a.name.includes("BUILD")
          ? "Ubuntu"
          : "Windows 11 Pro",
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
      // Even-indexed demo agents are dual-monitor so the screen-viewer monitor
      // picker is visible in demo mode; odd-indexed agents are single-monitor.
      monitors:
        index % 2 === 0
          ? [
              { index: 0, name: "Display 1", width: 2560, height: 1440, primary: true },
              { index: 1, name: "Display 2", width: 1920, height: 1080, primary: false },
            ]
          : [{ index: 0, name: "Display 1", width: 1920, height: 1080, primary: true }],
      config_agent_name: a.name,
      config_server_url: "wss://demo.vantyr.local/ws/agent",
      config_ui_password_set: true,
      ts: Math.floor(now / 1000),
    },
  ]),
);

// The first demo agent reports a fuller machine (several drives and adapters, long values) so the
// Specs view can be checked against realistic data, not just the one-drive default.
Object.assign(demoAgentInfo["win11dev"], {
  system_serial: "PF3DEMO0042",
  motherboard_manufacturer: "Micro-Star International Co., Ltd.",
  motherboard_model: "PRO B550M-VC WIFI (MS-7C95)",
  os_long_version: "Windows 11 Pro 23H2 (build 22631.4460)",
  timezone: "Australia/Sydney",
  install_path:
    "C:\\Program Files\\Vantyr Agent\\Customer Support Tools\\Remote Monitoring\\vantyr-agent.exe",
  config_path: "C:\\Users\\Demo\\AppData\\Roaming\\Vantyr\\agent-config.toml",
  config_server_url:
    "wss://demo.vantyr.local/ws/agent?token=demo-not-a-real-token-0123456789abcdef",
  capabilities: {
    remote_input: "supported",
    clipboard: "supported",
    audio_capture: "limited",
    software_inventory: "supported",
    terminal: "needs_permission",
    system_control: "unsupported",
  },
  drives: [
    {
      name: "C:",
      mount_point: "C:\\",
      file_system: "NTFS",
      total_gb: 930.52,
      available_gb: 826.09,
    },
    {
      name: "Data",
      mount_point: "D:\\",
      file_system: "exFAT",
      total_gb: 1862.4,
      available_gb: 120.3,
    },
    {
      name: "Backups",
      mount_point: "E:\\Backups",
      file_system: "NTFS",
      total_gb: 465.76,
      available_gb: 41.2,
    },
  ],
  adapters: [
    {
      name: "Ethernet",
      description: "Realtek PCIe 2.5GbE Family Controller",
      mac: "02-00-5E-10-00-00",
      ips: ["10.0.2.20", "fe80::a4ac:1498:9525:34ba"],
      gateways: ["10.0.2.1"],
      dns: ["1.1.1.1", "8.8.8.8", "1.1.1.1"],
    },
    {
      name: "WiFi",
      description: "Intel Wi-Fi 6 AX200",
      mac: "02-00-5E-10-00-10",
      ips: ["169.254.42.42", "fe80::9e2d:8547:877c:7bb6"],
      gateways: [],
      dns: ["10.0.2.3"],
    },
    {
      name: "Bluetooth Network Connection",
      description: "Bluetooth Device (Personal Area Network)",
      mac: "02-00-5E-10-00-70",
      ips: ["169.254.36.104"],
      gateways: [],
      dns: [],
    },
    {
      name: "Loopback Pseudo-Interface 1",
      description: "Software Loopback Interface 1",
      mac: "",
      ips: ["127.0.0.1", "::1"],
      gateways: [],
      dns: [],
    },
  ],
});

export const demoGroups: AgentGroup[] = [
  {
    id: "grp-workstations",
    name: "Workstations",
    description: "Employee laptops and desktops",
    created_at: isoHoursAgo(900),
    member_count: 5,
  },
  {
    id: "grp-kiosks",
    name: "Kiosks",
    description: "Shared unattended machines",
    created_at: isoHoursAgo(720),
    member_count: 2,
  },
  {
    id: "grp-build",
    name: "Build fleet",
    description: "CI and automation hosts",
    created_at: isoHoursAgo(480),
    member_count: 1,
  },
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
  {
    id: 3,
    name: "High CPU sustained",
    channel: "resource",
    pattern: "",
    match_mode: "substring",
    case_insensitive: false,
    cooldown_secs: 600,
    enabled: true,
    take_screenshot: false,
    scopes: [{ kind: "all" }],
  },
  {
    id: 4,
    name: "Agent offline > 10m",
    channel: "agent_offline",
    pattern: "",
    match_mode: "substring",
    case_insensitive: false,
    cooldown_secs: 1800,
    enabled: true,
    take_screenshot: false,
    scopes: [{ kind: "all" }],
  },
  {
    id: 5,
    name: "Gambling sites",
    channel: "url",
    pattern: "bet365.com|stake.com",
    match_mode: "regex",
    case_insensitive: true,
    cooldown_secs: 300,
    enabled: true,
    take_screenshot: true,
    scopes: [{ kind: "all" }],
  },
  {
    id: 6,
    name: "Adult content",
    channel: "url_category",
    pattern: "adult",
    match_mode: "substring",
    case_insensitive: true,
    cooldown_secs: 120,
    enabled: false,
    take_screenshot: false,
    scopes: [{ kind: "group", group_id: "grp-kiosks" }],
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
  {
    id: 12,
    name: "Block crypto miners",
    exe_pattern: "xmrig.exe",
    match_mode: "exact",
    enabled: true,
    created_at: isoHoursAgo(96),
    scopes: [{ kind: "all" }],
    schedules: [],
  },
  {
    id: 13,
    name: "Block remote tools",
    exe_pattern: "anydesk",
    match_mode: "contains",
    enabled: true,
    created_at: isoHoursAgo(12),
    scopes: [
      { kind: "group", group_id: "grp-workstations" },
      { kind: "group", group_id: "grp-kiosks" },
      { kind: "agent", agent_id: "sitting-room" },
    ],
    schedules: [1, 2, 3, 4, 5].map((day_of_week) => ({
      day_of_week,
      start_minute: 9 * 60,
      end_minute: 17 * 60,
    })),
  },
  {
    id: 14,
    name: "Block torrent clients",
    exe_pattern: "qbittorrent.exe",
    match_mode: "exact",
    enabled: false,
    created_at: isoHoursAgo(200),
    scopes: [{ kind: "all" }],
    schedules: [],
  },
  {
    id: 15,
    name: "Kiosk: lock to browser",
    exe_pattern: "cmd.exe",
    match_mode: "exact",
    enabled: true,
    created_at: isoHoursAgo(60),
    scopes: [{ kind: "group", group_id: "grp-kiosks" }],
    schedules: [
      { day_of_week: 5, start_minute: 22 * 60, end_minute: 1440 },
      { day_of_week: 6, start_minute: 0, end_minute: 6 * 60 },
    ],
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
  {
    id: 21,
    name: "",
    enabled: false,
    created_at: isoHoursAgo(30),
    scopes: [{ kind: "all" }],
    schedules: [],
  },
  {
    id: 22,
    name: "School nights",
    enabled: true,
    created_at: isoHoursAgo(10),
    scopes: [
      { kind: "group", group_id: "grp-workstations" },
      { kind: "agent", agent_id: "sitting-room" },
    ],
    schedules: [
      { day_of_week: 0, start_minute: 21 * 60, end_minute: 1440 },
      { day_of_week: 1, start_minute: 0, end_minute: 7 * 60 },
    ],
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
    scopes: [{ kind: "all", group_id: null, agent_id: null }],
    schedules: [
      { frequency: "daily", day_of_week: null, fire_minute: 3 * 60 },
      { frequency: "hourly", day_of_week: null, fire_minute: 15 },
    ],
  },
  {
    id: 31,
    name: "Clear temp files",
    shell: "powershell",
    script: "Remove-Item $env:TEMP\\* -Recurse -Force -ErrorAction SilentlyContinue",
    timeout_secs: 120,
    enabled: true,
    created_at: isoHoursAgo(72),
    updated_at: isoHoursAgo(8),
    scopes: [{ kind: "group", group_id: "grp-workstations", agent_id: null }],
    schedules: [{ frequency: "weekly", day_of_week: 1, fire_minute: 2 * 60 }],
  },
  {
    id: 32,
    name: "Windows update check",
    shell: "powershell",
    script: "Get-WindowsUpdate -AcceptAll -Install -AutoReboot",
    timeout_secs: 300,
    enabled: true,
    created_at: isoHoursAgo(48),
    updated_at: isoHoursAgo(12),
    scopes: [{ kind: "all", group_id: null, agent_id: null }],
    schedules: [{ frequency: "weekly", day_of_week: 6, fire_minute: 1 * 60 }],
  },
  {
    id: 33,
    name: "Restart print spooler",
    shell: "cmd",
    script: "net stop spooler && net start spooler",
    timeout_secs: 60,
    enabled: false,
    created_at: isoHoursAgo(120),
    updated_at: isoHoursAgo(30),
    scopes: [{ kind: "group", group_id: "grp-kiosks", agent_id: null }],
    schedules: [{ frequency: "daily", day_of_week: null, fire_minute: 5 * 60 }],
  },
  {
    id: 34,
    name: "Sync inventory",
    shell: "bash",
    script: "vantyr-agent --collect-software",
    timeout_secs: 90,
    enabled: true,
    created_at: isoHoursAgo(36),
    updated_at: isoHoursAgo(2),
    scopes: [{ kind: "all", group_id: null, agent_id: null }],
    schedules: [{ frequency: "daily", day_of_week: null, fire_minute: 4 * 60 }],
  },
];

export function demoWindows(agentId: string, count = 24): WindowEvent[] {
  const titles = [
    "Vantyr - Visual Studio Code",
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
    "https://github.com/example/vantyr",
    "https://docs.rs/tokio/latest/tokio/",
    "https://cloudscape.design/components/",
    "https://news.ycombinator.com/",
    "https://outlook.office.com/mail/",
  ];
  // Every few rows: a campaign link with a wall of tracking parameters, and a bare domain with no title.
  const trackedUrl =
    "https://www.example-shop.test/products/garden-chairs/summer-sale?utm_source=ads&utm_medium=cpc&utm_campaign=AU_EN_KWD_ACQ&ad_group=164750731181&gad_campaignid=21746669725&gclid=Cj0KCQiAdemoTrackingValue0123456789";
  return range(count).map((i) => ({
    id: i + 1,
    url:
      i % 7 === 3
        ? trackedUrl
        : i % 9 === 4
          ? "https://example.org/"
          : urls[(i + agentId.length) % urls.length],
    title:
      i % 9 === 4
        ? null
        : i % 7 === 3
          ? "Garden chairs — summer sale"
          : ["GitHub", "Tokio docs", "Cloudscape", "Hacker News", "Outlook"][i % 5],
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
    window_title: i % 2 === 0 ? "Vantyr - Visual Studio Code" : "PowerShell",
    text:
      i % 3 === 0
        ? "[demo keystroke session redacted] " +
          "Meeting notes for the quarterly review: budget, hiring plan and roadmap. ".repeat(6) +
          "[⌫][⌫]\nNext steps:\n- send summary\n- book follow-up\n- archive the old board"
        : "[demo keystroke session redacted]",
    started_at: isoMinutesAgo(i * 17 + 5),
    updated_at: isoMinutesAgo(i * 17 + 2),
    user: demoUserFor(agentId),
  }));
}

export function demoActivity(agentId: string, count = 18): ActivityEvent[] {
  return range(count).map((i) => ({
    event_type: i % 4 === 0 ? "afk" : "active",
    idle_secs: i % 4 === 0 ? 300 + i * 20 : null,
    ts: isoMinutesAgo(i * 9 + agentId.length),
    user: demoUserFor(agentId),
  }));
}

const DEMO_SOFTWARE: Array<[string, string, string, string]> = [
  ["Vantyr Agent", "", "Vantyr", "20260601"],
  ["Microsoft Edge", "142.0.3595.65", "Microsoft Corporation", "20261120"],
  ["Visual Studio Code", "1.96.2", "Microsoft Corporation", "20261104"],
  ["7-Zip 24.08 (x64)", "24.08", "Igor Pavlov", "20260822"],
  ["PowerShell 7-x64", "7.4.6.0", "Microsoft Corporation", "20260811"],
  [
    "Microsoft Visual C++ 2022 X64 Additional Runtime - 14.40.33816",
    "14.40.33816",
    "Microsoft Corporation",
    "20260709",
  ],
  [
    "Microsoft Visual C++ 2022 X64 Minimum Runtime - 14.40.33816",
    "14.40.33816",
    "Microsoft Corporation",
    "20260709",
  ],
  [
    "Python 3.12.4 Core Interpreter (64-bit)",
    "3.12.4150.0",
    "Python Software Foundation",
    "20260518",
  ],
  ["Git", "2.47.1", "The Git Development Community", "20260517"],
  [
    "Adobe Acrobat Reader - Enterprise Managed Deployment with Extended Language Pack and Accessibility Tools",
    "24.005.20320",
    "Adobe",
    "20260301",
  ],
  ["Node.js", "22.12.0", "Node.js Foundation", "20260215"],
  ["Zoom Workplace (64-bit)", "6.3.0 (47000)", "Zoom Communications, Inc.", "20260110"],
  ["Mozilla Firefox (x64 en-US)", "133.0", "Mozilla", "20251207"],
  ["VLC media player", "3.0.21", "VideoLAN", "20250914"],
  ["Unknown vendor utility", "1.0", "", ""],
];

export function demoSoftware(agentId: string): AgentSoftwareRow[] {
  const rows = DEMO_SOFTWARE.map(([name, version, publisher, date], i) => ({
    name,
    version: version || (demoAgentInfo[agentId]?.agent_version ?? "0.2.9"),
    publisher: publisher || null,
    install_location: `C:\\Program Files\\${name.split(" ")[0]}`,
    install_date: date || null,
    captured_at: isoMinutesAgo(i * 8),
  }));
  // The first agent has a long inventory so sorting and paging can be exercised.
  if (agentId !== "win11dev") return rows.slice(0, 5);
  const extra = Array.from({ length: 48 }, (_, i) => ({
    name: `Demo component ${String(i + 1).padStart(2, "0")} (x64)`,
    version: `${1 + (i % 4)}.${i}.0`,
    publisher: i % 3 === 0 ? "Demo Publisher" : i % 3 === 1 ? "Contoso Ltd." : "Fabrikam, Inc.",
    install_location: null,
    install_date: `2025${String(1 + (i % 12)).padStart(2, "0")}${String(1 + (i % 27)).padStart(2, "0")}`,
    captured_at: isoMinutesAgo(i),
  }));
  return [...rows, ...extra];
}

export function demoScheduledEvents(): ScheduledScriptEvent[] {
  const outcomes = [
    { status: "failed", output: "--- STDERR ---\nAccess is denied.\n--- ERROR ---\nExit code 1" },
    {
      status: "success",
      output:
        "--- STDOUT ---\nOsName      OsVersion\n------      ---------\nWindows 11  10.0.26100\n",
    },
    { status: "success", output: "--- STDOUT ---\nDiagnostics collected\n" },
    { status: "skipped_offline", output: null },
    { status: "fired", output: null },
  ];
  return demoAgents.slice(0, 5).map((a, i) => ({
    script_id: demoScheduledScripts[0].id,
    agent_id: a.id,
    agent_name: a.name,
    rule_name: demoScheduledScripts[0].name,
    status: outcomes[i].status,
    expected_fire_time: isoHoursAgo(1),
    output: outcomes[i].output,
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

function demoUserFor(agentId: string): string {
  const short = agentId
    .replace(/[^a-z0-9]+/gi, "")
    .slice(0, 10)
    .toLowerCase();
  return `${short || "demo"}\\user`;
}

function agent(
  id: string,
  name: string,
  online: boolean,
  lastSeenHoursAgo: number,
  version: string,
): Agent {
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
