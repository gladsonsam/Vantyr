# DNS events v1 wire fixture

Synthetic, non-secret fixture binding the server's strict request parser and
validator to the worker's strict reporter/DTO mirror. `report.json` is checked
by the actual server validator and by the worker parser; both must admit the
explicit `cache_state: "unknown"` produced when the maintained resolver's cache
use is unobservable. `upstream` stays null: no identity is fabricated.

This checks the wire contract only; it is not a substitute for the real
authenticated server↔worker E2E tests.
