<div align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset=".github/images/lockup-vantyr-dark.svg">
    <img src=".github/images/lockup-vantyr.svg" alt="Vantyr" height="64">
  </picture>
</div>

<br />

https://github.com/user-attachments/assets/1cfe297f-fa9a-4012-9892-e356ce8574c8

<br />

**A self-hosted monitoring and remote desktop system built with Rust and React.** Windows and Linux agents feed a web dashboard with live desktops, activity history and searchable screen captures. Features depend on the device platform and permissions.

> [!WARNING]
> Intended for **experimentation, not production**. The monitoring, remote-control, and keystroke features have privacy and security implications, and the code has had no professional security review. Use at your own risk.

## Features

- **Activity history**: App and website timelines, analytics, and Recall screen history with text search.
- **Live desktop**: H.264 streaming with MJPEG fallback and desktop audio on Windows.
- **Remote control**: Mouse, keyboard, clipboard, files, terminal and scripts, subject to device permissions.
- **Telemetry capture**: Window focus, URLs, AFK/active transitions and keystroke capture.

## Quick start (Docker)

```bash
cp .env.example .env  # Set POSTGRES_PASSWORD and ADMIN_PASSWORD before starting.
docker compose up -d
```

## Repository layout

| Path | What it is |
| --- | --- |
| `server/` | Rust (axum + sqlx + PostgreSQL) server. Architecture and design notes: [`server/docs/ARCHITECTURE.md`](server/docs/ARCHITECTURE.md); tests: [`server/docs/testing.md`](server/docs/testing.md); SQL and the sqlx cache: [`server/docs/database.md`](server/docs/database.md). |
| `protocol/` | Shared Rust crate with the server/agent wire types. See [`protocol/README.md`](protocol/README.md). |
| `agent/` | Tauri 2 desktop agent (Windows, headless on Linux) and its settings UI in `agent/ui-src`. Architecture: [`agent/docs/ARCHITECTURE.md`](agent/docs/ARCHITECTURE.md). |
| `frontend/` | React dashboard. Source layout: [`frontend/src/README.md`](frontend/src/README.md). |
| `packages/ui/` | `@vantyr/ui`: shadcn/ui components shared by the dashboard and the agent settings UI. See [`packages/ui/README.md`](packages/ui/README.md). |
| `packages/oxlint-config/` | Oxlint base and React Compiler rules shared by the JavaScript workspaces. |

`server/` and `protocol/` form the root Cargo workspace; `agent/` is built separately and depends on `protocol/` by path.

The JavaScript side is an npm workspace: `frontend/`, `agent/ui-src/` and `packages/ui/` share one root `package-lock.json`. Run `npm ci` at the repository root. Oxlint handles linting; pinned Bun runs formatting through `npm run format` and `npm run format:check`.

## Development

The [`justfile`](justfile) provides common local checks and dev servers (`just` lists every recipe):

```bash
just db-up                 # throwaway Postgres for the server tests; prints the DATABASE_URL to export
just check                 # server, sqlx cache, dashboard, agent UI and host agent checks
just server                # or one part: fmt, clippy and tests for server/ + protocol/
just frontend              # Oxlint, Bun tests, production and demo builds
just dev                   # dashboard dev server (`just demo` runs it with mock data)
just sqlx-prepare          # regenerate server/.sqlx after changing a sqlx::query!
```

The agent checks (`just agent`) need the Linux desktop packages listed in the `justfile`, or the Windows toolchain.

## Documentation

**Deploy, configure, use the dashboard and agent, and develop:** see the **[GitHub wiki](https://github.com/gladsonsam/Vantyr/wiki)**.

## License

MIT. See [LICENSE](LICENSE).
