import { useId, useState } from "react";

interface RowKeys<T> { rows: readonly T[]; keys: string[]; nextId: number }
/** Stable identities for controlled row editors whose API values carry no row ID.
 * Preserve unchanged rows through insertion/removal/reorder, and retain an edited
 * row's key at its position. API payloads remain free of UI-only identifiers.
 */
export function useRowKeys<T extends object>(rows: readonly T[]): readonly string[] {
  const prefix = useId();
  const [state, setState] = useState<RowKeys<T>>(() => ({ rows, keys: rows.map((_, i) => `${prefix}-${i}`), nextId: rows.length }));
  if (state.rows === rows) return state.keys;
  const previous = new Map<T, string[]>();
  state.rows.forEach((row, i) => previous.set(row, [...(previous.get(row) ?? []), state.keys[i]]));
  const keys = rows.map(row => previous.get(row)?.shift());
  const claimed = new Set(keys.filter(key => key !== undefined));
  let nextId = state.nextId;
  const resolved = keys.map((key, i) => {
    if (key !== undefined) return key;
    const prior = state.keys[i];
    if (rows.length === state.rows.length && prior !== undefined && !claimed.has(prior)) {
      claimed.add(prior);
      return prior;
    }
    return `${prefix}-${nextId++}`;
  });
  setState({ rows, keys: resolved, nextId });
  return resolved;
}
