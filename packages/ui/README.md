# @vantyr/ui

Shared shadcn/ui (Base UI, `base-nova` style) primitives for the dashboard (`frontend/`) and the
agent settings UI (`agent/ui-src/`). Private npm workspace package, **source only**: there is no
build step, each app compiles it through Vite and TypeScript.

```
src/components/   shadcn components, kebab-case (button.tsx, dialog.tsx, sidebar.tsx, ...)
src/hooks/        hooks the components need (use-mobile.ts for the sidebar)
src/lib/utils.ts  `cn`
```

Only generic shadcn primitives live here. App-specific composites (data tables, form fields,
page shells) stay in the app.

## Using it

```tsx
import { Button } from "@vantyr/ui/components/button";
import { cn } from "@vantyr/ui/lib/utils";
```

`package.json` `exports` maps `./components/*`, `./hooks/*` and `./lib/*` onto `src/`. Inside the
package, components import each other by the same `@vantyr/ui/...` path (what the shadcn CLI generates).

## Styling

The package ships no CSS. Each app owns its theme tokens in `src/styles/ui.css` (the dashboard
maps `--color-card` to `--ui-card` because legacy CSS owns `--card`; the agent does the same so the
two stay interchangeable) and must:

- have an `@source` line pointing Tailwind at `packages/ui/src` (Tailwind v4 does not scan
  `node_modules`, where the workspace link lives);
- define every token class the components use (`bg-card`, `text-muted-foreground`, `bg-success`, ...).

## Adding or updating a component

```bash
cd packages/ui
npx shadcn@latest add <name>      # writes src/components/<name>.tsx
```

The same command works from `frontend/` or `agent/ui-src/`: their `components.json` aliases
(`ui`, `utils`) point at `@vantyr/ui`. New CSS variables the CLI wants to add go to the app's
`src/styles/ui.css` by hand. Keep the generated files as generated (the lint config exempts them
from the Fast Refresh export rule).

## Checks

```bash
npm run lint -w packages/ui
npm run typecheck -w packages/ui
```
