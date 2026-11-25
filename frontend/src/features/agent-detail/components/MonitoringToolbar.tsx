import type { ReactNode } from "react";
import { Search, X } from "lucide-react";
import { Button } from "@vantyr/ui/components/button";
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupInput } from "@vantyr/ui/components/input-group";
import { RefreshButton } from "@/components/common/RefreshButton";

/** Row action button: always reachable by keyboard and touch, revealed on row hover for mouse users. */
export const ROW_ACTIONS_CLASS =
  "flex shrink-0 items-center gap-0.5 transition-opacity focus-within:opacity-100 pointer-fine:opacity-0 pointer-fine:group-hover/row:opacity-100";
export const ROW_ACTION_BUTTON_CLASS = "text-muted-foreground hover:text-foreground max-sm:size-9 pointer-coarse:size-9";

interface MonitoringToolbarProps {
  /** Accessible name of the list (kept out of sight: the pinned tool bar already says where you are). */
  title: string;
  searchLabel: string;
  placeholder: string;
  query: string;
  onQueryChange: (query: string) => void;
  /** "500 most recent visits" and friends; see `listCountLabel`. */
  count: ReactNode;
  /** Anything else that is true of the whole list (one browser, one user…). */
  detail?: ReactNode;
  onRefresh: () => void;
  refreshing?: boolean;
  /** Extra controls beside refresh (menus, toggles). */
  actions?: ReactNode;
}

/** The one header of every monitoring list: search, refresh, and a single line saying what is shown. */
export function MonitoringToolbar({
  title,
  searchLabel,
  placeholder,
  query,
  onQueryChange,
  count,
  detail,
  onRefresh,
  refreshing = false,
  actions,
}: MonitoringToolbarProps) {
  return (
    <div className="flex flex-col gap-2 px-4 pt-4 sm:px-5">
      <h2 className="sr-only">{title}</h2>
      <div className="flex items-center gap-2">
        <InputGroup className="h-9 min-w-0 flex-1">
          <InputGroupAddon>
            <Search />
          </InputGroupAddon>
          <InputGroupInput
            aria-label={searchLabel}
            placeholder={placeholder}
            value={query}
            onChange={(e) => onQueryChange(e.target.value)}
          />
          {query && (
            <InputGroupAddon align="inline-end">
              <InputGroupButton size="icon-xs" aria-label="Clear search" onClick={() => onQueryChange("")}>
                <X />
              </InputGroupButton>
            </InputGroupAddon>
          )}
        </InputGroup>
        {actions}
        <RefreshButton onClick={onRefresh} loading={refreshing} />
      </div>
      <div className="flex min-h-6 flex-wrap items-center gap-x-2 gap-y-1 text-[13px] text-muted-foreground tabular-nums">
        <span role="status">{count}</span>
        {detail}
        {query && (
          <Button variant="ghost" size="xs" className="pointer-coarse:h-9" onClick={() => onQueryChange("")}>
            Clear search
          </Button>
        )}
      </div>
    </div>
  );
}

/** A failed load must not read as "nothing happened": say so and offer the retry. */
export function LoadFailed({ what, onRetry }: { what: string; onRetry: () => void }) {
  return (
    <div role="alert" className="mx-4 mt-3 flex flex-wrap items-center gap-3 rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive sm:mx-5">
      <span>Couldn’t load {what}.</span>
      <Button variant="outline" size="sm" onClick={onRetry}>
        Try again
      </Button>
    </div>
  );
}
