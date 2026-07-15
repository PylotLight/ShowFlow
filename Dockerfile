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
ENV GITHUB_SHA=${GITHUB_SHA}
ENV GITHUB_REF_NAME=${GITHUB_REF_NAME}

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

COPY . .

# App binary (single-binary artifact, assets embedded).
RUN bun run build.ts

# Supervisor is its own compiled executable — a distroless image with no
# shell can't run a bare .ts file, and the app binary being self-contained
# doesn't make the supervisor self-contained too. Target pinned explicitly
# to match build.ts's showflow target, rather than relying on Bun's
# auto-detected host target inside this (already amd64-pinned) stage.
# Output goes to dist/ rather than ./supervisor — the latter collides with
# the supervisor/ *source* directory (supervisor/index.ts) and Bun refuses
# to overwrite a directory with a file.
RUN bun build --compile --target=bun-linux-x64 supervisor/index.ts --outfile=dist/supervisor

# The manifest for the bootstrap release baked into this image, so a fresh
# PVC has something the supervisor can verify and install as lastKnownGood
# on cold start.
RUN bun run scripts/release-manifest.ts showflow > manifest.json

FROM --platform=linux/amd64 gcr.io/distroless/base-debian12:nonroot
WORKDIR /data

COPY --from=build /app/dist/supervisor /supervisor
COPY --from=build /app/showflow /bootstrap/showflow
COPY --from=build /app/manifest.json /bootstrap/manifest.json

ENV NODE_ENV=production \
    PORT=3000

EXPOSE 3000

VOLUME ["/data"]

# The supervisor is the container's entrypoint now, not the app binary
# directly — it owns the stop-start handoff and proxies public traffic to
# whichever release is currently stable. `kubectl exec ... -- /supervisor
# activate <releaseId>` talks to the already-running instance of this same
# binary over its loopback admin API; it does not start a second daemon.
CMD ["/supervisor"]
