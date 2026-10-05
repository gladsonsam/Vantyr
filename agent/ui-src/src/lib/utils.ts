import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function getErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

/** Merge Tailwind class lists (shadcn/ui convention). */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
