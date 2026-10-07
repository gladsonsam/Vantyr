import { Plus, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
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
import { useEffect, useMemo, useState } from "react";
import { api } from "@/api";
import { AppIcon } from "@/components/common/AppIcon";

interface AppBlockModalProps {
  visible: boolean;
  agentId: string;
  agentName: string;
  onDismiss: () => void;
  onCreated: () => void;
}

export function AppBlockModal({
  visible,
  agentId,
  onDismiss,
  onCreated,
}: AppBlockModalProps) {
  const [exePattern, setExePattern] = useState("");
  const [matchMode, setMatchMode] = useState<"contains" | "exact">("contains");
  const [label, setLabel] = useState("");
  const [applyToAll, setApplyToAll] = useState(false);
  const [scheduled, setScheduled] = useState(false);
  const [scheduleRows, setScheduleRows] = useState<
    Array<{ day_of_week: number; start: string; end: string }>
  >([{ day_of_week: 1, start: "00:00", end: "23:59" }]);

  const [suggestions, setSuggestions] = useState<string[]>([]);
  const [protectedExes, setProtectedExes] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [prevVisible, setPrevVisible] = useState(false);
  const [prevAgentId, setPrevAgentId] = useState(agentId);

  if (visible !== prevVisible || agentId !== prevAgentId) {
    setPrevVisible(visible);
    setPrevAgentId(agentId);
    if (visible) {
      setExePattern("");
      setMatchMode("contains");
      setLabel("");
      setApplyToAll(false);
      setScheduled(false);
      setScheduleRows([{ day_of_week: 1, start: "00:00", end: "23:59" }]);
      setError(null);
    }
  }

  // Load known exe names and protected list once when the modal opens.
  useEffect(() => {
    if (!visible) return;
    api.agentKnownExes(agentId).then((r) => setSuggestions(r.exes)).catch(() => {});
    api.appBlockProtectedExes().then((r) => setProtectedExes(r.protected)).catch(() => {});
  }, [visible, agentId]);

  const DAY_OPTIONS = useMemo(
    () => [
      { label: "Sunday", value: "0" },
      { label: "Monday", value: "1" },
      { label: "Tuesday", value: "2" },
      { label: "Wednesday", value: "3" },
      { label: "Thursday", value: "4" },
      { label: "Friday", value: "5" },
      { label: "Saturday", value: "6" },
    ],
    [],
  );

  const timeToMinute = (t: string): number | null => {
    const m = /^(\d{1,2}):(\d{2})$/.exec(t.trim());
    if (!m) return null;
    const hhRaw = parseInt(m[1], 10);
    const mmRaw = parseInt(m[2], 10);
    const mm = Math.max(0, Math.min(59, mmRaw));
    if (hhRaw === 24 && mm === 0) return 1440;
    const hh = Math.max(0, Math.min(23, hhRaw));
    return hh * 60 + mm;
  };

  const schedulesForApi = () => {
    if (!scheduled) return undefined;
    const out: { day_of_week: number; start_minute: number; end_minute: number }[] = [];
    for (const r of scheduleRows) {
      const s = timeToMinute(r.start);
      const e = timeToMinute(r.end);
      if (s == null || e == null) continue;
      if (s === e) continue;
      if (s < e) {
        out.push({ day_of_week: r.day_of_week, start_minute: s, end_minute: e });
      } else {
        // Overnight window (e.g. 22:00 → 06:00). Split across two days.
        out.push({ day_of_week: r.day_of_week, start_minute: s, end_minute: 1440 });
        out.push({ day_of_week: (r.day_of_week + 1) % 7, start_minute: 0, end_minute: e });
      }
    }
    return out;
  };

  // Check if the current pattern would hit a protected exe.
  const protectedHit = (pattern: string, mode: "contains" | "exact"): string | null => {
    const pat = pattern.trim().toLowerCase();
    if (!pat) return null;
    for (const p of protectedExes) {
      const hit = mode === "exact" ? pat === p : p.includes(pat);
      if (hit) return p;
    }
    return null;
  };

  const handleCreate = () => {
    const pattern = exePattern.trim();
    if (!pattern) {
      setError("EXE name is required.");
      return;
    }
    const hit = protectedHit(pattern, matchMode);
    if (hit) {
      setError(`'${hit}' is protected and can't be blocked.`);
      return;
    }
    setSaving(true);
    setError(null);

    if (scheduled) {
      const sched = schedulesForApi() ?? [];
      if (sched.length === 0) {
        setSaving(false);
        setError("Add a valid window (end after start).");
        return;
      }
    }

    const scopes = applyToAll
      ? [{ kind: "all" as const }]
      : [{ kind: "agent" as const, agent_id: agentId }];

    api
      .appBlockRulesCreate({
        name: label.trim() || pattern,
        exe_pattern: pattern,
        match_mode: matchMode,
        scopes,
        schedules: schedulesForApi(),
      })
      .then(() => {
        onCreated();
        onDismiss();
      })
      .catch((e) => setError(String(e)))
      .finally(() => setSaving(false));
  };

  // Filter suggestions as user types, excluding protected exes.
  const filtered = exePattern.trim()
    ? suggestions.filter((s) =>
        s.toLowerCase().includes(exePattern.trim().toLowerCase()) &&
        !protectedExes.includes(s.toLowerCase()),
      )
    : suggestions.filter((s) => !protectedExes.includes(s.toLowerCase()));

  const liveProtectedHit = protectedHit(exePattern, matchMode);

  return (
    <Dialog open={visible} onOpenChange={(open) => { if (!open) onDismiss(); }}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Add app block rule</DialogTitle>
          <DialogDescription>
            Applies on the next policy sync.
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-4">
          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}

          <Field>
            <FieldLabel htmlFor="appblock-exe">EXE name</FieldLabel>
            <Input
              id="appblock-exe"
              value={exePattern}
              onChange={(e) => setExePattern(e.target.value)}
              placeholder="e.g. tiktok.exe"
              autoFocus
            />
            {liveProtectedHit && (
              <p role="alert" className="text-[13px] text-destructive">
                '{liveProtectedHit}' is protected and can't be blocked.
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
                    onClick={() => setExePattern(s)}
                    className="flex w-full cursor-pointer items-center gap-2 px-2.5 py-1.5 text-left text-[13px] hover:bg-muted"
                  >
                    <AppIcon agentId={agentId} exeName={s} size={16} />
                    <span className="font-mono">{s}</span>
                  </button>
                ))}
              </div>
            )}
          </Field>

          <Field>
            <FieldLabel id="appblock-match-label">Match mode</FieldLabel>
            <Tabs value={matchMode} onValueChange={(v) => setMatchMode(v as "contains" | "exact")}>
              <TabsList aria-labelledby="appblock-match-label">
                <TabsTrigger value="contains">Contains</TabsTrigger>
                <TabsTrigger value="exact">Exact</TabsTrigger>
              </TabsList>
            </Tabs>
          </Field>

          <Field>
            <FieldLabel htmlFor="appblock-label">Label (optional)</FieldLabel>
            <Input
              id="appblock-label"
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              placeholder="e.g. Block TikTok"
            />
          </Field>

          <label className="flex cursor-pointer items-center gap-2 text-sm">
            <Checkbox
              checked={applyToAll}
              onCheckedChange={(checked) => setApplyToAll(checked === true)}
            />
            Apply to all devices
          </label>

          <Field>
            <FieldLabel>Schedule</FieldLabel>
            <FieldDescription>Agent's local time.</FieldDescription>
            <label className="flex cursor-pointer items-center gap-2 text-sm">
              <Checkbox
                checked={scheduled}
                onCheckedChange={(checked) => setScheduled(checked === true)}
              />
              Only during set hours
            </label>
            {scheduled ? (
              <div className="flex flex-col gap-2">
                {scheduleRows.map((r, i) => (
                  <div key={i} className="flex items-center gap-2">
                    <Select
                      value={String(r.day_of_week)}
                      onValueChange={(v) =>
                        setScheduleRows((prev) => {
                          const next = [...prev];
                          next[i] = { ...next[i], day_of_week: Number(v) };
                          return next;
                        })
                      }
                    >
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
                      onChange={(e) =>
                        setScheduleRows((prev) => {
                          const next = [...prev];
                          next[i] = { ...next[i], start: e.target.value };
                          return next;
                        })
                      }
                      placeholder="HH:MM"
                    />
                    <span className="text-sm text-muted-foreground">to</span>
                    <Input
                      type="text"
                      inputMode="numeric"
                      aria-label="Window end"
                      className="w-20"
                      value={r.end}
                      onChange={(e) =>
                        setScheduleRows((prev) => {
                          const next = [...prev];
                          next[i] = { ...next[i], end: e.target.value };
                          return next;
                        })
                      }
                      placeholder="HH:MM"
                    />
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      aria-label="Remove window"
                      disabled={scheduleRows.length <= 1}
                      onClick={() => setScheduleRows((prev) => prev.filter((_, idx) => idx !== i))}
                    >
                      <X />
                    </Button>
                  </div>
                ))}
                <div>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setScheduleRows((prev) => [...prev, { day_of_week: 1, start: "00:00", end: "23:59" }])}
                  >
                    <Plus /> Add window
                  </Button>
                </div>
                <p className="text-[13px] text-muted-foreground">
                  Overnight windows split across days.
                </p>
              </div>
            ) : null}
          </Field>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onDismiss} disabled={saving}>
            Cancel
          </Button>
          <Button
            onClick={handleCreate}
            disabled={saving || !!liveProtectedHit}
          >
            {saving && <Spinner />} Add rule
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
