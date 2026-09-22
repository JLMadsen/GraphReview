# Agent instructions

## Docker builds

Never run `docker compose build` / `docker build` / `docker compose up --build` directly.
Rebuilding without pruning leaves the previous image dangling (untagged, `<none>:<none>`)
because the tag just moves to the new image — old layers stick around and silently eat disk.

Always use:

```bash
npm run docker
```

This builds the `app`/`worker` images (docker/docker-compose.yml, docker/Dockerfile), prunes the
now-dangling previous image (`docker image prune -f` — only removes untagged images, never
anything currently tagged or in use, so it's safe every time), then runs `docker compose up`.

Use `npm run docker:build` instead if you only want to build + prune without starting containers.

Use `npm run docker:up` (plain `up`, no build) only when you're certain no source/Dockerfile
changes have happened since the last build — it starts whatever image is already tagged, which
can silently run stale code otherwise.
