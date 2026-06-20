# ── Stage 1: Build React frontend ─────────────────────────────────────────────
FROM node:20-alpine AS frontend

WORKDIR /frontend

# Install deps first for better layer caching.
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci --no-audit --no-fund

# Build the app.
COPY frontend/ ./
RUN npm run build
# Produces: /frontend/dist/

# ── Stage 2: Build Rust server ────────────────────────────────────────────────
# The agent/ directory is NOT a workspace member; no Windows deps present.

FROM rust:1 AS builder

WORKDIR /workspace

# Cache Cargo dependencies (invalidated only when manifests change).
COPY Cargo.toml Cargo.lock ./
COPY server/Cargo.toml server/Cargo.toml

# Pre-fetch dependencies for better caching.
# This avoids accidentally producing a "dummy" vantyr-server binary during cache warming.
RUN cargo fetch --locked

# Real build.
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
COPY --from=frontend  /frontend/dist                   /app/static

ENV STATIC_DIR=/app/static \
    RUST_LOG=info

EXPOSE 9000

RUN useradd --create-home --uid 10001 --shell /usr/sbin/nologin app \
 && chown -R app:app /app

USER 10001:10001

HEALTHCHECK --interval=10s --timeout=3s --retries=6 CMD curl -fsS http://127.0.0.1:9000/healthz || exit 1

ENTRYPOINT ["/app/vantyr-server"]
