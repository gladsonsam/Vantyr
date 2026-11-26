import { Download, TriangleAlert } from "lucide-react";
import type { NetworkGatewayKind } from "@/api/types";
import { Button } from "@vantyr/ui/components/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@vantyr/ui/components/dialog";
import { CopyTextButton } from "@/components/common/CopyTextButton";
import { HelpTip } from "@/components/common/HelpTip";
import { KeyValueCard, KeyValueGrid } from "@/components/common/resource-detail/KeyValueCard";
import { TimeAgo } from "@/features/network/components/TimeAgo";
import { fmtDateTime } from "@/lib/utils";

/** What the one-time response held, plus what was asked for. Lives in memory only. */
export interface IssuedToken {
  token: string;
  expiresAt: string;
  commands: string[];
  gatewayLabel: string;
  gatewayKind?: NetworkGatewayKind;
}

function download(name: string, text: string) {
  const url = URL.createObjectURL(new Blob([text], { type: "text/plain" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  link.click();
  URL.revokeObjectURL(url);
}

/**
 * The worker token, shown exactly once. It can only be dismissed with the explicit button (not by
 * Escape or a click outside), and the parent drops it from state on close.
 */
export function IssuedTokenDialog({
  issued,
  onClose,
}: {
  issued: IssuedToken | null;
  onClose: () => void;
}) {
  const slug = (issued?.gatewayLabel ?? "gateway").toLowerCase().replace(/[^a-z0-9]+/g, "-");
  return (
    <Dialog open={issued !== null} onOpenChange={() => undefined}>
      <DialogContent showCloseButton={false} className="sm:max-w-lg">
        {issued ? (
          <>
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2">
                Worker token for {issued.gatewayLabel}
                <HelpTip label="About worker tokens">
                  This token lets the gateway worker call Vantyr. It is not a person’s proxy
                  sign-in credential and not a dashboard session. Only its hash is stored.
                </HelpTip>
              </DialogTitle>
              <DialogDescription className="flex items-start gap-2 text-warning">
                <TriangleAlert className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
                You will not see this again. Copy or download it now.
              </DialogDescription>
            </DialogHeader>
            <div
              data-testid="issued-token"
              className="rounded-xl border border-border/70 bg-card/10 p-3 font-mono text-xs break-all select-all"
            >
              {issued.token}
            </div>
            <KeyValueGrid className="sm:grid-cols-2 lg:grid-cols-2 xl:grid-cols-2">
              <KeyValueCard label="Expires" format="text" title={fmtDateTime(issued.expiresAt)}>
                <TimeAgo iso={issued.expiresAt} />
              </KeyValueCard>
              <KeyValueCard label="Allowed commands" format="text">
                {issued.commands.join(", ")}
              </KeyValueCard>
            </KeyValueGrid>
            {issued.gatewayKind === "dns" &&
            issued.commands.some((c) => c === "read_dns_management" || c === "report_dns_status") ? (
              <p className="text-sm text-muted-foreground">
                Run the DNS worker with a private (mode 0600) credential file and --dns-management
                (usually together with --subscriptions). Management reports are not heartbeats.
              </p>
            ) : null}
            <div className="flex flex-wrap gap-2">
              <CopyTextButton text={issued.token} label="Copy token" />
              <Button
                variant="outline"
                size="sm"
                onClick={() =>
                  download(`${slug}.env`, `VANTYR_GATEWAY_TOKEN=${issued.token}\n`)
                }
              >
                <Download /> Download .env
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() => download(`${slug}-token.txt`, `${issued.token}\n`)}
              >
                <Download /> Download .txt
              </Button>
            </div>
            <DialogFooter>
              <Button onClick={onClose}>I have saved it</Button>
            </DialogFooter>
          </>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
