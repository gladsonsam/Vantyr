import { createContext, useContext, useLayoutEffect } from "react";

export interface PageHeader {
  title: string;
  description?: string;
  /** Hide the shell's title block and phone top bar (the page renders its own header). */
  hideTopBar?: boolean;
}

export const PageHeaderContext = createContext<((header: PageHeader) => void) | null>(null);

/** Sets the title block of the persistent dashboard shell for the current page. */
export function usePageHeader({ title, description, hideTopBar = false }: PageHeader): void {
  const setHeader = useContext(PageHeaderContext);
  // Layout effect so the shell picks up the new title before the browser paints.
  useLayoutEffect(() => {
    setHeader?.({ title, description, hideTopBar });
  }, [setHeader, title, description, hideTopBar]);
}
