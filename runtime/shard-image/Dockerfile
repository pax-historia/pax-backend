# syntax=docker/dockerfile:1.7

FROM node:22-bookworm-slim AS app-builder

ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
ENV PNPM_HOME=/pnpm
ENV PATH="${PNPM_HOME}:${PATH}"

WORKDIR /app
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    ca-certificates \
    g++ \
    git \
    make \
    python3 \
  && rm -rf /var/lib/apt/lists/* \
  && corepack enable \
  && corepack prepare pnpm@10.29.3 --activate \
  && pnpm config set store-dir /pnpm/store

COPY . .
RUN --mount=type=cache,target=/pnpm/store \
  pnpm install --frozen-lockfile
RUN --mount=type=cache,target=/pnpm/store \
  pnpm --filter @pax-backend/ipc-protocol build \
  && pnpm --filter @pax-backend/runtime-sdk build \
  && pnpm --filter @pax-backend/state-store build \
  && pnpm --filter @pax-backend/runner build \
  && pnpm --filter @pax-backend/broker build \
  && pnpm build:bundles

FROM timberio/vector:0.55.0-debian AS vector

FROM node:22-bookworm-slim AS runtime

ENV NODE_ENV=production
WORKDIR /app

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    bash \
    ca-certificates \
    curl \
    libssl3 \
    tini \
  && rm -rf /var/lib/apt/lists/* \
  && mkdir -p /data \
  && chown node:node /data

COPY --from=vector /usr/bin/vector /usr/local/bin/vector
COPY --chown=node:node --from=app-builder /app/package.json ./package.json
COPY --chown=node:node --from=app-builder /app/pnpm-lock.yaml ./pnpm-lock.yaml
COPY --chown=node:node --from=app-builder /app/pnpm-workspace.yaml ./pnpm-workspace.yaml
COPY --chown=node:node --from=app-builder /app/tsconfig.json ./tsconfig.json
COPY --chown=node:node --from=app-builder /app/tsconfig.base.json ./tsconfig.base.json
COPY --chown=node:node --from=app-builder /app/node_modules ./node_modules
COPY --chown=node:node --from=app-builder /app/runtime ./runtime
COPY --chown=node:node --from=app-builder /app/shared ./shared
COPY --chown=node:node --from=app-builder /app/sdk/runtime-sdk ./sdk/runtime-sdk
COPY --chown=node:node --from=app-builder /app/examples/bundles ./examples/bundles
COPY --chown=node:node --from=app-builder /app/scripts/observability ./scripts/observability
RUN chmod 0755 /app/scripts/observability/start-vector.sh /app/scripts/observability/prune-local-buffer.sh

EXPOSE 4317 4318 7700 8686
USER node
ENTRYPOINT ["tini", "--", "/app/runtime/shard-image/entrypoint.sh"]
