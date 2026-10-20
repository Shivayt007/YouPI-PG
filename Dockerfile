# syntax=docker/dockerfile:1
# Native SQLite support requires a recent Node release; Node 24 also runs Berry.
FROM node:24-bookworm-slim AS dependencies
WORKDIR /app
# better-sqlite3 can fall back to compiling when a prebuilt binary is unavailable.
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 make g++ git ca-certificates \
    && rm -rf /var/lib/apt/lists/*
COPY . .
RUN npm ci --omit=dev --no-audit --no-fund

FROM node:24-bookworm-slim AS runtime
WORKDIR /app
RUN apt-get update \
    && apt-get install -y --no-install-recommends tini ca-certificates \
    && rm -rf /var/lib/apt/lists/*
COPY --from=dependencies --chown=node:node /app /app
RUN mkdir -p /app/data && chown node:node /app/data
ENV NODE_ENV=production \
    USE_SQLITE_FALLBACK=true \
    SQLITE_DB_PATH=/app/data/youpi_pg.sqlite
USER node
# Mount all of /app/data: database, WhatsApp credentials and observer state.
VOLUME ["/app/data"]
# Internal container ports, not published host ports.
EXPOSE 6100 7000 6001 6003
HEALTHCHECK --interval=30s --timeout=10s --start-period=60s --retries=3 \
    CMD ["node", "scripts/container-healthcheck.js"]
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "scripts/start.js"]
