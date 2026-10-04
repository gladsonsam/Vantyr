# Metadata-only diagnostic report

Run from a Vantyr source checkout with Python 3. No packages or running services are required:

```sh
python3 tools/diagnostic_report.py
python3 tools/diagnostic_report.py --storage-root /explicit/storage/root
python3 tools/diagnostic_report.py --output ./diagnostic-report.json
```

The default prints JSON to stdout. `--output` exclusively creates the requested file; it refuses to overwrite existing files (including symlinks), requests Unix mode 0600, and prints no path. `--storage-root` samples the containing filesystem's aggregate total/free bytes using `shutil.disk_usage`; it never enumerates directories or reads stored files. It does not calculate Vantyr storage consumption. Paths are accepted only for these two explicit purposes and are never report fields.

The version-1 schema has exactly these top-level keys:

| Key | Allowed contents |
| --- | --- |
| `schema_version` | Integer `1` |
| `system` | Allowlisted `os_family` and `architecture`; unknown values become `other` |
| `repository` | `status`, validated hexadecimal `commit`, and `tracked_changes` containing a status and boolean `dirty` when available |
| `tools` | Only `python`, `git`, `node`, `docker`, `psql`; each has a status and normalized numeric version when available |
| `storage` | `not_requested`, a fixed failure status, or `ok` with integer `total_bytes` and `free_bytes` |

Probe failure statuses are `unavailable`, `timeout`, `command_failed`, `malformed_output`, `output_limit`, and `storage_unavailable`. No raw stdout/stderr is copied into a failure. An unavailable or malformed probe is useful report data, so report generation still exits successfully. CLI argument errors exit 2 with `invalid_arguments`; output creation errors exit 1 with `output_unavailable`.

Git probes run against the checkout containing the tool, independent of the caller's working directory. **Dirty means tracked staged/unstaged changes relative to HEAD; it excludes untracked files and submodule changes.** The tool never requests filenames, diffs, remotes or branch names. An unborn or inaccessible repository has a fixed failure category.

Each child command is a fixed version or Git metadata command, with no shell or user-supplied command arguments, a three-second overall read/process deadline, a 4 KiB stdout limit and discarded stderr. Pipe polling uses no background reader threads. On POSIX, each command owns a new session/process group; timeout and excessive-output cleanup kills that group, tolerates an already-exited leader, waits at most another 0.5 seconds, and closes the pipe. Descendants that deliberately escape the group are outside this cleanup boundary. On Windows, nonblocking pipe polling closes the read handle and terminates the direct child with a bounded wait; descendant termination is not guaranteed (there is no Windows Job Object). The POSIX subprocess cleanup fixtures have been exercised locally; Windows execution still needs platform verification. The child environment uses the standard system executable search path and disables inherited Git global/system configuration and Node options. User-local tool installations outside that path may therefore appear unavailable. Repository Git configuration can still affect Git behavior; only run this utility from a trusted checkout. Rust toolchain shims are intentionally not probed because they can auto-install toolchains. Docker and psql probes check client versions only; they do not connect to the Docker daemon or PostgreSQL.

The utility does not read application configuration, logs, captured content, credentials, environment values for reporting, hostname/user identifiers, filename lists or directory trees. It does not perform network requests, inspect server endpoints, change device permissions or operate services. OS identity is family/architecture only; no kernel build string or distribution name is emitted.

This is a metadata report, **not evidence that a server is healthy or recoverable**. It cannot verify authentication, migrations, capture/Recall completeness, database availability, disk corruption or backups. Backup creation, integrity checking and tested restore procedures remain future operational work.

Fixture tests include actual isolated local Python subprocesses for excessive output, trickling output, closed stdout with a hung child, and a POSIX descendant retaining stdout. They require no production services or data:

```sh
PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s tools -p test_diagnostic_report.py -v
```
