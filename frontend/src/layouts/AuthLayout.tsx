import type { ReactNode } from "react";

interface AuthLayoutProps {
  children: ReactNode;
}

export function AuthLayout({ children }: AuthLayoutProps) {
  return (
    <div className="flex min-h-svh items-center justify-center bg-background px-4 py-10 font-sans antialiased">
      <div className="w-full max-w-sm rounded-xl bg-card px-6 py-8">
        <div className="mb-6 flex flex-col items-center gap-2 text-center">
          <img
            src={`${import.meta.env.BASE_URL}favicon.svg`}
            alt="Vantyr"
            className="size-10"
          />
          <h1 className="font-heading text-2xl font-semibold tracking-tight">
            Vantyr
          </h1>
          <p className="text-sm text-muted-foreground">Sign in to continue</p>
        </div>

        {children}
      </div>
    </div>
  );
}
