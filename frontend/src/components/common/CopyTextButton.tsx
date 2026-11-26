import { useEffect, useRef, useState } from "react";
import { Check, Copy } from "lucide-react";
import { Button } from "@vantyr/ui/components/button";
import { cn, copyToClipboard } from "@/lib/utils";

type CopyState = "idle" | "copied" | "failed";

/** A "Copy" button for a block of text (log lines, script output). The outcome replaces its label for a moment and is announced. */
export function CopyTextButton({
  text,
  label = "Copy",
  disabled = false,
  className,
}: {
  text: string;
  /** Visible name, and what the accessible name says ("Copy output"). */
  label?: string;
  disabled?: boolean;
  className?: string;
}) {
  const [state, setState] = useState<CopyState>("idle");
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  const copy = async () => {
    const ok = await copyToClipboard(text);
    setState(ok ? "copied" : "failed");
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setState("idle"), 2000);
  };

  return (
    <>
      <Button
        variant="outline"
        size="sm"
        className={cn("pointer-coarse:h-9", state === "failed" && "text-destructive", className)}
        disabled={disabled}
        onClick={() => void copy()}
      >
        {state === "copied" ? <Check className="text-success" /> : <Copy />}
        {state === "copied" ? "Copied" : state === "failed" ? "Couldn’t copy" : label}
      </Button>
      <span role="status" className="sr-only">
        {state === "copied"
          ? "Copied to clipboard"
          : state === "failed"
            ? "Couldn’t copy to the clipboard"
            : ""}
      </span>
    </>
  );
}
