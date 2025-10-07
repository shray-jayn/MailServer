# Dockerfile
FROM node:20-alpine

WORKDIR /app

# Install deps separately for better caching
COPY package*.json ./
RUN npm ci --omit=dev

# Copy source
COPY . .

ENV NODE_ENV=production
ENV PORT=3001

# Basic runtime health check deps (busybox wget is built-in on alpine)
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD wget -qO- http://localhost:3001/health || exit 1

EXPOSE 3001
CMD ["node", "index.js"]
