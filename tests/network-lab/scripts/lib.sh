#!/usr/bin/env bash
# Shared helpers for tests/network-lab. Sourced by lab.sh; not run directly.
set -euo pipefail

LAB_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
PROJECT="${VANTYR_NETLAB_PROJECT:-vantyr-network-lab}"
UPSTREAM_IP="172.26.9.53"
UPSTREAM_PORT="15353"
# Stub targets are fixed with the Compose fixture; future worker targets use
# the separate VANTYR_DNS_* integration contract.
ZONE="lab.vantyr.test"
LAB_PREFIX="[vantyr-netlab]"

compose() {
  docker compose -f "${LAB_DIR}/compose.yml" -p "${PROJECT}" "$@"
}

log() { printf '%s %s\n' "${LAB_PREFIX}" "$*" >&2; }
die() { log "ERROR: $*"; exit 1; }

case "${PROJECT}" in
  vantyr-network-lab|vantyr-network-lab-*) ;;
  *) die "refusing unexpected project: ${PROJECT}" ;;
esac

# Readiness via a real DNS answer from a maintained client tool, not a port ping.
wait_ready() {
  local attempts="${1:-30}" i
  for (( i = 1; i <= attempts; i++ )); do
    if compose exec -T client dig "@${UPSTREAM_IP}" -p "${UPSTREAM_PORT}" \
      +time=1 +tries=1 +short "www.${ZONE}" A 2>/dev/null | grep -qx '203.0.113.10'; then
      log "upstream ready (attempt ${i})"
      return 0
    fi
    sleep 1
  done
  die "stub upstream did not become ready within ${attempts}s"
}

assert_eq() {
  local label="$1" expected="$2" actual="$3"
  if [[ "${actual}" != "${expected}" ]]; then
    log "FAIL: ${label}: expected '${expected}', got '${actual}'"
    return 1
  fi
  log "PASS: ${label}"
}

assert_has_line() {
  local label="$1" needle="$2" output="$3"
  if ! grep -Fq -- "${needle}" <<<"${output}"; then
    log "FAIL: ${label}: missing '${needle}' in: ${output}"
    return 1
  fi
  log "PASS: ${label}"
}

assert_awk_line() {
  local label="$1" program="$2" output="$3"
  if ! awk "${program}" <<<"${output}"; then
    log "FAIL: ${label}: unexpected dig output: ${output}"
    return 1
  fi
  log "PASS: ${label}"
}
