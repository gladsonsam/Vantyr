import { useState } from "react";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { AuditTab } from "./AuditTab";

type LogScope = "all" | "auth" | "operator";

const LOG_SCOPES: { value: LogScope; label: string }[] = [
  { value: "all", label: "All events" },
  { value: "auth", label: "Authentication" },
  { value: "operator", label: "Operator & API" },
];

export function LogsPage() {
  const [scope, setScope] = useState<LogScope>("all");

  return (
    <div className="flex flex-col gap-6">
      <Tabs value={scope} onValueChange={(value) => setScope(value as LogScope)}>
        <div className="flex items-end gap-4 border-b border-foreground/[0.06]">
          <div className="-mb-px min-w-0 flex-1 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
            <TabsList variant="line" aria-label="Log scope" className="h-11! gap-2 p-0">
              {LOG_SCOPES.map((tab) => (
                <TabsTrigger
                  key={tab.value}
                  value={tab.value}
                  className="h-full! flex-none gap-2 px-2.5 after:bottom-0!"
                >
                  {tab.label}
                </TabsTrigger>
              ))}
            </TabsList>
          </div>
        </div>
      </Tabs>
      <AuditTab scope={scope} colorizeStatus title="Events" />
    </div>
  );
}
