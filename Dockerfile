# Astrivya MCP Server — Docker image
# Multi-stage build: install deps → build → slim runtime

FROM node:20-alpine AS builder
WORKDIR /app

# Install build deps
COPY package.json package-lock.json ./
COPY packages/akg-core/package.json packages/akg-core/
COPY packages/akg-indexer/package.json packages/akg-indexer/
COPY packages/mcp-server/package.json packages/mcp-server/
RUN npm ci --ignore-scripts

# Copy source
COPY packages/akg-core/src/ packages/akg-core/src/
COPY packages/akg-indexer/src/ packages/akg-indexer/src/
COPY packages/mcp-server/src/ packages/mcp-server/src/

# Build
RUN npm run build:akg-core && npm run build:akg-indexer && npm run build:mcp-server

# ── Runtime ──

FROM node:20-alpine
WORKDIR /app

# Copy only built artifacts + production deps
COPY --from=builder /app/packages/akg-core/dist/ /app/packages/akg-core/dist/
COPY --from=builder /app/packages/akg-core/package.json /app/packages/akg-core/
COPY --from=builder /app/packages/akg-indexer/dist/ /app/packages/akg-indexer/dist/
COPY --from=builder /app/packages/akg-indexer/package.json /app/packages/akg-indexer/
COPY --from=builder /app/packages/mcp-server/dist/ /app/packages/mcp-server/dist/
COPY --from=builder /app/packages/mcp-server/package.json /app/packages/mcp-server/

COPY package.json ./

ENV NODE_ENV=production
EXPOSE 3001

ENTRYPOINT ["node", "/app/packages/mcp-server/dist/index.js"]
CMD []
