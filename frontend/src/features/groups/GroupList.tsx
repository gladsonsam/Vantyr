import { useState } from "react";
import { Link } from "react-router-dom";
import { BellRing, MoreHorizontal, Monitor, Pencil, Users } from "lucide-react";
import { Button } from "@vantyr/ui/components/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@vantyr/ui/components/dropdown-menu";
import type { AgentGroup } from "@/api/types";
import { plural } from "./groupSummary";

export type GroupAction = "members" | "rename" | "rule" | "delete";

interface GroupListProps {
  groups: AgentGroup[];
  /** Alert rules that target each group; null while unknown (the rule list is loading or failed). */
  ruleCounts: Map<string, number> | null;
  onAction: (group: AgentGroup, action: GroupAction) => void;
}

/** One row per group: identity, what it holds, then its actions. Same layout from phone to desktop. */
export function GroupList({ groups, ruleCounts, onAction }: GroupListProps) {
  return (
    <ul aria-label="Agent groups" className="overflow-hidden rounded-xl bg-card">
      {groups.map((g) => (
        <li
          key={g.id}
          className="flex flex-col gap-3 border-b border-foreground/[0.06] p-4 last:border-b-0 sm:flex-row sm:items-center sm:gap-4"
        >
          <div className="min-w-0 flex-1">
            <h3 className="truncate text-base font-medium">{g.name}</h3>
            <Description text={g.description} />
            <p className="mt-1.5 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
              <span className="inline-flex items-center gap-1.5 tabular-nums">
                <Monitor className="size-3.5" aria-hidden /> {plural(g.member_count, "device")}
              </span>
              <RuleSummary count={ruleCounts?.get(g.id) ?? (ruleCounts ? 0 : null)} />
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <Button
              variant="outline"
              className="pointer-coarse:h-9"
              onClick={() => onAction(g, "members")}
            >
              <Users /> Members
            </Button>
            <Button
              variant="ghost"
              className="pointer-coarse:h-9"
              aria-label={`Edit ${g.name}`}
              onClick={() => onAction(g, "rename")}
            >
              <Pencil /> Edit
            </Button>
            <DropdownMenu>
              <DropdownMenuTrigger
                render={
                  <Button
                    variant="ghost"
                    size="icon"
                    className="pointer-coarse:size-9"
                    aria-label={`More actions for ${g.name}`}
                  />
                }
              >
                <MoreHorizontal />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-56">
                <DropdownMenuItem onClick={() => onAction(g, "rule")}>
                  New alert rule for this group
                </DropdownMenuItem>
                <DropdownMenuItem variant="destructive" onClick={() => onAction(g, "delete")}>
                  Delete group…
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </li>
      ))}
    </ul>
  );
}

function RuleSummary({ count }: { count: number | null }) {
  // Unknown is left out rather than shown as "no rules", which would be a claim.
  if (count === null) return null;
  return (
    <Link
      to="/rules"
      className="inline-flex items-center gap-1.5 rounded-sm outline-none hover:text-foreground hover:underline focus-visible:ring-2 focus-visible:ring-ring/50"
    >
      <BellRing className="size-3.5" aria-hidden />
      {count === 0 ? "No alert rules" : plural(count, "alert rule")}
    </Link>
  );
}

/** A group's description, cut to two lines with a way to read the rest. */
function Description({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  const value = text.trim();
  if (!value) return null;
  const long = value.length > 90;
  return (
    <div className="mt-0.5 text-sm text-muted-foreground">
      <p className={open || !long ? "break-words" : "line-clamp-2 break-words"}>{value}</p>
      {long && (
        <button
          type="button"
          aria-expanded={open}
          className="rounded-sm text-xs underline-offset-2 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring/50 pointer-coarse:py-2"
          onClick={() => setOpen((v) => !v)}
        >
          {open ? "Show less" : "Show more"}
        </button>
      )}
    </div>
  );
}
