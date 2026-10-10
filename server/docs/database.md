# Server SQL and the sqlx query cache

Static SQL in `server/src` uses the compile-time checked macros: `sqlx::query!`,
`sqlx::query_as!(RowStruct, ...)` and `sqlx::query_scalar!`. At build time each macro asks
PostgreSQL to describe its statement, checks the bound Rust types against the parameters, and
types the result columns. A typo in a column name or a type mismatch is a compile error.

Only SQL that is assembled at runtime (optional filters built with `format!`, `QueryBuilder`, or a
statement shared as a `const` with an `EXPLAIN` test) stays on the runtime `sqlx::query(...)` API.
Map those rows into a `#[derive(sqlx::FromRow)]` struct where possible.

## Offline builds

Builds without a database set `SQLX_OFFLINE=true`. The macros then read the statement
descriptions from `server/.sqlx/`, which is committed. The Docker build, CI and the release
checks all build this way. With `SQLX_OFFLINE` unset, the macros use `DATABASE_URL` when it is set
(that database must be migrated) and fall back to `server/.sqlx` when it is not.

## Changing a query

1. Have a migrated database to describe against (once):

   ```sh
   cargo install sqlx-cli --version '^0.8' --no-default-features --features postgres,rustls --locked
   docker run -d --name vantyr-test-pg -p 55432:5432 \
     -e POSTGRES_USER=vantyr -e POSTGRES_PASSWORD=vantyr -e POSTGRES_DB=vantyr \
     postgres:16-alpine
   docker exec vantyr-test-pg createdb -U vantyr vantyr_prepare
   export DATABASE_URL=postgres://vantyr:vantyr@127.0.0.1:55432/vantyr_prepare
   sqlx migrate run --source server/migrations
   ```

   After adding a migration, run `sqlx migrate run` again before preparing.

2. Edit the SQL. Keep the column names the code (and JSON responses) expect. When PostgreSQL's
   nullability inference is wrong for a column, override it in the alias:
   `AS "col!"` (not null), `AS "col?"` (nullable), `AS "col: Type"` (Rust type).
   Expressions such as `COUNT(*)`, `COALESCE(...)` and casts are inferred as nullable.

3. Regenerate the cache from the crate directory and commit `server/.sqlx` with the change:

   ```sh
   cd server
   DATABASE_URL=postgres://vantyr:vantyr@127.0.0.1:55432/vantyr_prepare \
     cargo sqlx prepare -- --all-targets
   ```

   `--all-targets` includes queries in tests. Stale entries for deleted queries are removed.

CI migrates its Postgres service and runs `cargo sqlx prepare --check -- --all-targets`, which
fails when `server/.sqlx` does not match the code.
