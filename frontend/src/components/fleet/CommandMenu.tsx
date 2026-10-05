import { useEffect } from "react";
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
} from "@/components/ui/command";
import type { Agent } from "@/lib/types";
import { StatusDot } from "./status";

export interface CommandPage {
  label: string;
  icon: LucideIcon;
  onSelect: () => void;
}

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  pages: CommandPage[];
  agents?: Agent[];
  onSelectAgent?: (agentId: string) => void;
}

/** Global ⌘K / Ctrl+K palette: jump to a page or straight to a device. */
export function CommandMenu({
  open,
  onOpenChange,
  pages,
  agents = [],
  onSelectAgent,
}: Props) {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        onOpenChange(!open);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open, onOpenChange]);

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
      description="Jump to a page or device"
    >
      <Command>
        <CommandInput placeholder="Search pages and devices…" />
        <CommandList>
          <CommandEmpty>No results.</CommandEmpty>
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
                    <CommandShortcut>
                      {agent.online ? "online" : "offline"}
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
