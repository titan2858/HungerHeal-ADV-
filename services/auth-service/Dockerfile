FROM node:22-alpine

# Install dependencies as a separate layer keyed on the manifests only, so a
# source-code edit does not force a full npm reinstall on every rebuild.
WORKDIR /app
COPY package*.json ./
# `npm ci` installs exactly what package-lock.json pins - reproducible, unlike
# `npm install` which may resolve newer versions. --omit=dev keeps supertest and
# other test-only packages out of the runtime image.
RUN npm ci --omit=dev

COPY src ./src

# node:alpine ships an unprivileged `node` user. Running as root inside a
# container means a container escape starts with root on the host.
USER node

ENV NODE_ENV=production
EXPOSE 4001

HEALTHCHECK --interval=15s --timeout=5s --retries=5 --start-period=20s \
  CMD wget -q -O /dev/null http://127.0.0.1:4001/health || exit 1

CMD ["node", "src/index.js"]
