import { z } from "zod";

const username = z.string().trim().min(1, "Username is required.");
const password = z.string().min(6, "Password must be at least 6 characters.");

/** Name, sign-in username and avatar of one account (own profile or an admin editing another user). */
export const profileSchema = z.object({
  display_name: z.string(),
  username,
  display_icon: z.string(),
});

export const createUserSchema = z.object({
  display_name: z.string(),
  username,
  password,
  role: z.enum(["viewer", "operator", "admin"]),
});
export type CreateUserValues = z.infer<typeof createUserSchema>;

export const resetPasswordSchema = z.object({ password });
export type ResetPasswordValues = z.infer<typeof resetPasswordSchema>;

export const linkIdentitySchema = z.object({
  issuer: z.string().trim().min(1, "Issuer is required."),
  subject: z.string().trim().min(1, "Subject is required."),
});
export type LinkIdentityValues = z.infer<typeof linkIdentitySchema>;
