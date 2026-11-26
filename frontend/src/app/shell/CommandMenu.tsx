import { useEffect, useEffectEvent } from "react";
import type { LucideIcon } from "lucide-react";
import {
  Command,
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
  CommandShortcut,
} from "@vantyr/ui/components/command";
import type { Agent } from "@/api/types";
import { searchAgentTabs, type TabKey } from "@/features/agent-detail/lib/agentTabNav";
import { StatusDot } from "@/features/fleet/components/FleetStatus";

export interface CommandPage {
  label: string;
  icon: LucideIcon;
  onSelect: () => void;
}

/** A tool of the device being viewed, e.g. Terminal or Websites. */
export interface CommandTool extends CommandPage {
  id: TabKey;
  /** One line shown beside the name. */
  hint: string;
}

const TOOL_PREFIX = "tool:";

/**
 * Tools are matched like the in-page tool switcher (whole words, best match first, no fuzzy hits such as
 * "logs" finding Recall); devices and pages must contain every typed word.
 */
function filterItems(value: string, search: string): number {
  if (!search.trim()) return 1;
  if (value.startsWith(TOOL_PREFIX)) {
    const rank = searchAgentTabs(search).indexOf(value.slice(TOOL_PREFIX.length) as TabKey);
    return rank < 0 ? 0 : 1 / (rank + 1);
  }
  const haystack = value.toLowerCase();
  return search.toLowerCase().split(/\s+/).filter(Boolean).every((word) => haystack.includes(word)) ? 0.5 : 0;
}

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  pages: CommandPage[];
  /** Offered first, only while a device is open; `heading` names it. */
  tools?: { heading: string; items: CommandTool[] };
  agents?: Agent[];
  onSelectAgent?: (agentId: string) => void;
}

/** Global ⌘K / Ctrl+K palette: jump to a tool of the open device, a page or straight to a device. */
export function CommandMenu({
  open,
  onOpenChange,
  pages,
  tools,
  agents = [],
  onSelectAgent,
}: Props) {
  const toggleOpen = useEffectEvent(() => onOpenChange(!open));
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      // A focused surface that already handled the chord (the remote desktop forwarding Ctrl+K)
      // owns it. Fullscreen hides this palette, so opening it there would only steal keys.
      if (event.defaultPrevented || document.fullscreenElement) return;
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        toggleOpen();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  const run = (action: () => void) => {
    onOpenChange(false);
    action();
  };
  const sorted = [...agents].sort(
    (a, b) =>
      Number(b.online) - Number(a.online) ||
      (a.name ?? a.id).localeCompare(b.name ?? b.id),
  );

  return (
    <CommandDialog
      open={open}
      onOpenChange={onOpenChange}
      title="Command palette"
      description="Jump to a tool, page or device"
      // Short screens (landscape phones): sit near the top so the list never runs off the bottom.
      className="[@media(max-height:560px)]:top-2"
    >
      <Command filter={filterItems}>
        <CommandInput placeholder={tools ? "Search tools, pages and devices…" : "Search pages and devices…"} />
        <CommandList className="max-h-[min(18rem,calc(100dvh-6rem))]">
          <CommandEmpty>No results.</CommandEmpty>
          {tools && tools.items.length > 0 && (
            <>
              <CommandGroup heading={tools.heading}>
                {tools.items.map((tool) => (
                  <CommandItem
                    key={tool.id}
                    value={`${TOOL_PREFIX}${tool.id}`}
                    onSelect={() => run(tool.onSelect)}
                  >
                    <tool.icon />
                    <span className="shrink-0">{tool.label}</span>
                    <CommandShortcut className="hidden min-w-0 truncate sm:inline">{tool.hint}</CommandShortcut>
                  </CommandItem>
                ))}
              </CommandGroup>
              <CommandSeparator />
            </>
          )}
          {onSelectAgent && sorted.length > 0 && (
            <>
              <CommandGroup heading="Devices">
                {sorted.map((agent) => (
                  <CommandItem
                    key={agent.id}
                    value={`${agent.name ?? ""} ${agent.id}`}
                    onSelect={() => run(() => onSelectAgent(agent.id))}
                  >
                    <StatusDot
                      row={{
                        online: agent.online,
                        status: agent.online ? "connected" : "offline",
                      }}
                    />
                    <span className="truncate">
                      {agent.name?.trim() || agent.id}
                    </span>
                    {/* The dot carries the status for sighted users; only the exception is spelled out. */}
                    <CommandShortcut>
                      {agent.online ? <span className="sr-only">online</span> : "offline"}
                    </CommandShortcut>
                  </CommandItem>
                ))}
              </CommandGroup>
              <CommandSeparator />
            </>
          )}
          <CommandGroup heading="Pages">
            {pages.map((page) => (
              <CommandItem key={page.label} onSelect={() => run(page.onSelect)}>
                <page.icon />
                {page.label}
              </CommandItem>
            ))}
          </CommandGroup>
        </CommandList>
      </Command>
    </CommandDialog>
  );
}
