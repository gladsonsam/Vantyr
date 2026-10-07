import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/api";
import { agentKeys, agentQueries } from "@/api/queries/agents";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { AGENT_ICON_DEFS, AGENT_ICON_MAP, type AgentIconKey, isAgentIconKey } from "@/features/fleet/lib/agentIcons";
import { cn } from "@/lib/utils";

/** The icon shown for this agent on the Agents overview (operators may change it). */
export function AgentIconCard({ agentId, canOperate }: { agentId: string; canOperate: boolean }) {
  const queryClient = useQueryClient();
  const iconQuery = useQuery(agentQueries.icon(agentId));
  const agentIcon: AgentIconKey = isAgentIconKey(iconQuery.data?.icon) ? iconQuery.data.icon : "monitor";
  const [pickerOpen, setPickerOpen] = useState(false);

  const save = useMutation({
    mutationFn: (next: AgentIconKey) => api.agentIconPut(agentId, next),
    onSuccess: (res) => queryClient.setQueryData(agentKeys.icon(agentId), res),
  });

  const pick = (key: AgentIconKey) => {
    queryClient.setQueryData(agentKeys.icon(agentId), { icon: key });
    setPickerOpen(false);
    if (canOperate) save.mutate(key);
  };

  const error = save.error ?? iconQuery.error;
  const Preview = AGENT_ICON_MAP[agentIcon].Icon;

  return (
    <>
      <Card className="gap-0 py-0">
        <CardHeader className="px-5 pt-5 pb-2">
          <CardTitle>Agent icon</CardTitle>
          <CardDescription>Shown on the Agents overview.</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4 px-5 pb-5">
          {error && (
            <Alert variant="destructive">
              <AlertDescription>{String(error)}</AlertDescription>
            </Alert>
          )}
          {save.isSuccess && (
            <Alert>
              <AlertDescription className="text-success">Saved.</AlertDescription>
            </Alert>
          )}
          <Field>
            <FieldLabel>Icon</FieldLabel>
            <button
              type="button"
              disabled={iconQuery.isPending || save.isPending || !canOperate}
              onClick={() => setPickerOpen(true)}
              aria-label="Change agent icon"
              className="flex size-14 items-center justify-center rounded-xl bg-muted/70 text-foreground outline-none transition-colors hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50 focus-visible:ring-2 focus-visible:ring-ring"
            >
              <Preview size={28} />
            </button>
            {!canOperate && <FieldDescription>Operators only.</FieldDescription>}
          </Field>
        </CardContent>
      </Card>

      <Dialog open={pickerOpen} onOpenChange={setPickerOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Pick an icon</DialogTitle>
          </DialogHeader>
          <div className="grid grid-cols-6 gap-1.5" role="group" aria-label="Agent icons">
            {AGENT_ICON_DEFS.map(({ key }) => {
              const Icon = AGENT_ICON_MAP[key].Icon;
              const selected = agentIcon === key;
              return (
                <button
                  key={key}
                  type="button"
                  onClick={() => pick(key)}
                  aria-label={key}
                  aria-pressed={selected}
                  className={cn(
                    "flex size-11 items-center justify-center rounded-lg bg-muted/50 text-muted-foreground outline-none transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring",
                    selected && "bg-primary/15 text-primary ring-2 ring-primary",
                  )}
                >
                  <Icon size={22} />
                </button>
              );
            })}
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
