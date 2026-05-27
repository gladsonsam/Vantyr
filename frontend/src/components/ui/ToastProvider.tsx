import { createContext, use, useCallback, useMemo, useState } from "react";

export type ToastVariant = "success" | "error" | "info";

export type ToastItem = {
  id: string;
  variant: ToastVariant;
  title: string;
  message?: string;
};

type PushToast = Omit<ToastItem, "id">;

type ToastContextValue = {
  pushToast: (t: PushToast) => void;
};

const ToastContext = createContext<ToastContextValue | null>(null);

function makeId() {
  const g = globalThis as unknown as { crypto?: { randomUUID?: () => string } };
  if (g.crypto?.randomUUID) return g.crypto.randomUUID();
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = useState<ToastItem[]>([]);

  const pushToast = useCallback((t: PushToast) => {
    const id = makeId();
    const item: ToastItem = { ...t, id };
    setToasts((prev) => [...prev, item]);

    window.setTimeout(() => {
      setToasts((prev) => prev.filter((x) => x.id !== id));
    }, 4000);
  }, []);

  const value = useMemo(() => ({ pushToast }), [pushToast]);

  return (
    <ToastContext.Provider value={value}>
      {children}

      <div className="fixed bottom-3 right-3 z-50 flex flex-col gap-2 w-[360px] max-w-[calc(100vw-1.5rem)]">
        {toasts.map((t) => {
          const tone =
            t.variant === "success"
              ? {
                  border: "border-ok/30",
                  bg: "bg-ok/10",
                  text: "text-ok",
                }
              : t.variant === "error"
                ? {
                    border: "border-danger/30",
                    bg: "bg-danger/10",
                    text: "text-danger",
                  }
                : {
                    border: "border-accent/30",
                    bg: "bg-accent/10",
                    text: "text-accent",
                  };

          return (
            <div
              key={t.id}
              className={[
                "bg-surface border rounded-lg shadow-lg px-3 py-2",
                tone.border,
                tone.bg,
              ].join(" ")}
            >
              <div className="flex items-start gap-2">
                <div className={["mt-1 w-2 h-2 rounded-full flex-shrink-0", tone.text].join(" ")} />
                <div className="min-w-0 flex-1">
                  <div className={["text-xs font-semibold", tone.text].join(" ")}>
                    {t.title}
                  </div>
                  {t.message && (
                    <div className="text-xs text-muted mt-0.5 leading-snug">
                      {t.message}
                    </div>
                  )}
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast() {
  const v = use(ToastContext);
  if (!v) throw new Error("useToast must be used within ToastProvider");
  return v;
}
