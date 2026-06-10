import { Download } from "lucide-react";
import type { LogSourceDesc, UpdateDialogState } from "../types";
import { Button, Field, Modal, Notice, Spinner, TextInput } from "./AgentUi";

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
        <div className="agent-modal-actions-row">
          <Button variant="ghost" disabled={busy} onClick={onClose}>
            Cancel
          </Button>
          <Button variant="danger" disabled={busy || !password} loading={busy} onClick={onConfirm}>
            Exit
          </Button>
        </div>
      }
    >
      <div className="agent-stack">
        {error ? (
          <Notice tone="error" title="Can't exit">
            {error}
          </Notice>
        ) : (
          <p className="agent-muted">Enter the UI access password to quit this agent.</p>
        )}
        <Field label="Password">
          <TextInput value={password} onChange={(event) => onPassword(event.currentTarget.value)} type="password" autoComplete="current-password" />
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
        <div className="agent-modal-actions-row">
          <Button variant="ghost" disabled={busy} onClick={onClose}>
            Cancel
          </Button>
          <Button variant="danger" disabled={busy || sources.length === 0} loading={busy} onClick={onConfirm}>
            Clear all
          </Button>
        </div>
      }
    >
      <div className="agent-stack">
        <p>This clears all known agent log files from this machine, not just the currently selected log.</p>
        {sources.length > 0 && <p className="agent-muted">Includes: {sources.map((source) => source.label).join(", ")}</p>}
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
          <div className="agent-modal-actions-row">
            {dialog?.phase === "available" && (
              <Button variant="ghost" onClick={onClose}>
                Not now
              </Button>
            )}
            {dialog?.phase === "available" ? (
              <Button variant="primary" icon={<Download size={16} />} onClick={onApply}>
                Download and install
              </Button>
            ) : (
              <Button variant="primary" onClick={onClose}>
                Close
              </Button>
            )}
          </div>
        )
      }
    >
      {dialog?.phase === "checking" && (
        <div className="agent-inline-state">
          <Spinner />
          Contacting update server...
        </div>
      )}
      {dialog?.phase === "uptodate" && <p className="agent-muted">This build matches the latest published Vantyr agent version.</p>}
      {dialog?.phase === "available" && (
        <p>
          Version <strong>{dialog.publishedVersion}</strong> is available. The agent will download the installer and restart.
        </p>
      )}
      {dialog?.phase === "installing" && (
        <div className="agent-inline-state">
          <Spinner />
          Downloading and starting the installer...
        </div>
      )}
      {dialog?.phase === "error" && <p className="agent-muted">{dialog.message}</p>}
    </Modal>
  );
}
