# Pinned to linux/amd64 explicitly. Docker Desktop on Apple Silicon builds
# arm64 by default when no --platform is given, which silently produces an
# image that won't run on an amd64 cluster. This makes `docker build` do
# the right thing regardless of host arch — Docker pulls/emulates the
# amd64 base image via QEMU, so no local Linux toolchain is needed on Mac.
FROM --platform=linux/amd64 oven/bun:slim AS build
WORKDIR /app

# Baked into both the app binary (via build.ts's `define` block) and the
# release manifest, so the two always describe the same build within a
# single CI job. Default to "development" for local `docker build` runs
# with no build-args supplied.
ARG GITHUB_SHA=development
ARG GITHUB_REF_NAME=development
ARG SUPERVISOR_VERSION=development
ENV GITHUB_SHA=${GITHUB_SHA}
ENV GITHUB_REF_NAME=${GITHUB_REF_NAME}
ENV SUPERVISOR_VERSION=${SUPERVISOR_VERSION}

# GITHUB_SHA and GITHUB_REF_NAME define the app binary's __BUILD_COMMIT__
# and __BUILD_VERSION__ at compile time (via build.ts's `define` block).
# SUPERVISOR_VERSION is used at runtime by the supervisor via
# process.env.SUPERVISOR_VERSION (supervisor/state.ts), so both build.ts
# (manifest minimumSupervisorVersion) and the supervisor process read the
# same env var to stay in sync.

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

COPY . .

# App binary + manifest.json baked into the same build step.
RUN bun run build.ts

# Supervisor is its own compiled executable — a distroless image with no
# shell can't run a bare .ts file, and the app binary being self-contained
# doesn't make the supervisor self-contained too. Target pinned explicitly
# to match build.ts's showflow target, rather than relying on Bun's
# auto-detected host target inside this (already amd64-pinned) stage.
# Output goes to dist/ rather than ./supervisor — the latter collides with
# the supervisor/ *source* directory (supervisor/index.ts) and Bun refuses
# to overwrite a directory with a file.
RUN bun build --compile --linux-x64 supervisor/index.ts --outfile=dist/supervisor


FROM --platform=linux/amd64 gcr.io/distroless/base-debian12:nonroot
WORKDIR /data

COPY --from=build /app/dist/supervisor /supervisor
COPY --from=build /app/showflow /bootstrap/showflow
COPY --from=build /app/manifest.json /bootstrap/manifest.json
COPY --from=build /app/src/backend/db/migrations /bootstrap/migrations

# SUPERVISOR_VERSION must be in the runtime env so the supervisor can read
# it from process.env at startup (supervisor/state.ts). The build stage has
# it from the ARG, but each stage is independent — copy it forward.
ARG SUPERVISOR_VERSION=development
ENV NODE_ENV=production \
    PORT=3000 \
    SUPERVISOR_VERSION=${SUPERVISOR_VERSION}

EXPOSE 3000

VOLUME ["/data"]

# The supervisor is the container's entrypoint now, not the app binary
# directly — it owns the stop-start handoff and proxies public traffic to
# whichever release is currently stable. `kubectl exec ... -- /supervisor
# activate <releaseId>` talks to the already-running instance of this same
# binary over its loopback admin API; it does not start a second daemon.
CMD ["/supervisor"]
