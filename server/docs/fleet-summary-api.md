# Fleet enrichment API

`GET /api/agents/fleet-summary?ids=UUID,UUID` uses the existing authenticated dashboard middleware. Admin, operator and viewer roles can read it, matching the individual info, window and policy reads; the application currently has no per-user agent visibility partition. It does not replace or change those endpoints.

`ids` is required, nonempty and comma-separated without empty entries. UUIDs are normalized and deduplicated; at most 100 unique IDs and 8192 decoded bytes are accepted. Invalid/missing/oversized input returns HTTP 400. Unknown/deleted IDs are omitted from `agents` and included in `missing`. Both are ordered by UUID; callers should look up entries by UUID, not response position. Empty matches are HTTP 200.

```json
{
  "agents": {
    "00000000-0000-4000-8000-000000000001": {
      "info": {"hostname": "workstation", "uptime_secs": 123},
      "info_reported_at": "2026-10-04T01:02:03Z",
      "last_window": {
        "app": "browser.exe",
        "title": "Dashboard",
        "reported_at": "2026-10-04T01:02:00Z"
      },
      "internet_blocked": true,
      "internet_block_source": "group",
      "app_block_enabled_count": 3
    }
  },
  "missing": []
}
```

- `info` is the latest stored agent-info object, using the existing public metadata shape. `info_reported_at` is the database's snapshot receipt/update timestamp, not the request time or a freshness guarantee. An absent/non-object snapshot produces `null` for both. Monitor inventory can be retained by existing ingestion across snapshots; its timestamp is not a new monitor-enumeration acknowledgement.
- Known info scalars, drive/adapter/monitor fields and capability names are allowlisted. Unknown/config objects, credentials and password/token/hash fields are not returned. Each known field is validated against its declared type: strings, numbers, booleans, string-only address arrays, or explicitly nullable fields. Mismatched scalar types and objects are dropped; values are never coerced. `config_server_url` permits HTTP(S)/WS(S), strips user/password/query/fragment, and drops invalid URLs. Nested metadata arrays are capped at 64 entries; scalar strings at 8192 characters, adapter address strings at 256. Other individual info reads are unchanged and currently return the raw stored JSON; this endpoint intentionally provides a sanitized projection rather than arbitrary extension fields.
- `last_window` is stored window history, or `null` if none. Timestamp ties use the largest event ID. It is not proof of the currently focused window: frontend live window events should take precedence. The existing live-cache timestamp covers other activity and cannot accurately date a window event, so this endpoint uses history only.
- `internet_blocked` / `internet_block_source` match the existing quick-toggle GET: enabled **always-on** applicable rules only, excluding any rule with schedules. Source is `all`, `group`, `agent`, or `null`, with that priority. `false` means no matching always-on configuration; scheduled enforcement and the agent's actual current blocking state remain unknown.
- `app_block_enabled_count` counts distinct enabled applicable rules across global/group/device scopes, including scheduled rules, matching the fleet's count from the individual rules list. It is a configured-rule count, not the number currently enforcing on the agent. Disabled and unrelated rules are excluded; overlapping scopes count once.
- Missing telemetry is `null`; known empty policy configuration is `false`/`0`. Any database/query/decode failure fails the entire request with HTTP 500 and the standard error body, with no partial healthy defaults.

The enrichment handler executes one SELECT statement and issues no audit writes or agent commands. Normal authentication middleware still performs its existing session activity touch. The statement uses indexed top-one window probes and bounded requested-agent IDs, not a scan over telemetry history. Migration 0070 replaces the `(agent_id, ts DESC)` index with `(agent_id, ts DESC, id DESC)` to keep equal-timestamp selection bounded. Policy work scales with configured rules and the requested agents, not historical event count.

Verification uses isolated PostgreSQL temporary tables and actual HTTP routing/authentication. No real fleet or hardware enforcement was tested.
