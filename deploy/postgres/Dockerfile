# Postgres 16 with pgBackRest, which archives every WAL segment to Spaces for
# point-in-time recovery. Configured entirely by PGBACKREST_* variables (compose.yaml).
FROM postgres:16-bookworm

RUN apt-get update \
    && apt-get install --yes --no-install-recommends pgbackrest \
    && rm -rf /var/lib/apt/lists/*
