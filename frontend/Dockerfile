# Build the static bundle, then serve it with nginx.
#
# The dev server is not a production server: it compiles on demand, ships
# source maps, and is deliberately unoptimised. `vite build` produces static
# files, and nginx serves them far better than Node would.
FROM node:22-alpine AS build

WORKDIR /app
COPY package*.json ./
RUN npm ci

COPY . .
RUN npm run build

# ---------------------------------------------------------------- runtime
FROM nginx:1.27-alpine

# Replaces the default config with one that knows about client-side routing
# and proxies /api to the gateway.
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist /usr/share/nginx/html

EXPOSE 80

HEALTHCHECK --interval=15s --timeout=5s --retries=5 --start-period=5s \
  CMD wget -q -O /dev/null http://127.0.0.1/ || exit 1
