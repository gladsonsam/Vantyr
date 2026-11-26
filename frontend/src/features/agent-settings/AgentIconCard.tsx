import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/api";
import { agentKeys, agentQueries } from "@/api/queries/agents";
import { Alert, AlertDescription } from "@vantyr/ui/components/alert";
import { Button } from "@vantyr/ui/components/button";
import { Card, CardContent } from "@vantyr/ui/components/card";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@vantyr/ui/components/dialog";
import { Spinner } from "@vantyr/ui/components/spinner";
import {
  AGENT_ICON_DEFS,
  AGENT_ICON_MAP,
  type AgentIconKey,
  isAgentIconKey,
} from "@/features/fleet/lib/agentIcons";
import { cn } from "@/lib/utils";

/** The device's identity on this page: its name and the icon shown for it on the Agents overview (operators may change it). */
export function AgentIconCard({
  agentId,
  agentName,
  canOperate,
}: {
  agentId: string;
  agentName?: string;
  canOperate: boolean;
}) {
  const queryClient = useQueryClient();
  const iconQuery = useQuery(agentQueries.icon(agentId));
  const agentIcon: AgentIconKey = isAgentIconKey(iconQuery.data?.icon)
    ? iconQuery.data.icon
    : "monitor";
  const [pickerOpen, setPickerOpen] = useState(false);

  const save = useMutation({
    mutationFn: (next: AgentIconKey) => api.agentIconPut(agentId, next),
    onSuccess: (res) => queryClient.setQueryData(agentKeys.icon(agentId), res),
    // The picker shows the new icon at once; a refused save puts the saved one back.
    onError: () => void queryClient.invalidateQueries({ queryKey: agentKeys.icon(agentId) }),
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
        <CardContent className="flex flex-col gap-3 p-5">
          <div className="flex flex-wrap items-center gap-x-4 gap-y-3">
            <span
              aria-hidden="true"
              className="flex size-14 shrink-0 items-center justify-center rounded-xl bg-muted/70 text-foreground"
            >
              <Preview size={28} />
            </span>
            <div className="min-w-0 flex-1 basis-40">
              <p className="truncate text-base font-medium">{agentName ?? "This device"}</p>
              <p className="text-sm text-muted-foreground">
                {canOperate ? "Icon shown on the Agents overview" : "Operators can change the icon"}
              </p>
            </div>
            <Button
              variant="outline"
              size="sm"
              className="pointer-coarse:h-9"
              disabled={iconQuery.isPending || save.isPending || !canOperate}
              onClick={() => setPickerOpen(true)}
            >
              <span>Change icon</span>
              {save.isPending && <Spinner />}
            </Button>
          </div>
          {error && (
            <Alert variant="destructive">
              <AlertDescription>{String(error)}</AlertDescription>
            </Alert>
          )}
          {save.isSuccess && (
            <p role="status" className="text-sm text-success">
              Icon saved.
            </p>
          )}
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
