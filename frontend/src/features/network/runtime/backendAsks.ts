/**
 * The minimal backend surface the Network screens need before the runtime source can stop reporting
 * "unavailable". Documentation as data: nothing renders this.
 */
export interface BackendAsk {
  area: string;
  need: string[];
  notes: string;
}

export const BACKEND_ASKS: readonly BackendAsk[] = [
  {
    area: "DNS and proxy events (query log)",
    need: [
      "List fields per event: id, at, source (dns|proxy|agent), deviceId, deviceLabel, personLabel, evidence (verified|asserted|weak|unknown), subject (domain or host), effect (allow|deny), reason, policy revision, correlationId",
      "Optional grouping=by_host: one row per device + host + decision, with observations (count), firstSeenAt and lastSeenAt",
      "Filters: deviceId (household-wide when omitted), source (dns|proxy|agent|all), decision (allowed|blocked|all), search (host/domain substring), from/to (ISO)",
      "Pagination: limit plus cursor or offset; response has total (nullable), hasMore and nextCursor",
      "Retention block on every page: keepDays, oldestStoredAt (nullable), storedCount, capCount (nullable), plus truncated when the requested range reaches before oldestStoredAt",
    ],
    notes:
      "Rows are domain/host observations by a gateway, never browser visits or page history. Hosts only: no full URLs or page contents.",
  },
  {
    area: "DNS and proxy statistics",
    need: [
      "Query by optional deviceId and requestedRange (24h|7d|30d)",
      "Response: total observations, blocked observations, time series buckets, top domains/hosts, top blocked, and for proxy the inspected count",
      "Response window: requested, actualStart, actualEnd, retainedDays, shortened",
    ],
    notes:
      "The UI must say how many days actually exist (for example 9 of 30) and never claim the requested range when shortened is true.",
  },
  {
    area: "Proxy sign-in credentials and sessions",
    need: [
      "List credentials: id, label, personLabel, deviceId, createdAt, expiresAt, lastUsedAt, revoked, revokedAt, scopes",
      "Issue credential for personId + optional deviceId + label + expiresInHours; the secret is returned once in that response and never listed",
      "Revoke one credential by id; revoke all credentials and sessions for a person",
      "List live sessions: id, credentialId, deviceId, personLabel, startedAt, lastActiveAt, expiresAt, revoked; end one session by id",
      "Enrollment availability flag with an optional reason",
    ],
    notes:
      "A proxy sign-in credential is distinct from a gateway worker token, a BYOD setup grant and HTTPS-inspection CA trust. Evidence from a session is 'proxy sign-in' only.",
  },
  {
    area: "DNS runtime settings",
    need: [
      "settingsVersion: its own counter, separate from the policy revision",
      "Update with expectedSettingsVersion (compare-and-set); a stale version returns a conflict, and success returns the new settingsVersion",
      "settingsStatus: saved, appliedVersion (nullable) and reportedAt (nullable), as reported by the gateway",
      "Cache clear action returning clearedAt and the number of entries dropped",
    ],
    notes:
      "appliedVersion is what the gateway reports; the server cannot verify it. Clearing the cache must not bump settingsVersion.",
  },
];
