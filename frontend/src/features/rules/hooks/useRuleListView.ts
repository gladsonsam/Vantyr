import { useMemo, useState } from "react";

const PAGE_SIZE = 50;
/** The search box appears once there are enough rows for it to help. */
const SEARCH_FROM = 6;

/** Search and paging over a rule list; `haystack` returns the texts one row can be found by. */
export function useRuleListView<T>(items: T[], haystack: (item: T) => string[]) {
  const [query, setQueryState] = useState("");
  const [page, setPage] = useState(1);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return items;
    return items.filter((item) => haystack(item).some((text) => text.toLowerCase().includes(q)));
  }, [items, query, haystack]);
  const pages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const activePage = Math.min(page, pages);
  const displayed = useMemo(
    () => filtered.slice((activePage - 1) * PAGE_SIZE, activePage * PAGE_SIZE),
    [filtered, activePage],
  );

  return {
    query,
    setQuery: (value: string) => {
      setQueryState(value);
      setPage(1);
    },
    showSearch: items.length >= SEARCH_FROM || query !== "",
    filteredCount: filtered.length,
    displayed,
    page: activePage,
    pages,
    setPage,
  };
}
