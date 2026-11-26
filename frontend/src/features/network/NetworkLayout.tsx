import { useState, type FormEvent } from "react";
import { Outlet } from "react-router-dom";
import {
  Globe,
  Home,
  KeyRound,
  LayoutDashboard,
  Network,
  ScrollText,
  Server,
  ShieldCheck,
  ShieldOff,
  Unplug,
  Waypoints,
} from "lucide-react";
import { Button } from "@vantyr/ui/components/button";
import { Input } from "@vantyr/ui/components/input";
import { Spinner } from "@vantyr/ui/components/spinner";
import { errorText } from "@/api";
import { useBootstrapNetworkMutation } from "@/api/queries/network";
import { usePageHeader } from "@/app/shell/usePageHeader";
import { EmptyState } from "@/components/common/EmptyState";
import { LoadFailedCard } from "@/components/common/LoadFailedCard";
import { SettingsArea, SettingsNavLinks } from "@/features/settings/components/SettingsLayout";
import { NetworkScopeContext, useNetworkHousehold } from "./access/networkScope";
import { useNetworkAdmin } from "./access/useNetworkAdmin";
import { useNetworkAccess } from "./access/useNetworkAccess";

const SECTIONS = [
  { id: "overview", to: "/network", label: "Overview", icon: LayoutDashboard },
  { id: "policies", to: "/network/policies", label: "Policies", icon: ShieldCheck },
  { id: "gateways", to: "/network/gateways", label: "Gateways", icon: Server },
  { id: "dns", to: "/network/dns", label: "DNS", icon: Globe },
  { id: "proxy", to: "/network/proxy", label: "Proxy", icon: Waypoints },
  { id: "household", to: "/network/household", label: "Household", icon: Home },
  { id: "audit", to: "/network/audit", label: "Audit", icon: ScrollText },
] as const;

/** Administrators only: who may enroll their own devices (BYOD). */
const ACCESS_SECTION = {
  id: "access",
  to: "/network/access",
  label: "Access",
  icon: KeyRound,
} as const;

/** The longest matching path wins, so "/network" is only active on the overview itself. */
function SectionNav() {
  const household = useNetworkHousehold();
  const isAdmin = useNetworkAdmin(household.id);
  const items = isAdmin ? [...SECTIONS, ACCESS_SECTION] : SECTIONS;
  return <SettingsNavLinks items={items} label="Network sections" />;
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
    <div className="mx-auto w-full max-w-lg rounded-xl border border-border/70 bg-card/10">
      <div className="space-y-5 p-6">
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
      </div>
    </div>
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
          <SettingsArea nav={<SectionNav />}>
            <Outlet />
          </SettingsArea>
        </NetworkScopeContext.Provider>
      );
  }
}
