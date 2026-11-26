import { useEffect, useRef } from "react";
import { cn } from "@/lib/utils";

/** Within this many pixels of the end counts as "following" the newest line. */
const FOLLOW_SLACK_PX = 25;

/**
 * The read-only log text. It is a textarea so lines can be selected and scrolled with the keyboard;
 * long lines scroll sideways inside it (or wrap) instead of widening the page. While `following`
 * it stays on the newest line; scrolling up hands control back to the reader.
 */
export function LogViewer({
  text,
  placeholder,
  wrap,
  following,
  onFollowingChange,
  label,
}: {
  text: string;
  /** Shown while there is no text: loading, empty, nothing matched. */
  placeholder: string;
  wrap: boolean;
  following: boolean;
  onFollowingChange: (following: boolean) => void;
  label: string;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (el && following) el.scrollTop = el.scrollHeight;
  }, [text, following, wrap]);

  return (
    <textarea
      ref={ref}
      aria-label={label}
      value={text}
      placeholder={placeholder}
      readOnly
      spellCheck={false}
      wrap={wrap ? "soft" : "off"}
      onScroll={(e) => {
        const el = e.currentTarget;
        onFollowingChange(el.scrollHeight - el.scrollTop - el.clientHeight <= FOLLOW_SLACK_PX);
      }}
      className={cn(
        "block h-full w-full resize-none border-0 bg-transparent p-3 font-mono text-xs leading-relaxed text-foreground outline-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/50",
        wrap ? "whitespace-pre-wrap" : "whitespace-pre",
      )}
    />
  );
}
