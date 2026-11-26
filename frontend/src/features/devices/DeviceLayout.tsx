import { Link, Navigate, Outlet, useLocation, useNavigate, useParams } from "react-router-dom";
import { ArrowLeft } from "lucide-react";
import { Button } from "@vantyr/ui/components/button";
import { Spinner } from "@vantyr/ui/components/spinner";
import { Tabs, TabsList, TabsTrigger } from "@vantyr/ui/components/tabs";
import { usePageHeader } from "@/app/shell/usePageHeader";
import { DevicePeople } from "./components/DevicePeople";
import { DeviceContext } from "./deviceContext";
import { useDeviceRows } from "./hooks/useDeviceRows";
import { DEVICE_TYPE_ICON, DEVICE_TYPE_LABEL } from "./lib/deviceIcons";
import { CONNECTION_KINDS, connectedCount } from "./lib/deviceModel";
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

  usePageHeader({
    title: row?.label ?? "Device",
    description: row ? DEVICE_TYPE_LABEL[row.type] : undefined,
  });

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
  const TypeIcon = DEVICE_TYPE_ICON[row.type];
  const online = connectedCount(row) > 0;

  return (
    <DeviceContext.Provider value={row}>
      <div className="space-y-6">
        <header className="border-b" aria-label="Device header">
          <div className="flex flex-wrap items-center gap-x-4 gap-y-3">
            <Button
              variant="ghost"
              size="sm"
              nativeButton={false}
              render={<Link to="/" />}
            >
              <ArrowLeft className="size-4" aria-hidden="true" /> Devices
            </Button>
            <div className="flex min-w-0 flex-1 items-center gap-3">
              <div
                className={
                  online
                    ? "flex size-11 shrink-0 items-center justify-center rounded-xl border border-border/70 text-success"
                    : "flex size-11 shrink-0 items-center justify-center rounded-xl border border-border/70 text-muted-foreground"
                }
                aria-hidden="true"
              >
                <TypeIcon size={20} />
              </div>
              <span
                className={
                  online
                    ? "inline-flex items-center gap-2 text-sm font-medium text-success"
                    : "inline-flex items-center gap-2 text-sm font-medium text-muted-foreground"
                }
              >
                <span className="size-2 rounded-full bg-current" aria-hidden="true" />
                {online ? "Connected" : "Not connected"}
              </span>
            </div>
            <div className="ml-auto">
              <DevicePeople device={row} />
            </div>
          </div>
          <div className="mt-4 -mb-px">
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
        </header>
        <Outlet />
      </div>
    </DeviceContext.Provider>
  );
}
