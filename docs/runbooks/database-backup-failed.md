# database-backup-failed

**Means:** `deploy/backup.sh` could not take a base backup. WAL archiving may still be working, but restores need a recent base backup, and pgBackRest expires old ones only after a new full succeeds.

**Check:** on the Droplet, from `deploy/`:
- `docker compose exec --user postgres postgres pgbackrest info`: the newest backup and the WAL range.
- `docker compose exec --user postgres postgres pgbackrest check`: confirms WAL archiving reaches Spaces.
- `docker compose logs postgres | grep -i archive`: Postgres logs every failed `archive-push`.

**Fix:** the usual causes are a revoked or mistyped `BACKUP_S3_*` key, a missing bucket, or a full disk (`df -h`; WAL piles up in the Postgres volume while archiving fails). Fix the cause, then run `./backup.sh full` and confirm it in `pgbackrest info`.
