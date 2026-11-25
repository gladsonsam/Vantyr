import { Tabs, TabsList, TabsTrigger } from "@vantyr/ui/components/tabs";
import {
  AGENT_SECTION_META,
  AGENT_SECTION_ORDER,
  AGENT_SECTION_SUBTABS,
  AGENT_TAB_META,
  agentSectionFromTabKey,
  defaultTabForAgentSection,
  type AgentSectionId,
  type TabKey,
} from "@/features/agent-detail/lib/agentTabNav";
import { useMediaQuery } from "@/hooks/useMediaQuery";
import { cn } from "@/lib/utils";

interface AgentSectionNavProps {
  activeTab: TabKey;
  onTabChange: (tab: TabKey) => void;
}

/**
 * One navigation bar for the agent page: the five sections, with the section's own pages inline
 * when there is room (and on their own row below otherwise). It stays pinned while the page
 * scrolls, except on short landscape screens where the desktop needs every pixel of height.
 */
export function AgentSectionNav({ activeTab, onTabChange }: AgentSectionNavProps) {
  // Sidebar included: below this width the pages no longer fit beside the section tabs.
  const wide = useMediaQuery("(min-width: 1280px)");
  const section = agentSectionFromTabKey(activeTab);
  const pages = AGENT_SECTION_SUBTABS[section];
  const showPages = pages.length > 1;

  return (
    <>
      <div className="agent-detail-section-tabs sticky top-0 z-20 mt-4 border-b border-foreground/[0.06] bg-background/90 backdrop-blur [@media(max-height:480px)]:static">
        <div className="flex items-center gap-4 px-3 sm:px-5 md:px-8">
          <Tabs
            value={section}
            onValueChange={(value) => onTabChange(defaultTabForAgentSection(value as AgentSectionId))}
            className="min-w-0"
          >
            <TabsList
              variant="line"
              aria-label="Agent sections"
              className="h-11! max-w-full justify-start gap-1 overflow-x-auto p-0 [scrollbar-width:none] sm:gap-2 [&::-webkit-scrollbar]:hidden"
            >
              {AGENT_SECTION_ORDER.map((id) => {
                const meta = AGENT_SECTION_META[id];
                const Icon = meta.icon;
                return (
                  <TabsTrigger key={id} value={id} className="h-full! flex-none gap-2 px-2.5">
                    <Icon size={15} aria-hidden="true" />
                    <span>{meta.label}</span>
                  </TabsTrigger>
                );
              })}
            </TabsList>
          </Tabs>
          {showPages && wide && (
            <SectionPages tabs={pages} value={activeTab} onChange={onTabChange} className="ml-auto border-l border-foreground/[0.06] pl-4" />
          )}
        </div>
      </div>
      {showPages && !wide && (
        <div className="px-3 pt-3 sm:px-5 md:px-8">
          <SectionPages tabs={pages} value={activeTab} onChange={onTabChange} />
        </div>
      )}
    </>
  );
}

function SectionPages({ tabs, value, onChange, className }: { tabs: TabKey[]; value: TabKey; onChange: (tab: TabKey) => void; className?: string }) {
  return (
    <Tabs value={value} onValueChange={(next) => onChange(next as TabKey)} className={cn("min-w-0", className)}>
      <TabsList aria-label="Section pages" className="h-9!">
        {tabs.map((tab) => {
          const meta = AGENT_TAB_META[tab];
          const Icon = meta.icon;
          return (
            <TabsTrigger key={tab} value={tab} className="flex-none gap-1.5 px-2.5 text-[13px]">
              <Icon size={13} aria-hidden="true" />
              <span>{meta.sideNavLabel}</span>
            </TabsTrigger>
          );
        })}
      </TabsList>
    </Tabs>
  );
}
