FROM node:22-alpine

WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev

COPY src ./src

USER node

ENV NODE_ENV=production
EXPOSE 4008

HEALTHCHECK --interval=15s --timeout=5s --retries=8 --start-period=40s \
  CMD wget -q -O /dev/null http://127.0.0.1:4008/health || exit 1

CMD ["node", "src/index.js"]
