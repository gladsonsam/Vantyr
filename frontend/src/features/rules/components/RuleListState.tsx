import type { ReactNode } from "react";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@vantyr/ui/components/empty";
import { Skeleton } from "@vantyr/ui/components/skeleton";

/** Common loading/search-empty boundary; rule tables keep their domain-specific columns and actions. */
export function RuleListState({
  loading,
  empty,
  searching,
  emptyTitle,
  emptyDescription,
  noun = "rules",
  children,
}: {
  loading: boolean;
  empty: boolean;
  searching: boolean;
  emptyTitle: string;
  emptyDescription: string;
  noun?: string;
  children: ReactNode;
}) {
  if (loading) return <Skeleton className="h-64 w-full rounded-xl" />;
  if (empty)
    return (
      <Empty className="border border-border/70 bg-card/10">
        <EmptyHeader>
          <EmptyTitle>{searching ? `No ${noun} match` : emptyTitle}</EmptyTitle>
          <EmptyDescription>
            {searching ? `No ${noun} match the current search.` : emptyDescription}
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  return children;
}
