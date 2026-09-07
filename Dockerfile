# syntax=docker/dockerfile:1

# flowlathe has no server build step by design (see CLAUDE.md): packages/server's "start"
# script runs tsx directly against TS source, and workspace deps resolve to raw .ts files
# via pnpm symlinks + moduleResolution "Bundler". Only packages/web has a real build (vite),
# because the server serves its compiled dist/ as a static SPA. So this image installs deps
# once, builds only the web bundle, and runs the server with tsx at container start.

FROM node:22-alpine AS base
# A plain global install (not `corepack prepare`) so the pnpm binary is on PATH for every
# user without corepack lazily re-fetching it per-$HOME at container start (it does, as
# root's corepack cache isn't visible to the "node" user runtime switches to below).
RUN npm install -g pnpm@10.6.5
WORKDIR /app

FROM base AS deps
COPY . .
# better-sqlite3@13 ships prebuilt binaries for linuxmusl-{x64,arm64}, so no compiler
# toolchain (python3/make/g++) is needed here even on Alpine's musl libc.
RUN pnpm install --frozen-lockfile

FROM deps AS build
RUN pnpm --filter @flowlathe/web run build

FROM base AS runtime
ENV NODE_ENV=production
COPY --from=build /app /app

# HOST=0.0.0.0 here is a *bind* address, not the network posture — it binds every interface
# inside the container's own network namespace, which `-p` port-forwarding requires (a container
# bound to 127.0.0.1 is unreachable through `-p` from outside). The actual boundary is on the
# host side of the publish: run this image with `-p 127.0.0.1:4310:4310`, never `-p 4310:4310`.
# See README.md's "Deployment and network posture" section — the API itself is unauthenticated.
ENV PORT=4310 \
    HOST=0.0.0.0 \
    FLOWLATHE_DB_PATH=/app/data/flowlathe.sqlite \
    FLOWLATHE_FLOWS_DIR=/app/flows

RUN mkdir -p /app/data /app/flows && chown -R node:node /app/data /app/flows
VOLUME ["/app/data", "/app/flows"]

USER node
EXPOSE 4310

CMD ["pnpm", "--filter", "@flowlathe/server", "run", "start"]
