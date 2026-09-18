FROM node:22-alpine

WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev

COPY src ./src

# Uploaded images live here. A named volume is mounted over it in
# docker-compose so photos survive the container being rebuilt - without that,
# every `docker compose up --build` would silently orphan every donation image.
RUN mkdir -p /app/uploads && chown -R node:node /app/uploads

USER node

ENV NODE_ENV=production
EXPOSE 4002

HEALTHCHECK --interval=15s --timeout=5s --retries=5 --start-period=20s \
  CMD wget -q -O /dev/null http://127.0.0.1:4002/health || exit 1

CMD ["node", "src/index.js"]
