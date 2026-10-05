import React from "react";
import { ServerOff, Loader2 } from "lucide-react";
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";

interface EmptyStateProps {
  title: string;
  description?: string;
  action?: React.ReactNode;
  icon?: React.ReactNode;
}

function EmptyState({ title, description, action, icon }: EmptyStateProps) {
  return (
    <Empty className="bg-card">
      <EmptyHeader>
        {icon ? <EmptyMedia>{icon}</EmptyMedia> : null}
        <EmptyTitle>{title}</EmptyTitle>
        {description ? <EmptyDescription>{description}</EmptyDescription> : null}
      </EmptyHeader>
      {action ? <EmptyContent>{action}</EmptyContent> : null}
    </Empty>
  );
}

export function NoAgentsState({ primaryAction }: { primaryAction?: React.ReactNode }) {
  return (
    <EmptyState
      title="No agents connected"
      description="Connect an agent to start monitoring. Admins can use Add agent for a pairing code and connection hints."
      action={primaryAction}
      icon={<ServerOff className="size-5 text-muted-foreground" />}
    />
  );
}

export function LoadingAgentsState() {
  return (
    <EmptyState
      title="Loading agents…"
      description="Waiting for the server to send the initial agent list."
      icon={<Loader2 className="size-5 animate-spin text-muted-foreground" />}
    />
  );
}
