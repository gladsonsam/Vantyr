import type { ReactNode } from "react";
import { Plus, Search } from "lucide-react";
import { Button } from "@vantyr/ui/components/button";
import { Skeleton } from "@vantyr/ui/components/skeleton";
import { EmptyState } from "@/components/common/EmptyState";
import { ListPagination } from "@/components/common/ListPagination";
import { LoadFailedCard } from "@/components/common/LoadFailedCard";
import { errorText } from "@/api";
import { ErrorBanner, Notice, RuleSearch, RuleToolbar } from "./RuleTabParts";

/** What the layout needs of `useRuleListView`: search, the current page and paging. */
interface ListViewState {
  query: string;
  setQuery: (query: string) => void;
  showSearch: boolean;
  filteredCount: number;
  displayed: readonly unknown[];
  page: number;
  pages: number;
  setPage: (page: number) => void;
}

export interface RuleTabLayoutProps {
  /** What the tab lists, as it reads in messages: "app block rules", "scheduled scripts". */
  noun: string;
  /** The create button: "New rule", "New script". */
  createLabel: string;
  query: { isPending: boolean; isError: boolean; error: unknown; refetch: () => unknown };
  total: number;
  countSummary: string;
  list: ListViewState;
  searchLabel: string;
  searchPlaceholder: string;
  empty: { title: string; description: string; icon: ReactNode };
  /** What failed or succeeded last, outside any dialog. */
  actionError: string | null;
  onDismissAction: () => void;
  saved: string | null;
  onDismissSaved: () => void;
  /** Further banners shown above the list (for example a feed that failed). */
  banners?: ReactNode;
  onCreate: () => void;
  /** The rows for the current page. */
  rows: ReactNode;
  dialogs: ReactNode;
}

/**
 * The frame every rules tab shares: a failed first load with Try again, a skeleton, the first-run invitation,
 * then banners, count, search, the rows and paging. A failed refresh keeps the rows already on screen.
 */
export function RuleTabLayout(props: RuleTabLayoutProps) {
  const { noun, createLabel, query, total, empty, saved, onDismissSaved, onCreate, dialogs } =
    props;
  const retry = () => void query.refetch();

  // Only a first load that failed has nothing to show.
  if (query.isError && total === 0) {
    return (
      <LoadFailedCard
        message={`Couldn’t load ${noun}: ${errorText(query.error)}`}
        onRetry={retry}
      />
    );
  }
  if (query.isPending) return <Skeleton className="h-64 w-full rounded-xl" />;
  if (total === 0) {
    return (
      <div className="flex flex-col gap-4">
        {saved && <Notice message={saved} onDismiss={onDismissSaved} />}
        <EmptyState
          title={empty.title}
          description={empty.description}
          icon={empty.icon}
          iconVariant="icon"
          action={
            <Button onClick={onCreate}>
              <Plus /> {createLabel}
            </Button>
          }
        />
        {dialogs}
      </div>
    );
  }
  return <RuleTabMain {...props} retry={retry} />;
}

function RuleTabMain({
  noun,
  createLabel,
  query,
  total,
  countSummary,
  list,
  searchLabel,
  searchPlaceholder,
  actionError,
  onDismissAction,
  saved,
  onDismissSaved,
  banners,
  onCreate,
  rows,
  dialogs,
  retry,
}: RuleTabLayoutProps & { retry: () => void }) {
  return (
    <div className="flex flex-col gap-4">
      {actionError && (
        <ErrorBanner message={actionError} actionLabel="Dismiss" onAction={onDismissAction} />
      )}
      {query.isError && (
        <ErrorBanner
          message={`Couldn’t refresh ${noun}: ${errorText(query.error)}. Showing the last list that loaded.`}
          actionLabel="Try again"
          onAction={retry}
        />
      )}
      {banners}
      {saved && <Notice message={saved} onDismiss={onDismissSaved} />}

      <RuleToolbar
        summary={
          list.query ? `${list.filteredCount} of ${total} ${noun.split(" ").pop()}` : countSummary
        }
        createLabel={createLabel}
        onCreate={onCreate}
      />
      {list.showSearch && (
        <RuleSearch
          label={searchLabel}
          placeholder={searchPlaceholder}
          query={list.query}
          onChange={list.setQuery}
        />
      )}

      {list.displayed.length === 0 ? (
        <EmptyState
          title={`No ${noun.split(" ").pop()} match`}
          description={`Nothing matches “${list.query.trim()}”.`}
          icon={<Search />}
          iconVariant="icon"
          action={
            <Button variant="outline" onClick={() => list.setQuery("")}>
              Clear search
            </Button>
          }
        />
      ) : (
        <div className="overflow-hidden rounded-xl bg-card">
          {rows}
          <ListPagination page={list.page} pages={list.pages} onPageChange={list.setPage} />
        </div>
      )}
      {dialogs}
    </div>
  );
}
