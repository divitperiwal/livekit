#!/usr/bin/env bash
# Deploys the checked-out commit on the Droplet: deploy/deploy.sh
set -euo pipefail
cd "$(dirname "$0")"

# The recording upload (120 s) and analysis (45 s) run after a call ends, rounded up.
POST_CALL_SECONDS=180

env_value() {
  grep -E "^$1=" .env | tail -n 1 | cut -d= -f2- | tr -d '\r'
}

require_whole_number() {
  if [[ ! $2 =~ ^[0-9]+$ ]]; then
    echo "$1 must be a whole number of seconds in .env (got '$2')" >&2
    exit 1
  fi
}

# Docker kills a container still running at the end of its grace period; a worker
# killed mid-call drops the call and its billing.
check_worker_grace_period() {
  local max_call grace needed
  max_call=$(env_value TELEPHONY_MAX_CALL_SECONDS)
  grace=$(env_value WORKER_STOP_GRACE_SECONDS)
  require_whole_number TELEPHONY_MAX_CALL_SECONDS "$max_call"
  require_whole_number WORKER_STOP_GRACE_SECONDS "$grace"
  needed=$((max_call + POST_CALL_SECONDS))
  if ((grace < needed)); then
    echo "WORKER_STOP_GRACE_SECONDS=$grace is under TELEPHONY_MAX_CALL_SECONDS + $POST_CALL_SECONDS = $needed" >&2
    exit 1
  fi
}

check_worker_grace_period
# Build provenance carries a timestamp, so it would give every build a new image id and
# restart Postgres and the workers on every deploy, changed or not.
BUILDX_NO_DEFAULT_ATTESTATIONS=1 docker compose build

docker compose up --detach --wait postgres
# Idempotent: creates the backup stanza on the first deploy, checks it on later ones.
docker compose exec -T --user postgres postgres pgbackrest stanza-create

# The old api keeps serving while this runs, so a migration must not break it.
docker compose run --rm --no-deps api bun src/db/migrate.ts
docker compose up --detach --wait --no-deps api background caddy

# One at a time: the other worker answers calls while this one drains.
for worker in worker-a worker-b; do
  docker compose up --detach --wait --no-deps "$worker"
done

docker image prune --force
