FROM node:22.23.5-bookworm-slim@sha256:e9f565d32859f0cbfb52125eafe8be39390f24dac302dc3cdf566e8ba3ab21ee AS build

ARG FOUNDRY_VERSION=1.5.1
ARG FOUNDRY_SHA256=73640b01bd9ed29fdb4965085099371f8cf0dbbec3e2086cf54564efc4dcfe88
ARG NEXT_PUBLIC_API_URL=http://localhost:3001/v1

ENV NEXT_TELEMETRY_DISABLED=1 \
    NEXT_PUBLIC_API_URL=${NEXT_PUBLIC_API_URL}

RUN apt-get update \
    && apt-get install --yes --no-install-recommends ca-certificates curl \
    && curl --fail --silent --show-error --location \
      "https://github.com/foundry-rs/foundry/releases/download/v${FOUNDRY_VERSION}/foundry_v${FOUNDRY_VERSION}_linux_amd64.tar.gz" \
      --output /tmp/foundry.tar.gz \
    && echo "${FOUNDRY_SHA256}  /tmp/foundry.tar.gz" | sha256sum --check --strict \
    && tar --extract --gzip --file /tmp/foundry.tar.gz --directory /usr/local/bin \
    && rm --force /tmp/foundry.tar.gz \
    && apt-get purge --yes --auto-remove curl \
    && rm --recursive --force /var/lib/apt/lists/*

WORKDIR /workspace
COPY package.json package-lock.json ./
COPY apps/api/package.json ./apps/api/package.json
COPY apps/web/package.json ./apps/web/package.json
COPY apps/worker/package.json ./apps/worker/package.json
COPY packages/agent/package.json ./packages/agent/package.json
COPY packages/database/package.json ./packages/database/package.json
COPY packages/domain/package.json ./packages/domain/package.json
COPY packages/intents/package.json ./packages/intents/package.json
COPY packages/optimizer/package.json ./packages/optimizer/package.json
COPY packages/protocols/package.json ./packages/protocols/package.json
COPY packages/sdk/package.json ./packages/sdk/package.json

RUN npm ci

COPY . .

RUN forge build --root contracts/evm \
    && npm run build \
    && npm prune --omit=dev \
    && npm cache clean --force

FROM node:22.23.5-bookworm-slim@sha256:e9f565d32859f0cbfb52125eafe8be39390f24dac302dc3cdf566e8ba3ab21ee AS runtime

ARG NEXT_PUBLIC_API_URL=http://localhost:3001/v1

ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    NEXT_PUBLIC_API_URL=${NEXT_PUBLIC_API_URL}

WORKDIR /workspace
COPY --from=build --chown=node:node /workspace/package.json ./package.json
COPY --from=build --chown=node:node /workspace/node_modules ./node_modules
COPY --from=build --chown=node:node /workspace/apps ./apps
COPY --from=build --chown=node:node /workspace/packages ./packages
COPY --from=build --chown=node:node /workspace/contracts/evm/out ./contracts/evm/out
COPY --from=build --chown=node:node /workspace/scripts/health-local-chains.mjs ./scripts/health-local-chains.mjs
COPY --from=build /usr/local/bin/anvil /usr/local/bin/anvil

RUN rm --recursive --force \
      /usr/local/lib/node_modules/npm \
      /usr/local/lib/node_modules/corepack \
      /opt/yarn-v1.22.22 \
    && rm --force \
      /usr/local/bin/npm \
      /usr/local/bin/npx \
      /usr/local/bin/corepack \
      /usr/local/bin/yarn \
      /usr/local/bin/yarnpkg \
    && test -x /usr/local/bin/anvil

USER node
