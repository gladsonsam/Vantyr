/** The error's message, else the given fallback. */
export function messageOr(error: unknown, fallback: string): string {
  return String((error as { message?: string } | null)?.message || fallback);
}
