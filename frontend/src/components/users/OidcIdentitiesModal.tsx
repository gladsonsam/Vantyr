import { useState } from "react";
import { X } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Field, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import type { DashboardIdentity } from "@/lib/types";

interface OidcIdentitiesModalProps {
  visible: boolean;
  onDismiss: () => void;
  username: string;
  isNarrow: boolean;
  identities: DashboardIdentity[] | null;
  onLink: (identity: { issuer: string; subject: string }) => Promise<void>;
  onUnlink: (identityId: number) => Promise<void>;
}

export function OidcIdentitiesModal({
  visible,
  onDismiss,
  username,
  isNarrow,
  identities,
  onLink,
  onUnlink,
}: OidcIdentitiesModalProps) {
  const [identityLink, setIdentityLink] = useState({ issuer: "", subject: "" });
  const [loading, setLoading] = useState(false);

  const handleLink = async () => {
    setLoading(true);
    try {
      await onLink({
        issuer: identityLink.issuer.trim(),
        subject: identityLink.subject.trim(),
      });
      setIdentityLink({ issuer: "", subject: "" });
    } catch {
      // Handled by parent
    } finally {
      setLoading(false);
    }
  };

  return (
    <Dialog open={visible} onOpenChange={(open) => !open && onDismiss()}>
      <DialogContent className="max-h-[90svh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Linked identities: {username}</DialogTitle>
        </DialogHeader>
        <div className="flex flex-col gap-5">
          <div className={isNarrow ? "grid grid-cols-1 gap-5" : "grid grid-cols-1 gap-5 md:grid-cols-2"}>
            <Field>
              <FieldLabel htmlFor="oidc-issuer">Issuer</FieldLabel>
              <Input
                id="oidc-issuer"
                value={identityLink.issuer}
                onChange={(event) => setIdentityLink((p) => ({ ...p, issuer: event.target.value }))}
                disabled={loading}
                className="h-9 font-mono text-xs"
              />
            </Field>
            <Field>
              <FieldLabel htmlFor="oidc-subject">Subject (sub)</FieldLabel>
              <Input
                id="oidc-subject"
                value={identityLink.subject}
                onChange={(event) => setIdentityLink((p) => ({ ...p, subject: event.target.value }))}
                disabled={loading}
                className="h-9 font-mono text-xs"
              />
            </Field>
          </div>
          {identities && identities.length > 0 ? (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="px-3">Issuer</TableHead>
                  <TableHead className="px-3">Subject</TableHead>
                  <TableHead className="px-3"><span className="sr-only">Unlink</span></TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {identities.map((i) => (
                  <TableRow key={i.id}>
                    <TableCell className="px-3 py-3.5 break-all font-mono text-xs">{i.issuer}</TableCell>
                    <TableCell className="px-3 py-3.5 break-all font-mono text-xs">{i.subject}</TableCell>
                    <TableCell className="px-3 py-3.5">
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        aria-label="Unlink identity"
                        onClick={() => void onUnlink(i.id)}
                      >
                        <X />
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          ) : (
            <p className="text-sm text-muted-foreground">No linked identities.</p>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onDismiss}>
            Close
          </Button>
          <Button
            disabled={!identityLink.issuer.trim() || !identityLink.subject.trim() || loading}
            onClick={() => void handleLink()}
          >
            {loading && <Spinner />} Link identity
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
