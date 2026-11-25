import { useEffect, useRef, useState } from "react";
import { messageOf } from "./groupSummary";

/**
 * Runs one membership change at a time and keeps its outcome: busy while it runs, then either a
 * success message (which takes focus, because a removed row takes its button with it) or the failure.
 */
export function useMemberChanges() {
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<string | null>(null);
  const outcomeRef = useRef<HTMLParagraphElement>(null);
  useEffect(() => { if (outcome) outcomeRef.current?.focus(); }, [outcome]);

  const run = async (action: () => Promise<void>, done: string) => {
    setBusy(true);
    setFailure(null);
    setOutcome(null);
    try {
      await action();
      setOutcome(done);
    } catch (e: unknown) {
      setFailure(messageOf(e));
    } finally {
      setBusy(false);
    }
  };

  return { busy, failure, outcome, outcomeRef, run };
}
