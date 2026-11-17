# KitchenLink API — production image.
# Build context: this folder (KitchenLink-backend). Used by deploy/docker-compose.prod.yml.
#
# Debian (glibc) base so sharp's prebuilt linux-x64 binaries work out of the box.
FROM node:24-bookworm-slim

ENV NODE_ENV=production \
    PORT=4000

WORKDIR /app

# Dependencies first (cached between builds while package*.json are unchanged).
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force

# Application code and the PostgreSQL mirror schema (used by `npm run migrate:pg`).
COPY src ./src
COPY postgres ./postgres

# Upload folders. Named volumes are mounted here (see the compose file); a new,
# empty volume inherits this ownership so the non-root user can write to it.
RUN mkdir -p /app/uploads /app/private-uploads \
    && chown -R node:node /app/uploads /app/private-uploads

USER node

EXPOSE 4000

# /api/v1/health answers once the server has connected to MongoDB and is listening.
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||4000)+'/api/v1/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "src/server.js"]
