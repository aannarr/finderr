# syntax=docker/dockerfile:1.7
#
# finderr -- multi-stage, non-root, minimal runtime.
#
# Build for the Synology NAS with:
#   docker buildx build --platform linux/amd64 -t finderr:latest .
#
# NOTE for Synology: the CPU in these boxes lacks AVX2 -- a J4125 measured here
# reports only `popcnt sse4_1 sse4_2 ssse3`, so it has no AVX of any kind. The oven/bun
# image already ships a baseline build, so the standard image works -- but if you ever
# compile a standalone binary from this source, you must pass
# --target=bun-linux-x64-baseline. The same rule governs the spellfix stage below.

# ---------------------------------------------------------------------------
# deps -- cached separately so source edits do not reinstall the world
# ---------------------------------------------------------------------------
FROM oven/bun:1.4.0-alpine AS deps
WORKDIR /app
COPY package.json bun.lock* ./
RUN bun install --frozen-lockfile

# ---------------------------------------------------------------------------
# prod-deps -- ONLY what the server imports at runtime
#
# Separate from `deps` so the runtime image carries no vite, no biome, no
# typescript. `--production` reads the same lockfile, so the resolved versions are
# identical to the ones the tests ran against.
# ---------------------------------------------------------------------------
FROM oven/bun:1.4.0-alpine AS prod-deps
WORKDIR /app
COPY package.json bun.lock* ./
RUN bun install --frozen-lockfile --production

# ---------------------------------------------------------------------------
# web build
# ---------------------------------------------------------------------------
FROM deps AS web
WORKDIR /app
COPY tsconfig.json biome.json ./
COPY web ./web

# `web/src/routes/SourcesRoute.tsx` does `import attribution from "../../../ATTRIBUTION.md?raw"`,
# so this file is a BUILD INPUT of the web bundle and not documentation. Without it the vite
# build dies with `[UNRESOLVED_IMPORT] Could not resolve '../../../ATTRIBUTION.md?raw'` -- and
# it dies ONLY in Docker, because on a developer's machine the file is simply there.
#
# That is exactly how it shipped broken: `/sources` landed after the last green CI run, the
# two runs after it failed at the gate first, and the docker build had therefore NEVER been
# executed against this import by anything but a human running `bun run build:web` in a tree
# that already had the file. `web-build-inputs.test.ts` now fails if another root-level import
# appears without a matching COPY here, which is the guard that was missing rather than a
# second owner of this line.
COPY ATTRIBUTION.md ./

# Studio, network, streaming and rating marks, from the Kometa commit pinned in the job.
#
# Fetched at BUILD time rather than tracked in git: they are 826 PNGs belonging to their
# trademark holders, not to this repo. Build time rather than RUN time is not a preference
# either -- vite bakes `web/public/` into `web/dist` during `build:web` below, and the
# container runs `read_only: true` with only `/data` writable, so there is no later moment
# at which these could be written. A build with no network reaches the next stage without
# them and every badge falls back to its text label.
#
# This runs AFTER `COPY src ./src`, which means any source change re-downloads the 220 MB
# tarball. That was measured and accepted rather than overlooked: copying just the
# importer first was tried and fails, because `src/lib/logos.ts` imports `./normalize`
# and mirroring a transitive import chain in a Dockerfile is a trap that breaks silently
# the next time somebody adds an import. The registry cache absorbs the repeat cost for
# any build whose sources have not moved.
COPY src ./src
RUN bun src/jobs/import-logos.ts
RUN bun run build:web

# ---------------------------------------------------------------------------
# spellfix1 -- SQLite's own fuzzy-match extension, compiled for THIS platform
#
# This is what makes "brigerton" find Bridgerton. It replaced a hand-rolled trigram
# index that was built in RAM at every boot and cost 1,514 MB and ~9M live objects,
# which kept JSC's collector busy enough to burn 14.5% of a core on an idle container.
# See vendor/sqlite-spellfix/README.md for the measurements.
#
# NO -march=native, NO -mavx2. The Synology's Celeron J4125 has no AVX at all, and a
# vectorised build would die there with an illegal instruction. The default baseline
# build is verified to contain zero AVX/AVX2 instructions.
# ---------------------------------------------------------------------------
FROM oven/bun:1.4.0-alpine AS spellfix
RUN apk add --no-cache build-base sqlite-dev
WORKDIR /build
COPY vendor/sqlite-spellfix/spellfix.c ./
RUN gcc -O2 -fPIC -shared spellfix.c -o spellfix1.so \
 && test -f spellfix1.so

# ---------------------------------------------------------------------------
# runtime
# ---------------------------------------------------------------------------
FROM oven/bun:1.4.0-alpine AS runtime

# gzip is required: the index builder pipes the IMDb dumps through `gunzip -c`
# rather than inflating 226 MB in-process.
# tini gives us correct signal handling and reaping for PID 1.
RUN apk add --no-cache gzip tini ca-certificates

WORKDIR /app

# > [!CAUTION] The runtime image MUST carry every runtime dependency, or the
# > container dies at boot with `bun is unable to write files: EROFS`.
# >
# > This stage used to copy no node_modules at all, on the grounds that "the server
# > imports nothing outside Bun's own namespace". That stopped being true when
# > `cockatiel` landed for the resilience policies, and the failure is nothing like
# > a missing-module error: Bun tries to AUTO-INSTALL the package at startup, the
# > compose file mounts the filesystem read-only, and the write is refused before a
# > single line of our own logging runs. Nine identical EROFS lines and no other
# > output is what that looks like.
# >
# > Worse is the version that "works": give Bun a writable HOME and the container
# > silently downloads a dependency from npm on every boot, which is a network call
# > on the startup path and an unpinned one at that.
# >
# > `--production` keeps vite, biome and typescript out. The web bundle is built in
# > the `web` stage above and needs nothing here.
# Ownership travels WITH the copy. A later `chown -R /app` would work, but on overlayfs
# it rewrites every file into a fresh layer -- the image then carries node_modules twice,
# once from the COPY and once from the chown. `--chown` sets it in the same layer, and
# numeric ids are fine before the user below exists.
COPY --chown=1001:1001 --from=prod-deps /app/node_modules ./node_modules
COPY --chown=1001:1001 --from=web /app/web/dist ./web/dist
COPY --chown=1001:1001 --from=spellfix /build/spellfix1.so ./ext/spellfix1.so
COPY --chown=1001:1001 src ./src
COPY --chown=1001:1001 package.json ./

# Run as a dedicated unprivileged user. UID 1001 avoids colliding with the
# `bun` user (1000) baked into the base image. Only the WRITABLE directories need a
# chown -- /app was already owned by the COPYs above.
RUN addgroup -g 1001 -S finderr \
 && adduser -u 1001 -S -G finderr -h /app -s /sbin/nologin finderr \
 && mkdir -p /data /config \
 && chown finderr:finderr /data /config

USER finderr

ENV NODE_ENV=production \
    FINDERR_DATA_DIR=/data \
    FINDERR_CONFIG_FILE=/config/config.yml \
    FINDERR_HOST=0.0.0.0 \
    FINDERR_PORT=7979

# The index, the poster cache and the app DB all live here. Persist it or every
# restart re-downloads 235 MB of dumps and rebuilds from scratch.
VOLUME ["/data"]

EXPOSE 7979

HEALTHCHECK --interval=30s --timeout=5s --start-period=90s --retries=3 \
  CMD bun -e "const r=await fetch('http://127.0.0.1:'+(process.env.FINDERR_PORT||7979)+'/api/health');process.exit(r.ok?0:1)"

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["bun", "src/server/index.ts"]
