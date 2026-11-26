import { Link, Navigate, Outlet, useLocation, useNavigate, useParams } from "react-router-dom";
import { ArrowLeft } from "lucide-react";
import { Spinner } from "@vantyr/ui/components/spinner";
import { Tabs, TabsList, TabsTrigger } from "@vantyr/ui/components/tabs";
import { usePageHeader } from "@/app/shell/usePageHeader";
import { DeviceContext } from "./deviceContext";
import { useDeviceRows } from "./hooks/useDeviceRows";
import { DEVICE_TYPE_LABEL } from "./lib/deviceIcons";
import { CONNECTION_KINDS } from "./lib/deviceModel";
import { CONNECTION_LABEL } from "./lib/identity";

/**
 * `/devices/:deviceKey` — one device. The Overview is always there; each connection the device has
 * adds its own sub-page (Agent, DNS, Proxy), and a connection it does not have adds nothing.
 */
export function DeviceLayout() {
  const { deviceKey = "" } = useParams();
  const { rows, loading } = useDeviceRows();
  const { pathname } = useLocation();
  const navigate = useNavigate();
  const row = rows.find((candidate) => candidate.key === deviceKey);

  const people = row?.people.map((p) => p.person.display_name).join(", ");
  usePageHeader({
    title: row?.label ?? "Device",
    description: row
      ? [DEVICE_TYPE_LABEL[row.type], people].filter(Boolean).join(" · ")
      : undefined,
  });

  // An agent that is not in a household has no device page of its own: it is just an agent.
  if (deviceKey.startsWith("agent:")) {
    return <Navigate to={`/agents/${deviceKey.slice("agent:".length)}`} replace />;
  }
  if (!row) {
    return loading ? (
      <div className="flex items-center justify-center gap-2 rounded-xl bg-card py-12 text-sm text-muted-foreground">
        <Spinner /> Loading…
      </div>
    ) : (
      <Navigate to="/" replace />
    );
  }

  const base = `/devices/${row.key}`;
  const present = CONNECTION_KINDS.filter((kind) => row.connections[kind].state !== "none");
  const section = pathname.slice(base.length).replace(/^\//, "").split("/")[0];
  // A sub-page only exists for a connection the device has.
  if (section && !present.some((kind) => kind === section)) {
    return <Navigate to={base} replace />;
  }
  const active = section ? `${base}/${section}` : base;

  return (
    <DeviceContext.Provider value={row}>
      <div className="space-y-8">
        <div className="space-y-4">
          <Link
            to="/"
            className="inline-flex items-center gap-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground"
          >
            <ArrowLeft className="size-4" aria-hidden="true" /> Devices
          </Link>
          <Tabs value={active} onValueChange={(value) => navigate(String(value))}>
            <TabsList variant="line" aria-label="Device sections">
              <TabsTrigger value={base}>Overview</TabsTrigger>
              {present.map((kind) => (
                <TabsTrigger key={kind} value={`${base}/${kind}`}>
                  {CONNECTION_LABEL[kind]}
                </TabsTrigger>
              ))}
            </TabsList>
          </Tabs>
        </div>
        <Outlet />
      </div>
    </DeviceContext.Provider>
  );
}
