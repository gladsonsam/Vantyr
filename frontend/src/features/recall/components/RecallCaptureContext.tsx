import { parseRecallContext } from "@/features/recall/lib/recallContext";
import type { RecallContextReason, RecallContextStatus } from "@/api/types";
const reasonLabels: Record<RecallContextReason,string> = {module_disabled:"local module disabled",revoked:"permission revoked",unsupported:"provider unsupported",no_foreground:"no foreground identity available",not_browser:"no verified browser",read_failed:"read failed",sample_timeout:"sampling timed out",changed:"foreground changed during sampling",identity_unverified:"identity unverified",invalid_url:"host unavailable",invalid_context:"metadata invalid"};
function stateLabel(status: RecallContextStatus, reason: RecallContextReason | null) {
  const label=status==="not_collected" ? "Not collected" : status==="uncertain" ? "Uncertain" : "Unknown";
  return `${label}${reason ? ` (${reasonLabels[reason]})` : ""}`;
}
/** Always scoped to the supplied frame/hit; never consults live window telemetry. */
export function RecallCaptureContext({context,compact=false}:{context:unknown;compact?:boolean}) {
  const c=parseRecallContext(context);
  const evidence="Foreground observed around capture. It may differ from the apps visible on this display.";
  const Wrapper=compact ? "span" : "div";
  return <Wrapper className="recall-capture-context" title={evidence}>
    <span><strong>Foreground app around capture: </strong>{!c ? "No context recorded (older or unavailable metadata)" : c.window.status==="observed" ? c.window.app ?? "Unknown app identity" : stateLabel(c.window.status,c.window.reason)}</span>
    {c?.window.status==="observed" && c.window.title && <span>Title: {c.window.title}{c.window.title_truncated ? " (truncated)" : ""}</span>}
    {c && <span>Site around capture: {c.browser.status==="observed" ? c.browser.url_host ?? "Unknown host" : stateLabel(c.browser.status,c.browser.reason)}</span>}
    {!compact && <details className="recall-context-about"><summary>About this context</summary><p className="recall-context-evidence">{evidence} {c ? c.monitor_relation==="same" ? "Foreground window was on this display." : c.monitor_relation==="other" ? "Foreground window was on another display." : "Its display is unknown." : "Missing context does not mean no app or browser was present."}</p></details>}
  </Wrapper>;
}
