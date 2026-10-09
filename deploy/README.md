# Deploying voiceAi

One Droplet (DigitalOcean BLR1, 4 vCPU / 8 GB) runs everything in `compose.yaml`: Postgres, the api, the background jobs, two workers and Caddy. Run every command below from `deploy/` on the Droplet.

## First time

1. **Droplet:** Ubuntu LTS with Docker Engine and the compose plugin. Cloud Firewall inbound: 443 (TCP and UDP), 80, 22 (key-only SSH). Only Caddy publishes ports; the workers need no inbound ones.
2. **Spaces (BLR1):** two buckets.
   - Recordings: add a lifecycle rule that expires objects some days after the longest org retention (default 30 days). It is the backstop to the retention job.
   - Backups: no lifecycle rule; pgBackRest expires its own files.
3. **DNS:** an A record for `API_DOMAIN` pointing at the Droplet.
4. **Code and settings:** clone the repository to `/opt/automitra`, then `cp .env.example .env`, fill it, `chmod 600 .env`. Copy `BACKUP_ENCRYPTION_PASSPHRASE` to the password manager: without it no backup restores.
5. **Deploy:** `./deploy.sh` (below). It creates the backup stanza on the first run.
6. **First backup:** `./backup.sh full`.
7. **Cron** (`crontab -e`; the Droplet's clock is UTC, 20:30 UTC = 02:00 IST):
   ```
   30 20 * * 6   /opt/automitra/deploy/backup.sh full
   30 20 * * 0-5 /opt/automitra/deploy/backup.sh diff
   ```
8. **Telephony:** `docker compose run --rm --no-deps worker-a telephony setup` creates the LiveKit trunks and dispatch rule, and prints the Plivo steps.
9. **Accounts and keys:** `docker compose exec api bun src/cli.ts help`.

## Deploy

```
git pull
./deploy.sh
```

It builds the images, migrates the database, restarts the api and background jobs, then restarts the workers one at a time. A worker stop waits for its live calls (up to `WORKER_STOP_GRACE_SECONDS`), so a deploy during calls can take that long. The other worker keeps answering meanwhile.

- The api is down for a few seconds while it restarts. A call that ends in that window loses its finalize (the worker does not retry it yet), and the `lost-worker` sweep marks it failed and unbilled.
- Migrations run while the old api still serves, so a migration must keep the old code working: add first, remove in a later deploy.
- Postgres restarts only when its image changes. The base image is not pulled on deploy; to take a Postgres 16 minor update, run `docker compose build --pull postgres` and deploy outside calling hours.

## Backups

Postgres archives every WAL segment to the backups bucket within 60 s (`archive_timeout`). `backup.sh` takes the base backups: full every week, differential every other day. pgBackRest keeps two full backups and the WAL since the older one, so any moment in roughly the last two weeks can be restored.

Check the state: `docker compose exec --user postgres postgres pgbackrest info`.

## Restore

Restoring replaces the database. Every write since the target time is lost.

1. Stop everything that writes: `docker compose stop worker-a worker-b api background`, then `docker compose stop postgres`.
2. Restore into the existing volume:
   - Latest state: `docker compose run --rm --no-deps --user postgres postgres pgbackrest --delta restore`
   - A moment in time (IST): add `--type=time "--target=2026-10-09 14:30:00+05:30" --target-action=promote`
   - On a new Droplet with an empty volume, leave out `--delta`.
3. `docker compose up --detach --wait postgres`. Postgres replays the archived WAL, then opens. Check `docker compose logs postgres` for `database system is ready to accept connections`.
4. `./deploy.sh` brings the rest back.
5. `./backup.sh full`: the restore started a new timeline, so take a fresh base backup.

Test a restore whenever this procedure changes, and at least once a quarter, on a separate Droplet: steps 2 to 4 with an empty volume, then `docker compose exec api bun src/cli.ts account list`.
