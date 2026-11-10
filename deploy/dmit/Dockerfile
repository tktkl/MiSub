FROM node:22-bookworm-slim@sha256:de170b39439eb0e5a3444ad7d60b015614a381e10fecae2e30ec9e735122f38d AS build
WORKDIR /app
ENV WRANGLER_SEND_METRICS=false
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY . .
RUN npm run build && npm run build:server

FROM node:22-bookworm-slim@sha256:de170b39439eb0e5a3444ad7d60b015614a381e10fecae2e30ec9e735122f38d
WORKDIR /app
ENV NODE_ENV=production PORT=8787 MISUB_DATA_DIR=/data
COPY --from=build --chown=node:node /app/schema.sql ./
COPY --from=build --chown=node:node /app/dist ./dist
COPY --from=build --chown=node:node /app/deploy/dmit ./deploy/dmit
RUN mkdir /data && chown node:node /data
USER node
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
    CMD node deploy/dmit/healthcheck.mjs
CMD ["node", "deploy/dmit/runtime.mjs"]
