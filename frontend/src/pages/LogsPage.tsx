import { useState } from "react";
import Box from "@cloudscape-design/components/box";
import ContentLayout from "@cloudscape-design/components/content-layout";
import Header from "@cloudscape-design/components/header";
import SegmentedControl from "@cloudscape-design/components/segmented-control";
import SpaceBetween from "@cloudscape-design/components/space-between";
import { AuditTab } from "../components/tabs/AuditTab";

type LogScope = "all" | "auth" | "operator";

export function LogsPage() {
  const [scope, setScope] = useState<LogScope>("all");

  return (
    <ContentLayout
      header={
        <Header
          variant="h1"
          description="Central audit log — same rows as PostgreSQL and Docker (tracing target sentinel_audit). Green = ok, yellow = rejected / limited, red = error."
        >
          Activity log
        </Header>
      }
    >
      <div className="sentinel-admin-page sentinel-logs-page sx-console">
      <SpaceBetween size="l">
        <Box>
          <SegmentedControl
            label="View"
            selectedId={scope}
            onChange={({ detail }) => setScope(detail.selectedId as LogScope)}
            options={[
              { id: "all", text: "All events" },
              { id: "auth", text: "Authentication" },
              { id: "operator", text: "Operator & API" },
            ]}
          />
        </Box>
        <AuditTab scope={scope} colorizeStatus title="Events" />
      </SpaceBetween>
      </div>
    </ContentLayout>
  );
}
