<div align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset=".github/images/lockup-vantyr-dark.svg">
    <img src=".github/images/lockup-vantyr.svg" alt="Vantyr" height="64">
  </picture>
</div>

<br />

<div align="center">
  <video src="https://github.com/gladsonsam/Vantyr/raw/main/assets/vantyr-promo.mp4" width="820" autoplay loop muted playsinline></video>
</div>

<br />

**A lightweight, self-hosted monitoring system built with Rust and React.** A Windows agent streams real-time telemetry to the server, which feeds a live web dashboard with screen streaming, window/URL tracking, and activity history.

> [!WARNING]
> Built with AI assistance and intended for **experimentation, not production**. The monitoring, remote-control, and keystroke features have privacy and security implications, and the code has had no professional security review. Use at your own risk.

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

## Documentation

**Deploy, configure, use the dashboard and agent, and develop:** see the **[GitHub wiki](https://github.com/gladsonsam/Vantyr/wiki)**.

## License

MIT — see [LICENSE](LICENSE).
