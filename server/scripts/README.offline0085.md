# offline0085 — offline evidence preservation for the DNS single-contract upgrade

Two explicit operator SQL scripts. They are **not** SQLx migrations, **not**
runtime readers and **not** code paths in the server or worker. Nothing in the
app invokes them. They add no Rust, change no migration file, version,
description or checksum, and make no change to any production database or host
by themselves. An operator runs them by hand, with `psql`, against a disposable
or operator-controlled database.

## Why this exists

Migration `0085_dns_single_contract.sql` rewrites the body digest of every
schema-1 `network_dns_management_config` row at the **same** `config_version`,
then rewrites the matching digest pins in `network_dns_delivery`,
`network_dns_status` and `network_dns_gateway_state` (both the delivered and the
reported pin). After that runs, the original digests are gone from the database
unless they were saved first. A separate `0086` migration bumps the desired
version only and deliberately preserves all ledger rows and pins. These scripts
save the original digests before `0085` and put them back after `0085 + 0086`.

## Stop-the-world constraint

All controllers, API servers and workers must have their **WRITES STOPPED**
before the snapshot script starts. Keep writes stopped continuously across
preflight → migrate → restore, and do not restart any writer until the restore
has been verified. If a read path can produce any write side effect (status
report, delivery, publish, ack), stop it too. Both scripts run in a single
transaction and lock the rows they touch, but a stopped writer is the primary
safety guarantee; do not rely on the locks alone.

## Procedure

Run from the repository root. Pass the connection through an environment
variable so no DSN, password or secret is printed or committed.

1. Stop every controller, API and worker write.
2. Snapshot (must report success before step 3):
   `psql "$VANTYR_DB_URL" -v ON_ERROR_STOP=1 -f server/scripts/offline0085_evidence_snapshot.sql`
   This creates and fills `operator_offline0085_dns_evidence_snapshot` with one
   `desired_config` row per affected household plus the exact scoped evidence
   digests keyed by household, gateway, version and kind.
3. Apply migration `0085` and then `0086` by the normal operator migration path.
   Do not start any writer between migrations.
4. Restore:
   `psql "$VANTYR_DB_URL" -v ON_ERROR_STOP=1 -f server/scripts/offline0085_evidence_restore.sql`
   It verifies the desired config is exactly `V+1` with the snapshotted
   converted body/digest, then restores the original digests only on the exact
   evidence rows that still exist and still carry the converted value. Missing
   rows or changed digests abort the whole transaction; no pins, status rows or
   new records are fabricated.
5. Verify the restored rows, and only then restart services and workers. Any
   later database testing must be on a fresh throwaway database, never on a
   household/production database.

## Overflow: stop before `0085`, shrink, restart

The snapshot validates every schema-1 body before recording anything. It
requires the exact canonical schema-1 ending and that
`octet_length(body) + (length(default_runtime) - 1) <= 16384` (the delta is
derived from the same literal migration `0085` appends, currently 199). If a
body would overflow, the script raises before producing any durable snapshot
and any partial work is rolled back. In that case **do not apply `0085`**:
shrink the stored config through the old (pre-`0085`) application, keep writes
stopped, and restart the whole procedure from step 2. An earlier successful
snapshot is not clobbered by a failed rerun.

## Already at `0085`, or no backup

If `0085` is already applied and there is no valid snapshot, the original
digests cannot be reconstructed from the database. Do **not** fabricate pins,
status rows or new records, and do not hand-edit digests to guess. Recovery is
BLOCKED pending an operator backup of the pre-`0085` state or an explicit
disposition. The snapshot script refuses to run once `0085` is in the ledger,
so it cannot overwrite a good backup after the fact.

## Backup retention and failure behaviour

Keep `operator_offline0085_dns_evidence_snapshot` after a successful restore
until recovery is no longer needed; the restore script never drops or
truncates it, and the snapshot script never deletes it once `0085` is applied.
Every script is one transaction: any guard failure raises and rolls back all
work, so there is no partial repair. Error messages deliberately include no
body bytes, digests or connection strings.

## Scope

No production DB or host change is made by these scripts. No Rust build,
test, clippy or broad redesign is part of this change. No migration bytes or
checksums are modified. No push, PR or deployment is performed.
# Snapshot integrity and repeat execution

The snapshot and metadata tables must be owned by the migration operator, with
write grants restricted to that operator. Verify their table definitions and
ownership before use; they are trusted recovery data, not untrusted input. The
snapshot checks the original desired body's digest before capturing it. A
completed marker records the captured row count, including zero: when there
were no schema-1 configs, restore succeeds without changing evidence. A missing
marker or changed row count refuses restoration.

Restore is a one-shot operation for nonempty snapshots. Repeating a successful
restore refuses the already-restored digests atomically; it does not delete the
recovery data. Keep both tables until the upgrade has been verified.
