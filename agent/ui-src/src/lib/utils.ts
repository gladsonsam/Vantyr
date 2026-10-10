// `cn` lives in the shared UI package; re-exported so app code keeps one import path.
export { cn } from "@vantyr/ui/lib/utils";

export function getErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
