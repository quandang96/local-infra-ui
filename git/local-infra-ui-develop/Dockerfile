FROM node:24-bookworm-slim AS dependencies
WORKDIR /workspace
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/package.json
COPY apps/web/package.json apps/web/package.json
RUN npm ci

FROM dependencies AS build
COPY . .
RUN npm run build

FROM golang:1.25.3-bookworm AS go-toolchain

FROM node:24-bookworm-slim AS runtime-base
WORKDIR /workspace
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl gnupg make && \
   install -m 0755 -d /etc/apt/keyrings && \
   curl -fsSL https://download.docker.com/linux/debian/gpg -o /etc/apt/keyrings/docker.asc && \
   chmod a+r /etc/apt/keyrings/docker.asc && \
   echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/debian bookworm stable" > /etc/apt/sources.list.d/docker.list && \
   apt-get update && apt-get install -y --no-install-recommends docker-ce-cli docker-compose-plugin && \
   rm -rf /var/lib/apt/lists/*
COPY --from=go-toolchain /usr/local/go /usr/local/go
ENV HOME=/home/coder
ENV GOPATH=/home/coder/go
ENV GOMODCACHE=/home/coder/go/pkg/mod
ENV GOCACHE=/home/coder/.cache/go-build
ENV GOBIN=/home/coder/go/bin
ENV PATH="/usr/local/go/bin:/home/coder/go/bin:${PATH}"
RUN mkdir -p /home/coder/go/bin /home/coder/go/pkg/mod /home/coder/.cache/go-build

FROM runtime-base AS runtime
ENV NODE_ENV=production
COPY --from=build /workspace/node_modules ./node_modules
COPY --from=build /workspace/apps/api/dist ./apps/api/dist
COPY --from=build /workspace/apps/web/dist ./apps/web/dist
COPY --from=build /workspace/apps/api/package.json ./apps/api/package.json
COPY --from=build /workspace/package.json ./package.json
EXPOSE 3001
CMD ["node", "apps/api/dist/server.js"]

FROM runtime-base AS development
ENV NODE_ENV=development
COPY --from=dependencies /workspace/node_modules ./node_modules
COPY . .
EXPOSE 3001 5173
CMD ["npm", "run", "dev"]
