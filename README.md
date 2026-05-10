---
title: PimpBunny Stremio Addon
emoji: 🔞
colorFrom: red
colorTo: pink
sdk: docker
pinned: false
---

# PimpBunny Stremio Addon

Node.js Stremio add-on for PimpBunny VOD pages, with optional outbound proxy support and a tiny `puppeteer-core` + system Chromium resolver used only as a last-resort 1080p helper.

## Files in this repo

- `addon.js` — main add-on server.
- `package.json` / `package-lock.json` — Node dependencies.
- `Dockerfile` — Docker deployment for Render or Hugging Face Spaces.
- `.dockerignore` — keeps Docker builds small.
- `.gitignore` — keeps local/generated files out of Git.

## Render setup

Create a new **Web Service** from this GitHub repo and select **Docker**.

Use these environment variables:

```env
PB_BASE_URL=https://pimpbunny.com
PUBLIC_URL=https://YOUR-RENDER-SERVICE.onrender.com
PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium
ENABLE_BROWSER_1080P=1
MAX_RESOLVE_CANDIDATES=4
ENABLE_EMBED_FALLBACK=1
RETRY_WITH_PAGE_REFERER=1
ADD_RES_PARAM_FOR_1080=0
DEBUG_VERBOSE=0
BROWSER_1080P_TIMEOUT_MS=9000
BROWSER_1080P_CACHE_MS=180000
BROWSER_IDLE_TTL_MS=30000
OUTBOUND_PROXY_URL=http://USERNAME:PASSWORD@HOST:PORT
```

Do not set `PORT` on Render. The app reads `process.env.PORT` when Render provides it and falls back to `7860` locally / on Hugging Face.

After deployment, test:

```text
https://YOUR-RENDER-SERVICE.onrender.com/health
https://YOUR-RENDER-SERVICE.onrender.com/manifest.json
```

Install in Stremio with the `/manifest.json` URL.

## Hugging Face Spaces setup

The same repo can still be used on Hugging Face Spaces with Docker. Set:

```env
SPACE_URL=https://YOUR-SPACE-NAME.hf.space
PB_BASE_URL=https://pimpbunny.com
PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium
ENABLE_BROWSER_1080P=1
OUTBOUND_PROXY_URL=http://USERNAME:PASSWORD@HOST:PORT
```

`PUBLIC_URL` is for Render. `SPACE_URL` is for Hugging Face. The code supports both.

## Proxy variables

Preferred combined proxy variable:

```env
OUTBOUND_PROXY_URL=http://USERNAME:PASSWORD@HOST:PORT
```

Alternative split variables:

```env
OUTBOUND_PROXY_HOST=HOST
OUTBOUND_PROXY_PORT=PORT
OUTBOUND_PROXY_USERNAME=USERNAME
OUTBOUND_PROXY_PASSWORD=PASSWORD
```

## Local test

```bash
npm install
npm run check
npm start
```

Then open:

```text
http://localhost:7860/health
http://localhost:7860/manifest.json
```
