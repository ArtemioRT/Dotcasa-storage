# ── dotcasa-storage ──────────────────────────────────────────────
FROM node:22.23.4-slim AS deps

# sharp necesita libvips nativa; en slim instalamos solo lo necesario
RUN apt-get update && apt-get install -y --no-install-recommends \
    libvips-dev python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund

# ── imagen final ─────────────────────────────────────────────────
FROM node:22.23.4-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    libvips42 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .

ENV NODE_ENV=production PORT=8080
EXPOSE 8080

CMD ["node", "server.js"]
