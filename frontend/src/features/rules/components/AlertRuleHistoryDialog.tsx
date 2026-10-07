import { useState } from "react";
import { Eye } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Empty, EmptyHeader, EmptyTitle } from "@/components/ui/empty";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { ScreenshotDialog } from "@/components/common/ScreenshotDialog";
import { fmtDateTime } from "@/lib/utils";
import type { AlertRule } from "@/api/types";
import type { AlertRuleHistoryRow } from "../hooks/useAlertRuleHistory";

/** Trigger history of one alert rule, with a screenshot preview for events that captured one. */
export function AlertRuleHistoryDialog({ rule, events, loading, onClose }: {
  rule: AlertRule | null;
  events: AlertRuleHistoryRow[];
  loading: boolean;
  onClose: () => void;
}) {
  const [previewEventId, setPreviewEventId] = useState<number | null>(null);

  return (
    <>
      <Dialog open={rule !== null} onOpenChange={(open) => { if (!open) onClose(); }}>
        <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-3xl">
          <DialogHeader>
            <DialogTitle>History — {rule?.name || rule?.pattern}</DialogTitle>
          </DialogHeader>
          {loading ? (
            <Skeleton className="h-48 w-full rounded-xl" />
          ) : events.length === 0 ? (
            <Empty className="bg-muted/50">
              <EmptyHeader>
                <EmptyTitle>No events yet</EmptyTitle>
              </EmptyHeader>
            </Empty>
          ) : (
            <div className="overflow-hidden rounded-xl bg-muted/50">
              <Table>
                <TableHeader className="[&_tr]:border-foreground/[0.06] [&_th]:h-11 [&_th]:px-3 [&_th]:text-xs [&_th]:font-medium [&_th]:text-muted-foreground">
                  <TableRow className="hover:bg-transparent">
                    <TableHead className="w-44">Time</TableHead>
                    <TableHead className="w-44">Agent</TableHead>
                    <TableHead>Matched</TableHead>
                    <TableHead className="w-28 text-right">Screenshot</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody className="[&_td]:px-3 [&_td]:py-3.5">
                  {events.map((row) => (
                    <TableRow key={row.id}>
                      <TableCell className="font-mono text-xs tabular-nums">{fmtDateTime(row.created_at)}</TableCell>
                      <TableCell>{row.agent_name}</TableCell>
                      <TableCell className="max-w-72">
                        <span className="block truncate font-mono text-xs">{row.snippet || "—"}</span>
                      </TableCell>
                      <TableCell className="text-right">
                        {row.has_screenshot
                          ? <Button variant="ghost" size="sm" onClick={() => setPreviewEventId(row.id)}><Eye /> View</Button>
                          : <span className="text-xs text-muted-foreground">—</span>}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={onClose}>Close</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <ScreenshotDialog eventId={previewEventId} onClose={() => setPreviewEventId(null)} />
    </>
  );
}
