import { Download } from "lucide-react";
import type { LogSourceDesc, UpdateDialogState } from "../types";
import { Field, Modal, Notice, TextInput } from "./AgentUi";
import { Button } from "@vantyr/ui/components/button";

export function ExitModal({
  open,
  busy,
  error,
  password,
  onPassword,
  onClose,
  onConfirm,
}: {
  open: boolean;
  busy: boolean;
  error: string | null;
  password: string;
  onPassword: (value: string) => void;
  onClose: () => void;
  onConfirm: () => void;
}) {
  return (
    <Modal
      open={open}
      title="Exit agent"
      locked={busy}
      onClose={onClose}
      actions={
        <>
          <Button variant="ghost" disabled={busy} onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="destructive"
            disabled={busy || !password}
            onClick={onConfirm}
          >
            {busy ? "Exiting…" : "Exit"}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        {error ? (
          <Notice tone="error" title="Can't exit">
            {error}
          </Notice>
        ) : (
          <p className="text-sm text-muted-foreground">
            Enter the password to quit.
          </p>
        )}
        <Field label="Password">
          <TextInput
            value={password}
            onChange={(event) => onPassword(event.currentTarget.value)}
            type="password"
            autoComplete="current-password"
          />
        </Field>
      </div>
    </Modal>
  );
}

export function ClearAllLogsModal({
  open,
  busy,
  sources,
  onClose,
  onConfirm,
}: {
  open: boolean;
  busy: boolean;
  sources: LogSourceDesc[];
  onClose: () => void;
  onConfirm: () => void;
}) {
  return (
    <Modal
      open={open}
      title="Clear all logs"
      locked={busy}
      onClose={onClose}
      actions={
        <>
          <Button variant="ghost" disabled={busy} onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="destructive"
            disabled={busy || sources.length === 0}
            onClick={onConfirm}
          >
            {busy ? "Clearing…" : "Clear all"}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-2 text-sm">
        <p>
          Deletes every agent log on this device.
        </p>
        {sources.length > 0 && (
          <p className="text-muted-foreground">
            Includes: {sources.map((source) => source.label).join(", ")}
          </p>
        )}
      </div>
    </Modal>
  );
}

export function UpdateModal({
  dialog,
  onClose,
  onApply,
}: {
  dialog: UpdateDialogState;
  onClose: () => void;
  onApply: () => void;
}) {
  const title =
    dialog?.phase === "checking"
      ? "Checking for updates"
      : dialog?.phase === "uptodate"
        ? "Up to date"
        : dialog?.phase === "available"
          ? "Update available"
          : dialog?.phase === "installing"
            ? "Installing update"
            : dialog?.phase === "error"
              ? "Update check failed"
              : "";

  return (
    <Modal
      open={dialog !== null}
      title={title}
      locked={dialog?.phase === "installing"}
      onClose={onClose}
      actions={
        dialog?.phase === "checking" || dialog?.phase === "installing" ? undefined : (
          <>
            {dialog?.phase === "available" && (
              <Button variant="ghost" onClick={onClose}>
                Not now
              </Button>
            )}
            {dialog?.phase === "available" ? (
              <Button variant="default" onClick={onApply}>
                <Download size={16} aria-hidden="true" />
                Download and install
              </Button>
            ) : (
              <Button variant="default" onClick={onClose}>
                Close
              </Button>
            )}
          </>
        )
      }
    >
      {dialog?.phase === "checking" && (
        <p className="text-sm text-muted-foreground">
          Contacting update server…
        </p>
      )}
      {dialog?.phase === "uptodate" && (
        <p className="text-sm text-muted-foreground">
          This build matches the latest published Vantyr agent version.
        </p>
      )}
      {dialog?.phase === "available" && (
        <p className="text-sm">
          Version <strong>{dialog.publishedVersion}</strong> is available. The
          agent will download the installer and restart.
        </p>
      )}
      {dialog?.phase === "installing" && (
        <p className="text-sm text-muted-foreground">
          Downloading and starting the installer…
        </p>
      )}
      {dialog?.phase === "error" && (
        <p className="text-sm text-muted-foreground">{dialog.message}</p>
      )}
    </Modal>
  );
}
