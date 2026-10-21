# syntax=docker/dockerfile:1

# --- Stage 1: Build TypeScript ---
FROM node:22-alpine AS builder
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build

# Prune devDependencies for production image
RUN npm prune --omit=dev

# --- Stage 2: Production Runtime ---
FROM node:22-alpine AS runtime
WORKDIR /app

# Install ffmpeg for audio compression and transcoding
RUN apk add --no-cache ffmpeg

ENV NODE_ENV=production
ENV CONFIG_PATH=/app/config.json

# Create writable directories for SQLite data, media, and WhatsApp auth state owned by non-root 'node' user
RUN mkdir -p /data /data/media /auth && \
    chmod 0700 /data /data/media /auth && \
    chown -R node:node /data /auth /app

COPY --from=builder --chown=node:node /app/package.json ./package.json
COPY --from=builder --chown=node:node /app/node_modules ./node_modules
COPY --from=builder --chown=node:node /app/dist ./dist
COPY --chown=node:node migrations ./migrations

USER node

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/health/live').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

CMD ["node", "--no-warnings=ExperimentalWarning", "dist/index.js"]
