# Security Policy

Vantyr is a lightweight, self-hosted monitoring system. It includes sensitive capabilities (screen streaming, activity/window/URL tracking, remote control, and related telemetry). Please treat potential security issues seriously and report them responsibly.

> Note: This project is primarily for experimentation/testing and is not a hardened or supported product (see `README.md`). Reports are still welcome, but response/patch timelines are best-effort.

## Supported Versions

Only the latest commit on the `main` branch is supported.

- If you found an issue on an older commit, please reproduce it on the latest `main` if possible.

## Reporting a Vulnerability

Please **do not** open a public GitHub issue for security vulnerabilities.

Instead, report privately:

- **Preferred**: Open a **private security advisory** on GitHub (Security → Advisories → “Report a vulnerability”) for this repository.
- **If you can’t use advisories**: Contact the repository owner/maintainers via a private channel listed on the project’s GitHub profile.

Include as much of the following as you can:

- A clear description of the vulnerability and its impact
- Reproduction steps and any proof-of-concept code
- Affected component(s): `vantyr-agent`, `vantyr-server`, `vantyr-dashboard`
- Environment details (Windows version, browser, server OS, configuration)
- Whether the issue is remotely exploitable and what authentication is required
- Any relevant logs (please redact secrets and personal data)

## What to Expect

- You should receive an acknowledgment when the report is received.
- Fixes, releases, and disclosure timing are coordinated on a best-effort basis.

## Safe Harbor

If you act in good faith and follow this policy (no data destruction, no service disruption, no privacy violations beyond what is necessary to demonstrate the issue), we will consider your research authorized for the purpose of reporting.

## Sensitive Data

Please **do not** include real screen captures, keystrokes, credentials, tokens, or other personal data in your report. If such data is required to demonstrate the issue, use synthetic/test accounts and redact wherever possible.

## Deployment hardening (operators)

The server supports common production patterns; see **`.env.example`** in the repository (copy to `.env`) and the wiki ([Configuration](https://github.com/gladsonsam/Vantyr/wiki/Configuration), [Environment template](https://github.com/gladsonsam/Vantyr/wiki/Environment-template)).

- **TLS**: Terminate HTTPS in a reverse proxy; keep `ENFORCE_HTTPS=true` and forward `X-Forwarded-Proto: https` (or `wss` for WebSocket upgrades).
- **Secrets**: Prefer `DATABASE_URL_FILE`, `ADMIN_PASSWORD_FILE`, `AGENT_SECRET_FILE`, etc., instead of embedding secrets in the environment.
- **Rate limiting**: Optional `API_RATE_LIMIT_PER_SECOND` limits authenticated `/api/`* traffic per client IP (useful when the dashboard is exposed).
- **Audit trail**: Sensitive dashboard actions are recorded in the audit log (viewable in the Activity log UI and via `/api/audit`).
- **Observability**: `GET /metrics` (Prometheus), `GET /healthz` (liveness), `GET /readyz` (DB readiness), structured logs via `LOG_JSON=true`.
