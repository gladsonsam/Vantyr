import type { ReactNode } from "react";

interface AuthLayoutProps {
  children: ReactNode;
  /** The line under the product name; says what this screen is for. */
  subtitle?: string;
}

/**
 * The signed-out frame: product mark and name over one card. The app root is a fixed-height,
 * non-scrolling column, so this frame scrolls itself; the card's auto margins centre it when it
 * fits and let it start at the top (never clipped) on short screens or with the keyboard open.
 */
export function AuthLayout({ children, subtitle = "Sign in to continue" }: AuthLayoutProps) {
  return (
    <main className="flex min-h-0 flex-1 flex-col overflow-y-auto bg-background px-4 py-6 font-sans antialiased sm:py-10">
      <div className="m-auto w-full max-w-sm rounded-xl border border-border/70 bg-card/10 px-6 py-8 sm:px-8 sm:py-10">
        <header className="mb-8 flex flex-col items-center gap-3 text-center">
          <div className="flex flex-col items-center gap-3">
            <img src={`${import.meta.env.BASE_URL}favicon.svg`} alt="" className="size-12" />
            <h1 className="font-heading text-2xl font-semibold tracking-tight">Vantyr</h1>
          </div>
          <p className="text-sm text-muted-foreground">{subtitle}</p>
        </header>

        {children}
      </div>
    </main>
  );
}
