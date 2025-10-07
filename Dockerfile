# ./backend/Dockerfile
FROM node:20-alpine
WORKDIR /app

# Install deps (prod only)
COPY package*.json ./
RUN npm ci --omit=dev

# Copy source
COPY . .

ENV NODE_ENV=production
ENV PORT=3001
EXPOSE 3001

# Simple healthcheck endpoint is /health in your code
HEALTHCHECK CMD wget -q -O- http://localhost:3001/health || exit 1

CMD ["node", "server.js"]
