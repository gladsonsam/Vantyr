import { useMemo, useState, type ReactNode } from "react";

export interface CollectionSortingColumn {
  sortingField?: string;
}

export interface UseCollectionCollectionProps {
  onSortingChange: (event: {
    detail: { sortingColumn?: CollectionSortingColumn; isDescending?: boolean };
  }) => void;
  sortingColumn?: CollectionSortingColumn;
  isDescending?: boolean;
}

export interface UseCollectionFilterProps {
  filteringText: string;
  onChange: (event: { detail: { filteringText: string } }) => void;
}

export interface UseCollectionPaginationProps {
  currentPageIndex: number;
  pagesCount: number;
  onChange: (event: { detail: { currentPageIndex: number } }) => void;
}

interface UseCollectionConfig<T> {
  filtering?: {
    empty?: ReactNode;
    noMatch?: ReactNode;
    filteringFunction?: (item: T, filteringText: string) => boolean;
  };
  pagination?: {
    pageSize?: number;
  };
  sorting?: {
    defaultState?: {
      sortingColumn?: CollectionSortingColumn;
      isDescending?: boolean;
    };
  };
}

function sortableValue<T>(item: T, field: string): unknown {
  if (typeof item !== "object" || item === null) return undefined;
  return (item as Record<string, unknown>)[field];
}

function compareValues(aVal: unknown, bVal: unknown): number {
  if (aVal == null) return 1;
  if (bVal == null) return -1;
  if (aVal === bVal) return 0;
  if (typeof aVal === "number" && typeof bVal === "number") {
    return aVal < bVal ? -1 : 1;
  }
  return String(aVal).localeCompare(String(bVal));
}

export function useCollection<T>(
  items: readonly T[] = [],
  config: UseCollectionConfig<T> = {}
) {
  const [filteringText, setFilteringText] = useState("");
  const [currentPageIndex, setCurrentPageIndex] = useState(1);
  const [sortingColumn, setSortingColumn] = useState<CollectionSortingColumn | undefined>(
    config.sorting?.defaultState?.sortingColumn
  );
  const [isDescending, setIsDescending] = useState<boolean | undefined>(
    config.sorting?.defaultState?.isDescending
  );

  const filteredItems = useMemo(() => {
    if (!filteringText) return items;
    const filterFn = config.filtering?.filteringFunction;
    if (!filterFn) return items;
    return items.filter((item) => filterFn(item, filteringText));
  }, [items, filteringText, config.filtering?.filteringFunction]);

  const sortedItems = useMemo(() => {
    const field = sortingColumn?.sortingField;
    if (!field) return filteredItems;
    const sorted = [...filteredItems];
    sorted.sort((a, b) => {
      const res = compareValues(sortableValue(a, field), sortableValue(b, field));
      return isDescending ? -res : res;
    });
    return sorted;
  }, [filteredItems, sortingColumn, isDescending]);

  const pageSize = config.pagination?.pageSize ?? 50;
  const pagesCount = Math.max(1, Math.ceil(sortedItems.length / pageSize));
  const activePageIndex = Math.min(currentPageIndex, pagesCount);

  const paginatedItems = useMemo(() => {
    const start = (activePageIndex - 1) * pageSize;
    return sortedItems.slice(start, start + pageSize);
  }, [sortedItems, activePageIndex, pageSize]);

  return {
    items: paginatedItems,
    filteredItemsCount: sortedItems.length,
    collectionProps: {
      onSortingChange: (event) => {
        setSortingColumn(event.detail.sortingColumn);
        setIsDescending(event.detail.isDescending);
      },
      sortingColumn,
      isDescending,
    } satisfies UseCollectionCollectionProps,
    filterProps: {
      filteringText,
      onChange: (event) => {
        setFilteringText(event.detail.filteringText);
        setCurrentPageIndex(1);
      },
    } satisfies UseCollectionFilterProps,
    paginationProps: {
      currentPageIndex: activePageIndex,
      pagesCount,
      onChange: (event) => {
        setCurrentPageIndex(event.detail.currentPageIndex);
      },
    } satisfies UseCollectionPaginationProps,
    actions: {
      setCurrentPage: (page: number) => {
        setCurrentPageIndex(page);
      },
      setFiltering: (text: string) => {
        setFilteringText(text);
      },
      setSorting: (col: CollectionSortingColumn | undefined, desc?: boolean) => {
        setSortingColumn(col);
        setIsDescending(desc);
      },
    },
  };
}
