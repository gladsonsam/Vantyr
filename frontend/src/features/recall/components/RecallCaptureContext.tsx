import { parseRecallContext } from "@/features/recall/lib/recallContext";
import type { RecallContextReason, RecallContextStatus } from "@/api/types";
const reasonLabels: Record<RecallContextReason, string> = {
  module_disabled: "local module disabled",
  revoked: "permission revoked",
  unsupported: "provider unsupported",
  no_foreground: "no foreground identity available",
  not_browser: "no verified browser",
  read_failed: "read failed",
  sample_timeout: "sampling timed out",
  changed: "foreground changed during sampling",
  identity_unverified: "identity unverified",
  invalid_url: "host unavailable",
  invalid_context: "metadata invalid",
};
function stateLabel(
  status: RecallContextStatus,
  reason: RecallContextReason | null,
) {
  const label =
    status === "not_collected"
      ? "Not collected"
      : status === "uncertain"
        ? "Uncertain"
        : "Unknown";
  return `${label}${reason ? ` (${reasonLabels[reason]})` : ""}`;
}
type Context = ReturnType<typeof parseRecallContext>;
const EVIDENCE =
  "Foreground observed around capture. It may differ from the apps visible on this display.";
function foregroundLabel(context: Context) {
  if (!context) return "No context recorded (older or unavailable metadata)";
  return context.window.status === "observed"
    ? (context.window.app ?? "Unknown app identity")
    : stateLabel(context.window.status, context.window.reason);
}
function monitorEvidence(context: Context) {
  if (!context)
    return "Missing context does not mean no app or browser was present.";
  if (context.monitor_relation === "same")
    return "Foreground window was on this display.";
  if (context.monitor_relation === "other")
    return "Foreground window was on another display.";
  return "Its display is unknown.";
}
function ContextTitle({ context }: { context: NonNullable<Context> }) {
  if (context.window.status !== "observed" || !context.window.title)
    return null;
  return (
    <span>
      Title: {context.window.title}
      {context.window.title_truncated ? " (truncated)" : ""}
    </span>
  );
}
function BrowserContext({ context }: { context: NonNullable<Context> }) {
  const label =
    context.browser.status === "observed"
      ? (context.browser.url_host ?? "Unknown host")
      : stateLabel(context.browser.status, context.browser.reason);
  return <span>Site around capture: {label}</span>;
}
/** Always scoped to the supplied frame/hit; never consults live window telemetry. */
export function RecallCaptureContext({
  context,
  compact = false,
}: {
  context: unknown;
  compact?: boolean;
}) {
  const parsed = parseRecallContext(context);
  const Wrapper = compact ? "span" : "div";
  return (
    <Wrapper className="recall-capture-context" title={EVIDENCE}>
      <span>
        <strong>Foreground app around capture: </strong>
        {foregroundLabel(parsed)}
      </span>
      {parsed && (
        <>
          <ContextTitle context={parsed} />
          <BrowserContext context={parsed} />
        </>
      )}
      {!compact && (
        <details className="recall-context-about">
          <summary>About this context</summary>
          <p className="recall-context-evidence">
            {EVIDENCE} {monitorEvidence(parsed)}
          </p>
        </details>
      )}
    </Wrapper>
  );
}
