import { useMemo, useState } from "react";
import { useForm, useWatch } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Plus, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { api } from "@/api";
import { ruleQueries } from "@/api/queries/rules";
import { AppIcon } from "@/components/common/AppIcon";
import { firstErrorMessage } from "@/components/common/form/errors";
import { CheckboxField, InputField } from "@/components/common/form/fields";
import { FormField } from "@/components/common/form/FormField";
import { emptyScheduleRow } from "@/features/rules/lib/scheduleRows";
import { DAY_OPTIONS } from "@/features/rules/rulesUtils";
import {
  createQuickAppBlockSchema,
  DEFAULT_QUICK_APP_BLOCK,
  protectedHit,
  protectedMessage,
  quickAppBlockToBody,
  type MatchMode,
  type QuickAppBlockValues,
} from "../lib/quickAppBlock";

const NO_EXES: string[] = [];

const toExes = (r: { exes: string[] }) => r.exes;
const toProtected = (r: { protected: string[] }) => r.protected;

interface AppBlockModalProps {
  visible: boolean;
  agentId: string;
  agentName: string;
  onDismiss: () => void;
  onCreated: () => void;
}

export function AppBlockModal({ visible, agentId, onDismiss, onCreated }: AppBlockModalProps) {
  return (
    <Dialog open={visible} onOpenChange={(open) => { if (!open) onDismiss(); }}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Add app block rule</DialogTitle>
          <DialogDescription>
            Applies on the next policy sync.
          </DialogDescription>
        </DialogHeader>
        {visible && <AppBlockForm key={agentId} agentId={agentId} onDismiss={onDismiss} onCreated={onCreated} />}
      </DialogContent>
    </Dialog>
  );
}

function AppBlockForm({ agentId, onDismiss, onCreated }: Pick<AppBlockModalProps, "agentId" | "onDismiss" | "onCreated">) {
  const [error, setError] = useState<string | null>(null);

  // Known exe names and the protected list load whenever the modal opens; failures leave them empty.
  const suggestions = useQuery({ ...ruleQueries.knownExes(agentId), select: toExes }).data ?? NO_EXES;
  const protectedExes = useQuery({ ...ruleQueries.appBlockProtectedExes(), select: toProtected }).data ?? NO_EXES;
  const create = useMutation({
    mutationFn: (body: Parameters<typeof api.appBlockRulesCreate>[0]) => api.appBlockRulesCreate(body),
    onSuccess: () => {
      onCreated();
      onDismiss();
    },
    onError: (e) => setError(String(e)),
  });
  const saving = create.isPending;

  const schema = useMemo(() => createQuickAppBlockSchema(protectedExes), [protectedExes]);
  const form = useForm<QuickAppBlockValues>({
    resolver: zodResolver(schema),
    defaultValues: DEFAULT_QUICK_APP_BLOCK,
  });
  const { control } = form;
  const exePattern = useWatch({ control, name: "exe_pattern" });
  const matchMode = useWatch({ control, name: "match_mode" });
  const scheduled = useWatch({ control, name: "scheduled" });

  const submit = form.handleSubmit(
    (values) => {
      setError(null);
      create.mutate(quickAppBlockToBody(values, agentId));
    },
    (errors) => setError(firstErrorMessage(errors)),
  );

  // Filter suggestions as user types, excluding protected exes.
  const filtered = exePattern.trim()
    ? suggestions.filter((s) =>
        s.toLowerCase().includes(exePattern.trim().toLowerCase()) &&
        !protectedExes.includes(s.toLowerCase()),
      )
    : suggestions.filter((s) => !protectedExes.includes(s.toLowerCase()));

  const liveProtectedHit = protectedHit(exePattern, matchMode, protectedExes);

  return (
    <form onSubmit={submit} noValidate className="contents">
      <div className="flex flex-col gap-4">
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}

        <FormField control={control} name="exe_pattern" id="appblock-exe" label="EXE name" hideError>
          {({ field, id }) => (
            <>
              <Input id={id} {...field} placeholder="e.g. tiktok.exe" autoFocus />
              {liveProtectedHit && (
                <p role="alert" className="text-[13px] text-destructive">
                  {protectedMessage(liveProtectedHit)}
                </p>
              )}
              {!liveProtectedHit && filtered.length > 0 && (
                <div
                  role="listbox"
                  aria-label="Known executables"
                  className="max-h-50 overflow-y-auto rounded-lg bg-popover ring-1 ring-foreground/10"
                >
                  {filtered.slice(0, 50).map((s) => (
                    <button
                      key={s}
                      type="button"
                      role="option"
                      aria-selected={false}
                      onClick={() => field.onChange(s)}
                      className="flex w-full cursor-pointer items-center gap-2 px-2.5 py-1.5 text-left text-[13px] hover:bg-muted"
                    >
                      <AppIcon agentId={agentId} exeName={s} size={16} />
                      <span className="font-mono">{s}</span>
                    </button>
                  ))}
                </div>
              )}
            </>
          )}
        </FormField>

        <FormField control={control} name="match_mode" hideError>
          {({ field }) => (
            <>
              <FieldLabel id="appblock-match-label">Match mode</FieldLabel>
              <Tabs value={field.value} onValueChange={(v) => field.onChange(v as MatchMode)}>
                <TabsList aria-labelledby="appblock-match-label">
                  <TabsTrigger value="contains">Contains</TabsTrigger>
                  <TabsTrigger value="exact">Exact</TabsTrigger>
                </TabsList>
              </Tabs>
            </>
          )}
        </FormField>

        <InputField control={control} name="label" id="appblock-label" label="Label (optional)" placeholder="e.g. Block TikTok" />

        <CheckboxField control={control} name="apply_to_all" label="Apply to all devices" />

        <Field>
          <FieldLabel>Schedule</FieldLabel>
          <FieldDescription>Agent's local time.</FieldDescription>
          <CheckboxField control={control} name="scheduled" label="Only during set hours" />
          {scheduled ? (
            <FormField control={control} name="schedule_rows" hideError>
              {({ field }) => {
                const rows = field.value;
                const patchRow = (i: number, patch: Partial<(typeof rows)[number]>) => {
                  const next = [...rows];
                  next[i] = { ...next[i], ...patch };
                  field.onChange(next);
                };
                return (
                  <div className="flex flex-col gap-2">
                    {rows.map((r, i) => (
                      <div key={i} className="flex items-center gap-2">
                        <Select value={String(r.day_of_week)} onValueChange={(v) => patchRow(i, { day_of_week: Number(v) })}>
                          <SelectTrigger aria-label="Day of week" className="w-32">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            {DAY_OPTIONS.map((o) => (
                              <SelectItem key={o.value} value={o.value}>
                                {o.label}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                        <Input
                          type="text"
                          inputMode="numeric"
                          aria-label="Window start"
                          className="w-20"
                          value={r.start}
                          onChange={(e) => patchRow(i, { start: e.target.value })}
                          placeholder="HH:MM"
                        />
                        <span className="text-sm text-muted-foreground">to</span>
                        <Input
                          type="text"
                          inputMode="numeric"
                          aria-label="Window end"
                          className="w-20"
                          value={r.end}
                          onChange={(e) => patchRow(i, { end: e.target.value })}
                          placeholder="HH:MM"
                        />
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          aria-label="Remove window"
                          disabled={rows.length <= 1}
                          onClick={() => field.onChange(rows.filter((_, idx) => idx !== i))}
                        >
                          <X />
                        </Button>
                      </div>
                    ))}
                    <div>
                      <Button variant="outline" size="sm" onClick={() => field.onChange([...rows, emptyScheduleRow()])}>
                        <Plus /> Add window
                      </Button>
                    </div>
                    <p className="text-[13px] text-muted-foreground">
                      Overnight windows split across days.
                    </p>
                  </div>
                );
              }}
            </FormField>
          ) : null}
        </Field>
      </div>
      <DialogFooter>
        <Button variant="outline" onClick={onDismiss} disabled={saving}>
          Cancel
        </Button>
        <Button type="submit" disabled={saving || !!liveProtectedHit}>
          {saving && <Spinner />} Add rule
        </Button>
      </DialogFooter>
    </form>
  );
}
