# Dashboard source layout

```
main.tsx       entry: mounts <App/> (index.html points here)
app/           composition root: App, router, DashboardLayout, queryClient (TanStack Query defaults),
               providers/ (query, session, agents, notifications, theme), shell/ (AppShell, CommandMenu, LoadShell)
api/           everything that talks to the server: client.ts (requestJson, ApiError, CSRF),
               endpoints/<domain>.ts composed into `api` in index.ts, types/<domain>.ts,
               queries/<domain>.ts (query keys + query/mutation hooks),
               serverSettings, serverVersionStore, the viewer WebSocket hook
features/      one folder per product area (fleet, agent-detail, activity, recall, remote, files,
               rules, groups, users, settings, agent-settings, enrollment, auth, logs)
components/common  shared app components (data-table, form/ field helpers, ScreenshotDialog, ErrorBoundary, ...)
hooks/         generic hooks (useMediaQuery, useTheme, useServerDraft, useServerForm, ...)
lib/           generic utilities (utils, pwa, appNames); utils re-exports `cn` from @vantyr/ui
demo/          demo-mode fake API and data (`npm run dev:demo`); app/App.tsx injects demo adapters
               (the simulated live screen is a `ScreenStreamSource`) rather than features branching on `isDemoMode`
styles/        global CSS and Tailwind/shadcn tokens
test/          test helpers (`withQueryClient`, `createTestQueryClient`, `formDom`)
```

shadcn/ui primitives are not in this tree: they live in the shared workspace package
`packages/ui` (`@vantyr/ui`), which the agent settings UI uses too (see Shared UI below).

A feature folder stays flat while small; larger ones split into `components/`, `hooks/`, `lib/`
(and `tabs/` in agent-detail). Tests sit next to the file they cover.

## Import rules

- Use `./x` only for a sibling in the same folder; everything else uses the `@/` alias. No `../`.
- Dependencies point down: `app` → `features` → `components/common`, `hooks`, `lib`, `api`.
  `api`, `lib`, `hooks` and `components` never import from `features` or `app`.
- Features may use app-level context hooks (`@/app/providers/use*`) and shell slots
  (`PageActions`, `usePageHeader`).
- Prefer not to reach into another feature. When one feature renders or links to another
  (agent-detail hosting the recall/remote/activity tabs, fleet linking to agent tabs), import the
  component or helper directly and keep the dependency one-way where possible.
- shadcn/ui primitives come from `@vantyr/ui/components/<name>` (see Shared UI below).
- API wire types live in `@/api/types`; call endpoints through `api.foo(...)` from `@/api`.
  Types for endpoints whose server handler returns a struct are generated from Rust
  (`api/types/generated/*.ts`, committed, never edited by hand) and re-exported from
  `api/types/<domain>.ts` under the names call sites use; the rest are still hand-written there.
  After changing a server struct, regenerate with `SQLX_OFFLINE=true cargo test --workspace
  export_bindings` from the repository root and commit the diff (see
  `server/docs/ARCHITECTURE.md`, "Generated dashboard types").

## Server state

REST data goes through TanStack Query; screens don't hand-roll `loading`/`error` state around
`api.*` calls in effects.

- `api/queries/<domain>.ts` mirrors `api/endpoints/<domain>.ts`: a key factory (`groupKeys`,
  `agentKeys`, …) plus `use…Query` / `use…Mutation` hooks that call `api.*`. Keys are hierarchical
  (`["agents", id, "urls", {limit}]`) so one `invalidateQueries` can cover a whole agent or domain.
- After a write, invalidate the affected keys instead of refetching by hand. Cross-screen
  refreshes (e.g. URL categories edited in Settings) are invalidations too, not window events.
- Keep a screen's existing toasts/inline errors: read `error` / `isPending` / `isFetching` from the
  query, or use the mutation's `onSuccess` / `onError`.
- Staged edit forms keep a local draft seeded from the query with `useServerDraft` (`@/hooks`); a
  save writes the server's answer back with `setQueryData` (or invalidates), which re-seeds it.
- Polling is `refetchInterval`. Defaults (no refetch on window focus, one retry except for 4xx)
  live in `app/queryClient.ts`; the cache is cleared on sign-out.
- Tests that render a component using queries wrap it in `withQueryClient(...)` from `@/test/queryClient`.

## Forms

Editor forms use react-hook-form with a zod schema (`@hookform/resolvers/zod`).

- The schema sits next to the form (`fooSchema.ts`, or `lib/fooForm.ts` when it also holds the
  form-to-request mapping) and exports the schema plus `type FooValues = z.infer<typeof fooSchema>`.
  Keep input and output types the same (no `transform`/`coerce`); `trim()` is fine, but use
  `refine` when the server must receive the text as typed. Rules that span fields go in
  `superRefine` with `path` set to the field that should show the message. Port the rules the old
  hand-written check enforced; don't add stricter ones.
- Build the form with `useForm<FooValues>({ resolver: zodResolver(fooSchema), defaultValues })`.
  Mount the form component only while its dialog is open (`{open && <FooForm />}` inside the
  `DialogContent`) so every open starts from fresh defaults; the dialog shell keeps the
  "can't dismiss while saving" guard. Data that arrives from the server later (a settings card)
  uses `useServerForm` (`@/hooks`), the react-hook-form counterpart of `useServerDraft`.
- Fields come from `components/common/form`: `InputField`, `NumberField` (a `parse` prop clamps what
  was typed), `TextareaField`, `SelectField`, `ToggleGroupField`, `CheckboxField`, or `FormField`
  with a render prop for anything custom (row editors, selects that need an id, tabs). They render
  the shadcn `Field` (label, control, description, `FieldError`) and set `aria-invalid`. `className`
  goes to the control, `fieldClassName` to the surrounding `Field`.
- Where a form only disables its submit button until the input is acceptable (no message shown),
  use `mode: "onChange"`, `disabled={!formState.isValid}` and `hideError` on the fields. Where a
  form shows one message above its fields, pass `firstErrorMessage` (`form/errors.ts`) as the
  `onInvalid` of `handleSubmit`.
- Submit with `form.handleSubmit(values => mutation.mutate(toBody(values)))`; the pure `toBody` /
  `toForm` mapping lives next to the schema and is unit-tested. Server failures still come from the
  mutation (`errorText(error)` in an `Alert` or toast), never from the schema.
- Variable-length lists (scope rows, schedule rows) are one `FormField` over the array value with a
  controlled row editor (`ScopeRowsEditor`, `ScheduleRowsEditor`).
- Tests drive forms with the helpers in `@/test/formDom` (`mountForm`, `typeInto`, `click`,
  `byLabel`, `buttonByText`, `fieldErrors`). Validation is asynchronous, so await the `act` around a
  change before pressing a button that depends on it.

## Live events

- AgentsProvider owns the viewer WebSocket and publishes every parsed message on a typed bus
  (`api/wsBus.ts`). Subscribe with `useWsEvent("dir_list", handler)` (or a list of types), or
  `useWsBus().subscribe(...)` / `.subscribeStatus(...)` inside an effect that manages its own
  lifetime. Messages are the `WsEvent` union in `api/types/ws.ts` — add a member there rather
  than casting. Tests provide a bus with `withWsBus(...)` from `@/test/wsBus` and `emit` on it.
- A 401 from any request reports session expiry through `onSessionExpired` (`api/sessionExpiry.ts`).

## Naming

React components `PascalCase.tsx`, hooks `useCamelCase.ts`, other modules `camelCase.ts`.
`@vantyr/ui` components keep shadcn's kebab-case file names.

## Shared UI

`packages/ui` (`@vantyr/ui`) holds the generic shadcn/ui primitives (button, dialog, select,
sidebar, table, ...), `cn`, and the `use-mobile` hook the sidebar needs. It is source-only:
Vite and `tsc` compile it as part of this app, so there is no build step and edits show up in
`npm run dev` immediately.

- Import `@vantyr/ui/components/button`, `@vantyr/ui/lib/utils`, never a relative path into the
  package. App-specific composites stay in `components/common`.
- Theme tokens stay here (`styles/ui.css`). `ui.css` has an `@source` line that makes Tailwind scan
  `packages/ui/src`; without it classes used only inside the package are not generated.
- Add or update a primitive with `npx shadcn@latest add <name>` from this folder or from
  `packages/ui`: `components.json` points the `ui`/`utils` aliases at `@vantyr/ui`. Copy any
  CSS variables the CLI mentions into `styles/ui.css` by hand.
- Lint and type-check the package with `npm run lint -w packages/ui` and
  `npm run typecheck -w packages/ui` (the dashboard's `tsc -b` also compiles what it imports).
- ESLint is `@vantyr/eslint-config` (`packages/eslint-config`), shared with the agent UI.
- Install from the repository root (`npm ci`); the three JS packages are npm workspaces sharing
  one `package-lock.json`. Run scripts from the root with `npm run <script> -w frontend`, or from
  `frontend/` as before.
