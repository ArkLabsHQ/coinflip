FROM node:20-alpine AS builder

WORKDIR /app

# Vendored @arkade-os/sdk tarball — package.json depends on
# `file:./vendor/...` while we track the arkade-script-final branch
# (PR arkade-os/ts-sdk#319). Must be in place BEFORE npm install.
COPY vendor/ ./vendor/

# Copy package files
COPY package.json package-lock.json* yarn.lock* ./

# Install dependencies
RUN npm install

# Copy source
COPY src/ ./src/
COPY public/ ./public/
COPY tsconfig.json babel.config.js vue.config.js* ./

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
