#!/usr/bin/env bash
# Vantyr family network — bounded DNS lab driver.
# All assertions use ISC BIND dig inside the isolated client containers.
# Awk programs are deliberately single-quoted: $2/$4/$5 are dig output fields.
# shellcheck disable=SC2016
set -euo pipefail
# shellcheck source=lib.sh
source "$(dirname -- "${BASH_SOURCE[0]}")/lib.sh"

# 172.26.9.56 is the unmapped "client-unknown" source declared in the override.
SINKHOLE_IP="192.0.2.222"
VANTYR_IMAGE="${PROJECT}-vantyr-dns:local"

up() {
  compose up -d --build
  wait_ready
  log "lab up: stub upstream at ${UPSTREAM_IP}:${UPSTREAM_PORT} on a private internal network"
}

query() {
  compose exec -T client dig "@${UPSTREAM_IP}" -p "${UPSTREAM_PORT}" "$@"
}

check() {
  local out

  out="$(query +notcp +short "www.${ZONE}" A)"
  assert_eq "UDP A answer" '203.0.113.10' "${out}"

  out="$(query +tcp +short "www.${ZONE}" A)"
  assert_eq "TCP A answer" '203.0.113.10' "${out}"

  out="$(query +short "www.${ZONE}" AAAA)"
  assert_eq "AAAA answer" '2001:db8::10' "${out}"

  out="$(query +short "alias.${ZONE}" CNAME)"
  assert_eq "CNAME target" 'www.lab.vantyr.test.' "${out}"

  out="$(query +noall +comments "missing.${ZONE}" A)"
  assert_has_line "NXDOMAIN status" 'status: NXDOMAIN' "${out}"

  out="$(query +noall +authority "missing.${ZONE}" A)"
  assert_awk_line "negative TTL 60s in SOA authority" \
    '$2 == 60 && $4 == "SOA" { found = 1 } END { exit found ? 0 : 1 }' "${out}"

  out="$(query +noall +answer "ttl.${ZONE}" A)"
  assert_awk_line "exact A TTL 123s" \
    '$2 == 123 && $4 == "A" && $5 == "198.51.100.7" { found = 1 } END { exit found ? 0 : 1 }' "${out}"

  out="$(query +noall +answer "alias.${ZONE}" CNAME)"
  assert_awk_line "exact CNAME TTL 90s" \
    '$2 == 90 && $4 == "CNAME" && $5 == "www.lab.vantyr.test." { found = 1 } END { exit found ? 0 : 1 }' "${out}"
}

outage() {
  local out rc=0
  compose stop upstream >/dev/null
  out="$(compose exec -T client dig "@${UPSTREAM_IP}" -p "${UPSTREAM_PORT}" \
    +time=2 +tries=1 +short "www.${ZONE}" A 2>/dev/null)" || rc=$?
  # Pinned dig reports a bounded-timeout diagnostic on stdout rather than
  # returning an empty string, so assert on the absence of an answer plus the
  # expected timeout diagnostic.
  if [[ "${out}" == *"203.0.113.10"* ]]; then
    compose up -d upstream >/dev/null
    die "outage check unexpectedly returned an answer: ${out}"
  fi
  if [[ "${out}" != *"no servers could be reached"* ]]; then
    compose up -d upstream >/dev/null
    die "outage check did not produce the expected timeout diagnostic: ${out} (dig rc=${rc})"
  fi
  log "PASS: controlled upstream outage (timeout diagnostic, no answer, dig rc=${rc})"
  compose up -d upstream >/dev/null
  wait_ready
  log "PASS: upstream recovery (queries answered again)"
}

down() {
  compose down --timeout 5 || return 1
  verify_cleanup_project "${PROJECT}"
}

smoke() {
  on_exit() {
    local rc=$?
    if (( rc != 0 )); then
      log "smoke FAILED (rc=${rc}); cleaning up scoped project ${PROJECT}"
    else
      log "cleaning up scoped project ${PROJECT} after successful smoke"
    fi
    if ! down; then
      log "cleanup failed; inspect project ${PROJECT}"
      exit 1
    fi
    exit "${rc}"
  }
  trap on_exit EXIT

  up
  check
  outage
  log "SMOKE PASS — every supported lab assertion succeeded"
}

# ---------------------------------------------------------------------------
# Opt-in full-stack Vantyr DNS smoke. Everything below uses the override file
# and never changes the base assertions above.
# ---------------------------------------------------------------------------

vquery() {
  compose exec -T client dig "@${VANTYR_IP}" -p "${VANTYR_PORT}" "$@"
}

vquery_unknown() {
  compose exec -T client-unknown dig "@${VANTYR_IP}" -p "${VANTYR_PORT}" "$@"
}

fullstack_up() {
  vantyr_compose up -d --build
  wait_ready
  wait_vantyr_ready
  log "full-stack up: Vantyr DNS at ${VANTYR_IP}:${VANTYR_PORT}, upstream ${UPSTREAM_IP}:${UPSTREAM_PORT}"
}

config_checks() {
  local out
  # One-off containers use --network none: no listener can bind anywhere, and
  # they cannot collide with the worker's static 172.26.9.55 address.
  out="$(docker run --rm --network none --read-only --cap-drop ALL \
    --security-opt no-new-privileges:true --pids-limit 64 --memory 128m \
    -v "${LAB_DIR}/configs/vantyr.lab.json:/etc/vantyr/vantyr.lab.json:ro" \
    "${VANTYR_IMAGE}" --check-config /etc/vantyr/vantyr.lab.json)"
  assert_has_line "validated JSON fixture accepted by --check-config" \
    'configuration valid' "${out}"
}

vcheck() {
  local out direct

  # Allowed forwarding through Vantyr, over both transports.
  out="$(vquery +notcp +short "www.${ZONE}" A)"
  assert_eq "Vantyr forwarded UDP A" '203.0.113.10' "${out}"
  out="$(vquery +tcp +short "www.${ZONE}" A)"
  assert_eq "Vantyr forwarded TCP A" '203.0.113.10' "${out}"
  out="$(vquery +short "www.${ZONE}" AAAA)"
  assert_eq "Vantyr forwarded AAAA" '2001:db8::10' "${out}"
  out="$(vquery +short "alias.${ZONE}" CNAME)"
  assert_eq "Vantyr forwarded CNAME" 'www.lab.vantyr.test.' "${out}"

  # Local authoritative zone owned by Vantyr: multiple A/AAAA and a CNAME.
  out="$(vquery +short multi.local.vantyr.test A)"
  assert_has_line "local multi A (first)" '192.0.2.10' "${out}"
  assert_has_line "local multi A (second)" '192.0.2.11' "${out}"
  assert_count "local multi A" 2 "${out}"
  out="$(vquery +short multi.local.vantyr.test AAAA)"
  assert_has_line "local multi AAAA (first)" '2001:db8::20' "${out}"
  assert_has_line "local multi AAAA (second)" '2001:db8::21' "${out}"
  assert_count "local multi AAAA" 2 "${out}"
  out="$(vquery +short localias.local.vantyr.test CNAME)"
  assert_eq "local CNAME target" 'multi.local.vantyr.test.' "${out}"

  # The stub knows the blocked names; Vantyr must answer from its own policy.
  direct="$(compose exec -T client dig "@${UPSTREAM_IP}" -p "${UPSTREAM_PORT}" \
    +short blocked.lab.vantyr.test A)"
  assert_eq "stub answers exact-blocked name directly" '198.51.100.99' "${direct}"
  out="$(vquery +short blocked.lab.vantyr.test A)"
  assert_eq "Vantyr sinkholes exact-blocked name" "${SINKHOLE_IP}" "${out}"
  out="$(vquery +noall +answer blocked.lab.vantyr.test A)"
  assert_awk_line "sinkhole TTL 30s" \
    '$2 == 30 && $4 == "A" && $5 == "192.0.2.222" { found = 1 } END { exit found ? 0 : 1 }' "${out}"

  direct="$(compose exec -T client dig "@${UPSTREAM_IP}" -p "${UPSTREAM_PORT}" \
    +short ads.tracker.lab.vantyr.test A)"
  assert_eq "stub answers suffix-blocked name directly" '198.51.100.98' "${direct}"
  out="$(vquery +short ads.tracker.lab.vantyr.test A)"
  assert_eq "Vantyr sinkholes suffix-blocked name" "${SINKHOLE_IP}" "${out}"

  # An allowed alias may not resolve to a denied target, local or forwarded.
  out="$(vquery +short badalias.local.vantyr.test A)"
  assert_eq "local CNAME to denied target is blocked" "${SINKHOLE_IP}" "${out}"
  direct="$(compose exec -T client dig "@${UPSTREAM_IP}" -p "${UPSTREAM_PORT}" \
    +short forwardalias.lab.vantyr.test A)"
  assert_has_line "stub resolves forwarded alias CNAME" 'blocked.lab.vantyr.test.' "${direct}"
  assert_has_line "stub resolves forwarded alias A" '198.51.100.99' "${direct}"
  out="$(vquery +short forwardalias.lab.vantyr.test A)"
  assert_eq "forwarded CNAME to denied target is blocked" "${SINKHOLE_IP}" "${out}"

  # Unknown source IP is not assigned to a device: restrictive default applies.
  out="$(vquery_unknown +short "www.${ZONE}" A)"
  assert_eq "unknown client uses restrictive profile" "${SINKHOLE_IP}" "${out}"
  out="$(vquery_unknown +short multi.local.vantyr.test A)"
  assert_eq "unknown client blocked on local zone too" "${SINKHOLE_IP}" "${out}"

  # Negative answers and their SOA/TTL are forwarded intact by Vantyr.
  out="$(vquery +noall +authority "missing.${ZONE}" A)"
  assert_awk_line "negative TTL 60s via Vantyr" \
    '$2 == 60 && $4 == "SOA" { found = 1 } END { exit found ? 0 : 1 }' "${out}"
}

voutage() {
  local out
  vantyr_compose stop upstream >/dev/null

  # www was primed by vcheck; its forwarder cache entry is reusable while the
  # stub is down. The stub itself no longer answers at all.
  out="$(vquery +time=1 +tries=1 +short "www.${ZONE}" A 2>/dev/null)" || true
  assert_eq "cached allowed answer during upstream outage" '203.0.113.10' "${out}"

  # Policy is evaluated before forwarding, so configured denials still hold.
  out="$(vquery +time=1 +tries=1 +short blocked.lab.vantyr.test A 2>/dev/null)" || true
  assert_eq "configured block holds during upstream outage" "${SINKHOLE_IP}" "${out}"

  # An uncached allowed name must NOT be answered from any other resolver.
  out="$(vquery +time=1 +tries=1 +short fresh.${ZONE} A 2>/dev/null)" || true
  if [[ "${out}" == *"203.0.113."* || "${out}" == *"192.0.2.10"* ]]; then
    vantyr_compose start upstream >/dev/null
    wait_ready
    die "no failopen: uncached allowed name was answered during outage: ${out}"
  fi
  log "PASS: no failopen during upstream outage (no fallback resolver)"

  vantyr_compose start upstream >/dev/null
  wait_ready
  wait_vantyr_ready
  log "PASS: upstream and Vantyr recovery after outage"
}

vrestart() {
  local out
  vantyr_compose restart vantyr-dns >/dev/null
  wait_vantyr_ready
  out="$(vquery +short "www.${ZONE}" A)"
  assert_eq "allowed answer after same-config restart" '203.0.113.10' "${out}"
  out="$(vquery +short blocked.lab.vantyr.test A)"
  assert_eq "blocked answer after same-config restart" "${SINKHOLE_IP}" "${out}"
  # Deliberately no claim about durable last-known-good policy or reload: the
  # runtime worker does not integrate either, and this test only restarts the
  # same process with the same config file.
  log "PASS: process restart with identical config is equivalent (no LKG/reload claim)"
}

startup_failure_checks() {
  local out rc=0
  out="$(docker run --rm --network none --read-only --cap-drop ALL \
    --security-opt no-new-privileges:true --pids-limit 64 --memory 128m \
    -v "${LAB_DIR}/configs/vantyr.malformed.json:/etc/vantyr/malformed.json:ro" \
    "${VANTYR_IMAGE}" --config /etc/vantyr/malformed.json 2>&1)" || rc=$?
  (( rc != 0 )) || die "malformed bind address was accepted"
  [[ "${out}" != *"listening"* ]] || die "malformed config started a DNS listener: ${out}"
  assert_has_line "malformed bind rejected before socket" \
    'must be an IP literal' "${out}"

  rc=0
  out="$(docker run --rm --network none --read-only --cap-drop ALL \
    --security-opt no-new-privileges:true --pids-limit 64 --memory 128m \
    -v "${LAB_DIR}/configs/vantyr.wildcard.json:/etc/vantyr/wildcard.json:ro" \
    "${VANTYR_IMAGE}" --config /etc/vantyr/wildcard.json 2>&1)" || rc=$?
  (( rc != 0 )) || die "0.0.0.0 wildcard bind was accepted"
  [[ "${out}" != *"listening"* ]] || die "wildcard config started a DNS listener: ${out}"
  assert_has_line "0.0.0.0 wildcard rejected before socket" \
    'an unspecified bind address is never allowed' "${out}"
}

fullstack_down() {
  vantyr_compose down --timeout 5 || return 1
  verify_cleanup_project "${PROJECT}"
}

fullstack_smoke() {
  preflight
  on_fullstack_exit() {
    local rc=$?
    if (( rc != 0 )); then
      log "full-stack smoke FAILED (rc=${rc}); cleaning up scoped project ${PROJECT}"
    else
      log "cleaning up scoped project ${PROJECT} after successful full-stack smoke"
    fi
    if ! fullstack_down; then
      log "cleanup failed; inspect project ${PROJECT}"
      exit 1
    fi
    exit "${rc}"
  }
  trap on_fullstack_exit EXIT

  fullstack_up
  config_checks
  vcheck
  voutage
  vrestart
  startup_failure_checks
  log "FULLSTACK SMOKE PASS — Vantyr DNS answered every filtering assertion"
}

# ---------------------------------------------------------------------------
# Opt-in durable lab. This is a REAL recovery test, not a same-config restart:
# the bundle is persisted on a disposable nonroot-owned volume, SIGHUP applies
# one higher revision at a time, rejected candidates keep the applied version,
# and an abrupt kill followed by a changed external config must recover the
# persisted revision/publication time/answers. No controller ack or canary is
# claimed; local durability is unauthenticated.
# ---------------------------------------------------------------------------

# Keep the recovery fixture fresh on every run, with distinct timestamps so a
# restarted worker cannot silently substitute the external publication time.
PUB_A_PREFIX="$(date -u -d '1 minute ago' +%Y-%m-%dT%H:%M:%S)"
PUB_A="${PUB_A_PREFIX}Z"
PUB_B="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

corrupt_state_check() {
  local out rc=0 corrupt="${LAB_DIR}/work/durable/corrupt.json"
  mkdir -p "${DURABLE_CONFIG_DIR}"
  printf '%s' '{"schema":' >"${corrupt}"
  make_durable_config "${LAB_DIR}/work/durable/corrupt-config.json" \
    "${DURABLE_HOUSEHOLD}" 20 "${PUB_A}" 86400 "${VANTYR_IP}" "${VANTYR_PORT}" 192.0.2.10
  out="$(docker run --rm --network none --read-only --cap-drop ALL \
    --security-opt no-new-privileges:true --pids-limit 64 --memory 128m \
    -v "${corrupt}:/state/vantyr-dns.json:ro" \
    -v "${LAB_DIR}/work/durable/corrupt-config.json:/etc/vantyr/active.json:ro" \
    "${VANTYR_IMAGE}" --state /state/vantyr-dns.json --worker "${DURABLE_WORKER}" \
    --config /etc/vantyr/active.json 2>&1)" || rc=$?
  (( rc != 0 )) || die "corrupt state file was accepted at startup"
  [[ "${out}" != *"listening"* ]] || die "corrupt state still started a listener: ${out}"
  assert_has_line "corrupt state rejected before any listener (no answer served)" \
    "malformed snapshot" "${out}"
}

durable_bootstrap() {
  preflight_project "${DURABLE_PROJECT}"
  mkdir -p "${DURABLE_CONFIG_DIR}"
  init_state_volume "${DURABLE_PROJECT}"
  make_durable_config "${DURABLE_CONFIG_DIR}/active.json" \
    "${DURABLE_HOUSEHOLD}" 20 "${PUB_A}" 86400 "${VANTYR_IP}" "${VANTYR_PORT}" 192.0.2.10
  durable_compose up -d --build
  wait_vantyr_ready_project "${DURABLE_PROJECT}"
}

# A rejected SIGHUP must leave both the answer and the persisted bundle on the
# previously applied version. The caller writes the candidate config first.
reject_reload() {
  local label="$1" out status
  sighup_and_wait "${DURABLE_PROJECT}"
  out="$(vquery_project "${DURABLE_PROJECT}" +short "${DURABLE_PROBE}" A)"
  assert_eq "${label} reload: applied answer retained" '192.0.2.30' "${out}"
  status="$(state_status "${DURABLE_PROJECT}")"
  assert_has_line "${label} reload: applied revision retained" 'revision 21' "${status}"
}

durable_lifecycle() {
  local out status
  durable_bootstrap

  status="$(state_status "${DURABLE_PROJECT}")"
  assert_has_line "durable bootstrap persisted revision" 'revision 20' "${status}"
  assert_has_line "durable bootstrap persisted published_at" \
    "published_at ${PUB_A_PREFIX}" "${status}"
  out="$(vquery_project "${DURABLE_PROJECT}" +short "${DURABLE_PROBE}" A)"
  assert_eq "durable bootstrap authored answer" '192.0.2.10' "${out}"
  out="$(vquery_project "${DURABLE_PROJECT}" +short blocked.lab.vantyr.test A)"
  assert_eq "durable bootstrap policy denial" "${SINKHOLE_IP}" "${out}"

  # Higher revision + different author answer, applied by one SIGHUP.
  make_durable_config "${DURABLE_CONFIG_DIR}/active.json" \
    "${DURABLE_HOUSEHOLD}" 21 "${PUB_A}" 86400 "${VANTYR_IP}" "${VANTYR_PORT}" 192.0.2.30
  sighup_and_wait "${DURABLE_PROJECT}"
  out="$(vquery_project "${DURABLE_PROJECT}" +short "${DURABLE_PROBE}" A)"
  assert_eq "SIGHUP higher revision changed answer" '192.0.2.30' "${out}"
  status="$(state_status "${DURABLE_PROJECT}")"
  assert_has_line "SIGHUP persisted higher revision" 'revision 21' "${status}"

  # Rejected candidates: malformed JSON, stale/equal revision, a foreign
  # household and a changed bind. Every one keeps the old version.
  cp "${LAB_DIR}/configs/vantyr.durable.malformed.json" "${DURABLE_CONFIG_DIR}/active.json"
  reject_reload "malformed config"
  make_durable_config "${DURABLE_CONFIG_DIR}/active.json" \
    "${DURABLE_HOUSEHOLD}" 20 "${PUB_A}" 86400 "${VANTYR_IP}" "${VANTYR_PORT}" 192.0.2.50
  reject_reload "stale revision"
  make_durable_config "${DURABLE_CONFIG_DIR}/active.json" \
    "${DURABLE_FOREIGN_HOUSEHOLD}" 22 "${PUB_A}" 86400 "${VANTYR_IP}" "${VANTYR_PORT}" 192.0.2.50
  reject_reload "foreign household"
  make_durable_config "${DURABLE_CONFIG_DIR}/active.json" \
    "${DURABLE_HOUSEHOLD}" 22 "${PUB_A}" 86400 "${VANTYR_IP}" 15354 192.0.2.50
  reject_reload "bind change"

  # Abrupt kill (no orderly shutdown) while the external config advances
  # independently. Recovery must come from the persisted bundle, not a fresh
  # bootstrap off the changed config.
  docker kill "$(durable_compose ps -q vantyr-durable)" >/dev/null
  make_durable_config "${DURABLE_CONFIG_DIR}/active.json" \
    "${DURABLE_HOUSEHOLD}" 99 "${PUB_B}" 86400 "${VANTYR_IP}" "${VANTYR_PORT}" 192.0.2.40
  durable_compose up -d >/dev/null
  wait_vantyr_ready_project "${DURABLE_PROJECT}"
  out="$(vquery_project "${DURABLE_PROJECT}" +short "${DURABLE_PROBE}" A)"
  assert_eq "abrupt restart recovers persisted answer (not changed config)" \
    '192.0.2.30' "${out}"
  status="$(state_status "${DURABLE_PROJECT}")"
  assert_has_line "abrupt restart keeps persisted revision" 'revision 21' "${status}"
  assert_has_line "abrupt restart keeps original published_at" \
    "published_at ${PUB_A_PREFIX}" "${status}"
  log "PASS: real recovery from persisted bundle after abrupt kill + changed external config"
}

stale_phase() {
  local out status now_prefix now_stamp
  preflight_project "${STALE_PROJECT}"
  init_state_volume "${STALE_PROJECT}"
  # Fixture clock only: a small stale_after plus a fresh published_at, never a
  # host clock/DNS change. The policy ages in a bounded <30s window.
  now_prefix="$(date -u +%Y-%m-%dT%H:%M:%S)"
  now_stamp="${now_prefix}Z"
  make_durable_config "${DURABLE_CONFIG_DIR}/active.json" \
    "${DURABLE_HOUSEHOLD}" 30 "${now_stamp}" 12 "${VANTYR_IP}" "${VANTYR_PORT}" 192.0.2.10
  stale_compose up -d --build
  wait_vantyr_ready_project "${STALE_PROJECT}"
  out="$(vquery_project "${STALE_PROJECT}" +short "${DURABLE_PROBE}" A)"
  assert_eq "stale fixture fresh answer" '192.0.2.10' "${out}"

  log "waiting 16s (bounded <30s) for a 12s stale_after policy to age"
  sleep 16
  out="$(vquery_project "${STALE_PROJECT}" +short "${DURABLE_PROBE}" A 2>/dev/null)" || true
  assert_eq "stale policy fails closed to sinkhole" "${SINKHOLE_IP}" "${out}"

  # The persisted publication time must not be refreshed by a restart, so the
  # deny survives an abrupt kill and restart even with the same external file.
  docker kill "$(stale_compose ps -q vantyr-durable)" >/dev/null
  stale_compose up -d >/dev/null
  wait_sinkhole_project "${STALE_PROJECT}" "${DURABLE_PROBE}"
  status="$(state_status "${STALE_PROJECT}")"
  assert_has_line "stale restart kept persisted revision" 'revision 30' "${status}"
  assert_has_line "stale restart kept original published_at" \
    "published_at ${now_prefix}" "${status}"

  # A genuinely newer revision carrying a fresh publication time recovers.
  now_prefix="$(date -u +%Y-%m-%dT%H:%M:%S)"
  now_stamp="${now_prefix}Z"
  make_durable_config "${DURABLE_CONFIG_DIR}/active.json" \
    "${DURABLE_HOUSEHOLD}" 31 "${now_stamp}" 86400 "${VANTYR_IP}" "${VANTYR_PORT}" 192.0.2.10
  sighup_and_wait "${STALE_PROJECT}"
  wait_vantyr_ready_project "${STALE_PROJECT}"
  out="$(vquery_project "${STALE_PROJECT}" +short "${DURABLE_PROBE}" A)"
  assert_eq "fresh reload clears stale fail-closed" '192.0.2.10' "${out}"
  log "PASS: stale deny persisted across restart; a fresh revision recovered the allow"
}

durable_down() {
  durable_compose down -v --timeout 5 || return 1
  verify_cleanup_project "${DURABLE_PROJECT}"
}

stale_down() {
  stale_compose down -v --timeout 5 || return 1
  verify_cleanup_project "${STALE_PROJECT}"
}

durable_smoke() {
  on_durable_exit() {
    local rc=$?
    if (( rc != 0 )); then
      log "durable smoke FAILED (rc=${rc}); cleaning up scoped disposable projects"
    else
      log "cleaning up scoped disposable durable projects after successful smoke"
    fi
    durable_compose down -v --timeout 5 >/dev/null 2>&1 || true
    stale_compose down -v --timeout 5 >/dev/null 2>&1 || true
    verify_cleanup_project "${DURABLE_PROJECT}" || rc=1
    verify_cleanup_project "${STALE_PROJECT}" || rc=1
    rm -rf "${DURABLE_WORK_DIR}"
    (( rc == 0 )) && log "state volumes of both disposable projects removed; no resources left"
    exit "${rc}"
  }
  trap on_durable_exit EXIT

  # Corrupt state is rejected on a one-off, network-less container (no answer
  # and no listener). Recovery is then shown by a fresh project/volume below;
  # no household data is ever mounted.
  corrupt_state_check
  durable_lifecycle
  durable_down
  stale_phase
  stale_down
  log "DURABLE SMOKE PASS — SIGHUP, rejection, real recovery and stale-age assertions passed"
}

main() {
  case "${1:-}" in
    up) up ;;
    check) check ;;
    outage) outage ;;
    smoke) smoke ;;
    fullstack-smoke) fullstack_smoke ;;
    fullstack-up)
      preflight
      fullstack_up
      ;;
    fullstack-check) vcheck;;
    fullstack-down) fullstack_down ;;
    durable-smoke) durable_smoke ;;
    durable-up) durable_bootstrap ;;
    durable-down) durable_down ;;
    stale-down) stale_down ;;
    down) down ;;
    ps) compose ps ;;
    pause-upstream)
      compose pause upstream
      log "upstream paused: queries now exceed their bounded deadline (delay fault)"
      ;;
    unpause-upstream)
      compose unpause upstream
      wait_ready
      ;;
    *)
      printf 'usage: %s {up|check|outage|smoke|fullstack-smoke|fullstack-up|fullstack-check|fullstack-down|durable-smoke|durable-up|durable-down|stale-down|down|ps|pause-upstream|unpause-upstream}\n' "$0" >&2
      exit 2
      ;;
  esac
}

main "$@"
