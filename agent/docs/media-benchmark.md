# Bounded MJPEG receive benchmark

`tools/media_benchmark.py` uses Python 3.10+ and the standard library. It measures **received HTTP body bytes and multipart frame completions**, not capture FPS, rendering FPS, capture-to-display latency, input latency, CPU use or image quality. No real-device measurements have been performed as part of implementation.

## Source contract and operational effect

The inspected route is `GET /agents/:id/mjpeg` (`server/src/api/agents_capture.rs`). It requires authenticated operator/admin access and a `session` UUID query value. Optional `jpeg_q`, `interval_ms`, and `monitor` values configure the viewer session. Current server clamps quality to 20–85 (default 40) and capture interval to 33–1000 ms (default 200). Parts use:

```text
--mjpegframe\r\n
Content-Type: image/jpeg\r\n
Content-Length: <JPEG byte count>\r\n
\r\n
<JPEG bytes>\r\n
```

No geometry/frame metadata is needed. The server can resend the same cached image after five seconds; those parts count as received frames, not fresh captures. Opening this GET starts/joins capture and closing the HTTP connection releases its session guard. Obtain operator authorization before a real-device run. The tool sends only this GET, never leave/control requests, and never contacts a database. Tests use localhost fixtures only.

## Run and authentication

Use a new session UUID per run. Supply a non-secret URL via `--url`; use `--url-env` whenever any URL component is private. Authentication values must come from an environment variable or stdin, never an argument. A cookie value is the complete Cookie header value; bearer mode accepts just the token. Do not use verbose HTTP logging, shell tracing or command-line secrets. Populate environment values through your existing secure session tooling.

```sh
# MJPEG_BENCH_URL and MJPEG_BENCH_COOKIE are already populated securely.
python3 tools/media_benchmark.py --url-env MJPEG_BENCH_URL \
  --auth-env MJPEG_BENCH_COOKIE --auth-kind cookie \
  --connect-ip 192.0.2.10 --warmup 5 --duration 30 --timeout 2 > receive.json

# POSIX: feed one secret line from secure tooling; input wait is bounded by timeout.
python3 tools/media_benchmark.py --url-env MJPEG_BENCH_URL \
  --auth-stdin --auth-kind bearer --connect-ip 192.0.2.10 \
  --duration 30 --format csv > receive.csv
```

No automatic DNS resolution: a numeric URL host works directly; DNS hostnames require `--connect-ip`. HTTP Host and TLS certificate verification/SNI still use the original hostname. HTTPS verification stays enabled. There are no redirects, ambient proxy settings or cookie jars. Stdin authentication supports POSIX file descriptors; Windows uses environment authentication. SIGINT cancels an active run and returns its partial report; cancellation before measurement/input completes can return without a report.

Reports go to stdout; the tool creates no output files itself. Raw JPEGs, titles, URL paths/queries/hostnames, device/session IDs, IPs and credentials never enter JSON/CSV or error messages. HTTP/body error details are reduced to fixed codes. Do not include credentials in argv: the tool cannot remove shell history or OS process listings after an argument has been supplied.

## Measurement and bounds

- `duration` is the measurement window after a single initial `warmup`, including any reconnect downtime. Both start at invocation, so connection/TLS time consumes warmup or measurement time. Actual measured elapsed time ends early on unrecovered errors/cancellation. Rates divide by that elapsed time.
- `body_bytes`/`bytes_per_second` count decoded HTTP body bytes received during measurement, including multipart headers/delimiters. HTTP headers, HTTP chunk framing, TLS and TCP/IP overhead are excluded. Reads crossing the warmup boundary are attributed by completion time.
- `marker_valid_frames`/`frames_per_second` count complete Content-Length parts with JPEG SOI/EOI markers and valid multipart framing. This is **not a full JPEG decoder**: marker-valid but undecodable images can count.
- Frame arrival timestamps are monotonic **client read completion** times. Several frames delivered in one read share a timestamp. Median and nearest-rank p95 describe successive completions, including reconnect downtime; they are null with fewer than two measured frames. They do not locate capture or display time.
- `gaps` counts silences at least `gap_ms` long, including silence before the first and after the last frame. `max_silence_ms` includes those edges. No-frame runs report their measured silent window.
- Reports include bounded configuration, connection attempts, reconnect attempts, fixed error codes and termination reason. Default reconnect count is zero; optional retries are capped at ten with explicit delay. Warmup does not restart on reconnect. Exit codes: 0 duration reached, 1 partial/error/cancelled run report, 2 invalid configuration/input, 130 cancelled before a report.

Total warmup/measurement is capped at 300/3600 seconds. Socket operations time out (0.01–10 seconds); a joined watchdog shuts down the active socket at the absolute deadline or cancellation, including stalled/trickling response and HTTP chunk headers. Timeouts terminate that connection and consume any configured retry. Local OS scheduling/uninterruptible kernel operations are not a hard real-time guarantee.

There is no reader queue or detached reader task. Reads are at most 64 KiB; response/part headers are capped at 16 KiB; multipart boundary at 70 ASCII bytes; frame allocation defaults to 16 MiB (maximum configurable 32 MiB). A partial frame plus one read is retained in memory only and discarded on disconnect. At most 100,000 measured frame timestamps are retained; exceeding that bound ends with `sample_limit`. Output contains aggregates, never timestamp arrays. Unknown part headers, missing/duplicate/non-numeric Content-Length, oversized/corrupt/truncated framing are rejected, not silently resynchronized. No-content-length JPEG streams are unsupported.

## Reproducible comparisons

Record non-sensitive trial conditions in a separate operator note: agent/server/tool revisions, machine/OS, monitor/resolution/scaling, quality and capture interval, single-viewer/arbitration state, fixed screen-motion workload, warmup/duration, network route and shaping, and timeout/retry policy. Run repeated trials under the same conditions; retain early/error runs and their actual elapsed time. Ensure other viewers do not change capture preferences. The benchmark itself performs no CPU sampling, network shaping, control input or workload generation.

For LAN versus WAN, keep hardware/content/settings constant and report bandwidth, RTT, loss/jitter and whether those are controlled or separately measured. Do not call client arrival interval “network latency.”

For a future encoded-video comparison, match resolution/content/duration/network conditions and report codec, bitrate, frame cadence, decoder/hardware acceleration and quality methodology. This MJPEG tool cannot parse encoded video; use equivalent bounded receive instrumentation for that transport. Measure decode/render time, end-to-end latency, input response and agent/server/client CPU/GPU separately before claiming improvements. Fresh-frame IDs/timestamps with clock synchronization, visual instrumentation or loopback experiments require future source/hardware work.

## Verification

```sh
PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s tools -p test_media_benchmark.py -v
```

Actual parser fixtures exercise every chunk size, embedded boundary bytes, Content-Length, corruption, truncation and oversize. Local HTTP tests exercise warmup/metrics, reconnect/error reporting, response-header limits, stalled bodies, incomplete chunk headers, trickling headers, cancellation/watchdog cleanup, credential/URL redaction and JSON/CSV. POSIX stdin tests cover input timeout, cancellation and size limits. TLS and real LAN/WAN/Windows execution remain unverified on hardware.
