import { useState, type ReactNode } from "react";
import { Plus, RefreshCw, Search, X } from "lucide-react";
import { Button } from "@vantyr/ui/components/button";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
} from "@vantyr/ui/components/input-group";
import { Spinner } from "@vantyr/ui/components/spinner";
import type { DashboardUser } from "@/api/types";
import { ROLE_OPTIONS } from "./roles";
import { directorySummary, filterUsers } from "./userDirectory";
import { ErrorBanner } from "./UserDialogParts";
import { UsersList, type UserActions } from "./UsersList";

/** Past this many accounts a search box earns its place. */
const SEARCH_FROM = 6;

interface UsersDirectoryProps {
  /** The last list the server sent; undefined until the first load succeeds. */
  users: DashboardUser[] | undefined;
  fetching: boolean;
  /** Why the last load failed. With `users` set, the list on screen is the older one. */
  loadError: string | null;
  meId: string | null;
  onReload: () => void;
  onCreate: () => void;
  actions: UserActions;
}

function RoleGuide() {
  return (
    <details className="rounded-xl border border-border/70 bg-card/10 px-4 py-3.5">
      <summary className="cursor-pointer rounded-sm text-sm font-medium outline-none focus-visible:ring-2 focus-visible:ring-ring">
        What each role can do
      </summary>
      <dl className="mt-3 flex flex-col gap-3">
        {ROLE_OPTIONS.map((r) => (
          <div key={r.value} className="rounded-lg border border-border/60 px-3.5 py-3">
            <dt className="text-sm font-semibold">{r.label}</dt>
            <dd className="mt-0.5 text-sm text-muted-foreground">{r.description}</dd>
          </div>
        ))}
      </dl>
    </details>
  );
}

function DirectoryBody({
  users,
  matches,
  query,
  loadError,
  fetching,
  meId,
  actions,
  onReload,
  onClearSearch,
}: Pick<
  UsersDirectoryProps,
  "users" | "loadError" | "fetching" | "meId" | "actions" | "onReload"
> & { matches: DashboardUser[]; query: string; onClearSearch: () => void }) {
  if (!users) {
    return loadError ? (
      <ErrorBanner
        message={`Couldn't load users: ${loadError}`}
        onRetry={onReload}
        retrying={fetching}
      />
    ) : (
      <p
        role="status"
        className="flex items-center gap-2 rounded-xl border border-border/70 bg-card/10 p-5 text-sm text-muted-foreground"
      >
        <Spinner /> Loading users…
      </p>
    );
  }
  if (users.length === 0)
    return (
      <p className="rounded-xl border border-border/70 bg-card/10 p-5 text-sm text-muted-foreground">
        No users yet. Create the first one.
      </p>
    );
  if (matches.length === 0) {
    return (
      <div className="flex flex-wrap items-center gap-3 rounded-xl border border-border/70 bg-card/10 p-5 text-sm text-muted-foreground">
        <span className="min-w-0 break-words">No user matches “{query.trim()}”.</span>
        <Button variant="outline" size="sm" onClick={onClearSearch}>
          Clear search
        </Button>
      </div>
    );
  }
  return <UsersList users={matches} allUsers={users} meId={meId} actions={actions} />;
}

function DirectoryToolbar({
  summary,
  search,
  fetching,
  onReload,
  onCreate,
}: {
  summary: string | null;
  search?: ReactNode;
  fetching: boolean;
  onReload: () => void;
  onCreate: () => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
      {search}
      <p role="status" className="min-w-0 flex-1 text-sm text-muted-foreground tabular-nums">
        {summary}
      </p>
      <Button
        variant="outline"
        size="icon"
        className="pointer-coarse:size-9"
        aria-label="Refresh users"
        disabled={fetching}
        onClick={onReload}
      >
        {fetching ? <Spinner /> : <RefreshCw />}
      </Button>
      <Button data-create-user onClick={onCreate}>
        <Plus /> Create user
      </Button>
    </div>
  );
}

function UserSearch({ query, onChange }: { query: string; onChange: (query: string) => void }) {
  return (
    <InputGroup className="h-9 min-w-0 basis-full sm:w-64 sm:basis-auto">
      <InputGroupAddon>
        <Search />
      </InputGroupAddon>
      <InputGroupInput
        aria-label="Search users"
        placeholder="Search name, username or role"
        value={query}
        onChange={(event) => onChange(event.target.value)}
      />
      {query && (
        <InputGroupAddon align="inline-end">
          <InputGroupButton size="icon-xs" aria-label="Clear search" onClick={() => onChange("")}>
            <X />
          </InputGroupButton>
        </InputGroupAddon>
      )}
    </InputGroup>
  );
}

/** The user list with what is in it, search, refresh and create, and honest load, stale and empty states. */
export function UsersDirectory({
  users,
  fetching,
  loadError,
  meId,
  onReload,
  onCreate,
  actions,
}: UsersDirectoryProps) {
  const [typed, setQuery] = useState("");
  // The search box only shows for long lists, so a query typed earlier doesn't linger after the list shrinks.
  const canSearch = (users?.length ?? 0) > SEARCH_FROM;
  const query = canSearch ? typed : "";
  const matches = users ? filterUsers(users, query) : [];
  const hasUsers = users !== undefined && users.length > 0;
  const summary =
    !users || users.length === 0
      ? null
      : query.trim()
        ? `${matches.length} of ${users.length} users`
        : directorySummary(users);

  return (
    <div className="flex flex-col gap-4">
      <DirectoryToolbar
        summary={summary}
        search={canSearch ? <UserSearch query={query} onChange={setQuery} /> : undefined}
        fetching={fetching}
        onReload={onReload}
        onCreate={onCreate}
      />
      {users && loadError && (
        <ErrorBanner
          message={`Couldn't refresh users: ${loadError}. Showing the list from the last successful load.`}
          onRetry={onReload}
          retrying={fetching}
        />
      )}
      <DirectoryBody
        users={users}
        matches={matches}
        query={query}
        loadError={loadError}
        fetching={fetching}
        meId={meId}
        actions={actions}
        onReload={onReload}
        onClearSearch={() => setQuery("")}
      />
      {hasUsers && <RoleGuide />}
    </div>
  );
}
