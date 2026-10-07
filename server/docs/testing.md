# Server tests

`cargo test --workspace` runs every test (the server and the shared `protocol/` crate), including the database-backed ones, so it needs a
PostgreSQL server. Point `DATABASE_URL` at a throwaway one:

```sh
docker run -d --name vantyr-test-pg -p 55432:5432 \
  -e POSTGRES_USER=vantyr -e POSTGRES_PASSWORD=vantyr -e POSTGRES_DB=vantyr \
  postgres:16-alpine
SQLX_OFFLINE=true DATABASE_URL=postgres://vantyr:vantyr@127.0.0.1:55432/vantyr \
  cargo test --workspace --locked
```

`SQLX_OFFLINE=true` makes the `sqlx::query!` macros compile from the committed `server/.sqlx`
cache. Without it they describe their SQL against `DATABASE_URL`, which then has to be migrated.
Changing a query means regenerating that cache; see [database.md](database.md).

Without `DATABASE_URL` the in-memory tests still pass, and each database test fails with
`DATABASE_URL must be set`. CI runs the same command against a `postgres:16-alpine` service
(`.github/workflows/ci.yml`).

## How database tests work

Database tests use `#[sqlx::test]`. For each test, sqlx creates a fresh database on the
`DATABASE_URL` server, applies every migration in `server/migrations`, passes the test a `PgPool`,
and drops the database when the test passes. A failed test keeps its database for inspection;
sqlx drops it on the next run. sqlx also keeps a small `_sqlx_test` schema in the `DATABASE_URL`
database to track these databases, so the role needs `CREATEDB`. Don't point `DATABASE_URL` at a
database you care about. sqlx also reads it from a `.env` file.

- Use the real schema. Insert the rows a test needs, including `agents` rows for any device ids
  it stores data for (`test_support::insert_agent`).
- `#[sqlx::test(migrations = false)]` gives an empty database. Use it for tests that build their
  own relations: storage accounting, cross-session retention locking, and the Recall fixture,
  which applies the migrations itself.
- To control the pool (one connection, session settings), take `PgPoolOptions` and
  `PgConnectOptions` instead of `PgPool` and close the pool before returning.
- Cross-session tests open separate single-connection pools on the same test database.

## Shared fixtures

`server/src/test_support/` (compiled only under `cfg(test)`):

- `test_support::state(pool)` returns an `AppState` with one enrolled device named `device`.
  `app_state(pool)` returns one without the device. `admin()` returns a dashboard admin.
- `test_support::control` sets up an offline `AppState`, a simulated agent connection
  (`connect`), module reports and tagged frames for control, viewer and ingest tests.
- `test_support::recall` builds a connected device with Recall context grants and frame headers.
