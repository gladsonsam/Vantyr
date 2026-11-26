import { ArrowDown, ArrowUp, Search, X } from "lucide-react";
import { Button } from "@vantyr/ui/components/button";
import { Checkbox } from "@vantyr/ui/components/checkbox";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
} from "@vantyr/ui/components/input-group";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@vantyr/ui/components/select";
import { RefreshButton } from "@/components/common/RefreshButton";

const STATUS_OPTIONS = [
  { label: "All outcomes", value: "all" },
  { label: "Succeeded", value: "ok" },
  { label: "Failed", value: "error" },
  { label: "Rejected", value: "rejected" },
];

interface AuditToolbarProps {
  summary: string;
  query: string;
  onQuery: (query: string) => void;
  status: string;
  onStatus: (status: string) => void;
  showViews: boolean;
  onShowViews: (show: boolean) => void;
  newestFirst: boolean;
  onToggleOrder: () => void;
  refreshing: boolean;
  onRefresh: () => void;
}

/** What is listed, then the ways to narrow it: search, outcome, page views and order; refresh sits beside the count. */
export function AuditToolbar(props: AuditToolbarProps) {
  const {
    summary,
    query,
    onQuery,
    status,
    onStatus,
    showViews,
    onShowViews,
    newestFirst,
    onToggleOrder,
    refreshing,
    onRefresh,
  } = props;
  const OrderIcon = newestFirst ? ArrowDown : ArrowUp;
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <InputGroup className="h-9 min-w-0 basis-full sm:w-64 sm:basis-auto">
          <InputGroupAddon>
            <Search />
          </InputGroupAddon>
          <InputGroupInput
            aria-label="Search audit log"
            placeholder="Search action, user, device, IP or detail"
            value={query}
            onChange={(event) => onQuery(event.target.value)}
          />
          {query && (
            <InputGroupAddon align="inline-end">
              <InputGroupButton
                size="icon-xs"
                aria-label="Clear search"
                onClick={() => onQuery("")}
              >
                <X />
              </InputGroupButton>
            </InputGroupAddon>
          )}
        </InputGroup>
        <Select value={status} onValueChange={(next) => onStatus(next ?? "all")}>
          <SelectTrigger
            aria-label="Filter by outcome"
            className="w-40 max-sm:h-9 pointer-coarse:h-9"
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {STATUS_OPTIONS.map((option) => (
              <SelectItem key={option.value} value={option.value}>
                {option.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <label className="flex min-h-8 cursor-pointer items-center gap-2 text-sm text-muted-foreground pointer-coarse:min-h-9">
          <Checkbox
            checked={showViews}
            onCheckedChange={(checked) => onShowViews(checked === true)}
            aria-label="Show page views"
          />
          Page views
        </label>
        <div className="ml-auto flex shrink-0 items-center gap-1">
          <Button
            variant="ghost"
            size="sm"
            className="text-muted-foreground pointer-coarse:h-9"
            aria-label={
              newestFirst ? "Newest first. Show oldest first" : "Oldest first. Show newest first"
            }
            onClick={onToggleOrder}
          >
            <OrderIcon /> {newestFirst ? "Newest" : "Oldest"}
          </Button>
          <RefreshButton onClick={onRefresh} loading={refreshing} label="Refresh audit log" />
        </div>
      </div>
      <p role="status" className="min-w-0 text-sm text-muted-foreground tabular-nums">
        {summary}
      </p>
    </div>
  );
}
