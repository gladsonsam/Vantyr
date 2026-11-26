import { Spinner } from "@vantyr/ui/components/spinner";

export function PageLoading() {
  return (
    <div className="flex items-center justify-center gap-2 rounded-xl border border-border/70 bg-card/10 py-12 text-sm text-muted-foreground">
      <Spinner /> Loading…
    </div>
  );
}
