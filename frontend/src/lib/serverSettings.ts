export interface ServerSettings {
  serverOrigin: string;
  apiPrefix: string;
  wsViewerPath: string;
}

const STORAGE_KEY = "vantyr-server-settings";

const DEFAULT_SETTINGS: ServerSettings = {
  serverOrigin: "",
  apiPrefix: "/api",
  wsViewerPath: "/ws/view",
};

export function getServerSettings(): ServerSettings {
  if (typeof window === "undefined") return DEFAULT_SETTINGS;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_SETTINGS;
    const parsed = JSON.parse(raw) as Partial<ServerSettings>;
    return {
      serverOrigin: parsed.serverOrigin ?? DEFAULT_SETTINGS.serverOrigin,
      apiPrefix: parsed.apiPrefix ?? DEFAULT_SETTINGS.apiPrefix,
      wsViewerPath: parsed.wsViewerPath ?? DEFAULT_SETTINGS.wsViewerPath,
    };
  } catch {
    return DEFAULT_SETTINGS;
  }
}

export function saveServerSettings(settings: ServerSettings) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
}

export function buildApiUrl(path: string): string {
  const settings = getServerSettings();
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  const normalizedPrefix = settings.apiPrefix.startsWith("/")
    ? settings.apiPrefix
    : `/${settings.apiPrefix}`;
  const base = `${normalizedPrefix}${normalizedPath}`;
  if (!settings.serverOrigin.trim()) return base;
  return `${settings.serverOrigin.replace(/\/+$/, "")}${base}`;
}

export function buildViewerWsUrl(): string {
  const settings = getServerSettings();
  const wsPath = settings.wsViewerPath.startsWith("/")
    ? settings.wsViewerPath
    : `/${settings.wsViewerPath}`;

  if (settings.serverOrigin.trim()) {
    const origin = settings.serverOrigin.replace(/\/+$/, "");
    if (origin.startsWith("https://")) return `wss://${origin.slice("https://".length)}${wsPath}`;
    if (origin.startsWith("http://")) return `ws://${origin.slice("http://".length)}${wsPath}`;
  }

  const proto = location.protocol === "https:" ? "wss" : "ws";
  return `${proto}://${location.host}${wsPath}`;
}

