import type { ReactNode } from "react";
import { useNotificationStore } from "@/app/providers/useNotificationStore";
import { NotificationsContext } from "./useNotifications";

export function NotificationsProvider({ children }: { children: ReactNode }) {
  const notifications = useNotificationStore();
  return <NotificationsContext.Provider value={notifications}>{children}</NotificationsContext.Provider>;
}
