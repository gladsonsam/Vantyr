# ── Stage 1: Build React frontend ─────────────────────────────────────────────
FROM node:22-alpine AS frontend

# The JS packages are npm workspaces sharing one root lockfile; only the dashboard is
# installed here (agent/ is excluded by .dockerignore).
WORKDIR /js

# Install deps first for better layer caching.
COPY package.json package-lock.json ./
COPY frontend/package.json frontend/package.json
RUN npm ci --workspace frontend --no-audit --no-fund

# Build the app.
COPY frontend/ frontend/
RUN npm run build --workspace frontend
# Produces: /js/frontend/dist/

# ── Stage 2: Build Rust server ────────────────────────────────────────────────
# The agent/ directory is NOT a workspace member; no Windows deps present.
# protocol/ is: the wire types shared with the agent.

FROM rust:1 AS builder

WORKDIR /workspace

# Cache Cargo dependencies (invalidated only when manifests change).
COPY Cargo.toml Cargo.lock ./
COPY server/Cargo.toml server/Cargo.toml
COPY protocol/Cargo.toml protocol/Cargo.toml

# Pre-fetch dependencies for better caching.
# This avoids accidentally producing a "dummy" vantyr-server binary during cache warming.
RUN cargo fetch --locked

# Real build. `server/.sqlx` (copied with the crate) lets the `sqlx::query!` macros
# compile without a database.
ENV SQLX_OFFLINE=true
COPY protocol/ protocol/
COPY server/ server/
# SQLx hashes raw bytes; CRLF from Windows Docker build contexts changes SHA-384 vs LF.
RUN find server/migrations -name '*.sql' -exec sed -i 's/\r$//' {} +
RUN cargo build --release --locked --package vantyr-server

# ── Stage 3: Runtime ──────────────────────────────────────────────────────────
FROM debian:bookworm-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY --from=builder   /workspace/target/release/vantyr-server /app/vantyr-server
# Serve the React SPA; migrations are embedded via sqlx::migrate!()
COPY --from=frontend  /js/frontend/dist                   /app/static

ENV STATIC_DIR=/app/static \
    RUST_LOG=info

EXPOSE 9000

RUN useradd --create-home --uid 10001 --shell /usr/sbin/nologin app \
 && chown -R app:app /app

USER 10001:10001

HEALTHCHECK --interval=10s --timeout=3s --retries=6 CMD curl -fsS http://127.0.0.1:9000/healthz || exit 1

ENTRYPOINT ["/app/vantyr-server"]
