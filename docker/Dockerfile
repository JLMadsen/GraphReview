# GraphReview — app + worker image.
#
# Both the `app` (Next.js web server) and `worker` (BullMQ worker) services
# in docker-compose.yml build from this same file, targeting the `app` or
# `worker` stage respectively (DESIGN.md §3, §12: "same image, different
# entrypoint"). Build context is the repo root (see docker-compose.yml).
#
# Two build args exist purely for closed-network use, where Docker Hub and
# Alpine's package CDN aren't reachable and an internal mirror stands in for
# them instead (docker-compose.yml passes both through from
# `NODE_BASE_IMAGE`/`ALPINE_MIRROR` in docker/.env — see .env.example).
# Neither changes anything when left unset: the defaults are the real-world
# services this app already depended on. npm's registry is deliberately
# *not* made configurable here — see docker/.env.example.

ARG NODE_BASE_IMAGE=node:20-alpine
FROM ${NODE_BASE_IMAGE} AS base
# simple-git shells out to the real `git` binary (DESIGN.md §5/§14: local
# clone + app-managed clone-by-URL both go through it).
ARG ALPINE_MIRROR
RUN if [ -n "$ALPINE_MIRROR" ]; then \
      sed -i "s|https://dl-cdn.alpinelinux.org/alpine|${ALPINE_MIRROR}|g" /etc/apk/repositories; \
    fi \
 && apk add --no-cache git
WORKDIR /app

FROM base AS deps
COPY package.json package-lock.json* ./
RUN npm ci

FROM deps AS builder
COPY . .
RUN npm run build

# ---- app service -----------------------------------------------------
FROM base AS app
ENV NODE_ENV=production
COPY --from=deps /app/node_modules ./node_modules
COPY --from=builder /app/.next ./.next
COPY --from=builder /app/public ./public
COPY --from=builder /app/package.json ./package.json
COPY --from=builder /app/next.config.ts ./next.config.ts
EXPOSE 3000
CMD ["npm", "run", "start"]

# ---- worker service -----------------------------------------------------
# The worker runs TypeScript directly via tsx (no Next.js build step
# needed for it) — see the `worker` script in package.json.
FROM deps AS worker
ENV NODE_ENV=production
COPY . .
CMD ["npm", "run", "worker"]
