import { useMemo, useState } from "react";
import { ChevronsUpDown } from "lucide-react";
import { Button } from "@vantyr/ui/components/button";
import {
  Command,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@vantyr/ui/components/command";
import { Popover, PopoverContent, PopoverTrigger } from "@vantyr/ui/components/popover";
import {
  AGENT_SECTION_META,
  AGENT_SECTION_ORDER,
  AGENT_SECTION_SUBTABS,
  AGENT_TAB_META,
  agentSectionFromTabKey,
  searchAgentTabs,
  type TabKey,
} from "@/features/agent-detail/lib/agentTabNav";

interface AgentToolSwitcherProps {
  agentName: string;
  activeTab: TabKey;
  onSelect: (tab: TabKey) => void;
}

/**
 * The "you are here" control: it names the agent and the tool being viewed, and opens a searchable
 * list of every tool, grouped. It is the one place all sixteen destinations are listed.
 */
export function AgentToolSwitcher({ agentName, activeTab, onSelect }: AgentToolSwitcherProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const searching = query.trim().length > 0;
  const current = AGENT_TAB_META[activeTab];
  const CurrentIcon = current.icon;

  const matches = useMemo(() => searchAgentTabs(query), [query]);
  const choose = (tab: TabKey) => {
    setOpen(false);
    setQuery("");
    onSelect(tab);
  };

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) setQuery("");
      }}
    >
      <PopoverTrigger
        render={
          <Button
            variant="outline"
            className="h-9 w-full min-w-0 justify-start gap-2 px-3 sm:w-auto sm:max-w-[22rem]"
          />
        }
      >
        <CurrentIcon aria-hidden="true" className="text-muted-foreground" />
        <span className="min-w-0 truncate text-muted-foreground">{agentName}</span>
        <span aria-hidden="true" className="text-muted-foreground/60">
          /
        </span>
        <span className="shrink-0 font-semibold text-foreground">{current.label}</span>
        <span className="sr-only">, switch tool</span>
        <ChevronsUpDown aria-hidden="true" className="ml-auto size-3.5! text-muted-foreground" />
      </PopoverTrigger>
      <PopoverContent align="start" className="w-[min(26rem,calc(100vw-1.5rem))] gap-0 p-0">
        <Command defaultValue={current.label} label="Agent tools" shouldFilter={false} loop>
          <CommandInput placeholder="Find a tool…" value={query} onValueChange={setQuery} />
          <CommandList className="max-h-[min(26rem,calc(100dvh-9rem))] pb-1">
            {searching ? (
              <>
                {matches.length === 0 && (
                  <div className="py-6 text-center text-sm">No tool matches that.</div>
                )}
                {matches.length > 0 && (
                  <CommandGroup>
                    {matches.map((tab) => (
                      <ToolItem
                        key={tab}
                        tab={tab}
                        activeTab={activeTab}
                        showGroup
                        onChoose={choose}
                      />
                    ))}
                  </CommandGroup>
                )}
              </>
            ) : (
              AGENT_SECTION_ORDER.map((sectionId) => (
                <CommandGroup key={sectionId} heading={AGENT_SECTION_META[sectionId].label}>
                  {AGENT_SECTION_SUBTABS[sectionId].map((tab) => (
                    <ToolItem key={tab} tab={tab} activeTab={activeTab} onChoose={choose} />
                  ))}
                </CommandGroup>
              ))
            )}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

function ToolItem({
  tab,
  activeTab,
  showGroup = false,
  onChoose,
}: {
  tab: TabKey;
  activeTab: TabKey;
  showGroup?: boolean;
  onChoose: (tab: TabKey) => void;
}) {
  const meta = AGENT_TAB_META[tab];
  const Icon = meta.icon;
  const isCurrent = tab === activeTab;
  return (
    <CommandItem
      value={meta.label}
      data-checked={isCurrent}
      aria-current={isCurrent ? "true" : undefined}
      onSelect={() => onChoose(tab)}
    >
      <Icon aria-hidden="true" className="text-muted-foreground" />
      <span className="shrink-0 font-medium">{meta.label}</span>
      <span className="min-w-0 truncate text-xs text-muted-foreground">
        {showGroup ? AGENT_SECTION_META[agentSectionFromTabKey(tab)].label : meta.hint}
      </span>
      {isCurrent && <span className="sr-only">(current)</span>}
    </CommandItem>
  );
}
