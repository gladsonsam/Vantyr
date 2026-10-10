import { z } from "zod";

/** Confirming enrollment takes the 6-digit code from the authenticator app. */
export const enrollCodeSchema = z.object({
  code: z.string().trim().min(6, "Enter the 6-digit code"),
});

/** Turning 2FA off takes any current code (or a recovery code). */
export const disableCodeSchema = z.object({
  code: z.string().trim().min(1, "Enter a code"),
});

export type TwoFactorCodeValues = z.infer<typeof enrollCodeSchema>;
