import { useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { Unlink } from "lucide-react";
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
import { InputField } from "@/components/common/form/fields";
import type { DashboardIdentity } from "@/api/types";
import { DialogError, ErrorBanner } from "./UserDialogParts";
import { messageOr } from "./messageOr";
import { linkIdentitySchema, type LinkIdentityValues } from "./userSchemas";

interface OidcIdentitiesModalProps {
  visible: boolean;
  onDismiss: () => void;
  /** Where focus goes when the dialog closes. */
  finalFocus?: () => HTMLElement | null;
  /** What the account is called (full name or username). */
  name: string;
  /** The identities the server last sent; null until the first load succeeds. */
  identities: DashboardIdentity[] | null;
  /** Why the last load failed. With `identities` set, they are from the last successful load. */
  loadError: string | null;
  loading: boolean;
  onReload: () => void;
  /** Reject with why the identity could not be linked / unlinked; the dialog shows it. */
  onLink: (identity: LinkIdentityValues) => Promise<void>;
  onUnlink: (identityId: number) => Promise<void>;
}

export function OidcIdentitiesModal({ visible, onDismiss, finalFocus, name, ...rest }: OidcIdentitiesModalProps) {
  // The dialog can't be dismissed while a link or unlink request is in flight.
  const [busy, setBusy] = useState(false);
  return (
    <Dialog open={visible} onOpenChange={(open) => !open && !busy && onDismiss()}>
      <DialogContent finalFocus={finalFocus} className="max-h-[calc(100dvh-1rem)] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="break-words">Linked identities for {name}</DialogTitle>
          <DialogDescription>Signing in through any of these identity-provider accounts opens this account.</DialogDescription>
        </DialogHeader>
        {visible && <OidcIdentitiesBody onDismiss={onDismiss} onBusyChange={setBusy} busy={busy} name={name} {...rest} />}
      </DialogContent>
    </Dialog>
  );
}

/** One linked identity; unlinking asks first, in the row, because that account can no longer sign in. */
function IdentityRow({ identity, name, disabled, onUnlink }: { identity: DashboardIdentity; name: string; disabled: boolean; onUnlink: (id: number) => Promise<void> }) {
  const [asking, setAsking] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const confirm = async () => {
    setRemoving(true);
    setError(null);
    try {
      await onUnlink(identity.id);
      setAsking(false);
    } catch (e: unknown) {
      setError(messageOr(e, "Failed to unlink identity"));
    } finally {
      setRemoving(false);
    }
  };

  return (
    <li className="flex flex-col gap-2 border-b border-foreground/[0.06] p-3 last:border-b-0">
      <div className="flex items-start gap-3">
        <dl className="grid min-w-0 flex-1 gap-1 text-xs">
          <div>
            <dt className="text-muted-foreground">Issuer</dt>
            <dd className="font-mono break-all">{identity.issuer}</dd>
          </div>
          <div>
            <dt className="text-muted-foreground">Subject</dt>
            <dd className="font-mono break-all">{identity.subject}</dd>
          </div>
        </dl>
        {!asking && (
          <Button type="button" variant="ghost" size="icon-sm" className="pointer-coarse:size-9" aria-label={`Unlink identity ${identity.subject}`} disabled={disabled} onClick={() => setAsking(true)}>
            <Unlink />
          </Button>
        )}
      </div>
      {asking && (
        <div className="flex flex-col gap-2 rounded-lg bg-muted/60 p-3 text-sm">
          <p>{name} will no longer be able to sign in with this identity.</p>
          <div className="flex flex-wrap gap-2">
            <Button type="button" variant="destructive" size="sm" disabled={removing} onClick={() => void confirm()}>
              {removing && <Spinner />} Unlink
            </Button>
            <Button type="button" variant="outline" size="sm" disabled={removing} onClick={() => { setAsking(false); setError(null); }}>
              Keep linked
            </Button>
          </div>
        </div>
      )}
      <DialogError prefix="Couldn't unlink" message={error} />
    </li>
  );
}

function IdentityList({ identities, loadError, loading, name, busy, onReload, onUnlink }: Pick<OidcIdentitiesModalProps, "identities" | "loadError" | "loading" | "onReload" | "onUnlink"> & { name: string; busy: boolean }) {
  if (!identities) {
    return loadError ? (
      <ErrorBanner message={`Couldn't load linked identities: ${loadError}`} onRetry={onReload} retrying={loading} />
    ) : (
      <p role="status" className="flex items-center gap-2 text-sm text-muted-foreground">
        <Spinner /> Loading linked identities…
      </p>
    );
  }
  return (
    <div className="flex flex-col gap-3">
      {loadError && <ErrorBanner message={`Couldn't refresh linked identities: ${loadError}. Showing the list from the last successful load.`} onRetry={onReload} retrying={loading} />}
      {identities.length === 0 ? (
        <p className="text-sm text-muted-foreground">No linked identities.</p>
      ) : (
        <ul aria-label="Linked identities" className="rounded-lg bg-muted/40">
          {identities.map((i) => (
            <IdentityRow key={i.id} identity={i} name={name} disabled={busy} onUnlink={onUnlink} />
          ))}
        </ul>
      )}
    </div>
  );
}

function OidcIdentitiesBody({ onDismiss, onBusyChange, busy, name, onLink, onUnlink, ...list }: Omit<OidcIdentitiesModalProps, "visible"> & { onBusyChange: (busy: boolean) => void; busy: boolean }) {
  const form = useForm<LinkIdentityValues>({
    resolver: zodResolver(linkIdentitySchema),
    mode: "onChange",
    defaultValues: { issuer: "", subject: "" },
  });
  const { isValid, isSubmitting } = form.formState;
  const [error, setError] = useState<string | null>(null);

  const submit = form.handleSubmit(async (values) => {
    onBusyChange(true);
    setError(null);
    try {
      await onLink(values);
      form.reset();
    } catch (e: unknown) {
      setError(messageOr(e, "Failed to link identity"));
    } finally {
      onBusyChange(false);
    }
  });

  const unlink = async (id: number) => {
    onBusyChange(true);
    try {
      await onUnlink(id);
    } finally {
      onBusyChange(false);
    }
  };

  return (
    <>
      <IdentityList {...list} name={name} busy={busy} onUnlink={unlink} />
      <form onSubmit={submit} noValidate aria-label="Link an identity" className="flex flex-col gap-4 border-t border-foreground/[0.06] pt-4">
        <h3 className="text-sm font-medium">Link another identity</h3>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <InputField control={form.control} name="issuer" id="oidc-issuer" label="Issuer" placeholder="https://idp.example.com" disabled={isSubmitting} autoComplete="off" className="h-9 font-mono text-xs" hideError />
          <InputField control={form.control} name="subject" id="oidc-subject" label="Subject (sub)" disabled={isSubmitting} autoComplete="off" className="h-9 font-mono text-xs" hideError />
        </div>
        <DialogError prefix="Couldn't link" message={error} />
        <Button type="submit" className="self-start" disabled={!isValid || isSubmitting || busy}>
          {isSubmitting && <Spinner />} Link identity
        </Button>
      </form>
      <DialogFooter>
        <Button type="button" variant="outline" disabled={busy} onClick={onDismiss}>
          Close
        </Button>
      </DialogFooter>
    </>
  );
}
