import { useSidebar } from "@vantyr/ui/components/sidebar";

/**
 * Opens the shell's mobile nav sheet for pages that render their own header
 * (e.g. the agent detail page). Returns null when not inside an AppShell.
 */
export function useMobileNavOpener(): (() => void) | null {
  let setOpenMobile: (open: boolean) => void;
  try {
    // oxlint-disable-next-line react/rules-of-hooks
    setOpenMobile = useSidebar().setOpenMobile;
  } catch {
    return null;
  }
  if (!setOpenMobile) return null;
  const open = setOpenMobile;
  return () => open(true);
}
