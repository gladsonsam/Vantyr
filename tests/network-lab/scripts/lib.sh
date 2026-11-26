#!/usr/bin/env bash
# Shared helpers for tests/network-lab. Sourced by lab.sh; not run directly.
set -euo pipefail

LAB_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
PROJECT="${VANTYR_NETLAB_PROJECT:-vantyr-network-lab}"
UPSTREAM_IP="172.26.9.53"
UPSTREAM_PORT="15353"
VANTYR_IP="172.26.9.55"
VANTYR_PORT="15353"
LAB_SUBNET="172.26.9.0/24"
# Stub targets are fixed with the Compose fixture; worker targets use the
# validated Vantyr DNS configuration in configs/.
ZONE="lab.vantyr.test"
LAB_PREFIX="[vantyr-netlab]"

compose() {
  docker compose -f "${LAB_DIR}/compose.yml" -p "${PROJECT}" "$@"
}

# The opt-in override adds the real Vantyr DNS worker and a second client.
# Base `compose()` above is intentionally left unchanged.
vantyr_compose() {
  docker compose -f "${LAB_DIR}/compose.yml" \
    -f "${LAB_DIR}/compose.vantyr.example.yml" -p "${PROJECT}" "$@"
}

log() { printf '%s %s\n' "${LAB_PREFIX}" "$*" >&2; }
die() { log "ERROR: $*"; exit 1; }

case "${PROJECT}" in
  vantyr-network-lab|vantyr-network-lab-*) ;;
  *) die "refusing unexpected project: ${PROJECT}" ;;
esac

# Preflight before ANY create. Never clean up anything here: if a project or
# the lab subnet is already in use we refuse and leave it untouched, so a
# guarded project name can never be used to remove another person's stack.
preflight() {
  local existing nets net subs
  existing="$(docker ps -aq --filter "label=com.docker.compose.project=${PROJECT}" || true)"
  [[ -z "${existing}" ]] || die "project ${PROJECT} already has containers; refusing to create or remove them"
  nets="$(docker network ls -q --filter "label=com.docker.compose.project=${PROJECT}" || true)"
  [[ -z "${nets}" ]] || die "project ${PROJECT} already has networks; refusing to create or remove them"

  while IFS= read -r net; do
    [[ -n "${net}" ]] || continue
    subs="$(docker network inspect -f '{{range .IPAM.Config}}{{.Subnet}} {{end}}' "${net}" 2>/dev/null || true)"
    if [[ "${subs}" == *"${LAB_SUBNET}"* ]]; then
      die "subnet ${LAB_SUBNET} is already in use (network ${net}); refusing to create or clean up"
    fi
  done < <(docker network ls --format '{{.Name}}')
  log "preflight ok: no containers/networks for ${PROJECT} and no ${LAB_SUBNET} collision"
}

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

# Vantyr readiness is an allowed answer from the worker itself, bounded by
# 20 x 1s. It is queried from the mapped client source (172.26.9.54).
wait_vantyr_ready() {
  local attempts="${1:-20}" i
  for (( i = 1; i <= attempts; i++ )); do
    if compose exec -T client dig "@${VANTYR_IP}" -p "${VANTYR_PORT}" \
      +time=1 +tries=1 +short "www.${ZONE}" A 2>/dev/null | grep -qx '203.0.113.10'; then
      log "Vantyr DNS ready (attempt ${i})"
      return 0
    fi
    sleep 1
  done
  die "Vantyr DNS did not become ready within ${attempts}s"
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

assert_count() {
  local label="$1" expected="$2" output="$3" count
  count="$(grep -c . <<<"${output}")"
  assert_eq "${label} (answer lines)" "${expected}" "${count}"
}

assert_awk_line() {
  local label="$1" program="$2" output="$3"
  if ! awk "${program}" <<<"${output}"; then
    log "FAIL: ${label}: unexpected dig output: ${output}"
    return 1
  fi
  log "PASS: ${label}"
}
