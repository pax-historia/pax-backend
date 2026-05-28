# syntax=docker/dockerfile:1.7

FROM rust:1-bookworm AS router-builder

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

COPY orchestration/placement-router ./orchestration/placement-router
WORKDIR /src/orchestration/placement-router
RUN --mount=type=cache,target=/usr/local/cargo/git \
  --mount=type=cache,target=/usr/local/cargo/registry \
  --mount=type=cache,target=/src/orchestration/placement-router/target \
  cargo build --release --locked --bin pax-backend-placement-router \
  && mkdir -p /out \
  && cp target/release/pax-backend-placement-router /out/pax-backend-placement-router \
  && (strip /out/pax-backend-placement-router || true)

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
  && pnpm --filter @pax-backend/node-telemetry build \
  && pnpm --filter @pax-backend/url-services build \
  && pnpm --filter @pax-backend/control-plane build \
  && pnpm --filter @pax-backend/api-gateway build

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

COPY --from=router-builder /out/pax-backend-placement-router /usr/local/bin/pax-backend-placement-router
COPY --chown=node:node --from=app-builder /app /app
COPY --chown=node:node --chmod=0755 orchestration/control-image/entrypoint.sh /app/orchestration/control-image/entrypoint.sh

EXPOSE 9070 9080 9081
USER node
ENTRYPOINT ["tini", "--", "/app/orchestration/control-image/entrypoint.sh"]
