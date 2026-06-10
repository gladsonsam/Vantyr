<picture>
  <source media="(prefers-color-scheme: dark)" srcset=".github/images/lockup-vantyr-dark.svg">
  <img src=".github/images/lockup-vantyr.svg" alt="Vantyr" height="48">
</picture>


**A lightweight, self-hosted monitoring system built with Rust and React.** A Windows agent streams real-time telemetry to the server, which feeds a live web dashboard with screen streaming, window/URL tracking, and activity history.

## Screenshots

<img src=".github/images/dashboard-agents-overview.jpg" alt="Agents overview" width="820" />

<img src=".github/images/agent-screen-viewer.jpg" alt="Agent screen viewer" width="820" />

<img src=".github/images/agent-activity-timeline.jpg" alt="Agent activity timeline" width="820" />

> [!WARNING]
> This project was **largely written with AI assistance** and is intended for **experimentation and testing**, not as a hardened or supported product. **Do not rely on it in production** or for sensitive environments. Monitoring, remote control, and keystroke-related features carry inherent privacy and security implications; the codebase has **not** undergone professional security review and may contain bugs, weak defaults, or other issues that could expose data or systems. Use at your own risk.

## Features

- **Activity timeline** — A browsable history of foreground apps/windows with durations.
- **Live screen viewer** — Demand-driven MJPEG screen streaming
- **Remote control** — Send mouse and keyboard commands from the dashboard to the agent.
- **Telemetry capture** — Window focus, URLs, AFK/active transitions and keystroke capture.

## Tech stack


| Component              | Technology                                                         |
| ---------------------- | ------------------------------------------------------------------ |
| **vantyr-agent**     | Rust (Windows, hidden Tauri settings window + hotkey, xcap, enigo) |
| **vantyr-server**    | Rust (Axum, Tokio, SQLx, PostgreSQL)                               |
| **vantyr-dashboard** | React 19, Vite, TailwindCSS                                        |


## Quick start (Docker)

```bash
cp .env.example .env
docker compose up -d
```


## Documentation

**Deploy, configure, use the dashboard and agent, and develop:** see the **[GitHub wiki](https://github.com/gladsonsam/Vantyr/wiki)**.

## License

MIT — see [LICENSE](LICENSE).
