import { createContext, useContext } from "react";
import type { useNotificationStore } from "@/app/providers/useNotificationStore";

export type NotificationsValue = ReturnType<typeof useNotificationStore>;

export const NotificationsContext = createContext<NotificationsValue | null>(null);

/** In-app notification banners shown at the top of the dashboard shell. */
export function useNotifications(): NotificationsValue {
  const value = useContext(NotificationsContext);
  if (!value) throw new Error("useNotifications must be used inside NotificationsProvider");
  return value;
}
