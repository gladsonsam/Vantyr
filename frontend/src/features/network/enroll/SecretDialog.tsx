import { TriangleAlert } from "lucide-react";
import { errorText } from "@/api";
import type { NetworkSetupGrantIssued } from "@/api/types";
import { Button } from "@vantyr/ui/components/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@vantyr/ui/components/dialog";
import { Spinner } from "@vantyr/ui/components/spinner";
import { CopyTextButton } from "@/components/common/CopyTextButton";
import { HelpTip } from "@/components/common/HelpTip";
import { KeyValueCard, KeyValueGrid } from "@/components/common/resource-detail/KeyValueCard";
import { fmtDateTime } from "@/lib/utils";
import { formatCountdown, purposeLabel, useSecondsLeft } from "./enrollLib";

/**
 * The setup grant secret, shown exactly once. It closes only through an explicit button, and the
 * parent drops it from state on close.
 */
export function SecretDialog({
  issued,
  deviceLabel,
  verifying,
  verifyError,
  onVerify,
  onClose,
}: {
  issued: NetworkSetupGrantIssued | null;
  deviceLabel: string;
  verifying: boolean;
  verifyError: unknown;
  onVerify: () => void;
  onClose: () => void;
}) {
  const left = useSecondsLeft(issued?.expires_at ?? null);
  return (
    <Dialog open={issued !== null} onOpenChange={() => undefined}>
      <DialogContent showCloseButton={false} className="sm:max-w-lg">
        {issued ? (
          <>
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2">
                Setup grant for {deviceLabel}
                <HelpTip label="About setup grants">
                  This secret is neither a proxy sign-in credential nor a gateway token. No
                  certificate or setup script is delivered with it. It only lets you verify this
                  device against your dashboard sign-in session.
                </HelpTip>
              </DialogTitle>
              <DialogDescription className="flex items-start gap-2 text-warning">
                <TriangleAlert className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
                Shown once. You will not see this secret again.
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-3">
              <div>
                <div className="mb-1 text-xs text-muted-foreground">Grant id</div>
                <div className="rounded-xl border border-border/70 bg-card/10 p-3 font-mono text-xs break-all select-all">
                  {issued.grant_id}
                </div>
              </div>
              <div>
                <div className="mb-1 text-xs text-muted-foreground">Secret</div>
                <div className="rounded-xl border border-border/70 bg-card/10 p-3 font-mono text-xs break-all select-all">
                  {issued.secret}
                </div>
              </div>
            </div>
            <KeyValueGrid className="sm:grid-cols-2 lg:grid-cols-2 xl:grid-cols-2">
              <KeyValueCard label="Purpose" format="text">
                {purposeLabel(issued.purpose)}
              </KeyValueCard>
              <KeyValueCard label="Expires in" format="text" title={fmtDateTime(issued.expires_at)}>
                {left > 0 ? formatCountdown(left) : "Expired"}
              </KeyValueCard>
            </KeyValueGrid>
            <p className="text-[0.8125rem] text-muted-foreground">{issued.note}</p>
            <div className="flex flex-wrap gap-2">
              <CopyTextButton text={issued.secret} label="Copy secret" />
              <CopyTextButton text={issued.grant_id} label="Copy grant id" />
            </div>
            {verifyError ? (
              <p role="alert" className="text-sm text-destructive">
                {errorText(verifyError)}
              </p>
            ) : null}
            <DialogFooter>
              <Button variant="outline" disabled={verifying || left === 0} onClick={onVerify}>
                {verifying ? <Spinner /> : null} Verify this device now
              </Button>
              <Button onClick={onClose}>I have saved it</Button>
            </DialogFooter>
          </>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
