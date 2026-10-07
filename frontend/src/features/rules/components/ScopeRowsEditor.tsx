import { Plus, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { FormSelect } from "@/components/common/form/FormSelect";
import type { Agent, AgentGroup } from "@/api/types";
import { updateScopeRow } from "../lib/scopeRows";
import { emptyScopeRow, type ScopeFormRow } from "../rulesUtils";

const SCOPE_OPTIONS = [
  { label: "All agents", value: "all" },
  { label: "Agent group", value: "group" },
  { label: "Single agent", value: "agent" },
];

/** Rows of "all agents / a group / one agent" pickers shared by the rule editors. */
export function ScopeRowsEditor({ rows, onChange, groups, agents, divided = true }: {
  rows: ScopeFormRow[];
  onChange: (rows: ScopeFormRow[]) => void;
  groups: AgentGroup[];
  agents: Agent[];
  /** Draw a hairline under each row. */
  divided?: boolean;
}) {
  const groupOptions = groups.map((g) => ({ label: g.name, value: g.id }));
  const agentOptions = agents.map((a) => ({ label: a.name, value: a.id }));
  const rowClass = divided
    ? "flex flex-wrap items-center gap-2 border-b border-foreground/[0.06] pb-3"
    : "flex flex-wrap items-center gap-2";

  return (
    <div className="flex flex-col gap-3">
      {rows.map((s, i) => (
        <div key={i} className={rowClass}>
          <div className="min-w-36 flex-1">
            <FormSelect
              ariaLabel={`Scope ${i + 1} kind`}
              value={s.kind}
              options={SCOPE_OPTIONS}
              onChange={(value) => onChange(updateScopeRow(rows, i, { kind: value as ScopeFormRow["kind"] }))}
            />
          </div>
          {s.kind === "group" && (
            <div className="min-w-36 flex-1">
              <FormSelect
                ariaLabel={`Scope ${i + 1} group`}
                placeholder="Select group"
                value={s.group_id}
                options={groupOptions}
                onChange={(value) => onChange(updateScopeRow(rows, i, { group_id: value }))}
              />
            </div>
          )}
          {s.kind === "agent" && (
            <div className="min-w-36 flex-1">
              <FormSelect
                ariaLabel={`Scope ${i + 1} agent`}
                placeholder="Select agent"
                value={s.agent_id}
                options={agentOptions}
                onChange={(value) => onChange(updateScopeRow(rows, i, { agent_id: value }))}
              />
            </div>
          )}
          {rows.length > 1 && (
            <Button variant="ghost" size="sm" aria-label={`Remove scope ${i + 1}`} onClick={() => onChange(rows.filter((_, j) => j !== i))}>
              <X /> Remove
            </Button>
          )}
        </div>
      ))}
      <Button variant="ghost" size="sm" className="self-start" onClick={() => onChange([...rows, emptyScopeRow()])}>
        <Plus /> Add scope
      </Button>
    </div>
  );
}
