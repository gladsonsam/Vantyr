export interface ScriptOutcome {
  /** ok: the script ran and exited 0; failed: it ran and exited non-zero; error: it didn't run to the end. */
  tone: "ok" | "failed" | "error";
  headline: string;
  stdout: string;
  stderr: string;
  /** Why it didn't run to the end, when the device or server said. */
  error: string | null;
}

const text = (value: unknown): string => (typeof value === "string" ? value : "");

/**
 * Reads the device's reply to a script run. Success is claimed only when the reply says `ok`;
 * anything else says what it can (exit code, or the error the device returned).
 */
export function describeScriptResult(result: Record<string, unknown>): ScriptOutcome {
  const exit = typeof result.exit_code === "number" ? result.exit_code : null;
  const error = text(result.error) || null;
  const base = { stdout: text(result.stdout), stderr: text(result.stderr), error };
  if (exit !== null && (result.ok !== true || exit !== 0)) {
    return { ...base, tone: "failed", headline: `Failed · exit code ${exit}` };
  }
  if (result.ok === true) {
    return { ...base, tone: "ok", headline: exit === null ? "Finished" : `Finished · exit code ${exit}` };
  }
  return { ...base, tone: "error", headline: "Didn’t finish" };
}
