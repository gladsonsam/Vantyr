import { Box } from "../components/ui/console";
import { ReactNode } from "react";

interface AuthLayoutProps {
  children: ReactNode;
}

export function AuthLayout({ children }: AuthLayoutProps) {
  return (
    <Box className="vantyr-auth-shell" textAlign="center">
      <Box className="vantyr-auth-card">
        <Box className="vantyr-auth-card-content">
          <Box className="vantyr-auth-card-brand">
            <img
              src={`${import.meta.env.BASE_URL}favicon.svg`}
              alt="Vantyr"
              className="vantyr-auth-logo"
            />
            <Box className="vantyr-auth-title" variant="h1" fontSize="heading-xl" fontWeight="bold">
              Vantyr
            </Box>
            <Box className="vantyr-auth-subtitle" color="text-body-secondary">
              Sign in to continue
            </Box>
          </Box>

          {children}
        </Box>
      </Box>
    </Box>
  );
}
