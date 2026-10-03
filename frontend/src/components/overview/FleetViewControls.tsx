import { useState } from "react";
import type { FleetPreferences, FleetStatusFilter, SavedFleetView } from "../../lib/fleetPreferences";
import type { FleetSort } from "../../lib/fleetSort";
interface Props {
  current: Omit<SavedFleetView, "name">;
  preferences: FleetPreferences;
  ready: boolean;
  visible: number;
  total: number;
  onSearch: (value: string) => void;
  onStatus: (value: FleetStatusFilter) => void;
  onView: (value: "grid" | "table") => void;
  onSort: (value: FleetSort) => void;
  onFavoritesOnly: (value: boolean) => void;
  onApply: (view: SavedFleetView) => void;
  onSave: (name: string) => void;
  onRemove: (name: string) => void;
  onClear: () => void;
}
export function FleetViewControls({ current, preferences, ready, visible, total, onSearch, onStatus, onView, onSort, onFavoritesOnly, onApply, onSave, onRemove, onClear }: Props) {
  const [name, setName] = useState("");
  const [chosen, setChosen] = useState("");
  const view = preferences.views.find((view) => view.name === chosen);
  const filtered = Boolean(current.search.trim() || current.status !== "all" || current.favoritesOnly);
  const full = preferences.views.length >= 20 && !preferences.views.some((view) => view.name === name.trim());
  return <div className="fleet-view-controls">
    <style>{`
      .fleet-view-controls { padding: 12px 24px 0; min-width: 0; color: var(--tx-2); font-size: 12.5px; }
      .fleet-view-summary, .fleet-view-fields { display: flex; align-items: center; flex-wrap: wrap; gap: 10px; }
      .fleet-view-controls button, .fleet-view-controls input, .fleet-view-controls select, .fleet-view-controls summary { min-height: 44px; box-sizing: border-box; }
      .fleet-view-controls button, .fleet-view-controls input, .fleet-view-controls select { border: 1px solid var(--line-2); border-radius: 8px; background: var(--card-2); color: var(--tx); padding: 8px 10px; max-width: 100%; }
      .fleet-view-controls label { display: flex; flex-direction: column; gap: 4px; min-width: 0; max-width: 100%; }
      .fleet-view-controls details { margin-top: 8px; }
      .fleet-view-controls summary { cursor: pointer; width: fit-content; padding: 12px 0; }
      .fleet-view-fields { padding: 8px 0; align-items: flex-end; }
      .fleet-view-controls form { min-width: 0; }
      .fleet-selection-toolbar { flex-wrap: wrap; }
      .fleet-selection-toolbar button { min-height: 44px !important; }
      @media (max-width: 400px) { .fleet-view-controls { padding: 12px 12px 0; } .fleet-selection-toolbar { padding-left: 12px !important; padding-right: 12px !important; } .fleet-view-fields label { width: 100%; } .fleet-view-fields input, .fleet-view-fields select { width: 100%; } }
    `}</style>
    <div className="fleet-view-summary">
      <span aria-live="polite">{visible} of {total} devices shown</span>
      <button type="button" aria-pressed={current.favoritesOnly} disabled={!ready} onClick={() => onFavoritesOnly(!current.favoritesOnly)}>Favorites only</button>
      {filtered && <button type="button" onClick={onClear}>Clear filters</button>}
    </div>
    {visible === 0 && filtered && <p>No devices match these filters. Clear filters to show the fleet.</p>}
    <details>
      <summary>Views &amp; filters</summary>
      <div className="fleet-view-fields">
        <label>Search devices<input aria-label="Search fleet devices" maxLength={512} value={current.search} onChange={(e) => onSearch(e.target.value)} /></label>
        <label>Status<select aria-label="Device status" value={current.status} onChange={(e) => onStatus(e.target.value as FleetStatusFilter)}>
          <option value="all">All statuses</option><option value="online">Online</option><option value="offline">Offline</option><option value="active">Active</option><option value="afk">AFK</option>
        </select></label>
        <label>View<select aria-label="Fleet view mode" value={current.view} onChange={(e) => onView(e.target.value as "grid" | "table")}><option value="grid">Grid</option><option value="table">List</option></select></label>
        <label>Sort devices<select aria-label="Sort devices" value={current.sort.key} onChange={(e) => onSort({ ...current.sort, key: e.target.value as FleetSort["key"] })}>
          <option value="connectivity">Connectivity, then name</option><option value="name">Name</option><option value="last_seen">Last seen</option><option value="first_seen">Date added</option><option value="agent_version">Agent version</option>
        </select></label>
        <label>Direction<select aria-label="Sort direction" value={current.sort.direction} onChange={(e) => onSort({ ...current.sort, direction: e.target.value as FleetSort["direction"] })}>
          <option value="asc">{current.sort.key === "connectivity" ? "Online first, A–Z" : ["last_seen", "first_seen"].includes(current.sort.key) ? "Oldest first" : current.sort.key === "agent_version" ? "Lowest first" : "A–Z"}</option>
          <option value="desc">{current.sort.key === "connectivity" ? "Offline first, Z–A" : ["last_seen", "first_seen"].includes(current.sort.key) ? "Newest first" : current.sort.key === "agent_version" ? "Highest first" : "Z–A"}</option>
        </select></label>
      </div>
      <p>Favorites and views are stored in this browser for your account on this server.</p>
      {!ready && <p>Sign-in identity is being checked. Saved views and favorites are unavailable until it is confirmed.</p>}
      <div className="fleet-view-fields">
        <label>Saved view<select aria-label="Saved fleet view" value={view ? chosen : ""} disabled={!ready} onChange={(e) => setChosen(e.target.value)}>
          <option value="">Choose a view</option>{preferences.views.map((view) => <option key={view.name} value={view.name}>{view.name}</option>)}
        </select></label>
        <button type="button" disabled={!view} onClick={() => view && onApply(view)}>Apply view</button>
        <button type="button" disabled={!view} onClick={() => { onRemove(chosen); setChosen(""); }}>Remove view</button>
      </div>
      <form className="fleet-view-fields" onSubmit={(e) => { e.preventDefault(); const value = name.trim(); if (ready && value && !full && current.search.length <= 512) { onSave(value); setChosen(value); setName(""); } }}>
        <label>View name<input aria-label="Fleet view name" maxLength={80} value={name} disabled={!ready} onChange={(e) => setName(e.target.value)} /></label>
        <button type="submit" disabled={!ready || !name.trim() || full || current.search.length > 512}>Save view</button>
      </form>
      <p>Saving an existing name replaces that view. Up to 20 views.</p>
    </details>
  </div>;
}
