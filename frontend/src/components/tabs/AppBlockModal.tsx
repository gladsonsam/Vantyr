import { Box, Button, Checkbox, FormField, Input, Modal, SegmentedControl, Select, SpaceBetween } from "../ui/console";
import { useEffect, useMemo, useState } from "react";
import { api } from "../../lib/api";
import { AppIcon } from "../common/AppIcon";

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
  agentName,
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
      setError(`'${hit}' is a protected system process and cannot be blocked.`);
      return;
    }
    setSaving(true);
    setError(null);

    if (scheduled) {
      const sched = schedulesForApi() ?? [];
      if (sched.length === 0) {
        setSaving(false);
        setError("Schedule is enabled but no valid windows were provided (end time must be after start time).");
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
    <Modal
      visible={visible}
      onDismiss={onDismiss}
      header="Add app block rule"
      size="medium"
      footer={
        <Box float="right">
          <SpaceBetween direction="horizontal" size="xs">
            <Button variant="link" onClick={onDismiss} disabled={saving}>
              Cancel
            </Button>
            <Button
              variant="primary"
              onClick={handleCreate}
              loading={saving}
              disabled={!!liveProtectedHit}
            >
              Add rule
            </Button>
          </SpaceBetween>
        </Box>
      }
    >
      <SpaceBetween size="m">
        {error && (
          <Box color="text-status-error" fontSize="body-s">
            {error}
          </Box>
        )}

        <FormField
          label="EXE name"
          description="The executable file name to block (e.g. tiktok.exe)."
        >
          <SpaceBetween size="xxs">
            <Input
              value={exePattern}
              onChange={({ detail }) => setExePattern(detail.value)}
              placeholder="e.g. tiktok.exe"
              autoFocus
            />
            {liveProtectedHit && (
              <Box color="text-status-error" fontSize="body-s">
                ⚠ '{liveProtectedHit}' is a protected system process and cannot be blocked.
              </Box>
            )}
            {!liveProtectedHit && filtered.length > 0 && (
              <div
                style={{
                  maxHeight: 200,
                  overflowY: "auto",
                  border: "1px solid var(--color-border-divider-default)",
                  borderRadius: 4,
                  background: "var(--color-background-container-content)",
                }}
              >
                {filtered.slice(0, 50).map((s) => (
                  <div
                    key={s}
                    onClick={() => setExePattern(s)}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 8,
                      padding: "5px 10px",
                      cursor: "pointer",
                      fontSize: 13,
                    }}
                    onMouseEnter={(e) =>
                      ((e.currentTarget as HTMLElement).style.background =
                        "var(--color-background-item-selected)")
                    }
                    onMouseLeave={(e) =>
                      ((e.currentTarget as HTMLElement).style.background = "")
                    }
                  >
                    <AppIcon agentId={agentId} exeName={s} size={16} />
                    <span style={{ fontFamily: "monospace" }}>{s}</span>
                  </div>
                ))}
              </div>
            )}
          </SpaceBetween>
        </FormField>

        <FormField label="Match mode">
          <SegmentedControl
            selectedId={matchMode}
            onChange={({ detail }) =>
              setMatchMode(detail.selectedId as "contains" | "exact")
            }
            options={[
              { id: "contains", text: "Contains" },
              { id: "exact", text: "Exact" },
            ]}
          />
        </FormField>

        <FormField label="Label" description="Optional friendly name for this rule.">
          <Input
            value={label}
            onChange={({ detail }) => setLabel(detail.value)}
            placeholder="e.g. Block TikTok"
          />
        </FormField>

        <Checkbox
          checked={applyToAll}
          onChange={({ detail }) => setApplyToAll(detail.checked)}
        >
          Apply to all devices
          {agentName?.trim() ? ` (not just ${agentName})` : ""}
        </Checkbox>

        <FormField
          label="Schedule (optional)"
          description="If enabled, this rule only applies during the specified windows in the agent's local time."
        >
          <SpaceBetween size="xs">
            <Checkbox checked={scheduled} onChange={({ detail }) => setScheduled(detail.checked)}>
              Enable schedule (curfew)
            </Checkbox>
            {scheduled ? (
              <SpaceBetween size="xs">
                {scheduleRows.map((r, i) => (
                  <SpaceBetween key={i} direction="horizontal" size="xs" alignItems="center">
                    <Select
                      selectedOption={DAY_OPTIONS.find((o) => o.value === String(r.day_of_week)) ?? DAY_OPTIONS[1]}
                      options={DAY_OPTIONS}
                      onChange={({ detail }) =>
                        setScheduleRows((prev) => {
                          const next = [...prev];
                          next[i] = { ...next[i], day_of_week: Number(detail.selectedOption.value) };
                          return next;
                        })
                      }
                    />
                    <Input
                      type="text"
                      inputMode="numeric"
                      value={r.start}
                      onChange={({ detail }) =>
                        setScheduleRows((prev) => {
                          const next = [...prev];
                          next[i] = { ...next[i], start: detail.value };
                          return next;
                        })
                      }
                      placeholder="HH:MM"
                    />
                    <Box>to</Box>
                    <Input
                      type="text"
                      inputMode="numeric"
                      value={r.end}
                      onChange={({ detail }) =>
                        setScheduleRows((prev) => {
                          const next = [...prev];
                          next[i] = { ...next[i], end: detail.value };
                          return next;
                        })
                      }
                      placeholder="HH:MM"
                    />
                    <Button
                      variant="inline-icon"
                      iconName="remove"
                      ariaLabel="Remove window"
                      disabled={scheduleRows.length <= 1}
                      onClick={() => setScheduleRows((prev) => prev.filter((_, idx) => idx !== i))}
                    />
                  </SpaceBetween>
                ))}
                <Button
                  iconName="add-plus"
                  onClick={() => setScheduleRows((prev) => [...prev, { day_of_week: 1, start: "00:00", end: "23:59" }])}
                >
                  Add window
                </Button>
                <Box fontSize="body-s" color="text-body-secondary">
                  Overnight windows (e.g. 22:00 → 06:00) are supported (they’ll be split across days automatically).
                </Box>
              </SpaceBetween>
            ) : null}
          </SpaceBetween>
        </FormField>
      </SpaceBetween>
    </Modal>
  );
}
