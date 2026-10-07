import type { FieldErrors, FieldValues } from "react-hook-form";

/**
 * The first validation message in a form's errors, in field order. For forms that report a single
 * message in one place (an alert above the fields) instead of under each field: pass it to the
 * `onInvalid` of `handleSubmit`.
 */
export function firstErrorMessage<T extends FieldValues>(errors: FieldErrors<T>): string | null {
  return findMessage(errors);
}

function findMessage(node: unknown): string | null {
  if (typeof node !== "object" || node === null) return null;
  const message = (node as { message?: unknown }).message;
  if (typeof message === "string" && message) return message;
  for (const [key, value] of Object.entries(node)) {
    // `ref` is the DOM element the error belongs to; `types` repeats the messages.
    if (key === "ref" || key === "types") continue;
    const found = findMessage(value);
    if (found) return found;
  }
  return null;
}
