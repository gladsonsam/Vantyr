import { createContext, useContext } from "react";
import type { DeviceRow } from "@/features/devices/lib/deviceModel";

/** The device the open device page is about. Set by `DeviceLayout`. */
export const DeviceContext = createContext<DeviceRow | null>(null);

export function useDevice(): DeviceRow {
  const device = useContext(DeviceContext);
  if (!device) throw new Error("useDevice must be used inside DeviceLayout");
  return device;
}
