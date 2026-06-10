import { Box, SpaceBetween } from "../ui/console";

export function ToolsContent() {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <h2>Agent details help</h2>
      <SpaceBetween size="m">
        <div>
          <Box><h3>Activity</h3></Box>
          <div style={{ fontSize: "12.5px", color: "var(--text-2)" }}>Timeline sessions aggregated from windows, URLs and keystrokes.</div>
        </div>
        <div>
          <Box><h3>Screen</h3></Box>
          <div style={{ fontSize: "12.5px", color: "var(--text-2)" }}>Live stream with remote control commands (mouse and keyboard).</div>
        </div>
        <div>
          <Box><h3>History tabs</h3></Box>
          <div style={{ fontSize: "12.5px", color: "var(--text-2)" }}>Keys, windows and URLs support filtering, sorting and pagination.</div>
        </div>
      </SpaceBetween>
      <div style={{ borderTop: "1px solid var(--border)", paddingTop: 12, marginTop: 12 }}>
        <Box color="text-body-secondary">
          Use tabs to switch telemetry views and use the page header actions for agent operations.
        </Box>
      </div>
    </div>
  );
}
