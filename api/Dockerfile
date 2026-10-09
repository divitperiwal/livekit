# Built from the repository root: the api imports schema/agent-config.schema.json at runtime.
FROM oven/bun:1.3.13-slim

WORKDIR /app/api
COPY api/package.json api/bun.lock ./
RUN bun install --frozen-lockfile --production

COPY schema /app/schema
COPY api/tsconfig.json ./
COPY api/drizzle ./drizzle
COPY api/src ./src

USER bun
CMD ["bun", "src/server.ts"]
