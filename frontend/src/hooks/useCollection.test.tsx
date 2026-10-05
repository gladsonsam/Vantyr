// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it } from "vitest";
import { useCollection } from "./useCollection";

const rows = [{ id: "a", score: 2 }, { id: "b", score: null }, { id: "c", score: 10 }, { id: "d", score: null }];
type Row = (typeof rows)[number];

let api: ReturnType<typeof useCollection<Row>> | null = null;
function Harness() {
  api = useCollection<Row>(rows, { sorting: {} });
  return null;
}

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  api = null;
});

function order() {
  return api!.items.map((row) => row.id);
}

it("sorts numerically and keeps unknowns last in both directions", () => {
  act(() => root.render(<Harness />));
  expect(order()).toEqual(["a", "b", "c", "d"]);
  act(() => api!.actions.setSorting({ sortingField: "score" }, false));
  expect(order()).toEqual(["a", "c", "b", "d"]);
  act(() => api!.actions.setSorting({ sortingField: "score" }, true));
  expect(order()).toEqual(["c", "a", "b", "d"]);
});
