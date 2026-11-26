import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { networkQueries } from "@/api/queries/network";
import { useAgents } from "@/app/providers/useAgents";
import { useNetworkAccess } from "@/features/network/access/useNetworkAccess";
import { buildDeviceRows, type DeviceRow } from "@/features/devices/lib/deviceModel";

const NO_AGENTS: never[] = [];

/**
 * Every device, from the live agents plus the household inventory when the server has one. Without
 * an inventory (or without access to it) the list is simply the agents, so the page works anywhere.
 */
export function useDeviceRows(): { rows: DeviceRow[]; loading: boolean; hasHousehold: boolean } {
  const { agents, initialized } = useAgents();
  const access = useNetworkAccess();
  const household = access.state === "ready" ? access.household.id : null;
  const enabled = household !== null;
  const id = household ?? "";

  const persons = useQuery({ ...networkQueries.persons(id), enabled });
  const devices = useQuery({ ...networkQueries.devices(id), enabled });
  const assignments = useQuery({ ...networkQueries.assignments(id), enabled });
  const connections = useQuery({ ...networkQueries.connections(id), enabled });

  const inventoryLoading =
    access.state === "loading" ||
    (enabled && [persons, devices, assignments, connections].some((query) => query.isPending));

  const rows = useMemo(
    () =>
      buildDeviceRows({
        agents: initialized ? Object.values(agents) : NO_AGENTS,
        persons: persons.data?.persons ?? [],
        devices: devices.data?.devices ?? [],
        assignments: assignments.data?.assignments ?? [],
        connections: connections.data?.connections ?? [],
      }),
    [agents, initialized, persons.data, devices.data, assignments.data, connections.data],
  );

  return { rows, loading: !initialized || inventoryLoading, hasHousehold: enabled };
}
