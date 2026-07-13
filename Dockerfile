FROM oven/bun:slim AS build
WORKDIR /app

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

COPY . .
RUN bun run build

RUN bun build --compile --target=bun \
    --outfile=showflow \
    src/backend/server.ts

FROM gcr.io/distroless/base-debian12:nonroot
WORKDIR /data

COPY --from=build /app/showflow /showflow
COPY --from=build /app/dist /dist

ENV NODE_ENV=production \
    PORT=3000

EXPOSE 3000

VOLUME ["/data"]

CMD ["/showflow"]
