import { useState } from "react";
import { Search, Trash2, X } from "lucide-react";
import { Alert, AlertDescription } from "@vantyr/ui/components/alert";
import { Button } from "@vantyr/ui/components/button";
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupInput } from "@vantyr/ui/components/input-group";
import { Spinner } from "@vantyr/ui/components/spinner";

export type UrlOverrideRow = {
  id: number;
  kind: "domain" | "url";
  value: string;
  category_key: string;
  category_label: string;
  note: string;
  created_at: string;
};

/** The server returns at most this many overrides per search. */
export const OVERRIDE_LIMIT = 500;

const KIND_LABEL = { domain: "Domain", url: "URL prefix" } as const;
const rowKey = (row: UrlOverrideRow) => `${row.kind}-${row.id}`;

/** The saved overrides: search, count, and one row each with an in-row delete confirmation. */
export function UrlOverrideList({ rows, search, onSearch, loading, firstLoad, loadError, hasRows, onRetry, onDelete, deleting }: {
  rows: UrlOverrideRow[];
  search: string;
  onSearch: (value: string) => void;
  /** A (re)load is in flight. */
  loading: boolean;
  /** Nothing has loaded yet. */
  firstLoad: boolean;
  /** Why the last load failed; with rows present they are what was loaded before. */
  loadError: string | null;
  hasRows: boolean;
  onRetry: () => void;
  onDelete: (row: UrlOverrideRow) => Promise<void>;
  deleting: boolean;
}) {
  const [confirming, setConfirming] = useState<string | null>(null);
  const failedEmpty = !!loadError && !hasRows;

  return (
    <section aria-labelledby="override-list-heading" className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-2">
        <h3 id="override-list-heading" className="font-heading text-base font-medium">Saved overrides</h3>
        {loading && !firstLoad ? <Spinner aria-label="Updating" /> : null}
      </div>
      <InputGroup className="h-9">
        <InputGroupAddon>
          <Search />
        </InputGroupAddon>
        <InputGroupInput
          aria-label="Search overrides"
          placeholder="Search by domain, URL or category"
          value={search}
          onChange={(event) => onSearch(event.target.value)}
        />
        {search && (
          <InputGroupAddon align="inline-end">
            <InputGroupButton size="icon-xs" aria-label="Clear search" onClick={() => onSearch("")}>
              <X />
            </InputGroupButton>
          </InputGroupAddon>
        )}
      </InputGroup>

      {loadError && hasRows ? (
        <Alert variant="destructive">
          <AlertDescription className="flex flex-wrap items-center justify-between gap-2">
            <span>Couldn't refresh. These are the overrides from the last load.</span>
            <Button variant="outline" size="sm" onClick={onRetry}>Try again</Button>
          </AlertDescription>
        </Alert>
      ) : null}

      <ListBody
        rows={rows}
        search={search}
        firstLoad={firstLoad}
        failedEmpty={failedEmpty}
        loadError={loadError}
        onRetry={onRetry}
        confirming={confirming}
        setConfirming={setConfirming}
        onDelete={onDelete}
        deleting={deleting}
      />
    </section>
  );
}

function ListBody({ rows, search, firstLoad, failedEmpty, loadError, onRetry, confirming, setConfirming, onDelete, deleting }: {
  rows: UrlOverrideRow[];
  search: string;
  firstLoad: boolean;
  failedEmpty: boolean;
  loadError: string | null;
  onRetry: () => void;
  confirming: string | null;
  setConfirming: (key: string | null) => void;
  onDelete: (row: UrlOverrideRow) => Promise<void>;
  deleting: boolean;
}) {
  return (
    <>
      {firstLoad ? (
        <p className="flex items-center gap-2 py-4 text-sm text-muted-foreground"><Spinner /> Loading overrides…</p>
      ) : failedEmpty ? (
        <Alert variant="destructive">
          <AlertDescription className="flex flex-wrap items-center justify-between gap-2">
            <span>Couldn't load the overrides. {loadError}</span>
            <Button variant="outline" size="sm" onClick={onRetry}>Try again</Button>
          </AlertDescription>
        </Alert>
      ) : rows.length === 0 ? (
        <p className="py-4 text-sm text-muted-foreground">
          {search ? `No overrides match “${search}”.` : "No overrides yet. Add one above."}
        </p>
      ) : (
        <OverrideRows rows={rows} search={search} confirming={confirming} setConfirming={setConfirming} onDelete={onDelete} deleting={deleting} />
      )}
    </>
  );
}

function overrideCount(count: number, search: string): string {
  if (count >= OVERRIDE_LIMIT) return `Showing the first ${OVERRIDE_LIMIT}. Search to narrow the list.`;
  const noun = count === 1 ? "override" : "overrides";
  return search ? `${count} ${noun} match “${search}”` : `${count} ${noun}`;
}

function OverrideRows({ rows, search, confirming, setConfirming, onDelete, deleting }: {
  rows: UrlOverrideRow[];
  search: string;
  confirming: string | null;
  setConfirming: (key: string | null) => void;
  onDelete: (row: UrlOverrideRow) => Promise<void>;
  deleting: boolean;
}) {
  return (
    <>
      <p className="text-xs text-muted-foreground">{overrideCount(rows.length, search)}</p>
      <ul className="flex flex-col divide-y divide-border/50">
        {rows.map((row) => (
          <OverrideRow
            key={rowKey(row)}
            row={row}
            confirming={confirming === rowKey(row)}
            deleting={deleting}
            onAsk={() => setConfirming(rowKey(row))}
            onKeep={() => setConfirming(null)}
            onRemove={async () => { await onDelete(row); setConfirming(null); }}
          />
        ))}
      </ul>
    </>
  );
}

function OverrideRow({ row, confirming, deleting, onAsk, onKeep, onRemove }: {
  row: UrlOverrideRow;
  confirming: boolean;
  deleting: boolean;
  onAsk: () => void;
  onKeep: () => void;
  onRemove: () => Promise<void>;
}) {
  return (
    <li className="flex flex-wrap items-start gap-x-3 gap-y-2 py-3">
      <div className="min-w-0 flex-1 basis-56">
        <div className="text-sm font-medium break-all">{row.value}</div>
        <div className="text-xs text-muted-foreground">
          {KIND_LABEL[row.kind]} → {row.category_label || row.category_key}
          {row.note ? ` · ${row.note}` : ""}
        </div>
        <div className="text-xs text-muted-foreground">Added {new Date(row.created_at).toLocaleString()}</div>
      </div>
      {confirming ? (
        <div className="flex w-full flex-col gap-2 rounded-lg bg-muted/50 p-3 sm:w-auto sm:max-w-xs">
          <p className="text-sm">Remove this override? Pages that match it go back to the category from the lists.</p>
          <div className="flex flex-wrap gap-2">
            <Button size="sm" variant="destructive" disabled={deleting} onClick={() => void onRemove()}>
              {deleting && <Spinner />} Remove override
            </Button>
            <Button size="sm" variant="outline" disabled={deleting} onClick={onKeep}>Keep</Button>
          </div>
        </div>
      ) : (
        <Button variant="ghost" size="sm" aria-label={`Remove override for ${row.value}`} onClick={onAsk}>
          <Trash2 /> Remove
        </Button>
      )}
    </li>
  );
}
