import {
  Cpu,
  HelpCircle,
  Monitor,
  Router,
  Smartphone,
  Tablet,
  Tv,
  Wifi,
  type LucideIcon,
} from "lucide-react";
import type { NetworkDeviceType } from "@/api/types";

export const DEVICE_TYPE_ICON: Record<NetworkDeviceType, LucideIcon> = {
  computer: Monitor,
  phone: Smartphone,
  tablet: Tablet,
  tv: Tv,
  router: Router,
  switch: Router,
  ap: Wifi,
  iot: Cpu,
  other: HelpCircle,
  unknown: HelpCircle,
};

export const DEVICE_TYPE_LABEL: Record<NetworkDeviceType, string> = {
  computer: "Computer",
  phone: "Phone",
  tablet: "Tablet",
  tv: "TV",
  router: "Router",
  switch: "Switch",
  ap: "Access point",
  iot: "Smart device",
  other: "Device",
  unknown: "Device",
};
