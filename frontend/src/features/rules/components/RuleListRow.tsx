import type { ComponentType, ReactNode } from "react";
import { MoreHorizontal, Trash2 } from "lucide-react";
import { Button } from "@vantyr/ui/components/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@vantyr/ui/components/dropdown-menu";
import { Switch } from "@/components/common/SettingsSwitch";

/** The list of rule rows inside a card; each row is a `RuleRow`. */
export function RuleList({ label, children }: { label: string; children: ReactNode }) {
  return <ul aria-label={label}>{children}</ul>;
}

/** One small fact about a rule: an icon, then text that may be long and wraps instead of being cut off. */
export function RuleFact({ icon: Icon, title, children }: { icon: ComponentType<{ className?: string; "aria-hidden"?: boolean }>; title?: string; children: ReactNode }) {
  return (
    <span className="inline-flex min-w-0 items-start gap-1.5" title={title}>
      <Icon className="mt-0.5 size-3.5 shrink-0" aria-hidden />
      <span className="min-w-0 break-words">{children}</span>
    </span>
  );
}

/**
 * One rule: its on/off switch, a title, a line saying what it is, a line of facts (where it applies, when),
 * and its actions. The switch shows what the server last confirmed, never a hopeful guess.
 */
export function RuleRow({ enabled, switchLabel, switchDisabled, onToggle, title, lead, state, facts, actions }: {
  enabled: boolean;
  switchLabel: string;
  switchDisabled: boolean;
  onToggle: () => void;
  title: ReactNode;
  /** The line under the title: what the rule matches or runs. */
  lead?: ReactNode;
  /** Said when the rule is off ("Off, not blocking"). */
  state?: ReactNode;
  facts: ReactNode;
  actions: ReactNode;
}) {
  return (
    <li className="flex flex-col gap-3 border-b border-foreground/[0.06] p-4 last:border-b-0 sm:flex-row sm:items-center sm:gap-4">
      <div className="flex min-w-0 flex-1 items-start gap-3">
        <Switch
          className="mt-0.5 after:absolute after:-inset-1.5 after:content-['']"
          aria-label={switchLabel}
          checked={enabled}
          disabled={switchDisabled}
          onCheckedChange={onToggle}
        />
        <div className="min-w-0 flex-1">
          <h3 className="break-words text-base font-medium">{title}</h3>
          {(lead || state) && (
            <p className="flex min-w-0 flex-wrap items-baseline gap-x-2 text-sm text-muted-foreground">
              {lead}
              {state && <span className="font-medium text-foreground">{state}</span>}
            </p>
          )}
          <p className="mt-1.5 flex flex-wrap items-start gap-x-4 gap-y-1 text-xs text-muted-foreground">{facts}</p>
        </div>
      </div>
      <div className="flex shrink-0 flex-wrap items-center gap-2 pl-[3.25rem] sm:pl-0">{actions}</div>
    </li>
  );
}

/** The "…" menu at the end of a row: the one action that deserves a second look, deleting. */
export function RuleDeleteMenu({ title, deleteLabel, onDelete }: { title: string; deleteLabel: string; onDelete: () => void }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger render={<Button variant="ghost" size="icon" className="pointer-coarse:size-9" aria-label={`More actions for ${title}`} />}>
        <MoreHorizontal />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem variant="destructive" onClick={onDelete}>
          <Trash2 /> {deleteLabel}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
