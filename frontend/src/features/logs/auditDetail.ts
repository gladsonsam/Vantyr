export interface AuditDetailPair {
  label: string;
  value: string;
}

export interface AuditDetailView {
  pairs: AuditDetailPair[];
  /** Full payload, for a tooltip; null when there is nothing to show. */
  full: string | null;
}

const LABELS: Record<string, string> = {
  cmd_type: "Command",
  kind: "Source",
  max_kb: "Max KB",
  agent_id: "Agent",
};

function humanize(text: string): string {
  const spaced = text.replace(/_/g, " ").trim();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

function labelFor(key: string): string {
  return LABELS[key] ?? humanize(key);
}

function tryParseObject(text: string): Record<string, unknown> | null {
  const t = text.trim();
  if (!t.startsWith("{")) return null;
  try {
    const parsed: unknown = JSON.parse(t);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function formatValue(key: string, value: unknown): string {
  if (value === null || value === undefined) return "none";
  if (typeof value === "string") {
    // Errors often arrive as a JSON-encoded `{code, message}` string.
    const obj = tryParseObject(value);
    if (obj) {
      if (typeof obj.message === "string" && obj.message.trim()) return obj.message.trim();
      if (typeof obj.code === "string" && obj.code.trim()) return obj.code.replace(/_/g, " ");
    }
    return key === "error" && /^[a-z0-9_]+$/.test(value) ? value.replace(/_/g, " ") : value;
  }
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

/** Turn an audit record's raw detail payload into labelled pairs plus the full text. */
export function formatAuditDetail(action: string, detail: unknown): AuditDetailView {
  if (typeof detail === "string") {
    const text = detail.trim();
    return text ? { pairs: [{ label: "Detail", value: text }], full: text } : { pairs: [], full: null };
  }
  if (!detail || typeof detail !== "object" || Array.isArray(detail)) return { pairs: [], full: null };

  const record = detail as Record<string, unknown>;
  const keys = Object.keys(record);
  if (keys.length === 0) return { pairs: [], full: null };
  // Paging parameters alone say nothing worth showing.
  if (keys.every((k) => k === "limit" || k === "offset")) return { pairs: [], full: null };

  const full = JSON.stringify(record, null, 2);
  if (action === "view_agent_logs" && typeof record.kind === "string") {
    const pairs = [{ label: "Source", value: record.kind }];
    if (record.max_kb) pairs.push({ label: "Max KB", value: String(record.max_kb) });
    return { pairs, full };
  }
  return { pairs: keys.map((k) => ({ label: labelFor(k), value: formatValue(k, record[k]) })), full };
}
