#!/usr/bin/env bash
# Shared helpers for tests/network-lab. Sourced by lab.sh; not run directly.
set -euo pipefail

LAB_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
PROJECT="${VANTYR_NETLAB_PROJECT:-vantyr-network-lab}"
# Two additional disposable projects are used by the opt-in durable lab. They
# are separate from the base/full-stack project so a state volume can never be
# confused with household data, and both match the guarded project prefix.
DURABLE_PROJECT="${VANTYR_NETLAB_DURABLE_PROJECT:-vantyr-network-lab-durable}"
STALE_PROJECT="${VANTYR_NETLAB_STALE_PROJECT:-vantyr-network-lab-durable-stale}"
UPSTREAM_IP="172.26.9.53"
UPSTREAM_PORT="15353"
VANTYR_IP="172.26.9.55"
VANTYR_PORT="15353"
LAB_SUBNET="172.26.9.0/24"
# Stub targets are fixed with the Compose fixture; worker targets use the
# validated Vantyr DNS configuration in configs/.
ZONE="lab.vantyr.test"
LAB_PREFIX="[vantyr-netlab]"
DURABLE_WORKER="netlab-durable-worker"
# The values below are consumed by lab.sh (the only caller of this library).
# shellcheck disable=SC2034
DURABLE_PROBE="probe.local.vantyr.test."
# shellcheck disable=SC2034
DURABLE_HOUSEHOLD="11111111-2222-3333-4444-555555555555"
# shellcheck disable=SC2034
DURABLE_FOREIGN_HOUSEHOLD="22222222-3333-4444-5555-666666666666"
# shellcheck disable=SC2034
DURABLE_CONFIG_DIR="${LAB_DIR}/work/durable/config"
# shellcheck disable=SC2034
DURABLE_WORK_DIR="${LAB_DIR}/work"
# Pinned base only (no shell needed in the worker image): used to chown the
# disposable state volume root to the nonroot runtime uid before start.
PINNED_ALPINE="docker.io/library/alpine@sha256:49340b346798875b5592e5d420241f2f9cfba5f47e62ebb1446a1b34734e898f"

compose() {
  docker compose -f "${LAB_DIR}/compose.yml" -p "${PROJECT}" "$@"
}

# The opt-in override adds the real Vantyr DNS worker and a second client.
# Base `compose()` above is intentionally left unchanged.
vantyr_compose() {
  docker compose -f "${LAB_DIR}/compose.yml" \
    -f "${LAB_DIR}/compose.vantyr.example.yml" -p "${PROJECT}" "$@"
}

# Opt-in durable override. It is parameterised by project so the lifecycle and
# stale-age phases get their own disposable state volume.
compose_project() {
  local proj="$1"
  shift
  docker compose -f "${LAB_DIR}/compose.yml" \
    -f "${LAB_DIR}/compose.vantyr-durable.yml" -p "${proj}" "$@"
}
durable_compose() { compose_project "${DURABLE_PROJECT}" "$@"; }
stale_compose() { compose_project "${STALE_PROJECT}" "$@"; }

log() { printf '%s %s\n' "${LAB_PREFIX}" "$*" >&2; }
die() { log "ERROR: $*"; exit 1; }

check_project_name() {
  case "$1" in
    vantyr-network-lab|vantyr-network-lab-*) ;;
    *) die "refusing unexpected project: $1" ;;
  esac
}
check_project_name "${PROJECT}"
check_project_name "${DURABLE_PROJECT}"
check_project_name "${STALE_PROJECT}"

# Preflight before ANY create. Never clean up anything here: if a project or
# the lab subnet is already in use we refuse and leave it untouched, so a
# guarded project name can never be used to remove another person's stack.
preflight_project() {
  local proj="$1"
  check_project_name "${proj}"
  local existing nets vols net subs
  existing="$(docker ps -aq --filter "label=com.docker.compose.project=${proj}" || true)"
  [[ -z "${existing}" ]] || die "project ${proj} already has containers; refusing to create or remove them"
  nets="$(docker network ls -q --filter "label=com.docker.compose.project=${proj}" || true)"
  [[ -z "${nets}" ]] || die "project ${proj} already has networks; refusing to create or remove them"
  vols="$(docker volume ls -q --filter "label=com.docker.compose.project=${proj}" || true)"
  [[ -z "${vols}" ]] || die "project ${proj} already has volumes; refusing to create or remove them"

  while IFS= read -r net; do
    [[ -n "${net}" ]] || continue
    subs="$(docker network inspect -f '{{range .IPAM.Config}}{{.Subnet}} {{end}}' "${net}" 2>/dev/null || true)"
    if [[ "${subs}" == *"${LAB_SUBNET}"* ]]; then
      die "subnet ${LAB_SUBNET} is already in use (network ${net}); refusing to create or clean up"
    fi
  done < <(docker network ls --format '{{.Name}}')
  log "preflight ok: no containers/networks/volumes for ${proj} and no ${LAB_SUBNET} collision"
}

preflight() { preflight_project "${PROJECT}"; }

# Scoped post-run verification. Checks containers, networks AND volumes created
# by this project only. It never prunes anything globally and never removes a
# resource belonging to another project.
verify_cleanup_project() {
  local proj="$1"
  check_project_name "${proj}"
  local leftovers nets vols
  leftovers="$(docker ps -aq --filter "label=com.docker.compose.project=${proj}" || true)"
  [[ -z "${leftovers}" ]] || die "leftover containers for ${proj}: ${leftovers}"
  nets="$(docker network ls -q --filter "label=com.docker.compose.project=${proj}" || true)"
  [[ -z "${nets}" ]] || die "leftover networks for ${proj}: ${nets}"
  vols="$(docker volume ls -q --filter "label=com.docker.compose.project=${proj}" || true)"
  [[ -z "${vols}" ]] || die "leftover volumes for ${proj}: ${vols}"
  log "scoped cleanup verified: no containers, networks or volumes for ${proj}"
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

# ---------------------------------------------------------------------------
# Durable-lab helpers (opt-in). All state is on a disposable, project-scoped
# volume; no household data, host CA/network or controller canary is involved.
# ---------------------------------------------------------------------------

state_volume_name() { printf '%s_state' "$1"; }

# Create the project's named state volume and hand its root to the nonroot
# runtime uid (65532) so the distroless worker can write its one bundle. The
# volume is labelled exactly as Compose would label it, so `down -v` removes
# this run's volume and nothing else.
init_state_volume() {
  local proj="$1" vol
  vol="$(state_volume_name "${proj}")"
  docker volume create \
    --label "com.docker.compose.project=${proj}" \
    --label "com.docker.compose.volume=state" \
    "${vol}" >/dev/null
  docker run --rm --user 0:0 --entrypoint chown \
    -v "${vol}:/state" "${PINNED_ALPINE}" 65532:65532 /state >/dev/null
  log "state volume ${vol} created for ${proj} and owned by nonroot 65532"
}

# Fill the validated config template. Only fixture values change; no CLI flag
# is invented and every generated file is the real `Config::parse` schema.
make_durable_config() {
  local dest="$1" household="$2" revision="$3" published="$4" stale="$5" \
    bind_addr="$6" bind_port="$7" probe_addr="$8"
  sed -e "s|__HOUSEHOLD__|${household}|g" \
      -e "s|__REVISION__|${revision}|g" \
      -e "s|__PUBLISHED__|${published}|g" \
      -e "s|__STALE__|${stale}|g" \
      -e "s|__BIND_ADDR__|${bind_addr}|g" \
      -e "s|__BIND_PORT__|${bind_port}|g" \
      -e "s|__PROBE_ADDR__|${probe_addr}|g" \
      "${LAB_DIR}/configs/vantyr.durable.template.json" >"${dest}"
}

# One-off read of local bundle metadata. No listener, no host resolver, and
# the state volume is mounted read-only. Never claims controller origin.
state_status() {
  local proj="$1" vol
  vol="$(state_volume_name "${proj}")"
  docker run --rm --network none --read-only --cap-drop ALL \
    --security-opt no-new-privileges:true --pids-limit 64 --memory 128m \
    -v "${vol}:/state:ro" "${VANTYR_IMAGE}" \
    --state-status --state /state/vantyr-dns.json --worker "${DURABLE_WORKER}"
}

# Query the durable worker from the mapped lab client on a given project.
vquery_project() {
  local proj="$1"
  shift
  compose_project "${proj}" exec -T client dig "@${VANTYR_IP}" -p "${VANTYR_PORT}" "$@"
}

wait_vantyr_ready_project() {
  local proj="$1" attempts="${2:-20}" i
  for (( i = 1; i <= attempts; i++ )); do
    if compose_project "${proj}" exec -T client dig "@${VANTYR_IP}" -p "${VANTYR_PORT}" \
      +time=1 +tries=1 +short "www.${ZONE}" A 2>/dev/null | grep -qx '203.0.113.10'; then
      log "Vantyr DNS ready in ${proj} (attempt ${i})"
      return 0
    fi
    sleep 1
  done
  die "Vantyr DNS in ${proj} did not become ready within ${attempts}s"
}

# After the policy goes stale the allowed name is sinkholed, so readiness must
# poll for the sinkhole answer instead of the fresh allow.
wait_sinkhole_project() {
  local proj="$1" name="$2" attempts="${3:-20}" i out
  for (( i = 1; i <= attempts; i++ )); do
    out="$(vquery_project "${proj}" +time=1 +tries=1 +short "${name}" A 2>/dev/null)" || true
    if [[ "${out}" == *"${SINKHOLE_IP}"* ]]; then
      log "stale fail-closed answer from ${proj} (attempt ${i})"
      return 0
    fi
    sleep 1
  done
  die "no fail-closed sinkhole answer from ${proj} within ${attempts}s (last: ${out})"
}

# Send SIGHUP to PID 1 via the Docker API (distroless has no shell) and wait
# until the worker has logged a reload outcome. Both the applied and rejected
# paths log a line containing 'reload', so the count increases either way.
sighup_and_wait() {
  local proj="$1" i before after cid
  cid="$(compose_project "${proj}" ps -q vantyr-durable)"
  [[ -n "${cid}" ]] || die "no vantyr-durable container in ${proj}"
  before="$(compose_project "${proj}" logs vantyr-durable 2>&1 | grep -Fc 'reload ' || true)"
  docker kill -s HUP "${cid}" >/dev/null
  for (( i = 1; i <= 20; i++ )); do
    after="$(compose_project "${proj}" logs vantyr-durable 2>&1 | grep -Fc 'reload ' || true)"
    (( after > before )) && { log "SIGHUP processed by ${proj} (attempt ${i})"; return 0; }
    sleep 0.5
  done
  die "SIGHUP produced no reload outcome in ${proj} within bounded wait"
}
