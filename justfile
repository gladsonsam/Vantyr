# Local equivalents of the CI checks (.github/workflows/ci.yml) plus dev servers.
# Run `just` to list recipes, `just check` to run everything CI runs.

set shell := ["bash", "-euo", "pipefail", "-c"]

# Throwaway Postgres for the server tests (see db-up). 55432 avoids docker-compose's 5432.
db_port := env("VANTYR_TEST_DB_PORT", "55432")
db_name := env("VANTYR_TEST_DB_NAME", "vantyr-test-pg")
db_url := "postgres://vantyr:vantyr@127.0.0.1:" + db_port + "/vantyr"

[private]
default:
    @just --list

# Everything CI runs: server, sqlx cache, frontend, agent UI and the agent crate.
check: server sqlx-check frontend agent-ui agent

# ---- Server (Rust: server/ + protocol/) ------------------------------------

# Server and protocol crate: rustfmt, clippy, tests. Needs DATABASE_URL (see db-up).
server: _require-db
    cargo fmt --all --check
    SQLX_OFFLINE=true cargo clippy --workspace --all-targets --locked -- -D warnings
    SQLX_OFFLINE=true cargo test --workspace --locked

# Verify server/.sqlx matches the queries in the code (CI "sqlx query cache" step). Needs sqlx-cli.
sqlx-check: _require-db _require-sqlx
    sqlx migrate run --source server/migrations
    cd server && cargo sqlx prepare --check -- --all-targets

# Regenerate server/.sqlx after changing a sqlx::query! (commit the result). Needs sqlx-cli.
sqlx-prepare: _require-db _require-sqlx
    sqlx migrate run --source server/migrations
    cd server && cargo sqlx prepare -- --all-targets

# Start (or restart) a throwaway postgres:16-alpine for the tests and print its DATABASE_URL.
db-up:
    #!/usr/bin/env bash
    set -euo pipefail
    if docker container inspect {{ db_name }} >/dev/null 2>&1; then
        docker start {{ db_name }} >/dev/null
    else
        docker run -d --name {{ db_name }} -p 127.0.0.1:{{ db_port }}:5432 \
            -e POSTGRES_USER=vantyr -e POSTGRES_PASSWORD=vantyr -e POSTGRES_DB=vantyr \
            postgres:16-alpine >/dev/null
    fi
    for _ in $(seq 1 30); do
        if docker exec {{ db_name }} pg_isready -U vantyr -d vantyr >/dev/null 2>&1; then
            echo "Postgres is ready. Use it with:"
            echo "  export DATABASE_URL={{ db_url }}"
            exit 0
        fi
        sleep 1
    done
    echo "Postgres did not become ready in 30s: docker logs {{ db_name }}" >&2
    exit 1

# Remove the throwaway test Postgres.
db-down:
    docker rm -f {{ db_name }}

# ---- Frontend (React dashboard) ---------------------------------------------

# Dashboard: lint, tests, type-check + build, and the demo-mode build.
frontend:
    [ -d node_modules ] || npm ci --no-audit --no-fund
    npm run lint -w frontend
    npm test -w frontend
    npm run build -w frontend
    npm run build:demo -w frontend

# Dashboard dev server against a running server (Vite).
dev:
    npm run dev -w frontend

# Dashboard dev server with mock data and no backend.
demo:
    npm run dev:demo -w frontend

# ---- Agent (Tauri 2) ---------------------------------------------------------

# Agent settings UI (agent/ui-src): lint + build. Windows `cargo check` needs this dist to exist.
agent-ui:
    [ -d node_modules ] || npm ci --no-audit --no-fund
    npm run lint -w agent/ui-src
    npm run build -w agent/ui-src

# The agent crate builds natively on Linux only with the system packages CI installs
# (Debian/Ubuntu): libx11-dev libxrandr-dev libxtst-dev libxdo-dev libxcb1-dev
# libxcb-randr0-dev libxcb-render0-dev libxcb-shape0-dev libxcb-shm0-dev libxcb-xfixes0-dev
# libdbus-1-dev libpipewire-0.3-dev libwayland-dev libxkbcommon-dev libegl1-mesa-dev
# libgbm-dev pkg-config. Install them with `sudo apt-get install -y --no-install-recommends`.

# Agent crate for the host OS: rustfmt, check, tests (the agent is not in the root workspace).
agent:
    cargo fmt --manifest-path agent/Cargo.toml --all --check
    cargo check --manifest-path agent/Cargo.toml --locked
    cargo test --manifest-path agent/Cargo.toml --locked

# Cross-check the Windows build from Linux (needs cargo-xwin; agent/.cargo/config.toml sets the msvc target).
agent-windows: agent-ui
    cd agent && cargo xwin check --locked

# ---- Helpers ----------------------------------------------------------------

[private]
_require-db:
    #!/usr/bin/env bash
    if [ -z "${DATABASE_URL:-}" ]; then
        echo "DATABASE_URL is not set. The server tests use #[sqlx::test] and need a Postgres." >&2
        echo "Start a throwaway one and export the URL it prints:" >&2
        echo "  just db-up" >&2
        echo "  export DATABASE_URL={{ db_url }}" >&2
        exit 1
    fi

[private]
_require-sqlx:
    #!/usr/bin/env bash
    if ! command -v sqlx >/dev/null 2>&1; then
        echo "sqlx-cli is not installed. Install it with:" >&2
        echo "  cargo install sqlx-cli --version '^0.8' --no-default-features --features postgres,rustls --locked" >&2
        exit 1
    fi
