# syntax=docker/dockerfile:1
ARG NODE_IMAGE=node:24-bookworm-slim

FROM ${NODE_IMAGE} AS build
WORKDIR /app

# better-sqlite3 can compile here if no prebuilt binary matches the platform.
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY . .
RUN npm run build \
    && npm prune --omit=dev --ignore-scripts --no-audit --no-fund

FROM ${NODE_IMAGE} AS runtime
WORKDIR /app
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3000 \
    DATABASE_PATH=/app/data/open-bot.sqlite

# flock serializes container instances independently of their PID namespaces.
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates util-linux \
    && rm -rf /var/lib/apt/lists/* \
    && mkdir -p /app/data \
    && chown node:node /app/data

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/rules ./rules
COPY --from=build /app/migrations ./migrations
COPY --from=build /app/package.json /app/package-lock.json ./
COPY --from=build /app/LICENSE /app/THIRD_PARTY_NOTICES.md ./
COPY --chmod=0555 docker/start.sh /usr/local/bin/open-bot-start
COPY --chmod=0444 docker/healthcheck.mjs ./docker/healthcheck.mjs

LABEL org.opencontainers.image.title="Open Bot" \
      org.opencontainers.image.description="Discord server management bot and web panel" \
      org.opencontainers.image.source="https://github.com/cryals/open-bot" \
      org.opencontainers.image.licenses="LicenseRef-Open-Bot-Project-1.0"

USER node:node
EXPOSE 3000
STOPSIGNAL SIGTERM
HEALTHCHECK --interval=30s --timeout=7s --start-period=60s --retries=3 \
    CMD ["node", "docker/healthcheck.mjs"]
CMD ["/usr/local/bin/open-bot-start"]
