# GraphReview — app + worker image.
#
# Both the `app` (Next.js web server) and `worker` (BullMQ worker) services
# in docker-compose.yml build from this same file, targeting the `app` or
# `worker` stage respectively ("same image, different entrypoint"). Build
# context is the repo root (see docker-compose.yml).
#
# Two build args exist purely for closed-network use, where Docker Hub and
# Alpine's package CDN aren't reachable and an internal mirror stands in for
# them instead (docker-compose.yml passes both through from
# `NODE_BASE_IMAGE`/`ALPINE_MIRROR` in docker/.env — see .env.example).
# Neither changes anything when left unset: the defaults are the real-world
# services this app already depended on. npm's registry is deliberately
# *not* made configurable here — see docker/.env.example.
#
# Internal CA certificates come in through a separate build context named
# `certs` (docker-compose.yml points it at `CA_CERT_DIR`, default
# docker/certs/). Every *.crt/*.pem in it is appended to the system bundle
# *before* anything touches the network, so `apk add`, `npm ci`, and at
# runtime git and Node (AI endpoint, GitHub/GitLab APIs) all trust it. With
# plain `docker build`, pass `--build-context certs=docker/certs`.

ARG NODE_BASE_IMAGE=node:20-alpine
FROM ${NODE_BASE_IMAGE} AS base
# Alpine's git (libcurl) reads /etc/ssl/certs/ca-certificates.crt directly.
# Node does not — it ships its own CA list — so NODE_EXTRA_CA_CERTS points
# it at the same (now extended) bundle. Duplicates of Node's built-in roots
# are harmless. An empty certs dir leaves the bundle unchanged.
COPY --from=certs . /tmp/extra-ca/
RUN for f in /tmp/extra-ca/*.crt /tmp/extra-ca/*.pem; do       [ -f "$f" ] && { cat "$f"; echo; } >> /etc/ssl/certs/ca-certificates.crt;     done;     rm -rf /tmp/extra-ca
ENV NODE_EXTRA_CA_CERTS=/etc/ssl/certs/ca-certificates.crt
# simple-git shells out to the real `git` binary (local clone + app-managed
# clone-by-URL both go through it).
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
