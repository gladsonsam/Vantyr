import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { X } from "lucide-react";
import { Button } from "@vantyr/ui/components/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@vantyr/ui/components/dialog";
import { Spinner } from "@vantyr/ui/components/spinner";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@vantyr/ui/components/table";
import { InputField } from "@/components/common/form/fields";
import type { DashboardIdentity } from "@/api/types";
import { linkIdentitySchema, type LinkIdentityValues } from "./userSchemas";

interface OidcIdentitiesModalProps {
  visible: boolean;
  onDismiss: () => void;
  username: string;
  isNarrow: boolean;
  identities: DashboardIdentity[] | null;
  onLink: (identity: LinkIdentityValues) => Promise<void>;
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
  return (
    <Dialog open={visible} onOpenChange={(open) => !open && onDismiss()}>
      <DialogContent className="max-h-[90svh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Linked identities: {username}</DialogTitle>
        </DialogHeader>
        {visible && (
          <OidcIdentitiesForm onDismiss={onDismiss} isNarrow={isNarrow} identities={identities} onLink={onLink} onUnlink={onUnlink} />
        )}
      </DialogContent>
    </Dialog>
  );
}

function OidcIdentitiesForm({ onDismiss, isNarrow, identities, onLink, onUnlink }: Omit<OidcIdentitiesModalProps, "visible" | "username">) {
  const form = useForm<LinkIdentityValues>({
    resolver: zodResolver(linkIdentitySchema),
    mode: "onChange",
    defaultValues: { issuer: "", subject: "" },
  });
  const { isValid, isSubmitting } = form.formState;

  const submit = form.handleSubmit(async (values) => {
    try {
      await onLink(values);
      form.reset();
    } catch {
      // The parent reports the failure.
    }
  });

  return (
    <form onSubmit={submit} noValidate className="contents">
      <div className="flex flex-col gap-5">
        <div className={isNarrow ? "grid grid-cols-1 gap-5" : "grid grid-cols-1 gap-5 md:grid-cols-2"}>
          <InputField control={form.control} name="issuer" id="oidc-issuer" label="Issuer" disabled={isSubmitting} className="h-9 font-mono text-xs" hideError />
          <InputField control={form.control} name="subject" id="oidc-subject" label="Subject (sub)" disabled={isSubmitting} className="h-9 font-mono text-xs" hideError />
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
        <Button type="submit" disabled={!isValid || isSubmitting}>
          {isSubmitting && <Spinner />} Link identity
        </Button>
      </DialogFooter>
    </form>
  );
}
