import Container from "@cloudscape-design/components/container";
// import Header from "@cloudscape-design/components/header";
import Box from "@cloudscape-design/components/box";
import Spinner from "@cloudscape-design/components/spinner";

interface EmptyStateProps {
  title: string;
  description?: string;
  action?: React.ReactNode;
  icon?: React.ReactNode;
}

export function EmptyState({ title, description, action, icon }: EmptyStateProps) {
  return (
    <Container>
      <Box textAlign="center" padding={{ vertical: "xxxl" }}>
        {icon && <Box margin={{ bottom: "m" }}>{icon}</Box>}
        <Box variant="h2" margin={{ bottom: "xs" }}>
          {title}
        </Box>
        {description && (
          <Box variant="p" color="text-body-secondary" margin={{ bottom: "m" }}>
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
