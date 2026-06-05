FROM node:20-alpine AS builder

WORKDIR /app

# Vendored @arkade-os/sdk tarball — package.json depends on
# `file:./vendor/...` while we track the arkade-script-final branch
# (PR arkade-os/ts-sdk#319). Must be in place BEFORE npm install.
COPY vendor/ ./vendor/

# The client depends on `arkade-coinflip` (file:packages/lib), which depends on
# @arklabshq/contract-workflows-prototype. Both must be BUILT before the root
# `npm install` can resolve `file:packages/lib` and the client bundle can import
# `arkade-coinflip/contract`. (Mirrors Dockerfile.bundle Stage 1.)

# contract-workflows-prototype first (file: dep of lib).
COPY packages/contract-workflows-prototype/package.json packages/contract-workflows-prototype/package-lock.json* ./packages/contract-workflows-prototype/
WORKDIR /app/packages/contract-workflows-prototype
RUN npm install
COPY packages/contract-workflows-prototype/ ./
RUN npm run build

# lib (client imports arkade-coinflip/contract from it).
WORKDIR /app
COPY packages/lib/package.json packages/lib/package-lock.json* ./packages/lib/
WORKDIR /app/packages/lib
RUN npm install
COPY packages/lib/ ./
RUN npm run build

# Copy package files
WORKDIR /app
COPY package.json package-lock.json* yarn.lock* ./

# Install dependencies (resolves file:packages/lib to the built dist)
RUN npm install

# Copy source
COPY src/ ./src/
COPY public/ ./public/
COPY tsconfig.json babel.config.js vue.config.js* ./
# .eslintignore is load-bearing: vue-cli's build lints the project tree, and
# with `transpileDependencies` the lib/cwp transpiled dist/*.js lands inside it.
# Without these the eslint-loader rejects the transpiled JS (var / require()).
COPY .eslintrc.js .eslintignore ./

# Build Vue app
RUN npm run build

# Production stage — serve with nginx
FROM nginx:alpine

# Copy built files
COPY --from=builder /app/dist /usr/share/nginx/html

# Nginx config: SPA routing + reverse proxy /api to server
COPY nginx.conf /etc/nginx/templates/default.conf.template

EXPOSE 80

CMD ["nginx", "-g", "daemon off;"]
