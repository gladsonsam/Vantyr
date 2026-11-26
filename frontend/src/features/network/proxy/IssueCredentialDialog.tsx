import { useState, type FormEvent } from "react";
import { useQuery } from "@tanstack/react-query";
import { KeyRound, TriangleAlert } from "lucide-react";
import { errorText } from "@/api";
import { networkQueries } from "@/api/queries/network";
import { Button } from "@vantyr/ui/components/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@vantyr/ui/components/dialog";
import { Input } from "@vantyr/ui/components/input";
import { Label } from "@vantyr/ui/components/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@vantyr/ui/components/select";
import { Spinner } from "@vantyr/ui/components/spinner";
import { CopyTextButton } from "@/components/common/CopyTextButton";
import { HelpTip } from "@/components/common/HelpTip";
import { KeyValueCard, KeyValueGrid } from "@/components/common/resource-detail/KeyValueCard";
import { TimeAgo } from "@/features/network/components/TimeAgo";
import type { IssuedProxyCredential } from "@/features/network/runtime/types";
import { useIssueProxyCredentialMutation } from "@/features/network/runtime/useRuntimeQueries";
import { fmtDateTime } from "@/lib/utils";
import { EXPIRY_OPTIONS, PROXY_CREDENTIAL_HELP, suggestLabel } from "./proxyAccessLib";

const ANY_DEVICE = "__any__";
const UNAVAILABLE = "Proxy sign-in isn’t available on this server yet.";

/** The proxy sign-in secret, shown exactly once. Only the explicit button closes it; the parent wipes it. */
function SecretDialog({
  issued,
  onClose,
}: {
  issued: IssuedProxyCredential | null;
  onClose: () => void;
}) {
  return (
    <Dialog open={issued !== null} onOpenChange={() => undefined}>
      <DialogContent showCloseButton={false} className="sm:max-w-lg">
        {issued ? (
          <>
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2">
                Proxy sign-in secret for {issued.credential.personLabel ?? "this person"}
                <HelpTip label="About proxy sign-in credentials">{PROXY_CREDENTIAL_HELP}</HelpTip>
              </DialogTitle>
              <DialogDescription className="flex items-start gap-2 text-warning">
                <TriangleAlert className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
                You will not see this again. Copy it now; it cannot be recovered.
              </DialogDescription>
            </DialogHeader>
            <div
              data-testid="issued-proxy-secret"
              className="rounded-xl border border-border/70 bg-card/10 p-3 font-mono text-xs break-all select-all"
            >
              {issued.secret}
            </div>
            <KeyValueGrid className="sm:grid-cols-2 lg:grid-cols-2 xl:grid-cols-2">
              <KeyValueCard label="Credential" format="text">
                {issued.credential.label}
              </KeyValueCard>
              <KeyValueCard
                label="Expires"
                format="text"
                title={fmtDateTime(issued.credential.expiresAt ?? undefined)}
              >
                <TimeAgo iso={issued.credential.expiresAt} />
              </KeyValueCard>
            </KeyValueGrid>
            <div className="flex flex-wrap gap-2">
              <CopyTextButton text={issued.secret} label="Copy secret" />
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

/**
 * Issue a proxy sign-in credential for a person, optionally tied to one device. The secret appears once
 * in its own dialog and is dropped from memory (including the mutation state) when that closes.
 */
export function IssueCredentialDialog({
  household,
  fixedDeviceId,
  triggerLabel = "Issue credential",
  variant = "default",
}: {
  household: string;
  /** Locks the device (the device's own Proxy tab). */
  fixedDeviceId?: string;
  triggerLabel?: string;
  variant?: "default" | "outline";
}) {
  const issue = useIssueProxyCredentialMutation();
  const persons = useQuery(networkQueries.persons(household));
  const devices = useQuery(networkQueries.devices(household));
  const people = persons.data?.persons ?? [];
  const deviceList = devices.data?.devices ?? [];

  const [open, setOpen] = useState(false);
  const [personId, setPersonId] = useState<string | null>(null);
  const [deviceId, setDeviceId] = useState<string>(fixedDeviceId ?? ANY_DEVICE);
  const [label, setLabel] = useState("");
  const [labelEdited, setLabelEdited] = useState(false);
  const [hours, setHours] = useState<number>(24);
  const [error, setError] = useState<string | null>(null);
  const [issued, setIssued] = useState<IssuedProxyCredential | null>(null);

  const effectiveDevice = fixedDeviceId ?? deviceId;
  const realDevice = effectiveDevice === ANY_DEVICE ? null : effectiveDevice;
  const personName = people.find((p) => p.id === personId)?.display_name;
  const deviceName = deviceList.find((d) => d.id === realDevice)?.label;

  const refreshLabel = (person: string | undefined, device: string | undefined) => {
    if (!labelEdited) setLabel(suggestLabel(person, device));
  };

  const reset = () => {
    setPersonId(null);
    setDeviceId(fixedDeviceId ?? ANY_DEVICE);
    setLabel("");
    setLabelEdited(false);
    setHours(24);
    setError(null);
    issue.reset();
  };

  const trimmed = label.trim();
  const problem = !personId
    ? "Choose who this credential is for."
    : !trimmed
      ? "Give the credential a label."
      : null;

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (problem || !personId || issue.isPending) return;
    setError(null);
    try {
      const result = await issue.mutateAsync({
        personId,
        deviceId: realDevice,
        label: trimmed,
        expiresInHours: hours,
      });
      if (result.state === "unavailable") {
        setError(UNAVAILABLE);
        return;
      }
      setOpen(false);
      setIssued(result.data);
    } catch (e) {
      setError(errorText(e));
    }
  };

  const closeSecret = () => {
    setIssued(null);
    issue.reset();
    reset();
  };

  return (
    <>
      <Dialog
        open={open}
        onOpenChange={(next) => {
          if (issue.isPending) return;
          setOpen(next);
          if (!next) reset();
        }}
      >
        <DialogTrigger render={<Button variant={variant} size="sm" />}>
          <KeyRound /> {triggerLabel}
        </DialogTrigger>
        <DialogContent className="sm:max-w-lg">
          <form onSubmit={(event) => void submit(event)} className="grid gap-4">
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2">
                Issue a proxy sign-in credential
                <HelpTip label="What is this?">{PROXY_CREDENTIAL_HELP}</HelpTip>
              </DialogTitle>
              <DialogDescription>
                Next you get its secret, shown once. Signing in with it is evidence, not proof of who
                is using the device.
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-2">
              <Label htmlFor="proxy-cred-person">Person</Label>
              <Select
                value={personId}
                onValueChange={(v) => {
                  const next = v as string | null;
                  setPersonId(next);
                  refreshLabel(people.find((p) => p.id === next)?.display_name, deviceName);
                }}
              >
                <SelectTrigger id="proxy-cred-person" className="w-full">
                  <SelectValue placeholder="Choose person" />
                </SelectTrigger>
                <SelectContent>
                  {people.map((p) => (
                    <SelectItem key={p.id} value={p.id}>
                      {p.display_name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label htmlFor="proxy-cred-device">Device (optional)</Label>
              <Select
                value={effectiveDevice}
                disabled={fixedDeviceId !== undefined}
                onValueChange={(v) => {
                  const next = (v as string | null) ?? ANY_DEVICE;
                  setDeviceId(next);
                  refreshLabel(personName, deviceList.find((d) => d.id === next)?.label);
                }}
              >
                <SelectTrigger id="proxy-cred-device" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={ANY_DEVICE}>Any device</SelectItem>
                  {deviceList.map((d) => (
                    <SelectItem key={d.id} value={d.id}>
                      {d.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="grid gap-4 sm:grid-cols-[minmax(0,1fr)_10rem]">
              <div className="space-y-2">
                <Label htmlFor="proxy-cred-label">Label</Label>
                <Input
                  id="proxy-cred-label"
                  value={label}
                  maxLength={80}
                  onChange={(event) => {
                    setLabel(event.target.value);
                    setLabelEdited(true);
                  }}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="proxy-cred-expiry">Expires after</Label>
                <Select value={String(hours)} onValueChange={(v) => setHours(Number(v))}>
                  <SelectTrigger id="proxy-cred-expiry" className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {EXPIRY_OPTIONS.map((o) => (
                      <SelectItem key={o.hours} value={String(o.hours)}>
                        {o.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
            {error ? (
              <p role="alert" className="text-sm text-destructive">
                {error}
              </p>
            ) : problem && (personId !== null || labelEdited) ? (
              <p className="text-sm text-muted-foreground">{problem}</p>
            ) : null}
            <DialogFooter>
              <Button type="submit" disabled={problem !== null || issue.isPending}>
                {issue.isPending ? <Spinner /> : null}
                Issue credential
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
      <SecretDialog issued={issued} onClose={closeSecret} />
    </>
  );
}
