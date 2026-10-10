/** Branded full-screen loader for auth/route-chunk loads — matches the index.html
 *  boot splash so the hand-off is seamless (no black flash). */
export function LoadShell({ label = "Loading…" }: { label?: string }) {
  return (
    <div className="fixed inset-0 z-[100] flex flex-col items-center justify-center gap-[18px] bg-background font-sans text-muted-foreground">
      <div className="size-[42px] animate-spin rounded-full border-[3px] border-muted border-t-primary" />
      <div className="text-[13px] font-medium tracking-[0.02em]">{label}</div>
    </div>
  );
}
