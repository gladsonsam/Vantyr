# Storage accounting and Recall read-error semantics

The authenticated `GET /api/settings/storage` response is unchanged:
`{database_bytes, public_tables_bytes, other_bytes, tables:[{name,bytes}]}`.

These are **PostgreSQL storage bytes**, not frame counts, JPEG/thumbnail bytes, capture coverage, or total server disk usage. `pg_database_size` includes the connected database's relation files; it excludes the separate Recall blob root and cluster-level WAL/backups. Values can change between catalog reads, so `other_bytes` is an approximate remainder, clamped at zero, rather than a transactionally frozen disk snapshot.

For a declaratively partitioned public table such as `screen_frames`, the table entry explicitly sums its parent and all declarative partition descendants, including each physical relation's indexes and TOAST. PostgreSQL `pg_total_relation_size` on a partitioned parent alone does not include its children. Child partitions have no separate entries, so they are not double-counted. Ordinary inheritance is not rolled up: parents and inherited children each remain separate entries, including a multiple-inheritance child exactly once. No history rows are counted/scanned to compute these sizes. Invalid decoded counts/query errors fail the report instead of fabricating zero usage.

Separate files can outlive database rows: failed retention directory removals, transient insert failures and thumbnail caches are not represented by table-byte totals. Conversely, an indexed row does not prove its JPEG remains readable. This stage adds no filesystem accounting scan, retained-blob reconciliation, migration, or capture-coverage claim.

Recall blob GET now distinguishes:

- HTTP 200: readable original bytes, or normal thumbnail behavior. An unsafe/unavailable thumbnail cache falls back to the original bytes, without reading/writing the unsafe path. Decode failures and thumbnail-worker errors return the original bytes already read; they do not retry the source read or turn a successful read into an empty response.
- HTTP 404 with orphan row healing: confirmed absent agent/day/file path under an available storage root. Failed DB healing is logged and retried by a later read as before.
- HTTP 500 with the indexed row preserved: missing/unavailable storage root, unsafe filesystem structure, non-regular file, permission/I/O or worker errors. Later reads retry naturally. A missing mount root is not proof that an individual frame was deleted.
- HTTP 400 with the row preserved: malformed blob reference, including traversal, wrong UUID device, invalid day, non-UUID JPEG name, absolute path or extra components.

Blob paths must have the server-generated UUID/day/UUID.jpg shape. Original and cache operations refuse static symlinks and non-directory ancestors. Original reads, cache validation/reads, and thumbnail rendering/writes run in filesystem workers that retain the existing per-device lifecycle ingestion lease, including after HTTP cancellation, so app-driven device deletion cannot overtake them. This is defense within a trusted configured storage tree, not an atomic OS sandbox against external local-admin filesystem replacement. The existing global retention task does not use these per-device gates; its redesign is deferred.

Concrete outstanding retention gaps from source review:

1. Directory removal is tied only to partitions dropped during that run. If the database drop succeeds but file removal fails, the next run sees no partition and does not retry that directory.
2. The global directory cleanup lacks per-device lifecycle gates and uses directory checks that follow symlinks. A safe retry mechanism needs synchronized database absence checks plus gated UUID/day cleanup, not an unconditional old-directory sweep.
3. Only named day partitions are dropped. Old rows in the default partition can remain after partition creation failures; there is no default-row pruning in that function.
4. Partition-drop and narrative-prune failures are logged but `prune_screen_history` can still return success. Individual blob removals also lack a persisted retry record or retained retry summary.

Verification queries only temporary PostgreSQL schemas and creates disposable filesystem roots. Fixtures verify nested/default partition and index sizes, independent ordinary inheritance storage, partition-drop bytes versus untouched JPEG/orphan/cache files, original response bytes, missing-row healing, row preservation on errors, device isolation, and traversal/symlink refusal. No real database/blob-directory scan or cleanup was run; no hardware verification is claimed.
