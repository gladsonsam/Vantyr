import React from "react";
import { Container, Box, Spinner } from "../ui/console";

interface EmptyStateProps {
  title: string;
  description?: string;
  action?: React.ReactNode;
  icon?: React.ReactNode;
}

export function EmptyState({ title, description, action, icon }: EmptyStateProps) {
  return (
    <Container>
      <Box textAlign="center" padding="l">
        {icon && <Box>{icon}</Box>}
        <Box>
          <h2 style={{ fontSize: "16px", fontWeight: "bold", margin: "10px 0" }}>{title}</h2>
        </Box>
        {description && (
          <Box color="text-body-secondary">
            {description}
          </Box>
        )}
        {action && <Box>{action}</Box>}
      </Box>
    </Container>
  );
}

export function NoAgentsState({ primaryAction }: { primaryAction?: React.ReactNode }) {
  return (
    <EmptyState
      title="No agents connected"
      description="Connect an agent to start monitoring. Admins can use Add agent for a pairing code and connection hints."
      action={primaryAction}
    />
  );
}

export function LoadingAgentsState() {
  return (
    <EmptyState
      title="Loading agents…"
      description="Waiting for the server to send the initial agent list."
      icon={<Spinner size="large" />}
    />
  );
}

export function NoDataState({ message = "No data available" }: { message?: string }) {
  return (
    <EmptyState
      title={message}
      description="Data will appear here once the agent starts sending telemetry."
    />
  );
}
