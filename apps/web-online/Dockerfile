# Scelo Web — container image for the hosted browser edition.
#
#   docker build -f apps/web-online/Dockerfile -t scelo-web .
#   docker run -p 8080:8080 scelo-web
#
# Build context is the REPO ROOT (the web app lives in apps/web and is a
# bun workspace). Runs on Linux, where Bun is at its best — the Windows
# dev-machine quirks never reach production.

FROM oven/bun:1 AS build
WORKDIR /repo
COPY package.json bun.lock ./
COPY apps/web/package.json apps/web/package.json
COPY apps/scelo-ide/package.json apps/scelo-ide/package.json
COPY apps/web-online/package.json apps/web-online/package.json
RUN bun install --frozen-lockfile
COPY . .
RUN bun run --cwd apps/web build

FROM oven/bun:1-slim
WORKDIR /app
COPY --from=build /repo/apps/web/dist ./web/dist
COPY apps/web-online/server.ts ./web-online/server.ts
ENV PORT=8080
EXPOSE 8080
# Unprivileged user — the server only reads baked static files.
USER bun
CMD ["bun", "run", "web-online/server.ts"]
