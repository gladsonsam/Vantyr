import { useState, type FormEvent } from "react";
import { Outlet, useLocation, useNavigate } from "react-router-dom";
import { Network, ShieldOff, Unplug } from "lucide-react";
import { Button } from "@vantyr/ui/components/button";
import { Card, CardContent } from "@vantyr/ui/components/card";
import { Input } from "@vantyr/ui/components/input";
import { Spinner } from "@vantyr/ui/components/spinner";
import { Tabs, TabsList, TabsTrigger } from "@vantyr/ui/components/tabs";
import { errorText } from "@/api";
import { useBootstrapNetworkMutation } from "@/api/queries/network";
import { usePageHeader } from "@/app/shell/usePageHeader";
import { EmptyState } from "@/components/common/EmptyState";
import { LoadFailedCard } from "@/components/common/LoadFailedCard";
import { NetworkScopeContext } from "./access/networkScope";
import { useNetworkAccess } from "./access/useNetworkAccess";

const TABS = [
  { path: "/network", label: "Overview" },
  { path: "/network/policies", label: "Policies" },
  { path: "/network/dns", label: "DNS" },
  { path: "/network/proxy", label: "Proxy" },
] as const;

function SectionTabs() {
  const { pathname } = useLocation();
  const navigate = useNavigate();
  // The longest matching path wins, so "/network" is only active on the overview itself.
  const active =
    [...TABS].reverse().find((tab) => pathname === tab.path || pathname.startsWith(`${tab.path}/`))
      ?.path ?? "/network";
  return (
    <Tabs value={active} onValueChange={(value) => navigate(String(value))}>
      <TabsList
        variant="line"
        aria-label="Network sections"
        className="max-w-full justify-start overflow-x-auto border-b border-border/50"
      >
        {TABS.map((tab) => (
          <TabsTrigger key={tab.path} value={tab.path}>
            {tab.label}
          </TabsTrigger>
        ))}
      </TabsList>
    </Tabs>
  );
}

/** Admin-only, one time: creates the first household and the first `network_admin` grant. */
function SetupCard() {
  const [name, setName] = useState("");
  const bootstrap = useBootstrapNetworkMutation();
  const submit = (event: FormEvent) => {
    event.preventDefault();
    const trimmed = name.trim();
    if (trimmed) bootstrap.mutate(trimmed);
  };
  return (
    <Card className="mx-auto w-full max-w-lg gap-0 py-0">
      <CardContent className="space-y-5 p-6">
        <div className="flex items-center gap-3">
          <Network className="size-5 text-primary" aria-hidden="true" />
          <h2 className="text-lg font-medium">Set up Vantyr Network</h2>
        </div>
        <p className="text-sm text-muted-foreground">
          Create the household that people, devices and policy belong to. You become its network
          administrator; this is recorded in the audit log.
        </p>
        <form onSubmit={submit} className="flex gap-3">
          <Input
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="Household name"
            aria-label="Household name"
            maxLength={80}
            autoFocus
          />
          <Button type="submit" disabled={!name.trim() || bootstrap.isPending}>
            {bootstrap.isPending ? <Spinner /> : null}
            Create
          </Button>
        </form>
        {bootstrap.isError ? (
          <p role="alert" className="text-sm text-destructive">
            {errorText(bootstrap.error)}
          </p>
        ) : null}
      </CardContent>
    </Card>
  );
}

/**
 * Layout route for every Network screen. It decides, from what the server returns, whether to show
 * the screens at all, and scopes them to one household.
 */
export function NetworkLayout() {
  usePageHeader({
    title: "Network",
    description: "DNS and proxy filtering for the people and devices in your household.",
  });
  const access = useNetworkAccess();

  switch (access.state) {
    case "loading":
      return (
        <div className="flex items-center justify-center gap-2 rounded-xl bg-card py-12 text-sm text-muted-foreground">
          <Spinner /> Loading…
        </div>
      );
    case "unavailable":
      return (
        <EmptyState
          title="Vantyr Network isn’t available on this server"
          description="This server was built without the Network feature, so there is nothing to manage here."
          icon={<Unplug className="size-5" />}
          iconVariant="icon"
        />
      );
    case "denied":
      return (
        <EmptyState
          title="You don’t have access to Vantyr Network"
          description="Network access is granted separately from dashboard roles. Ask a network administrator to grant you access."
          icon={<ShieldOff className="size-5" />}
          iconVariant="icon"
        />
      );
    case "error":
      return (
        <LoadFailedCard
          message={`Couldn’t load Vantyr Network: ${access.message}`}
          onRetry={access.retry}
        />
      );
    case "setup":
      return <SetupCard />;
    case "ready":
      return (
        <NetworkScopeContext.Provider value={access.household}>
          <div className="space-y-6">
            <SectionTabs />
            <Outlet />
          </div>
        </NetworkScopeContext.Provider>
      );
  }
}
