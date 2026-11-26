/** Page size meaning "show everything". */
export const PAGE_SIZE_ALL = 0;
export const PAGE_SIZE_OPTIONS = [10, 20, 50, 100, PAGE_SIZE_ALL] as const;

/** Rows visible on `page` (1-based) for `pageSize`, plus the clamped page and page count. */
export function paginate<T>(items: readonly T[], page: number, pageSize: number) {
  if (pageSize === PAGE_SIZE_ALL) return { items: [...items], page: 1, pages: 1 };
  const pages = Math.max(1, Math.ceil(items.length / pageSize));
  const current = Math.min(Math.max(1, page), pages);
  return {
    items: items.slice((current - 1) * pageSize, current * pageSize),
    page: current,
    pages,
  };
}
