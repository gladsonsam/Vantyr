export function classNames(...items: Array<string | false | null | undefined>) {
  return items.filter(Boolean).join(" ");
}

export function getErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
