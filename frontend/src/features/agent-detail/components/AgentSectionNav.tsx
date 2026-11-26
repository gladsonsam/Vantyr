import { useEffect, useRef } from "react";
import { Tabs, TabsList, TabsTrigger } from "@vantyr/ui/components/tabs";
import { AgentToolSwitcher } from "@/features/agent-detail/components/AgentToolSwitcher";
import {
  AGENT_SECTION_META,
  AGENT_SECTION_SUBTABS,
  AGENT_TAB_META,
  agentSectionFromTabKey,
  type TabKey,
} from "@/features/agent-detail/lib/agentTabNav";

interface AgentSectionNavProps {
  agentName: string;
  activeTab: TabKey;
  onTabChange: (tab: TabKey) => void;
}

/**
 * The agent page's one navigation bar. It names the agent and the tool you are on and opens the
 * searchable list of every tool; the tools that sit next to the current one are one tap away beside
 * it (or on a second row when there is no room). It stays pinned while the page scrolls, except on
 * short landscape screens where the desktop needs every pixel of height.
 */
export function AgentSectionNav({ agentName, activeTab, onTabChange }: AgentSectionNavProps) {
  const section = agentSectionFromTabKey(activeTab);
  const siblings = AGENT_SECTION_SUBTABS[section];
  const siblingsRef = useRef<HTMLDivElement>(null);

  // Keep the selected sibling inside its own scroller (narrow phones) without moving the page.
  useEffect(() => {
    const list = siblingsRef.current?.querySelector<HTMLElement>('[role="tablist"]');
    const tab = list?.querySelector<HTMLElement>('[aria-selected="true"]');
    if (!list || !tab) return;
    const listBox = list.getBoundingClientRect();
    const tabBox = tab.getBoundingClientRect();
    list.scrollLeft += tabBox.left + tabBox.width / 2 - (listBox.left + listBox.width / 2);
  }, [activeTab]);

  return (
    <nav
      aria-label="Agent tools"
      className="agent-detail-section-tabs sticky top-0 z-20 mt-4 border-b bg-background [@media(max-height:480px)]:static"
    >
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 px-3 py-2 sm:px-5 md:px-8">
        <AgentToolSwitcher agentName={agentName} activeTab={activeTab} onSelect={onTabChange} />
        {siblings.length > 1 && (
          <div ref={siblingsRef} className="min-w-0 max-w-full">
            <Tabs
              value={activeTab}
              onValueChange={(next) => onTabChange(next as TabKey)}
              className="min-w-0"
            >
              <TabsList variant="line" aria-label={`${AGENT_SECTION_META[section].label} tools`} className="h-9!">
                {siblings.map((tab) => {
                  const meta = AGENT_TAB_META[tab];
                  const Icon = meta.icon;
                  return (
                    <TabsTrigger
                      key={tab}
                      value={tab}
                      className="flex-none gap-1.5 px-2.5 text-[13px]"
                    >
                      <Icon size={13} aria-hidden="true" />
                      <span>{meta.label}</span>
                    </TabsTrigger>
                  );
                })}
              </TabsList>
            </Tabs>
          </div>
        )}
      </div>
    </nav>
  );
}
