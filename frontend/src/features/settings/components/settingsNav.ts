import { cn } from "@/lib/utils";

export const NAV_ITEM =
  "flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-sm font-medium whitespace-nowrap text-muted-foreground transition-colors hover:bg-muted/40 hover:text-foreground";

/** Classes that turn a base-ui tab trigger into a flat nav item (use inside `SettingsAreaTabsList`). */
export const SETTINGS_TAB_TRIGGER_CLASS = cn(
  NAV_ITEM,
  "h-auto flex-none justify-start border-transparent lg:w-full",
  "after:hidden data-active:bg-muted/60 data-active:text-foreground dark:data-active:bg-muted/60 dark:data-active:text-foreground data-active:[&_svg]:text-primary",
);
