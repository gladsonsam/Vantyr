import { useState, type FormEvent } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Plus } from "lucide-react";
import { api, errorText } from "@/api";
import { networkKeys, useGatewayMutations } from "@/api/queries/network";
import { NETWORK_GATEWAY_KINDS, type NetworkGatewayKind } from "@/api/types";
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
import { CredentialRequestFields } from "./CredentialRequestFields";
import { DEFAULT_CREDENTIAL_REQUEST, toCredentialBody } from "./credentialRequest";
import type { IssuedToken } from "./IssuedTokenDialog";

const KIND_LABEL: Record<NetworkGatewayKind, string> = { dns: "DNS", proxy: "Proxy" };

/**
 * Admin flow: kind and label create the gateway, then a first worker token is issued and handed
 * to `onIssued` (shown once by the caller). The gateway record stays if the token step fails.
 */
export function AddGatewayDialog({
  household,
  onIssued,
}: {
  household: string;
  onIssued: (issued: IssuedToken) => void;
}) {
  const queryClient = useQueryClient();
  const { create } = useGatewayMutations(household);
  const [open, setOpen] = useState(false);
  const [kind, setKind] = useState<NetworkGatewayKind>("dns");
  const [label, setLabel] = useState("");
  const [request, setRequest] = useState(DEFAULT_CREDENTIAL_REQUEST);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reset = () => {
    setKind("dns");
    setLabel("");
    setRequest(DEFAULT_CREDENTIAL_REQUEST);
    setError(null);
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const trimmed = label.trim();
    if (!trimmed || busy) return;
    setBusy(true);
    setError(null);
    let gatewayId: string;
    try {
      gatewayId = (await create.mutateAsync({ kind, label: trimmed })).id;
    } catch (e) {
      setError(errorText(e));
      setBusy(false);
      return;
    }
    try {
      const body = toCredentialBody(request);
      const issued = await api.networkGatewayCredentialIssue(household, gatewayId, body);
      void queryClient.invalidateQueries({
        queryKey: networkKeys.gatewayCredentials(household, gatewayId),
      });
      setOpen(false);
      reset();
      onIssued({
        token: issued.token,
        expiresAt: issued.expires_at,
        commands: body.commands,
        gatewayLabel: trimmed,
      });
    } catch (e) {
      setError(
        `The gateway was created, but its token couldn’t be issued (${errorText(e)}). Open it to issue one.`,
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (busy) return;
        setOpen(next);
        if (!next) reset();
      }}
    >
      <DialogTrigger render={<Button />}>
        <Plus /> Add gateway
      </DialogTrigger>
      <DialogContent className="sm:max-w-lg">
        <form onSubmit={(event) => void submit(event)} className="grid gap-4">
          <DialogHeader>
            <DialogTitle>Add gateway</DialogTitle>
            <DialogDescription>
              A gateway is a DNS or proxy worker. Next you get its worker token, shown once.
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-4 sm:grid-cols-[10rem_minmax(0,1fr)]">
            <div className="space-y-2">
              <Label htmlFor="gateway-kind">Kind</Label>
              <Select value={kind} onValueChange={(v) => setKind(v as NetworkGatewayKind)}>
                <SelectTrigger id="gateway-kind" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {NETWORK_GATEWAY_KINDS.map((k) => (
                    <SelectItem key={k} value={k}>
                      {KIND_LABEL[k]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label htmlFor="gateway-label">Label</Label>
              <Input
                id="gateway-label"
                value={label}
                onChange={(event) => setLabel(event.target.value)}
                placeholder="Home DNS"
                maxLength={80}
                autoFocus
              />
            </div>
          </div>
          <CredentialRequestFields values={request} onChange={setRequest} idPrefix="add-gateway" />
          {error ? (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          ) : null}
          <DialogFooter>
            <Button type="submit" disabled={!label.trim() || busy}>
              {busy ? <Spinner /> : null}
              Create and issue token
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
