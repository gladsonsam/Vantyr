import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import type { Agent, AgentGroup } from "@/api/types";
import {
  defaultInternetBlockForm,
  internetBlockFormToBody,
  SCHEDULE_NEEDS_WINDOW,
  type InternetBlockForm,
  type InternetBlockRuleBody,
} from "../lib/internetBlockForm";
import { expandScheduleRows } from "../lib/scheduleRows";
import { ScheduleRowsEditor } from "./ScheduleRowsEditor";
import { ScopeRowsEditor } from "./ScopeRowsEditor";

interface InternetBlockRuleDialogProps {
  open: boolean;
  groups: AgentGroup[];
  agents: Agent[];
  saving: boolean;
  onSave: (body: InternetBlockRuleBody) => void;
  /** Reports a validation message (or clears it with null). */
  onValidationError: (message: string | null) => void;
  onClose: () => void;
}

/** Create dialog for an internet block rule. */
export function InternetBlockRuleDialog({ open, onClose, ...rest }: InternetBlockRuleDialogProps) {
  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) onClose(); }}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>New internet block rule</DialogTitle>
        </DialogHeader>
        {open && <InternetBlockRuleFormBody onClose={onClose} {...rest} />}
      </DialogContent>
    </Dialog>
  );
}

function InternetBlockRuleFormBody({ groups, agents, saving, onSave, onValidationError, onClose }: Omit<InternetBlockRuleDialogProps, "open">) {
  const [form, setForm] = useState<InternetBlockForm>(defaultInternetBlockForm);

  const createRule = () => {
    onValidationError(null);
    if (form.scheduled && expandScheduleRows(form.schedule_rows).length === 0) {
      onValidationError(SCHEDULE_NEEDS_WINDOW);
      return;
    }
    onSave(internetBlockFormToBody(form));
  };

  return (
    <>
      <div className="grid gap-6">
        <Field>
          <FieldLabel htmlFor="inet-name">Name (optional)</FieldLabel>
          <Input
            id="inet-name"
            className="h-9"
            value={form.name}
            onChange={(event) => setForm({ ...form, name: event.target.value })}
            placeholder="e.g. Block school devices"
          />
        </Field>
        <Field>
          <FieldLabel>Scope</FieldLabel>
          <ScopeRowsEditor rows={form.scopes} onChange={(scopes) => setForm({ ...form, scopes })} groups={groups} agents={agents} divided={false} />
          <FieldDescription>Who this rule blocks.</FieldDescription>
        </Field>

        <Field>
          <FieldLabel>Schedule (optional)</FieldLabel>
          <div className="flex flex-col gap-3">
            <label className="flex cursor-pointer items-center gap-2 text-sm">
              <Checkbox checked={form.scheduled} onCheckedChange={(checked) => setForm({ ...form, scheduled: checked === true })} />
              Enable schedule (curfew)
            </label>
            {form.scheduled && (
              <>
                <ScheduleRowsEditor rows={form.schedule_rows} onChange={(schedule_rows) => setForm({ ...form, schedule_rows })} />
                <p className="text-xs text-muted-foreground">
                  Overnight windows (e.g. 22:00 → 06:00) are supported (they’ll be split across days automatically).
                </p>
              </>
            )}
          </div>
          <FieldDescription>If enabled, this rule only applies during these windows in the agent’s local time.</FieldDescription>
        </Field>
      </div>
      <DialogFooter>
        <Button variant="outline" onClick={onClose}>Cancel</Button>
        <Button onClick={createRule} disabled={saving}>
          {saving && <Spinner />} Create
        </Button>
      </DialogFooter>
    </>
  );
}
