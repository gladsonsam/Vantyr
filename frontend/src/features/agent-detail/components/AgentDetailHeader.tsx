import { ArrowLeft, Menu } from "lucide-react";
import { Button } from "@vantyr/ui/components/button";
import type { Agent, AgentInfo } from "@/api/types";
import { OsBadge } from "@/components/common/OsBadge";
import { Dot } from "@/components/common/Metrics";
import { AgentDetailActions } from "@/features/agent-detail/components/AgentDetailActions";
import { osFromInfo, type AgentAction } from "@/features/agent-detail/lib/agentStatus";

interface AgentDetailHeaderProps {
  agent: Agent;
  resolvedInfo: AgentInfo | null;
  statusLabel: string;
  statusTextClass: string;
  statusDotColor: string;
  openMobileNav: (() => void) | null;
  onBackToOverview?: () => void;
  isViewer: boolean;
  systemControlAvailable: boolean;
  pendingAction: AgentAction | null;
  onAction: (action: AgentAction) => void;
}

/** Own header for the agent route: nav buttons, OS mark + identity, and the action buttons. */
export function AgentDetailHeader({
  agent,
  resolvedInfo,
  statusLabel,
  statusTextClass,
  statusDotColor,
  openMobileNav,
  onBackToOverview,
  isViewer,
  systemControlAvailable,
  pendingAction,
  onAction,
}: AgentDetailHeaderProps) {
  return (
    <section aria-label="Agent header" className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-3 border-b border-foreground/[0.06] px-5 py-4 md:px-8">
      {/* Left: back/menu nav buttons (a sibling of identity so they can share the
          top row with the action buttons on mobile) */}
      {(openMobileNav || onBackToOverview) && (
        <div className="order-1 flex shrink-0 items-center gap-2">
          {openMobileNav && (
            <Button
              variant="ghost"
              size="icon"
              onClick={openMobileNav}
              aria-label="Open navigation menu"
              title="Menu"
              className="md:hidden"
            >
              <Menu />
            </Button>
          )}
          {onBackToOverview && (
            <Button
              variant="ghost"
              size="icon"
              onClick={onBackToOverview}
              title="Back to fleet"
              aria-label="Back to fleet"
            >
              <ArrowLeft />
            </Button>
          )}
        </div>
      )}

      {/* OS mark + identity */}
      <div className="order-3 flex min-w-0 flex-1 basis-full items-center gap-3 sm:order-2 sm:basis-auto sm:flex-1 sm:w-auto">
        <OsBadge os={osFromInfo(resolvedInfo)} size={32} className="text-foreground" />
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
            <span className="truncate font-heading text-xl font-bold tracking-tight">
              {agent.name}
            </span>
            <span className="inline-flex items-center gap-1.5">
              <Dot color={statusDotColor} size={6} halo={false} />
              <span className={`text-xs font-semibold ${statusTextClass}`}>
                {statusLabel}
              </span>
            </span>
          </div>
        </div>
      </div>

      {/* Right: actions */}
      <AgentDetailActions
        agent={agent}
        isViewer={isViewer}
        systemControlAvailable={systemControlAvailable}
        pendingAction={pendingAction}
        onAction={onAction}
      />
    </section>
  );
}
