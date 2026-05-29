FROM node:22-slim AS builder

# Build toolchain so better-sqlite3 can compile its native addon if no
# prebuilt binary matches (Debian/glibc base; prebuilds usually cover it).
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Vendored @arkade-os/sdk tarball — both packages/lib/package.json and
# packages/server/package.json depend on `file:../../vendor/...` while we
# track the arkade-script-final branch (PR arkade-os/ts-sdk#319). Must be
# in place BEFORE npm install in either package.
COPY vendor/ ./vendor/

# Copy lib package first (server depends on it)
COPY packages/lib/package.json packages/lib/package-lock.json* ./packages/lib/
WORKDIR /app/packages/lib
RUN npm install
COPY packages/lib/ ./
RUN npm run build

# Copy server package
WORKDIR /app/packages/server
COPY packages/server/package.json packages/server/package-lock.json* ./
RUN npm install
COPY packages/server/ ./
RUN npm run build

# Production stage
FROM node:22-slim

WORKDIR /app

# Copy lib
COPY --from=builder /app/packages/lib/dist ./packages/lib/dist
COPY --from=builder /app/packages/lib/package.json ./packages/lib/
COPY --from=builder /app/packages/lib/node_modules ./packages/lib/node_modules

# Copy server
COPY --from=builder /app/packages/server/dist ./packages/server/dist
COPY --from=builder /app/packages/server/package.json ./packages/server/
COPY --from=builder /app/packages/server/node_modules ./packages/server/node_modules
COPY --from=builder /app/packages/server/src/admin/dashboard.html ./packages/server/dist/admin/

# Create data directory
RUN mkdir -p /app/data

WORKDIR /app/packages/server

ENV NODE_ENV=production
ENV DATA_DIR=/app/data
ENV PUBLIC_PORT=3001
ENV ADMIN_PORT=3002

EXPOSE 3001 3002

CMD ["node", "dist/index.js"]
