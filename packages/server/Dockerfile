FROM node:22-slim AS builder
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY . .
RUN npm ci && npm run build:server && npm prune --omit=dev --ignore-scripts \
    && mkdir -p packages/lib/node_modules packages/server/node_modules

FROM node:22-slim
WORKDIR /app
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/packages/lib/dist ./packages/lib/dist
COPY --from=builder /app/packages/lib/package.json ./packages/lib/package.json
COPY --from=builder /app/packages/lib/node_modules ./packages/lib/node_modules
COPY --from=builder /app/packages/server/dist ./packages/server/dist
COPY --from=builder /app/packages/server/package.json ./packages/server/package.json
COPY --from=builder /app/packages/server/node_modules ./packages/server/node_modules
RUN mkdir -p /app/data
ENV NODE_ENV=production DATA_DIR=/app/data PUBLIC_PORT=3001 ADMIN_PORT=3002
EXPOSE 3001 3002
CMD ["node", "packages/server/dist/index.js"]
