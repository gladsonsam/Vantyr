import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Spinner } from "@/components/ui/spinner";
import type { InternetBlockRule } from "@/api/types";
import { emptyScheduleRow, expandScheduleRows, scheduleToRows, type ScheduleFormRow, type ScheduleWindow } from "../lib/scheduleRows";
import { ScheduleRowsEditor } from "./ScheduleRowsEditor";

interface InternetScheduleDialogProps {
  rule: InternetBlockRule | null;
  saving: boolean;
  onSave: (rule: InternetBlockRule, schedules: ScheduleWindow[]) => void;
  onClose: () => void;
}

/** Edits just the schedule windows of an existing internet block rule. */
export function InternetScheduleDialog({ rule, saving, onSave, onClose }: InternetScheduleDialogProps) {
  return (
    <Dialog open={rule !== null} onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Edit schedule — {rule?.name || "Internet block"}</DialogTitle>
        </DialogHeader>
        {rule && <InternetScheduleFormBody rule={rule} saving={saving} onSave={onSave} onClose={onClose} />}
      </DialogContent>
    </Dialog>
  );
}

function InternetScheduleFormBody({ rule, saving, onSave, onClose }: Omit<InternetScheduleDialogProps, "rule"> & { rule: InternetBlockRule }) {
  const [rows, setRows] = useState<ScheduleFormRow[]>(() => scheduleToRows(rule.schedules));

  return (
    <>
      <div className="grid gap-6">
        <p className="text-sm text-muted-foreground">
          Empty schedule means <strong className="text-foreground">Always</strong>. Overnight windows (22:00 → 06:00) are supported (split automatically).
        </p>
        <ScheduleRowsEditor rows={rows} onChange={setRows} />
        <Button variant="ghost" size="sm" className="self-start" onClick={() => setRows([emptyScheduleRow()])}>
          Reset to Always
        </Button>
      </div>
      <DialogFooter>
        <Button variant="outline" onClick={onClose} disabled={saving}>
          Cancel
        </Button>
        <Button onClick={() => onSave(rule, expandScheduleRows(rows))} disabled={saving}>
          {saving && <Spinner />} Save
        </Button>
      </DialogFooter>
    </>
  );
}
