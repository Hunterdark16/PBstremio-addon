FROM node:20-slim

WORKDIR /app

ENV NODE_ENV=production
ENV PUPPETEER_SKIP_DOWNLOAD=true
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium

# Lightweight defaults for the current addon. Override these in Render/Hugging Face env vars if needed.
ENV MAX_RESOLVE_CANDIDATES=4
ENV ENABLE_EMBED_FALLBACK=1
ENV RETRY_WITH_PAGE_REFERER=1
ENV ADD_RES_PARAM_FOR_1080=0
ENV DEBUG_VERBOSE=0
ENV ENABLE_BROWSER_1080P=1
ENV BROWSER_1080P_TIMEOUT_MS=9000
ENV BROWSER_1080P_CACHE_MS=180000
ENV BROWSER_IDLE_TTL_MS=30000

# Install system Chromium for puppeteer-core without bundling full Puppeteer/Chrome.
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates chromium \
  && rm -rf /var/lib/apt/lists/*

COPY package*.json ./
RUN if [ -f package-lock.json ]; then npm ci --omit=dev; else npm install --omit=dev; fi \
  && npm cache clean --force

COPY addon.js ./

EXPOSE 7860

CMD ["npm", "start"]
