import { useState, useCallback, useEffect, useRef } from "react";
import type { FlashbarProps } from "@cloudscape-design/components/flashbar";

export type NotificationType = "success" | "error" | "warning" | "info";

export interface NotificationItem extends FlashbarProps.MessageDefinition {
  id: string;
}

let notificationIdCounter = 0;

export function useNotifications() {
  const [notifications, setNotifications] = useState<NotificationItem[]>([]);
  // Pending auto-dismiss timers keyed by notification id, so we can cancel them on manual
  // dismiss and on unmount and avoid `setState` after the component is gone.
  const timersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());

  const removeNotification = useCallback((id: string) => {
    const handle = timersRef.current.get(id);
    if (handle) {
      clearTimeout(handle);
      timersRef.current.delete(id);
    }
    setNotifications((prev) => prev.filter((n) => n.id !== id));
  }, []);

  const addNotification = useCallback(
    (
      type: NotificationType,
      header: string,
      content?: string,
      options?: {
        dismissible?: boolean;
        dismissLabel?: string;
        autoDismiss?: boolean;
        autoDismissTimeout?: number;
        action?: FlashbarProps.MessageDefinition["action"];
      }
    ) => {
      const id = `notification-${++notificationIdCounter}`;
      const notification: NotificationItem = {
        id,
        type,
        header,
        content,
        dismissible: options?.dismissible ?? true,
        dismissLabel: options?.dismissLabel ?? "Dismiss",
        action: options?.action,
        onDismiss: () => removeNotification(id),
      };

      setNotifications((prev) => [...prev, notification]);

      if (options?.autoDismiss !== false) {
        const timeout = options?.autoDismissTimeout ?? 5000;
        const handle = setTimeout(() => {
          removeNotification(id);
        }, timeout);
        timersRef.current.set(id, handle);
      }

      return id;
    },
    [removeNotification]
  );

  const clearAll = useCallback(() => {
    timersRef.current.forEach((handle) => clearTimeout(handle));
    timersRef.current.clear();
    setNotifications([]);
  }, []);

  // Cancel any pending auto-dismiss timers on unmount.
  useEffect(() => {
    const timers = timersRef.current;
    return () => {
      timers.forEach((handle) => clearTimeout(handle));
      timers.clear();
    };
  }, []);

  const success = useCallback(
    (header: string, content?: string, options?: Parameters<typeof addNotification>[3]) => {
      return addNotification("success", header, content, options);
    },
    [addNotification]
  );

  const error = useCallback(
    (header: string, content?: string, options?: Parameters<typeof addNotification>[3]) => {
      return addNotification("error", header, content, options);
    },
    [addNotification]
  );

  const warning = useCallback(
    (header: string, content?: string, options?: Parameters<typeof addNotification>[3]) => {
      return addNotification("warning", header, content, options);
    },
    [addNotification]
  );

  const info = useCallback(
    (header: string, content?: string, options?: Parameters<typeof addNotification>[3]) => {
      return addNotification("info", header, content, options);
    },
    [addNotification]
  );

  return {
    notifications,
    addNotification,
    removeNotification,
    clearAll,
    success,
    error,
    warning,
    info,
  };
}
