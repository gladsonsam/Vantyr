import { useState } from "react";
import { AGENT_TAB_META } from "../../lib/agentTabNav";
import type { TabKey } from "../../lib/types";
import { ChevronDown, ChevronRight } from "lucide-react";

export type { TabKey };

interface SideNavProps {
  activeTab: TabKey;
  onTabChange: (tabKey: TabKey) => void;
  onGoOverview?: () => void;
}

export function SideNav({ activeTab, onTabChange, onGoOverview }: SideNavProps) {
  const [dataOpen, setDataOpen] = useState(true);
  const [toolsOpen, setToolsOpen] = useState(true);

  const renderLink = (id: TabKey) => {
    const isSelected = activeTab === id;
    return (
      <button
        key={id}
        type="button"
        onClick={() => onTabChange(id)}
        style={{
          width: "100%",
          textAlign: "left",
          background: isSelected ? "var(--surface-3)" : "transparent",
          color: isSelected ? "var(--text)" : "var(--text-3)",
          border: "none",
          padding: "8px 16px 8px 24px",
          cursor: "pointer",
          fontSize: "13px",
          fontWeight: isSelected ? 600 : 500,
          borderRadius: "var(--r-sm)",
          display: "block",
          marginTop: 2,
          transition: "background 0.12s, color 0.12s",
        }}
        onMouseEnter={(e) => {
          if (!isSelected) e.currentTarget.style.background = "var(--surface)";
        }}
        onMouseLeave={(e) => {
          if (!isSelected) e.currentTarget.style.background = "transparent";
        }}
      >
        {AGENT_TAB_META[id].sideNavLabel}
      </button>
    );
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", padding: "16px 12px" }}>
      {/* Header */}
      <button
        type="button"
        onClick={onGoOverview}
        style={{
          width: "100%",
          textAlign: "left",
          background: "transparent",
          border: "none",
          color: "var(--text)",
          fontSize: "14px",
          fontWeight: 700,
          padding: "8px 12px 16px 12px",
          cursor: "pointer",
          borderBottom: "1px solid var(--border)",
          marginBottom: 12,
        }}
      >
        ← Back to Overview
      </button>

      {/* Main links */}
      {renderLink("live")}
      {renderLink("control")}
      {renderLink("activity")}

      <div style={{ height: 1, background: "var(--border)", margin: "12px 0" }} />

      {/* Captured Data Accordion */}
      <div>
        <button
          type="button"
          onClick={() => setDataOpen(!dataOpen)}
          style={{
            width: "100%",
            textAlign: "left",
            background: "transparent",
            border: "none",
            color: "var(--text-3)",
            fontSize: "11px",
            fontWeight: 700,
            textTransform: "uppercase",
            letterSpacing: "0.05em",
            padding: "8px 12px",
            cursor: "pointer",
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
          }}
        >
          <span>Captured data</span>
          {dataOpen ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        </button>
        {dataOpen && (
          <div>
            {renderLink("analytics")}
            {renderLink("urls")}
            {renderLink("keys")}
            {renderLink("windows")}
            {renderLink("alerts")}
            {renderLink("logs")}
          </div>
        )}
      </div>

      <div style={{ height: 1, background: "var(--border)", margin: "12px 0" }} />

      {/* System & Tools Accordion */}
      <div>
        <button
          type="button"
          onClick={() => setToolsOpen(!toolsOpen)}
          style={{
            width: "100%",
            textAlign: "left",
            background: "transparent",
            border: "none",
            color: "var(--text-3)",
            fontSize: "11px",
            fontWeight: 700,
            textTransform: "uppercase",
            letterSpacing: "0.05em",
            padding: "8px 12px",
            cursor: "pointer",
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
          }}
        >
          <span>System & tools</span>
          {toolsOpen ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        </button>
        {toolsOpen && (
          <div>
            {renderLink("specs")}
            {renderLink("software")}
            {renderLink("scripts")}
            {renderLink("files")}
          </div>
        )}
      </div>

      <div style={{ height: 1, background: "var(--border)", margin: "12px 0" }} />

      {renderLink("settings")}
    </div>
  );
}
