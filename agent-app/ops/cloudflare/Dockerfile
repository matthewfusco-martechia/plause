FROM caddy:2.11.7 AS caddy
FROM node:24-bookworm-slim AS build
WORKDIR /app
ENV CI=true NEXT_TELEMETRY_DISABLED=1 EVE_TELEMETRY_DISABLED=1 DO_NOT_TRACK=1
RUN npm install --global pnpm@11.24.0 --ignore-scripts
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY patches ./patches
RUN --mount=type=cache,id=plause-pnpm-store,target=/pnpm/store \
    pnpm install --store-dir=/pnpm/store --frozen-lockfile --ignore-scripts
# Source-only changes reuse dependency installation and its download cache.
COPY . .
# Fictional build values only. Real credentials arrive through Worker secrets.
RUN env DATABASE_URL=postgresql://test:test@127.0.0.1:1/build \
    KERNEL_API_KEY=fictional-build-key \
    BETTER_AUTH_SECRET=fictional-build-secret-0123456789abcdefghijk \
    BETTER_AUTH_URL=https://agent.plause.si \
    SECRET_ENCRYPTION_KEY=AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE= \
    INTERNAL_SERVICE_SECRET=fictional-internal-secret-0123456789abcdefghijk \
    PLAUSE_WORKFLOW_BACKEND=postgres MESSAGING_PROVIDER=disabled LIVE_MODEL_ENABLED=false \
    pnpm exec eve build --skip-sandbox-prewarm
RUN env DATABASE_URL=postgresql://test:test@127.0.0.1:1/build \
    KERNEL_API_KEY=fictional-build-key \
    BETTER_AUTH_SECRET=fictional-build-secret-0123456789abcdefghijk \
    BETTER_AUTH_URL=https://agent.plause.si \
    SECRET_ENCRYPTION_KEY=AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE= \
    INTERNAL_SERVICE_SECRET=fictional-internal-secret-0123456789abcdefghijk \
    PLAUSE_WORKFLOW_BACKEND=postgres MESSAGING_PROVIDER=disabled LIVE_MODEL_ENABLED=false \
    pnpm build -- --webpack
RUN rm -rf .next/cache

FROM node:24-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 EVE_TELEMETRY_DISABLED=1 DO_NOT_TRACK=1 \
    PLAUSE_WORKFLOW_BACKEND=postgres WORKFLOW_LOCAL_BASE_URL=http://127.0.0.1:4274
COPY --from=caddy /usr/bin/caddy /usr/bin/caddy
COPY --from=build --chown=node:node /app /app
USER node
EXPOSE 8080
# Sandbox prewarming is not accepted by this image. See launch-review.md before
# enabling file/browser-image scenarios; no deployment is authorized by this file.
CMD ["node", "ops/cloudflare/start.mjs"]
