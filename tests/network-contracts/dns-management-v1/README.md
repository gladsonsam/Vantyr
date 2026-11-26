# DNS management v1 wire fixtures

These synthetic, non-secret fixtures bind the server serializer and validator
to the worker's strict parser and reporter. They are test inputs, never fetched
lists or a curated service catalogue.

`read.json` includes a pending refresh's expiry. The server unit test constructs
the actual response type and compares its serialized value with this fixture.
`report.json` is checked by the actual server request parser and status validator.
The worker tests must read these same files and check serialization compatibility.

Validation uses the fixed `server_time` in the read fixture, so the old applied
and content times and seven-day scheduling horizon remain reproducible. The
config digest covers the typed configuration's canonical compact JSON bytes.
This checks the wire contract; it does not substitute for authenticated server,
worker, download and durable-publication integration tests.
