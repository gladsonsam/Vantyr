export function page<T>(rows: T[], params: unknown): T[] {
  const p = asRecord(params);
  const offset = numberOr(p.offset, 0);
  const limit = numberOr(p.limit, rows.length);
  return rows.slice(offset, offset + limit);
}

export function asRecord(value: unknown): Record<string, unknown> {
  return value != null && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

export function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.map(String) : [];
}

export function numberOr(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}
