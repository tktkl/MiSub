FROM node:22-bookworm-slim@sha256:de170b39439eb0e5a3444ad7d60b015614a381e10fecae2e30ec9e735122f38d AS build
WORKDIR /app
ENV WRANGLER_SEND_METRICS=false
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY . .
RUN npm run build && ./node_modules/.bin/wrangler pages functions build functions \
    --outdir deploy/dmit/build --compatibility-date 2024-04-01 --compatibility-flags nodejs_compat

FROM node:22-bookworm-slim@sha256:de170b39439eb0e5a3444ad7d60b015614a381e10fecae2e30ec9e735122f38d
WORKDIR /app
ENV NODE_ENV=production PORT=8787 MISUB_DATA_DIR=/data
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/package.json /app/schema.sql ./
COPY --from=build --chown=node:node /app/dist ./dist
COPY --from=build --chown=node:node /app/deploy/dmit ./deploy/dmit
USER node
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:8787/login').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "deploy/dmit/runtime.mjs"]
