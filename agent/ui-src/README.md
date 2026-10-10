# Agent settings UI

The React front end of the Tauri desktop agent (the "Agent Settings" window). It is an npm
workspace of the repo root, so install from the repository root (`npm ci`), not from here.

```
src/main.tsx, App.tsx    entry and screen switch (loading / password gate / settings)
src/components/          AgentUi, PasswordGate, SettingsPanel, SettingsModals (app-specific)
src/lib/tauri.ts         `invoke` / `listen` wrappers that no-op or reject outside Tauri
src/lib/utils.ts         `getErrorMessage`; re-exports `cn` from @vantyr/ui
src/styles/ui.css        shadcn theme tokens (dark only) and the Tailwind `@source` for @vantyr/ui
src/index.css            minimal app base styles
```

## Commands

From the repository root:

```bash
npm run agent:ui                 # Vite dev server on :5173 (outside Tauri, `invoke` calls reject)
npm run lint -w agent/ui-src
npm run build -w agent/ui-src    # tsc -b && vite build -> agent/ui-src/dist (Tauri's frontendDist)
npm run agent:dev                # the whole agent with this UI, via the Tauri CLI
```

## Shared components

shadcn/ui primitives (`Button`, `Card`, `Dialog`, `Field`, `Select`, ...) come from the shared
workspace package [`packages/ui`](../../packages/ui) (`@vantyr/ui`), the same one the dashboard uses:

```tsx
import { Button } from "@vantyr/ui/components/button";
```

There is no local `components/ui` folder. To add a primitive, run `npx shadcn@latest add <name>`
from this directory or from `packages/ui`: `components.json` points the `ui` and `utils` aliases at
`@vantyr/ui`, so it lands in `packages/ui/src/components`. Tailwind only scans this app's own
sources, so `src/styles/ui.css` has an `@source` line for `packages/ui/src`; keep it.

Theme tokens stay per app (`src/styles/ui.css`); components may only use token classes both
apps define.

ESLint comes from `@vantyr/eslint-config` (`packages/eslint-config`); this app also enables
react-hooks' React Compiler rules.
