#!/usr/bin/env bash
# A base backup of Postgres to Spaces. WAL between backups is archived continuously, so
# any moment since the oldest kept full backup can be restored. Run from cron (README).
# A diff with no full backup yet becomes a full one.
set -uo pipefail
cd "$(dirname "$0")"

backup_type=${1:-}
if [[ $backup_type != full && $backup_type != diff ]]; then
  echo "usage: backup.sh full|diff" >&2
  exit 2
fi

if ! docker compose exec -T --user postgres postgres pgbackrest --type="$backup_type" backup; then
  alert="ALERT database-backup-failed: pgbackrest $backup_type backup failed"
  echo "$alert" >&2
  logger --tag automitra "$alert"
  exit 1
fi
