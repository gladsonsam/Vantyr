#!/usr/bin/env bash
# Vantyr family network — bounded DNS lab driver.
# All assertions use ISC BIND dig inside the isolated client container.
# Awk programs are deliberately single-quoted: $2/$4/$5 are dig output fields.
# shellcheck disable=SC2016
set -euo pipefail
# shellcheck source=lib.sh
source "$(dirname -- "${BASH_SOURCE[0]}")/lib.sh"

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
  compose down --timeout 5
  local leftovers
  leftovers="$(docker ps -aq --filter "label=com.docker.compose.project=${PROJECT}" || true)"
  [[ -z "${leftovers}" ]] || die "leftover containers for ${PROJECT}: ${leftovers}"
  local nets
  nets="$(docker network ls -q --filter "label=com.docker.compose.project=${PROJECT}" || true)"
  [[ -z "${nets}" ]] || die "leftover networks for ${PROJECT}: ${nets}"
  log "scoped cleanup verified: no containers or networks for ${PROJECT}"
}

smoke() {
  on_exit() {
    local rc=$?
    if (( rc != 0 )); then
      log "smoke FAILED (rc=${rc}); cleaning up scoped project ${PROJECT}"
    else
      log "cleaning up scoped project ${PROJECT} after successful smoke"
    fi
    scoped_down
  }
  trap on_exit EXIT

  up
  check
  outage
  log "SMOKE PASS — every supported lab assertion succeeded"
}

main() {
  case "${1:-}" in
    up) up ;;
    check) check ;;
    outage) outage ;;
    smoke) smoke ;;
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
      printf 'usage: %s {up|check|outage|smoke|down|ps|pause-upstream|unpause-upstream}\n' "$0" >&2
      exit 2
      ;;
  esac
}

main "$@"
