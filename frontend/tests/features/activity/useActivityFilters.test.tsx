import { act, useLayoutEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, useLocation, useNavigate } from "react-router-dom";
import { afterEach, beforeEach, expect, it } from "bun:test";
import { useActivityFilters, type ActivityFilters } from "@/features/activity/useActivityFilters";
import {
  encodeActivityState,
  readActivityStateFromSearchParams,
} from "@/features/activity/activityUrl";
let host: HTMLDivElement, root: Root;
let filters: ActivityFilters, location: string, navigate: ReturnType<typeof useNavigate>;
function Harness({ agentId }: { agentId?: string }) {
  const current = useActivityFilters(agentId),
    route = useLocation(),
    go = useNavigate();
  useLayoutEffect(() => {
    filters = current;
    location = route.search;
    navigate = go;
  });
  return <output>{current.searchQuery}</output>;
}
beforeEach(() => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});
it("keeps multiword draft whitespace and unrelated deep-link parameters while editing and clearing filters", async () => {
  await act(async () =>
    root.render(
      <MemoryRouter initialEntries={["/agents/a?tab=activity&at=alert-time"]}>
        <Harness agentId="a" />
      </MemoryRouter>,
    ),
  );
  await act(async () => filters.setSearchQuery("hello "));
  expect(filters.searchQuery).toBe("hello ");
  expect(readActivityStateFromSearchParams(new URLSearchParams(location))?.q).toBe("hello ");
  await act(async () => filters.setSearchQuery("hello world"));
  await act(async () => filters.toggleAppFilter("Editor.exe"));
  expect(filters.searchQuery).toBe("hello world");
  expect(filters.appFilterExe).toBe("Editor.exe");
  await act(async () => filters.toggleAppFilter("editor.EXE"));
  expect(filters.appFilterExe).toBeNull();
  await act(async () => filters.clearFilters());
  expect(filters.isFiltered).toBe(false);
  expect(new URLSearchParams(location).get("at")).toBe("alert-time");
  expect(new URLSearchParams(location).has("activity")).toBe(false);
});
it("derives filters immediately from back and forward navigation", async () => {
  const encoded = encodeActivityState({
    v: 1,
    q: "linked search",
    alerts: true,
    app: "browser.exe",
    from: "2026-11-01",
    to: "2026-11-02",
  });
  await act(async () =>
    root.render(
      <MemoryRouter
        initialEntries={["/agents/a", `/agents/a?activity=${encoded}`]}
        initialIndex={1}
      >
        <Harness agentId="a" />
      </MemoryRouter>,
    ),
  );
  expect(filters.searchQuery).toBe("linked search");
  expect(filters.alertsOnly).toBe(true);
  expect(filters.jumpRangeValue).toMatchObject({
    startDate: "2026-11-01",
    endDate: "2026-11-02",
  });
  await act(async () => navigate(-1));
  expect(filters.isFiltered).toBe(false);
  await act(async () => navigate(1));
  expect(filters.searchQuery).toBe("linked search");
  expect(filters.appFilterExe).toBe("browser.exe");
});
it("keeps fleet filters local and supports functional updates", async () => {
  await act(async () =>
    root.render(
      <MemoryRouter initialEntries={["/?unrelated=kept"]}>
        <Harness />
      </MemoryRouter>,
    ),
  );
  await act(async () => filters.setSearchQuery("fleet"));
  await act(async () => filters.setSearchQuery((previous) => `${previous} search`));
  await act(async () => filters.setAlertsOnly((previous) => !previous));
  expect(filters.searchQuery).toBe("fleet search");
  expect(filters.alertsOnly).toBe(true);
  expect(location).toBe("?unrelated=kept");
});
