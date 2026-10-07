<div align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset=".github/images/lockup-vantyr-dark.svg">
    <img src=".github/images/lockup-vantyr.svg" alt="Vantyr" height="64">
  </picture>
</div>

<br />

https://github.com/user-attachments/assets/1cfe297f-fa9a-4012-9892-e356ce8574c8

<br />

**A lightweight, self-hosted monitoring system built with Rust and React.** A Windows agent streams real-time telemetry to the server, which feeds a live web dashboard with screen streaming, window/URL tracking, and activity history.

> [!WARNING]
> Intended for **experimentation, not production**. The monitoring, remote-control, and keystroke features have privacy and security implications, and the code has had no professional security review. Use at your own risk.

## Features

- **Activity timeline**: A browsable history of foreground apps/windows with durations.
- **Live screen viewer**: Demand-driven MJPEG screen streaming
- **Remote control**: Send mouse and keyboard commands from the dashboard to the agent.
- **Telemetry capture**: Window focus, URLs, AFK/active transitions and keystroke capture.

## Quick start (Docker)

```bash
cp .env.example .env
docker compose up -d
```

## Repository layout

| Path | What it is |
| --- | --- |
| `server/` | Rust (axum + sqlx + PostgreSQL) server. Architecture and design notes: [`server/docs/ARCHITECTURE.md`](server/docs/ARCHITECTURE.md); tests: [`server/docs/testing.md`](server/docs/testing.md); SQL and the sqlx cache: [`server/docs/database.md`](server/docs/database.md). |
| `protocol/` | Shared Rust crate with the server/agent wire types. See [`protocol/README.md`](protocol/README.md). |
| `agent/` | Tauri 2 desktop agent (Windows, headless on Linux) and its settings UI in `agent/ui-src`. Architecture: [`agent/docs/ARCHITECTURE.md`](agent/docs/ARCHITECTURE.md). |
| `frontend/` | React dashboard. Source layout: [`frontend/src/README.md`](frontend/src/README.md). |

`server/` and `protocol/` form the root Cargo workspace; `agent/` is built separately and depends on `protocol/` by path.

## Development

The [`justfile`](justfile) mirrors CI, so the same checks run locally (`just` lists every recipe):

```bash
just db-up                 # throwaway Postgres for the server tests; prints the DATABASE_URL to export
just check                 # everything CI runs: server, sqlx cache, frontend, agent UI, agent
just server                # or one part: fmt, clippy and tests for server/ + protocol/
just frontend              # dashboard lint, tests, build, demo build
just dev                   # dashboard dev server (`just demo` runs it with mock data)
just sqlx-prepare          # regenerate server/.sqlx after changing a sqlx::query!
```

The agent checks (`just agent`) need the Linux desktop packages listed in the `justfile`, or the Windows toolchain.

## Documentation

**Deploy, configure, use the dashboard and agent, and develop:** see the **[GitHub wiki](https://github.com/gladsonsam/Vantyr/wiki)**.

## License

MIT — see [LICENSE](LICENSE).
