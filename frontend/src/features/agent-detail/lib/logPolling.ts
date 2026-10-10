import { isApiError } from "@/api";

export const LOG_POLL_MS = 2000;

/** A 4xx (other than timeout/rate-limit) won't fix itself by retrying: authorisation, missing module, etc. */
export function isDefinitiveFailure(error: unknown): boolean {
  if (!isApiError(error)) return false;
  const s = error.status;
  return s >= 400 && s < 500 && s !== 408 && s !== 429;
}

/** Poll interval for the live tail: stops while the last attempt failed definitively. */
export function logPollInterval(autoRefresh: boolean, error: unknown): number | false {
  return autoRefresh && !isDefinitiveFailure(error) ? LOG_POLL_MS : false;
}

export function logRetry(failureCount: number, error: unknown): boolean {
  return !isDefinitiveFailure(error) && failureCount < 2;
}
