import { useQuery } from "@tanstack/react-query";
import { Button } from "@vantyr/ui/components/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@vantyr/ui/components/dialog";
import { Empty, EmptyHeader, EmptyTitle } from "@vantyr/ui/components/empty";
import { Skeleton } from "@vantyr/ui/components/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@vantyr/ui/components/table";
import { ruleQueries } from "@/api/queries/rules";
import { fmtDateTime } from "@/lib/utils";
import type { AppBlockEvent, AppBlockRule } from "@/api/types";

const NO_EVENTS: AppBlockEvent[] = [];
const HISTORY_PAGE = { limit: 200 };
const toEvents = (d: { rows: AppBlockEvent[] }) => d.rows;

/** Recent kills for one app block rule. */
export function AppBlockHistoryDialog({ rule, onClose }: { rule: AppBlockRule | null; onClose: () => void }) {
  const historyQuery = useQuery({
    ...ruleQueries.appBlockEventsForRule(rule?.id ?? 0, HISTORY_PAGE),
    enabled: rule !== null,
    select: toEvents,
  });
  // A failed history load shows an empty list.
  const events = historyQuery.isError ? NO_EVENTS : historyQuery.data ?? NO_EVENTS;

  return (
    <Dialog open={rule !== null} onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>Kill history — {rule?.name || rule?.exe_pattern}</DialogTitle>
        </DialogHeader>
        {historyQuery.isFetching ? (
          <Skeleton className="h-48 w-full rounded-xl" />
        ) : events.length === 0 ? (
          <Empty className="bg-muted/50">
            <EmptyHeader>
              <EmptyTitle>No kills recorded yet</EmptyTitle>
            </EmptyHeader>
          </Empty>
        ) : (
          <div className="overflow-hidden rounded-xl bg-muted/50">
            <Table>
              <TableHeader className="[&_tr]:border-foreground/[0.06] [&_th]:h-11 [&_th]:px-3 [&_th]:text-xs [&_th]:font-medium [&_th]:text-muted-foreground">
                <TableRow className="hover:bg-transparent">
                  <TableHead className="w-44">Time</TableHead>
                  <TableHead className="w-44">Agent</TableHead>
                  <TableHead>EXE</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody className="[&_td]:px-3 [&_td]:py-3.5">
                {events.map((row) => (
                  <TableRow key={row.id}>
                    <TableCell className="font-mono text-xs tabular-nums">{fmtDateTime(row.killed_at)}</TableCell>
                    <TableCell>{row.agent_name}</TableCell>
                    <TableCell>
                      <span className="font-mono text-xs">{row.exe_name}</span>
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
  );
}
