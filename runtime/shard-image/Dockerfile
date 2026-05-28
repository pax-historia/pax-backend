# syntax=docker/dockerfile:1.7

FROM rust:1-bookworm AS engine-builder

WORKDIR /src
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    binutils \
    ca-certificates \
    clang \
    cmake \
    lld \
    libssl-dev \
    make \
    pkg-config \
    protobuf-compiler \
  && rm -rf /var/lib/apt/lists/*

COPY vendor/rivet ./vendor/rivet
WORKDIR /src/vendor/rivet
RUN --mount=type=cache,target=/usr/local/cargo/git \
  --mount=type=cache,target=/usr/local/cargo/registry \
  --mount=type=cache,target=/src/vendor/rivet/target \
  cargo build -p rivet-engine --bin rivet-engine --profile=quick \
  && mkdir -p /out \
  && cp target/quick/rivet-engine /out/rivet-engine \
  && (strip /out/rivet-engine || true)

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
  pnpm build:vendor-ts \
  && pnpm --filter @pax-backend/ipc-protocol build \
  && pnpm --filter @pax-backend/runtime-sdk build \
  && pnpm --filter @pax-backend/child-runner-noivm build \
  && pnpm --filter @pax-backend/child-runner-ivm build \
  && pnpm --filter @pax-backend/parent-actor build \
  && pnpm build:bundles

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

COPY --from=engine-builder /out/rivet-engine /usr/local/bin/rivet-engine
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

EXPOSE 6420 6421 6430 7700
USER node
ENTRYPOINT ["tini", "--", "/app/runtime/shard-image/entrypoint.sh"]
