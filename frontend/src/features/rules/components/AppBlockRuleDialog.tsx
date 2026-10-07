import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import type { Agent, AgentGroup, AppBlockRule } from "@/api/types";
import {
  appBlockFormToBody,
  appBlockRuleToForm,
  defaultAppBlockForm,
  type AppBlockForm,
  type AppBlockRuleBody,
} from "../lib/appBlockForm";
import { ScheduleRowsEditor } from "./ScheduleRowsEditor";
import { ScopeRowsEditor } from "./ScopeRowsEditor";

export type AppBlockRuleDialogTarget = null | { mode: "create" } | { mode: "edit"; rule: AppBlockRule };

interface AppBlockRuleDialogProps {
  target: AppBlockRuleDialogTarget;
  groups: AgentGroup[];
  agents: Agent[];
  /** Seeds the scope of a legacy single-agent rule. */
  contextAgentId: string;
  saving: boolean;
  onSave: (id: number | null, body: AppBlockRuleBody) => void;
  /** Reports a validation message (or clears it with null). */
  onValidationError: (message: string | null) => void;
  onClose: () => void;
}

/** Create/edit dialog for one app block rule. */
export function AppBlockRuleDialog({ target, onClose, ...rest }: AppBlockRuleDialogProps) {
  return (
    <Dialog open={target !== null} onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>
            {target?.mode === "edit"
              ? `Edit app block rule — ${target.rule.name || target.rule.exe_pattern || ""}`
              : "Add app block rule"}
          </DialogTitle>
        </DialogHeader>
        {target && <AppBlockRuleFormBody target={target} onClose={onClose} {...rest} />}
      </DialogContent>
    </Dialog>
  );
}

function AppBlockRuleFormBody({ target, groups, agents, contextAgentId, saving, onSave, onValidationError, onClose }: Omit<AppBlockRuleDialogProps, "target"> & { target: NonNullable<AppBlockRuleDialogTarget> }) {
  const [form, setForm] = useState<AppBlockForm>(() => (
    target.mode === "edit" ? appBlockRuleToForm(target.rule, contextAgentId) : defaultAppBlockForm()
  ));

  const saveRule = () => {
    if (!form.exe_pattern.trim()) {
      onValidationError("EXE name is required.");
      return;
    }
    onSave(target.mode === "create" ? null : target.rule.id, appBlockFormToBody(form));
  };

  return (
    <>
      <div className="grid gap-6">
        <Field>
          <FieldLabel htmlFor="appblock-exe">EXE name</FieldLabel>
          <Input
            id="appblock-exe"
            className="h-9"
            value={form.exe_pattern}
            onChange={(event) => setForm({ ...form, exe_pattern: event.target.value })}
            placeholder="e.g. tiktok.exe"
          />
          <FieldDescription>Executable file name to block (e.g. tiktok.exe).</FieldDescription>
        </Field>
        <Field>
          <FieldLabel>Match mode</FieldLabel>
          <ToggleGroup
            size="sm"
            spacing={0}
            className="rounded-lg bg-muted/70 p-0.5"
            aria-label="Match mode"
            value={[form.match_mode]}
            onValueChange={(value) => {
              const next = value[0] as "contains" | "exact" | undefined;
              if (next) setForm({ ...form, match_mode: next });
            }}
          >
            <ToggleGroupItem value="contains" aria-label="Contains" className="rounded-md! px-3 aria-pressed:bg-background">
              Contains
            </ToggleGroupItem>
            <ToggleGroupItem value="exact" aria-label="Exact" className="rounded-md! px-3 aria-pressed:bg-background">
              Exact
            </ToggleGroupItem>
          </ToggleGroup>
        </Field>
        <Field>
          <FieldLabel htmlFor="appblock-label">Label</FieldLabel>
          <Input
            id="appblock-label"
            className="h-9"
            value={form.label}
            onChange={(event) => setForm({ ...form, label: event.target.value })}
            placeholder="Optional"
          />
        </Field>
        <Field>
          <FieldLabel>Scope</FieldLabel>
          <ScopeRowsEditor rows={form.scopes} onChange={(scopes) => setForm({ ...form, scopes })} groups={groups} agents={agents} />
          <FieldDescription>Which agents this rule applies to.</FieldDescription>
        </Field>

        <Field>
          <FieldLabel>Schedule (optional)</FieldLabel>
          <div className="flex flex-col gap-3">
            <label className="flex cursor-pointer items-center gap-2 text-sm">
              <Checkbox checked={form.scheduled} onCheckedChange={(checked) => setForm({ ...form, scheduled: checked === true })} />
              Enable schedule (curfew)
            </label>
            {form.scheduled && (
              <ScheduleRowsEditor rows={form.schedule_rows} onChange={(schedule_rows) => setForm({ ...form, schedule_rows })} />
            )}
          </div>
          <FieldDescription>
            If enabled, this rule only applies during these windows in the agent&apos;s local time. Overnight windows are supported (e.g. 22:00 → 06:00).
          </FieldDescription>
        </Field>
      </div>
      <DialogFooter>
        <Button variant="outline" onClick={onClose} disabled={saving}>
          Cancel
        </Button>
        <Button onClick={saveRule} disabled={saving}>
          {saving && <Spinner />} {target.mode === "create" ? "Add rule" : "Save"}
        </Button>
      </DialogFooter>
    </>
  );
}
