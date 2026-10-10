import { useSidebar } from "@vantyr/ui/components/sidebar";

/**
 * Compatibility for pages that opened the legacy mobile nav drawer (e.g. the
 * agent detail page, which renders its own header). With the shadcn Sidebar,
 * opening the mobile sheet is `setOpenMobile(true)`. Returns null when not
 * inside an AppShell.
 */
export function useMobileNavOpener(): (() => void) | null {
  let setOpenMobile: ((open: boolean) => void) | null = null;
  try {
    // eslint-disable-next-line react-hooks/rules-of-hooks
    setOpenMobile = useSidebar().setOpenMobile;
  } catch {
    return null;
  }
  if (!setOpenMobile) return null;
  const open = setOpenMobile;
  return () => open(true);
}
