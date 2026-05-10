const { addonBuilder, getRouter } = require("stremio-addon-sdk");
const express = require("express");
const fetch = require("node-fetch");
const cheerio = require("cheerio");
const { HttpsProxyAgent } = require("https-proxy-agent");
const crypto = require("crypto");

const PORT = process.env.PORT || 7860;
const BASE_URL = process.env.PB_BASE_URL || "https://pimpbunny.com";
const PUBLIC_BASE_URL = process.env.SPACE_URL || process.env.PUBLIC_URL || "";

// Lightweight knobs for Render / Hugging Face free-style Docker hosts.
const MAX_RESOLVE_CANDIDATES = Number(process.env.MAX_RESOLVE_CANDIDATES || 4);
const ENABLE_EMBED_FALLBACK = process.env.ENABLE_EMBED_FALLBACK !== "0";
const RETRY_WITH_PAGE_REFERER = process.env.RETRY_WITH_PAGE_REFERER !== "0";
const ADD_RES_PARAM_FOR_1080 = process.env.ADD_RES_PARAM_FOR_1080 === "1";
const DEBUG_VERBOSE = process.env.DEBUG_VERBOSE === "1";

// Tiny browser resolver: enabled by default, but only used as a last resort
// when the normal lightweight get_file resolver does not produce 1080p.
const ENABLE_BROWSER_1080P = process.env.ENABLE_BROWSER_1080P !== "0";
const BROWSER_1080P_TIMEOUT_MS = Number(process.env.BROWSER_1080P_TIMEOUT_MS || 30000);
const BROWSER_1080P_CACHE_MS = Number(process.env.BROWSER_1080P_CACHE_MS || 180 * 1000);
const BROWSER_IDLE_TTL_MS = Number(process.env.BROWSER_IDLE_TTL_MS || 30 * 1000);
const PUPPETEER_EXECUTABLE_PATH = process.env.PUPPETEER_EXECUTABLE_PATH || "/usr/bin/chromium";
const GETFILE_CAPTURE_GRACE_MS = Number(process.env.GETFILE_CAPTURE_GRACE_MS || 3500);
const ENABLE_BROWSER_EMBED_FIRST = process.env.ENABLE_BROWSER_EMBED_FIRST === "1";
const ENABLE_META_1080P_PREWARM = process.env.ENABLE_META_1080P_PREWARM !== "0";
const PREWARM_1080P_TTL_MS = Number(process.env.PREWARM_1080P_TTL_MS || 2 * 60 * 1000);

// Cheap caches to avoid duplicate Stremio/UI requests.
const STREAM_CACHE_MS = Number(process.env.STREAM_CACHE_MS || 45 * 1000);
const CATALOG_CACHE_MS = Number(process.env.CATALOG_CACHE_MS || 10 * 60 * 1000);
const STREAM_TOKEN_TTL_MS = Number(process.env.STREAM_TOKEN_TTL_MS || 10 * 60 * 1000);
const streamTokenCache = new Map();
const playbackCookieCache = new Map();

function setPlaybackCookiesForUrl(url, cookieStr = "") {
  if (!url || !cookieStr) return;

  playbackCookieCache.set(url, {
    cookieStr,
    expiresAt: Date.now() + STREAM_TOKEN_TTL_MS,
  });
}

function getPlaybackCookiesForUrl(url) {
  const entry = playbackCookieCache.get(url);
  if (!entry) return "";

  if (entry.expiresAt <= Date.now()) {
    playbackCookieCache.delete(url);
    return "";
  }

  return entry.cookieStr || "";
}

function createStreamToken(targetUrl, referer, cookieStr = "") {
  const token = crypto.randomBytes(16).toString("hex");

  streamTokenCache.set(token, {
    targetUrl,
    referer,
    cookieStr,
    expiresAt: Date.now() + STREAM_TOKEN_TTL_MS,
  });

  return token;
}

function getStreamToken(token) {
  const entry = streamTokenCache.get(token);
  if (!entry) return null;

  if (entry.expiresAt <= Date.now()) {
    streamTokenCache.delete(token);
    return null;
  }

  return entry;
}

const browser1080pCache = new Map();
const browser1080pPrewarmCache = new Map();

function browser1080pKey(videoId, pageUrl) {
  return `${videoId}:${pageUrl}`;
}
let sharedBrowser = null;
let sharedBrowserLaunchPromise = null;
let browserIdleTimer = null;
let browserJobQueue = Promise.resolve();
let activeBrowserJobs = 0;

function cancelSharedBrowserIdleClose() {
  if (browserIdleTimer) {
    clearTimeout(browserIdleTimer);
    browserIdleTimer = null;
  }
}

const GENRE_TAG_SLUGS = {
  "Teen": "teen",
  "Asian": "asian",
  "Latina": "latina",
  "Onlyfans": "onlyfans",
  "PAWG": "pawg",
  "Pornstar": "pornstar",
  "Chaturbate": "chaturbate",
  "Reverse Cowgirl": "reverse-cowgirl",
  "Stepsister": "stepsister",
};

const PROXY_HOST = process.env.OUTBOUND_PROXY_HOST || "";
const PROXY_PORT_ENV = process.env.OUTBOUND_PROXY_PORT || "";
const PROXY_USER = process.env.OUTBOUND_PROXY_USERNAME || "";
const PROXY_PASS = process.env.OUTBOUND_PROXY_PASSWORD || "";
const PROXY_URL = process.env.OUTBOUND_PROXY_URL || (PROXY_HOST && PROXY_PORT_ENV
  ? `http://${PROXY_USER ? encodeURIComponent(PROXY_USER) : ""}${PROXY_PASS ? ":" + encodeURIComponent(PROXY_PASS) : ""}${PROXY_USER || PROXY_PASS ? "@" : ""}${PROXY_HOST}:${PROXY_PORT_ENV}`
  : "");
const proxyAgent = PROXY_URL ? new HttpsProxyAgent(PROXY_URL) : null;

// TS/AAC/M4S/WOFF2 segments are not proxied. Everything else can go through the outbound proxy.
const SEGMENT_RE = /\.(ts|aac|m4s|woff2)(\?|$)/i;

async function doFetch(url, opts = {}, useProxy = true) {
  const options = { redirect: "follow", ...opts };
  if (useProxy && proxyAgent) options.agent = proxyAgent;
  return fetch(url, options);
}

const manifest = {
  id: "community.pimpbunny.vod",
  version: "1.0.0",
  name: "[18+] PimpBunny",
  description: "18+ adult videos scraped from pimpbunny.com.",
  logo: "https://pimpbunny.com/favicon.ico",
  types: ["movie"],
  resources: ["catalog", { name: "meta", types: ["movie"] }, { name: "stream", types: ["movie"] }],
  idPrefixes: ["pb:"],
  catalogs: [
    {
      type: "movie",
      id: "latest",
      name: "PB Latest Videos",
      extra: [
        {
          name: "genre",
          isRequired: false,
          options: [
  "Teen",
  "Asian",
  "Latina",
  "Onlyfans",
  "PAWG",
  "Pornstar",
  "Chaturbate",
  "Reverse Cowgirl",
  "Stepsister",
],
        },
        { name: "skip", isRequired: false },
        { name: "search", isRequired: false },
      ],
      behaviorHints: { adult: true, configurable: false, configurationRequired: false },
    },
  ],
};

const builder = new addonBuilder(manifest);
const metaCache = new Map();
const catalogCache = new Map();

setInterval(() => {
  const cutoff = Date.now() - 60 * 60 * 1000;

  for (const [key, val] of metaCache.entries()) {
    if (val.updatedAt < cutoff) metaCache.delete(key);
  }

  const now = Date.now();
  
  for (const [key, val] of browser1080pPrewarmCache.entries()) {
  if (val.expiresAt <= now) {
    if (!val.controller.signal.aborted) {
      val.controller.abort("cleanup expired");
    }
    browser1080pPrewarmCache.delete(key);
  }
}

  for (const [key, val] of catalogCache.entries()) {
    if (val.expiresAt <= now) catalogCache.delete(key);
  }

  for (const [key, val] of streamTokenCache.entries()) {
    if (val.expiresAt <= now) streamTokenCache.delete(key);
  }

  for (const [key, val] of playbackCookieCache.entries()) {
    if (val.expiresAt <= now) playbackCookieCache.delete(key);
  }
}, 15 * 60 * 1000);

const HEADERS = {
  "User-Agent": "Mozilla/5.0 (Linux; Android 6.0; Nexus 5 Build/MRA58N) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Mobile Safari/537.36",
  "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9",
  "Cache-Control": "no-cache",
  "Pragma": "no-cache",
  "Upgrade-Insecure-Requests": "1",
  "Referer": BASE_URL + "/",
};

const VIDEO_HEADERS = {
  "User-Agent": HEADERS["User-Agent"],
  "Accept": "video/webm,video/ogg,video/*;q=0.9,application/ogg;q=0.7,audio/*;q=0.6,*/*;q=0.5",
  "Accept-Language": "en-US,en;q=0.9",
  "Referer": BASE_URL + "/",
  "Origin": BASE_URL,
};

function absoluteUrl(url, base = BASE_URL) {
  if (!url) return null;
  try {
    return new URL(url, base).toString();
  } catch {
    return null;
  }
}

async function fetchHtml(url, extraHeaders = {}) {
  console.log(`[fetchHtml] GET ${url} (proxy=${!!proxyAgent})`);
  const res = await doFetch(url, { headers: { ...HEADERS, ...extraHeaders } }, true);
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return await res.text();
}

function cleanSlugPath(value) {
  return String(value || "")
    .replace(/^\/+|\/+$/g, "")
    .replace(/null$/i, "");
}

function makeIdFromPath(pathname) {
  return `pb:${cleanSlugPath(pathname)}`;
}

function decodeId(id) {
  return cleanSlugPath(String(id || "").replace(/^pb:/, ""));
}


function getSetCookiePairs(res) {
  return (res.headers.raw?.()?.["set-cookie"] || [])
    .map(c => c.split(";")[0])
    .filter(Boolean)
    .join("; ");
}

function mergeCookies(...cookieStrings) {
  const jar = new Map();

  for (const cookieString of cookieStrings) {
    String(cookieString || "")
      .split(";")
      .map(c => c.trim())
      .filter(Boolean)
      .forEach(pair => {
        const eq = pair.indexOf("=");
        if (eq <= 0) return;
        jar.set(pair.slice(0, eq), pair);
      });
  }

  return [...jar.values()].join("; ");
}

function qualityPreferenceCookies(slug) {
  // The important browser discovery was localStorage.kvsplayer_selected_format = "1080p".
  // localStorage is not sent over HTTP, so server-side we mimic that behavior by trying the
  // extracted 1080p KVS URL first. These cookies are still useful for a normal KVS-like session.
  const slugOnly = slug.replace(/^videos\//, "");
  const ktQParams = `dir%3D${encodeURIComponent(slugOnly)}`;

  return [
    "kt_browser_res=1920x1080",
    "kt_is_visited=1",
    "kt_tcookie=1",
    `kt_qparams=${ktQParams}`,
  ].join("; ");
}

let _taxonomyCache = null;
async function getTaxonomyPrefix(testSlug) {
  if (_taxonomyCache) return _taxonomyCache.prefix;

  const prefixes = ["tag", "category", "tags", "categories", "genre", "niche"];
  for (const prefix of prefixes) {
    const url = `${BASE_URL}/${prefix}/${testSlug}/`;
    try {
      const res = await doFetch(url, { headers: HEADERS }, true);
      console.log(`[taxonomy] probe /${prefix}/${testSlug}/ → HTTP ${res.status}`);
      if (res.ok) {
        console.log(`[taxonomy] ✅ resolved prefix: /${prefix}/`);
        _taxonomyCache = { prefix };
        return prefix;
      }
    } catch (e) {
      console.log(`[taxonomy] probe error /${prefix}/${testSlug}/: ${e.message}`);
    }
  }

  console.warn(`[taxonomy] ⚠️ all prefixes failed for "${testSlug}", defaulting to "tag"`);
  _taxonomyCache = { prefix: "tag" };
  return "tag";
}

const BAD_CATALOG_TITLE_RE = /^(home|about|contact|blog|videos?|models?|categories?|tags?|search|login|register|privacy|terms|dmca|sitemap|upload and earn|verified|male|female|become a model|affiliate program|advertise|members?|join|sign up|signup)$/i;

const BAD_CATALOG_SLUG_RE = /^(home|about|contact|blog|videos?|models?|categories?|tags?|search|login|register|privacy|terms|dmca|sitemap|upload-and-earn|verified|male|female|become-a-model|affiliate-program|advertise|members?|join|sign-up|signup)$/i;

function cleanCatalogText(value) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .replace(/\b\d{1,2}:\d{2}(?::\d{2})?\b/g, "")
    .trim();
}

function titleFromVideoSlug(slug) {
  return cleanCatalogText(
    String(slug || "")
      .replace(/-/g, " ")
      .replace(/\b\w/g, c => c.toUpperCase())
  );
}

function isRealVideoPath(pathname) {
  const path = cleanSlugPath(pathname);
  const segments = path.split("/").filter(Boolean);

  // Only allow real video pages:
  // /videos/some-video-title/
  if (segments.length !== 2) return false;
  if (segments[0] !== "videos") return false;

  const slug = segments[1];

  if (!slug) return false;
  if (/^\d+$/.test(slug)) return false;
  if (!slug.includes("-")) return false;
  if (slug.length < 8) return false;
  if (BAD_CATALOG_SLUG_RE.test(slug)) return false;

  return true;
}

function extractPostCards(html, baseUrl) {
  const $ = cheerio.load(html);
  const siteBase = baseUrl || BASE_URL;

  const siteHostname = (() => {
    try {
      return new URL(siteBase).hostname;
    } catch {
      return "";
    }
  })();

  const results = [];
  const seenVideoPaths = new Set();

  $("a[href]").each((_, el) => {
    const a = $(el);
    const rawHref = a.attr("href");
    if (!rawHref) return;

    let u;
    try {
      u = new URL(rawHref, siteBase);
    } catch {
      return;
    }

    if (u.hostname !== siteHostname) return;

    // Main fix: only accept /videos/<slug>/ URLs.
    if (!isRealVideoPath(u.pathname)) return;

    const pathKey = cleanSlugPath(u.pathname);
    if (seenVideoPaths.has(pathKey)) return;
    seenVideoPaths.add(pathKey);

    const slug = pathKey.split("/").pop();

    // Keep this narrow. Do NOT use generic "li, div" here,
    // because those can climb into nav/sidebar/model blocks.
    const closestCard = a.closest(
      "article, .video, .video-item, .thumb, .thumbnail, .item, .card, .post, [class*='video'], [class*='thumb']"
    );

    const container = closestCard.length ? closestCard : a;

    const imgNode =
      a.find("img").first().length
        ? a.find("img").first()
        : container.find("img").first();

    const rawTitleCandidates = [
      a.attr("title"),
      imgNode.attr("alt"),
      imgNode.attr("title"),
      a.find("[class*='title'], [class*='name']").first().text(),
      container.find("[class*='title']").first().text(),
      a.text(),
      titleFromVideoSlug(slug),
    ];

    let title = "";

    for (const candidate of rawTitleCandidates) {
      const cleaned = cleanCatalogText(candidate);
      if (!cleaned) continue;
      if (cleaned.length < 3) continue;
      if (BAD_CATALOG_TITLE_RE.test(cleaned)) continue;

      title = cleaned;
      break;
    }

    if (!title) {
      title = titleFromVideoSlug(slug);
    }

    if (!title || BAD_CATALOG_TITLE_RE.test(title)) return;

    const rawImg = absoluteUrl(
      imgNode.attr("data-src") ||
      imgNode.attr("data-lazy-src") ||
      imgNode.attr("data-original") ||
      imgNode.attr("data-thumb") ||
      (() => {
        const ss = imgNode.attr("srcset");
        if (!ss) return null;

        const first = ss
          .split(",")
          .map(x => x.trim().split(/\s+/)[0])
          .find(Boolean);

        return first || null;
      })() ||
      imgNode.attr("src"),
      siteBase
    );

    const imgOk =
      rawImg &&
      !/(placeholder|avatar|logo|icon|blank|spacer|pixel|\.gif)/i.test(rawImg);

    const img = imgOk
      ? (PUBLIC_BASE_URL
          ? `${PUBLIC_BASE_URL}/imgproxy?url=${encodeURIComponent(rawImg)}`
          : rawImg)
      : undefined;

    const description = cleanCatalogText(
      container
        .find("[class*='desc'], [class*='excerpt'], [class*='summary'], p")
        .first()
        .text()
    ).substring(0, 200);

    const date =
      container.find("time").attr("datetime") ||
      cleanCatalogText(container.find("[class*='date'], [class*='time']").first().text());

    results.push({
      id: makeIdFromPath(pathKey),
      type: "movie",
      name: title,
      poster: img,
      posterShape: "landscape",
      background: img,
      description: [date, description].filter(Boolean).join(" • "),
      website: u.toString(),
    });
  });

  console.log(`[catalog] extractPostCards found ${results.length} video items`);
  return results.slice(0, 24);
}

async function fetchCatalogPage(_catalogId, skip = 0, search = "", genre = "") {
  const page = Math.floor((Number(skip) || 0) / 24) + 1;

  if (search) {
    const searchUrls = [
      `${BASE_URL}/?s=${encodeURIComponent(search)}${page > 1 ? `&paged=${page}` : ""}`,
      `${BASE_URL}/search/${encodeURIComponent(search)}${page > 1 ? `/page/${page}/` : "/"}`,
    ];

    for (const url of searchUrls) {
      try {
        const html = await fetchHtml(url);
        const metas = extractPostCards(html);
        if (metas.length > 0) return metas;
      } catch (err) {
        console.warn(`Search fetch failed: ${url} -> ${err.message}`);
      }
    }

    throw new Error("No search results could be fetched");
  }

  if (genre && GENRE_TAG_SLUGS[genre]) {
  const slug = GENRE_TAG_SLUGS[genre];

  const tagUrl = page <= 1
    ? `${BASE_URL}/tags/${slug}/`
    : `${BASE_URL}/tags/${slug}/${page}/`;

  try {
    console.log(`[catalog] fetching genre "${genre}" from ${tagUrl}`);

    const html = await fetchHtml(tagUrl);
    const metas = extractPostCards(html, tagUrl);

    if (metas.length > 0) {
      return metas;
    }

    console.warn(`[catalog] genre "${genre}" returned no video metas from ${tagUrl}`);
  } catch (err) {
    console.warn(`[catalog] genre "${genre}" fetch failed: ${tagUrl} -> ${err.message}`);
  }

  return [];
}

  const catalogUrl = page <= 1
  ? `${BASE_URL}/videos/`
  : `${BASE_URL}/videos/${page}/`;

try {
  const html = await fetchHtml(catalogUrl);
  const metas = extractPostCards(html, catalogUrl);

  if (metas.length > 0) {
    return metas;
  }

  throw new Error(`No metas found on ${catalogUrl}`);
} catch (err) {
  console.warn(`Catalog fetch failed: ${catalogUrl} -> ${err.message}`);
  throw err;
}
}

function extractVideoIdFromHtml(html) {
  const patterns = [
    /\/embed\/(\d+)/i,
    /video_id["']?\s*[:=]\s*["']?(\d+)/i,
    /videoId["']?\s*[:=]\s*["']?(\d+)/i,
    /video-id=["']?(\d+)/i,
    /\/videos_screenshots\/\d+\/(\d+)\//i,
    /\/get_file\/\d+\/[^/]+\/\d+\/(\d+)\//i,
  ];

  for (const re of patterns) {
    const m = html.match(re);
    if (m?.[1]) return m[1];
  }

  return null;
}

function urlBelongsToVideo(url, videoId) {
  if (!videoId) return true;

  let decoded = String(url || "");
  try { decoded = decodeURIComponent(decoded); } catch {}

  return (
    decoded.includes(`/${videoId}/`) ||
    decoded.includes(`_${videoId}_`) ||
    decoded.includes(`/embed/${videoId}`) ||
    decoded.includes(`${videoId}_pb_`) ||
    decoded.includes(`${videoId}_preview`) ||
    decoded.includes(`/${videoId}_`)
  );
}

function isPreviewOrThumbMp4(url) {
  let decoded = String(url || "");
  try { decoded = decodeURIComponent(decoded); } catch {}
  return /(preview_pb|_preview\.mp4|videos_screenshots|thumb|poster|listing|webp)/i.test(decoded);
}

function decodeEscapedMediaString(value) {
  return String(value || "")
    .replace(/&amp;/g, "&")
    .replace(/\\u0026/gi, "&")
    .replace(/\\u003d/gi, "=")
    .replace(/\\u003f/gi, "?")
    .replace(/\\u002f/gi, "/")
    .replace(/\\\//g, "/")
    .replace(/\\\\\//g, "/")
    .replace(/\\"/g, '"')
    .replace(/&#x2F;/g, "/")
    .replace(/&#47;/g, "/")
    .trim();
}

function unwrapKvsFunctionUrl(value) {
  let v = decodeEscapedMediaString(value);

  // KVS player format: function/0/https://site/get_file/.../video_1080p.mp4/
  const m = v.match(/^function\/\d+\/(https?:\/\/.+)$/i);
  if (m) v = m[1];

  v = v.replace(/^[`'"]+|[`'"]+$/g, "");
  v = v.replace(/[),;]+$/g, "");
  return v;
}

function getQualityFromUrlOrText(url, text = "") {
  const s = `${decodeEscapedMediaString(url)} ${decodeEscapedMediaString(text)}`;
  if (/_1080p\.mp4/i.test(s) || /\b1080p\b/i.test(s)) return "1080p";
  if (/_720p\.mp4/i.test(s) || /\b720p\b/i.test(s)) return "720p";
  if (/_480p\.mp4/i.test(s) || /\b480p\b/i.test(s)) return "480p";
  if (/_360p\.mp4/i.test(s) || /\b360p\b/i.test(s)) return "360p";
  if (/\.mp4\/?(?:[?#]|$)/i.test(s)) return "480p";
  return "HD";
}

function qualityRank(q) {
  return {
    "1080p": 0,
    "720p": 1,
    "480p": 2,
    "360p": 3,
    "HD": 4,
  }[q] ?? 99;
}

function getQualSuffix(u) {
  let decoded = decodeEscapedMediaString(u);
  try { decoded = decodeURIComponent(decoded); } catch {}
  const m = decoded.match(/_(1080p|720p|480p|360p)\.mp4\/?(?:[?#]|$)/i);
  return m ? `_${m[1].toLowerCase()}.mp4` : ".mp4";
}

function getGetFileHash(url) {
  const m = String(url || "").match(/\/get_file\/\d+\/([^/]+)\//i);
  return m ? m[1] : "";
}

function extractKvsPlayerSources(html, videoId = null) {
  const text = decodeEscapedMediaString(html);
  const out = [];
  const seen = new Set();

  const urlRe = /\b(video_url|video_alt_url\d*)\s*:\s*(['"`])((?:\\.|(?!\2).)*?)\2/gi;

  for (const m of text.matchAll(urlRe)) {
    const key = m[1];
    const rawValue = m[3];
    const unwrapped = unwrapKvsFunctionUrl(rawValue);

    if (!/^https?:\/\//i.test(unwrapped)) continue;
    if (!/\/get_file\//i.test(unwrapped)) continue;
    if (!/\.mp4\/?(?:[?#]|$)/i.test(unwrapped)) continue;
    if (isPreviewOrThumbMp4(unwrapped)) continue;
    if (!urlBelongsToVideo(unwrapped, videoId)) continue;

    const textKey = `${key}_text`;
    const textRe = new RegExp(
  "\\b" + textKey + "\\s*:\\s*([\"'`])((?:\\\\.|(?!\\1).)*?)\\1",
  "i"
);
    const textMatch = text.match(textRe);
    const qualityText = textMatch ? textMatch[2] : "";

    const quality = getQualityFromUrlOrText(unwrapped, qualityText);
    const hash = getGetFileHash(unwrapped);
    const dedupeKey = `${quality}:${hash}:${unwrapped}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);

    out.push({ key, quality, hash, source: `kvs:${key}`, url: unwrapped });
  }

  out.sort((a, b) => qualityRank(a.quality) - qualityRank(b.quality));
  return out;
}

function collectAllGetFileCandidates(text, videoId = null, sourceLabel = "raw-html") {
  const normalized = decodeEscapedMediaString(text);
  const out = [];
  const seen = new Set();

  const add = (raw, source) => {
    let u = unwrapKvsFunctionUrl(raw);
    u = decodeEscapedMediaString(u).replace(/[),;'"<>]+$/g, "");

    if (!/^https?:\/\//i.test(u)) return;
    if (!/\/get_file\//i.test(u)) return;
    if (!/\.mp4\/?(?:[?#]|$)/i.test(u)) return;
    if (isPreviewOrThumbMp4(u)) return;
    if (!urlBelongsToVideo(u, videoId)) return;

    const quality = getQualityFromUrlOrText(u);
    const hash = getGetFileHash(u);
    const key = `${quality}:${hash}:${u}`;
    if (seen.has(key)) return;
    seen.add(key);

    out.push({ quality, hash, source, url: u });
  };

  const patterns = [
    /https?:\/\/[^"'\\\s<>]+\/get_file\/[^"'\\\s<>]+\.mp4\/?(?:[?#][^"'\\\s<>]*)?/gi,
    /function\/\d+\/https?:\/\/[^"'\\\s<>]+\/get_file\/[^"'\\\s<>]+\.mp4\/?/gi,
  ];

  for (const re of patterns) {
    for (const m of normalized.matchAll(re)) {
      add(m[0], sourceLabel);
    }
  }

  for (const src of extractKvsPlayerSources(normalized, videoId)) {
    add(src.url, src.source);
  }

  out.sort((a, b) => {
    const q = qualityRank(a.quality) - qualityRank(b.quality);
    if (q !== 0) return q;
    return a.hash.localeCompare(b.hash);
  });

  return out;
}

async function fetchEmbedCandidates(videoId, pageUrl, cookieStr) {
  if (!ENABLE_EMBED_FALLBACK || !videoId) return [];

  const embedUrl = `${BASE_URL}/embed/${videoId}`;
  try {
    console.log(`[embed] fetching lightweight fallback: ${embedUrl}`);
    const res = await doFetch(embedUrl, {
      headers: {
        ...HEADERS,
        Cookie: cookieStr,
        Referer: pageUrl,
        Origin: BASE_URL,
      },
    }, true);

    console.log(`[embed] ${embedUrl} -> HTTP ${res.status}`);
    if (!res.ok) return [];

    const body = await res.text();
    return collectAllGetFileCandidates(body, videoId, `embed:${embedUrl}`);
  } catch (e) {
    console.log(`[embed] fallback error: ${e.message}`);
    return [];
  }
}

function addRndParam(url, quality) {
  const base = decodeEscapedMediaString(url);

  try {
    const u = new URL(base);
    u.searchParams.set("rnd", String(Date.now()));

    if (ADD_RES_PARAM_FOR_1080 && quality === "1080p") {
      u.searchParams.set("res", "1080p");
    }

    return u.toString();
  } catch {
    const sep = base.includes("?") ? "&" : "?";
    const resParam = ADD_RES_PARAM_FOR_1080 && quality === "1080p" ? "&res=1080p" : "";
    return `${base}${sep}rnd=${Date.now()}${resParam}`;
  }
}

async function resolveGetFileCandidate(candidate, pageUrl, cookieStr, videoId) {
  const embedReferer = videoId ? `${BASE_URL}/embed/${videoId}` : pageUrl;
  const referers = RETRY_WITH_PAGE_REFERER && embedReferer !== pageUrl
    ? [embedReferer, pageUrl]
    : [embedReferer];

  for (const referer of referers) {
    const resolveUrl = addRndParam(candidate.url, candidate.quality);
    console.log(`[resolve] trying ${candidate.quality} ${candidate.hash || "nohash"}: ${resolveUrl} ref=${referer}`);

    let res = null;
    try {
      res = await doFetch(resolveUrl, {
        headers: {
          "User-Agent": HEADERS["User-Agent"],
          "Accept": "*/*",
          "Accept-Language": "en-US,en;q=0.9",
          "Accept-Encoding": "identity;q=1, *;q=0",
          "Range": "bytes=0-",
          "Referer": referer,
          "Origin": BASE_URL,
          ...(cookieStr ? { Cookie: cookieStr } : {}),
          "Sec-Fetch-Dest": "video",
          "Sec-Fetch-Mode": "no-cors",
          "Sec-Fetch-Site": "same-origin",
        },
        redirect: "manual",
      }, true);

      const location = res.headers.get("location");
      const contentType = res.headers.get("content-type") || "";
      const status = res.status;

      // Avoid leaving a response stream open if the server unexpectedly returns bytes.
      res.body?.destroy?.();

      console.log(`[resolve] status=${status} location=${location || "(none)"}`);

      if (location) {
        const resolved = new URL(location, resolveUrl).toString();
        let decoded = resolved;
        try { decoded = decodeURIComponent(resolved); } catch {}

        if (/\/remote_control\.php\?/i.test(resolved) && /\.mp4/i.test(decoded)) {
          console.log(`[resolve] ✅ ${candidate.quality} remote_control: ${decoded}`);
          return resolved;
        }

        if (/\.mp4(?:[?#]|$)/i.test(decoded)) {
          console.log(`[resolve] ✅ ${candidate.quality} direct mp4 redirect: ${decoded}`);
          return resolved;
        }
      }

      if ((status === 200 || status === 206) && /video|octet-stream/i.test(contentType)) {
        console.log(`[resolve] ✅ ${candidate.quality} get_file itself appears playable`);
        return resolveUrl;
      }
    } catch (e) {
      res?.body?.destroy?.();
      console.log(`[resolve] error for ${candidate.quality}: ${e.message}`);
    }
  }

  console.log(`[resolve] ❌ unusable ${candidate.quality}: ${candidate.url}`);
  return null;
}

function getFilePathForDedupe(u) {
  try {
    const match = String(u || "").match(/[?&]file=([^&]+)/i);
    return match ? decodeURIComponent(match[1]) : String(u || "");
  } catch {
    return String(u || "");
  }
}

function replaceQualityWith1080(value) {
  const s = String(value || "");
  if (!/_(720p|480p|360p)\.mp4/i.test(s)) return null;
  return s.replace(/_(720p|480p|360p)\.mp4/i, "_1080p.mp4");
}

function deriveFast1080CandidateFromResolvedUrl(resolvedUrl) {
  if (!resolvedUrl) return null;

  let decoded = String(resolvedUrl);
  try { decoded = decodeURIComponent(decoded); } catch {}

  try {
    const u = new URL(resolvedUrl);

    // Case 1: direct storage URL:
    // https://st33.pimpbunny.com/videos/562000/562845/562845_720p.mp4
    if (/\.mp4(?:[?#]|$)/i.test(decoded) && !/\/remote_control\.php/i.test(u.pathname)) {
      const upgradedPath = replaceQualityWith1080(u.pathname);
      if (!upgradedPath || upgradedPath === u.pathname) return null;

      u.pathname = upgradedPath;
      u.search = "";
      return u.toString();
    }

    // Case 2: signed remote_control URL:
    // Try direct path on same media host, but verify before using.
    if (/\/remote_control\.php/i.test(u.pathname)) {
      const file = u.searchParams.get("file");
      if (!file) return null;

      const upgradedFile = replaceQualityWith1080(file);
      if (!upgradedFile || upgradedFile === file) return null;

      const path = upgradedFile.startsWith("/") ? upgradedFile : `/${upgradedFile}`;
      return `${u.protocol}//${u.host}${path}`;
    }
  } catch {}

  return null;
}

async function verifyFast1080Url(candidateUrl, pageUrl, cookieStr) {
  if (!candidateUrl) return null;

  let decoded = String(candidateUrl);
  try { decoded = decodeURIComponent(decoded); } catch {}

  if (!/_1080p\.mp4/i.test(decoded)) return null;

  console.log(`[fast-1080p] verifying candidate: ${decoded}`);

  let res = null;
  try {
    res = await doFetch(candidateUrl, {
      headers: {
        "User-Agent": HEADERS["User-Agent"],
        "Accept": VIDEO_HEADERS.Accept,
        "Accept-Language": "en-US,en;q=0.9",
        "Accept-Encoding": "identity;q=1, *;q=0",
        "Range": "bytes=0-0",
        "Referer": pageUrl,
        "Origin": BASE_URL,
        ...(cookieStr ? { Cookie: cookieStr } : {}),
      },
      redirect: "manual",
    }, true);

    const status = res.status;
    const location = res.headers.get("location");
    const contentType = res.headers.get("content-type") || "";
    const contentRange = res.headers.get("content-range") || "";
    const acceptRanges = res.headers.get("accept-ranges") || "";

    res.body?.destroy?.();

    console.log(`[fast-1080p] status=${status} location=${location || "(none)"}`);

    if (location) {
      const resolved = new URL(location, candidateUrl).toString();

      let resolvedDecoded = resolved;
      try { resolvedDecoded = decodeURIComponent(resolved); } catch {}

      if (/_1080p\.mp4/i.test(resolvedDecoded) && (/\.mp4/i.test(resolvedDecoded) || /remote_control\.php/i.test(resolvedDecoded))) {
        console.log(`[fast-1080p] ✅ verified via redirect: ${resolvedDecoded}`);
        return resolved;
      }
    }

    const looksLikeMedia =
      /video|octet-stream/i.test(contentType) ||
      /bytes/i.test(contentRange) ||
      /bytes/i.test(acceptRanges);

    if ((status === 200 || status === 206) && looksLikeMedia) {
      console.log(`[fast-1080p] ✅ verified direct 1080p: ${decoded}`);
      return candidateUrl;
    }
  } catch (e) {
    res?.body?.destroy?.();
    console.log(`[fast-1080p] verify failed: ${e.message}`);
  }

  console.log(`[fast-1080p] ❌ candidate not usable`);
  return null;
}

async function tryFast1080FromFallback(videoUrls, pageUrl, cookieStr) {
  for (const fallbackUrl of videoUrls || []) {
    const candidate = deriveFast1080CandidateFromResolvedUrl(fallbackUrl);
    if (!candidate) continue;

    const verified = await verifyFast1080Url(candidate, pageUrl, cookieStr);
    if (verified) return verified;
  }

  return null;
}


function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function cookiesFromHeader(cookieStr) {
  return String(cookieStr || "")
    .split(";")
    .map(c => c.trim())
    .filter(Boolean)
    .map(pair => {
      const eq = pair.indexOf("=");
      if (eq <= 0) return null;
      return {
        name: pair.slice(0, eq).trim(),
        value: pair.slice(eq + 1).trim(),
        url: BASE_URL,
      };
    })
    .filter(c => c && c.name);
}

function isBrowserConnected(browser) {
  if (!browser) return false;
  if (typeof browser.isConnected === "function") return browser.isConnected();
  return !!browser.connected;
}

function getCachedBrowser1080p(cacheKey) {
  const cached = browser1080pCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    console.log(`[browser-1080p] cache hit for ${cacheKey}`);
    return cached.value;
  }
  if (cached) browser1080pCache.delete(cacheKey);
  return null;
}

function setCachedBrowser1080p(cacheKey, value) {
  browser1080pCache.set(cacheKey, {
    value,
    expiresAt: Date.now() + BROWSER_1080P_CACHE_MS,
  });
}

async function closeSharedBrowser(reason = "idle") {
  if (browserIdleTimer) {
    clearTimeout(browserIdleTimer);
    browserIdleTimer = null;
  }

  const browser = sharedBrowser;
  sharedBrowser = null;
  sharedBrowserLaunchPromise = null;

  if (browser) {
    console.log(`[browser-1080p] closing shared browser: ${reason}`);
    await browser.close().catch(() => {});
  }
}

function scheduleSharedBrowserIdleClose() {
  if (browserIdleTimer) clearTimeout(browserIdleTimer);

  browserIdleTimer = setTimeout(() => {
    if (activeBrowserJobs > 0) {
      console.log(`[browser-1080p] idle close skipped; ${activeBrowserJobs} active browser job(s)`);
      scheduleSharedBrowserIdleClose();
      return;
    }

    closeSharedBrowser("idle-timeout").catch(() => {});
  }, BROWSER_IDLE_TTL_MS);
}

async function getSharedBrowser() {
  cancelSharedBrowserIdleClose();

  if (isBrowserConnected(sharedBrowser)) return sharedBrowser;
  if (sharedBrowserLaunchPromise) return sharedBrowserLaunchPromise;

  let puppeteer;
  try {
    puppeteer = require("puppeteer-core");
  } catch (e) {
    console.log(`[browser-1080p] puppeteer-core not installed: ${e.message}`);
    return null;
  }

  const launchArgs = [
    "--no-sandbox",
    "--disable-setuid-sandbox",
    "--disable-dev-shm-usage",
    "--disable-gpu",
    "--disable-extensions",
    "--disable-background-networking",
    "--disable-sync",
    "--disable-default-apps",
    "--disable-component-update",
    "--disable-features=Translate,BackForwardCache,AcceptCHFrame,MediaRouter,OptimizationHints,Prerender2",
    "--disable-renderer-backgrounding",
    "--disable-background-timer-throttling",
    "--disable-backgrounding-occluded-windows",
    "--disable-breakpad",
    "--disable-client-side-phishing-detection",
    "--disable-popup-blocking",
    "--disable-prompt-on-repost",
    "--metrics-recording-only",
    "--mute-audio",
    "--no-first-run",
    "--no-default-browser-check",
    "--password-store=basic",
    "--use-mock-keychain",
    "--autoplay-policy=no-user-gesture-required",
    "--disable-blink-features=AutomationControlled",
  ];

  let proxyAuth = null;
  if (PROXY_URL) {
    try {
      const p = new URL(PROXY_URL);
      launchArgs.push(`--proxy-server=${p.protocol}//${p.hostname}:${p.port}`);
      if (p.username || p.password) {
        proxyAuth = {
          username: decodeURIComponent(p.username || ""),
          password: decodeURIComponent(p.password || ""),
        };
      }
      console.log(`[browser-1080p] using proxy ${p.protocol}//${p.hostname}:${p.port}`);
    } catch (e) {
      console.log(`[browser-1080p] proxy parse error: ${e.message}`);
    }
  }

  sharedBrowserLaunchPromise = puppeteer.launch({
    executablePath: PUPPETEER_EXECUTABLE_PATH,
    headless: true,
    args: launchArgs,
    protocolTimeout: BROWSER_1080P_TIMEOUT_MS,
    timeout: BROWSER_1080P_TIMEOUT_MS,
  }).then(browser => {
    sharedBrowser = browser;
    sharedBrowserLaunchPromise = null;
    browser.__proxyAuth = proxyAuth;

    browser.once("disconnected", () => {
      console.log("[browser-1080p] shared browser disconnected");
      sharedBrowser = null;
      sharedBrowserLaunchPromise = null;
    });

    return browser;
  }).catch(e => {
    sharedBrowser = null;
    sharedBrowserLaunchPromise = null;
    console.log(`[browser-1080p] launch error: ${e.message}`);
    return null;
  });

  return sharedBrowserLaunchPromise;
}

function enqueueBrowserJob(fn) {
  const result = browserJobQueue.then(fn, fn);
  browserJobQueue = result.catch(() => {});
  return result;
}

function getActive1080pPrewarm(pageUrl, videoId) {
  if (!pageUrl || !videoId) return null;

  const cacheKey = browser1080pKey(videoId, pageUrl);
  const entry = browser1080pPrewarmCache.get(cacheKey);

  if (!entry) return null;

  if (entry.expiresAt <= Date.now()) {
    if (!entry.controller.signal.aborted) {
      entry.controller.abort("prewarm expired");
    }
    browser1080pPrewarmCache.delete(cacheKey);
    return null;
  }

  return entry;
}

function abort1080pPrewarm(pageUrl, videoId, reason = "not needed") {
  const entry = getActive1080pPrewarm(pageUrl, videoId);
  if (!entry) return;

  console.log(`[prewarm-1080p] aborting ${entry.id || entry.cacheKey}: ${reason}`);

  if (!entry.controller.signal.aborted) {
    entry.controller.abort(reason);
  }

  browser1080pPrewarmCache.delete(entry.cacheKey);
}

async function materializeBrowser1080p(browser1080p, pageUrl, cookieStr) {
  if (!browser1080p) return null;

  const browserCookieStr = mergeCookies(cookieStr, browser1080p.cookieStr);

  if (browser1080p.remoteControlUrl) {
    setPlaybackCookiesForUrl(browser1080p.remoteControlUrl, browserCookieStr);

    return {
      url: browser1080p.remoteControlUrl,
      cookieStr: browserCookieStr,
    };
  }

  if (browser1080p.getFileUrl) {
    const resolvedBrowserGetFile = await resolveCapturedBrowserGetFile(
      browser1080p.getFileUrl,
      pageUrl,
      browserCookieStr
    );

    if (resolvedBrowserGetFile) {
      setPlaybackCookiesForUrl(resolvedBrowserGetFile, browserCookieStr);

      return {
        url: resolvedBrowserGetFile,
        cookieStr: browserCookieStr,
      };
    }
  }

  return null;
}

function start1080pPrewarm({ id, pageUrl, videoId, cookieStr }) {
  if (!ENABLE_META_1080P_PREWARM) return null;
  if (!ENABLE_BROWSER_1080P) return null;
  if (!pageUrl || !videoId) return null;

  const cacheKey = browser1080pKey(videoId, pageUrl);

  if (getCachedBrowser1080p(cacheKey)) {
    console.log(`[prewarm-1080p] browser cache already has ${cacheKey}`);
    return null;
  }

  const existing = getActive1080pPrewarm(pageUrl, videoId);
  if (existing) {
    console.log(`[prewarm-1080p] already running for ${id}`);
    return existing;
  }

  const controller = new AbortController();

  const entry = {
    id,
    cacheKey,
    pageUrl,
    videoId,
    controller,
    expiresAt: Date.now() + PREWARM_1080P_TTL_MS,
    promise: null,
  };

  entry.promise = (async () => {
    console.log(`[prewarm-1080p] starting for ${id}`);

    const browser1080p = await resolve1080pViaTinyBrowser(pageUrl, videoId, cookieStr, {
      signal: controller.signal,
      prewarm: true,
    });

    if (controller.signal.aborted) {
      console.log(`[prewarm-1080p] aborted for ${id}`);
      return null;
    }

    const materialized = await materializeBrowser1080p(browser1080p, pageUrl, cookieStr);

    if (materialized?.url) {
      console.log(`[prewarm-1080p] ✅ ready for ${id}: ${materialized.url.substring(0, 100)}`);

      const cachedMeta = metaCache.get(id);
      if (cachedMeta?.meta) {
        metaCache.set(id, {
          ...cachedMeta,
          videoUrl: materialized.url,
          videoUrls: [materialized.url],
          cookieStr: materialized.cookieStr || cachedMeta.cookieStr || cookieStr,
          updatedAt: Date.now(),
        });
      }

      return materialized;
    }

    console.log(`[prewarm-1080p] no 1080p result for ${id}`);
    return null;
  })()
    .catch(e => {
      console.log(`[prewarm-1080p] error for ${id}: ${e.message}`);
      return null;
    })
    .finally(() => {
      setTimeout(() => {
        if (browser1080pPrewarmCache.get(cacheKey) === entry) {
          browser1080pPrewarmCache.delete(cacheKey);
        }
      }, 30 * 1000).unref?.();
    });

  browser1080pPrewarmCache.set(cacheKey, entry);
  return entry;
}

async function resolve1080pViaTinyBrowser(pageUrl, videoId, cookieStr, options = {}) {
  const signal = options.signal || null;
  if (!ENABLE_BROWSER_1080P) {
    console.log("[browser-1080p] disabled");
    return null;
  }

  if (!pageUrl || !videoId) return null;
  if (signal?.aborted) {
  console.log(`[browser-1080p] aborted before start: ${signal.reason || "no reason"}`);
  return null;
}

  const cacheKey = browser1080pKey(videoId, pageUrl);
  const cached = getCachedBrowser1080p(cacheKey);
  if (cached) return cached;

  return enqueueBrowserJob(async () => {
  activeBrowserJobs++;
  cancelSharedBrowserIdleClose();
  if (signal?.aborted) {
  console.log(`[browser-1080p] aborted before queued job started: ${signal.reason || "no reason"}`);
  activeBrowserJobs = Math.max(0, activeBrowserJobs - 1);
  scheduleSharedBrowserIdleClose();
  return null;
}

  const cachedInsideQueue = getCachedBrowser1080p(cacheKey);
  if (cachedInsideQueue) {
    activeBrowserJobs = Math.max(0, activeBrowserJobs - 1);
    scheduleSharedBrowserIdleClose();
    return cachedInsideQueue;
  }

  let context = null;
let page = null;
let getFileGraceTimer = null;
let onAbort = null;

try {
      // IMPORTANT:
      // Launch can be slow on Render cold starts. Do not count launch time
      // against the page/player runtime budget.
      const browser = await getSharedBrowser();
      if (!browser) return null;

      const startedAt = Date.now();
const deadline = startedAt + BROWSER_1080P_TIMEOUT_MS;
const timeLeft = () => Math.max(0, deadline - Date.now());

      context = browser.createBrowserContext
        ? await browser.createBrowserContext()
        : await browser.createIncognitoBrowserContext();

      page = await context.newPage();

      page.setDefaultTimeout(Math.min(8000, timeLeft()));
      page.setDefaultNavigationTimeout(Math.min(8000, timeLeft()));

      if (browser.__proxyAuth) {
        await page.authenticate(browser.__proxyAuth);
      }

      await page.setUserAgent(HEADERS["User-Agent"]);

      await page.setViewport({
        width: 390,
        height: 844,
        deviceScaleFactor: 2,
        isMobile: true,
        hasTouch: true,
      });

      await page.setExtraHTTPHeaders({
        "Accept-Language": "en-US,en;q=0.9",
        "Sec-GPC": "1",
      });

      const seededCookies = cookiesFromHeader(cookieStr);
      if (seededCookies.length) {
        const setCookieTarget = typeof context.setCookie === "function" ? context : page;

        await setCookieTarget.setCookie(...seededCookies).catch(e => {
          console.log(`[browser-1080p] cookie seed error: ${e.message}`);
        });

        console.log(`[browser-1080p] seeded ${seededCookies.length} cookie(s)`);
      }

      // This must run before the site's player scripts read localStorage.
      await page.evaluateOnNewDocument(() => {
  try {
    localStorage.setItem("kvsplayer_selected_format", "1080p");
    localStorage.setItem("volume", "1");
  } catch {}

  const pokePlayer = () => {
    try {
      localStorage.setItem("kvsplayer_selected_format", "1080p");

      const player = document.querySelector("#kt_player");
      if (player) {
        player.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
        player.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
        player.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
        player.click();
      }

      const video = document.querySelector("video");
      if (video) {
        video.muted = true;
        video.volume = 0;
        video.play().catch(() => null);
      }
    } catch {}
  };

  window.addEventListener("DOMContentLoaded", () => {
    pokePlayer();
    setTimeout(pokePlayer, 250);
    setTimeout(pokePlayer, 750);
    setTimeout(pokePlayer, 1500);
  });
});

      const found = {
  remoteControlUrl: null,
  getFileUrl: null,
};

let foundDoneReason = null;
let resolveFound;

const foundPromise = new Promise(resolve => {
  resolveFound = resolve;
});

    

const finishFound = (reason) => {
  foundDoneReason = reason;

  if (resolveFound) {
    const fn = resolveFound;
    resolveFound = null;
    fn(reason);
  }
};

const abortPromise = signal
  ? new Promise(resolve => {
      onAbort = () => {
        console.log(`[browser-1080p] abort requested: ${signal.reason || "no reason"}`);
        finishFound("abort");

        if (page) page.close().catch(() => {});
        if (context) context.close().catch(() => {});

        resolve("abort");
      };

      if (signal.aborted) {
        onAbort();
      } else {
        signal.addEventListener("abort", onAbort, { once: true });
      }
    })
  : null;

const scheduleGetFileGraceResolve = () => {
  if (getFileGraceTimer) clearTimeout(getFileGraceTimer);

  getFileGraceTimer = setTimeout(() => {
    if (found.getFileUrl && !found.remoteControlUrl) {
      console.log(`[browser-1080p] get_file grace elapsed; resolving captured get_file`);
      finishFound("get_file");
    }
  }, GETFILE_CAPTURE_GRACE_MS);

  getFileGraceTimer.unref?.();
};

const considerUrl = (rawUrl, source) => {
  if (!rawUrl) return;

  let decoded = rawUrl;
  try {
    decoded = decodeURIComponent(rawUrl);
  } catch {}

  if (!decoded.includes(String(videoId))) return;

  if (/\/remote_control\.php\?/i.test(rawUrl) && /_1080p\.mp4/i.test(decoded)) {
    if (!found.remoteControlUrl) {
      found.remoteControlUrl = rawUrl;
      console.log(`[browser-1080p] captured 1080p remote_control from ${source}: ${decoded}`);
      finishFound("remote");
    }
    return;
  }

  if (/\/get_file\//i.test(rawUrl) && /_1080p\.mp4/i.test(decoded)) {
    if (!found.getFileUrl) {
      found.getFileUrl = rawUrl;
      console.log(`[browser-1080p] captured 1080p get_file from ${source}: ${decoded}`);

      // Wait briefly for Chromium to expose a 302 Location header.
      // If it does not, resolve the captured get_file ourselves.
      scheduleGetFileGraceResolve();
    }
  }
};

      page.on("response", res => {
        const responseUrl = res.url();

        if (/\/get_file\/|\/remote_control\.php\?/i.test(responseUrl)) {
          let decoded = responseUrl;
          try {
            decoded = decodeURIComponent(responseUrl);
          } catch {}
          console.log(`[browser-1080p] saw response: ${decoded}`);
        }

        considerUrl(responseUrl, "response");

        const location = res.headers()?.location;
        if (location) {
          try {
            considerUrl(new URL(location, responseUrl).toString(), "response-location");
          } catch {}
        }
      });

      await page.setRequestInterception(true);

      page.on("request", req => {
        const reqUrl = req.url();
        const type = req.resourceType();

        if (/\/get_file\/|\/remote_control\.php\?/i.test(reqUrl)) {
          let decoded = reqUrl;
          try {
            decoded = decodeURIComponent(reqUrl);
          } catch {}
          console.log(`[browser-1080p] saw request ${type}: ${decoded}`);
        }

        considerUrl(reqUrl, "request");

        // Capture signed URL, but do not download video bytes.
        if (/\/remote_control\.php\?/i.test(reqUrl)) {
          return req.abort().catch(() => {});
        }

        // Save bandwidth/CPU.
        if (["image", "font"].includes(type)) {
          return req.abort().catch(() => {});
        }

        if (/google-analytics|googletagmanager|doubleclick|analytics|adsystem|adservice|exoclick|trafficjunky|popads|juicyads/i.test(reqUrl)) {
          return req.abort().catch(() => {});
        }

        // Let player scripts/XHR run. For media, allow only get_file.
        if (type === "media" && !/\/get_file\//i.test(reqUrl)) {
          return req.abort().catch(() => {});
        }

        return req.continue().catch(() => {});
      });

            const isFound = () => signal?.aborted || !!found.remoteControlUrl || !!foundDoneReason;

      const remaining = (maxMs) => {
        const left = deadline - Date.now();
        if (left <= 0) return 0;
        return Math.min(maxMs, left);
      };

      const hasBudget = (label, minMs = 800) => {
        const left = deadline - Date.now();
        if (left < minMs) {
          console.log(`[browser-1080p] budget exhausted before ${label}: ${left}ms left`);
          return false;
        }
        return true;
      };

      const waitOrFound = async (ms) => {
  const waitMs = remaining(ms);
  if (waitMs <= 0 || isFound()) return;

  const racers = [sleep(waitMs), foundPromise];
  if (abortPromise) racers.push(abortPromise);

  await Promise.race(racers);
};

      const runFlow = async () => {
  const runPlayerAttempt = async (targetUrl, referer, label) => {
    console.log(`[browser-1080p] opening ${label}: ${targetUrl}`);

    if (!hasBudget(`goto ${label}`, 3000)) return;

    await page.goto(targetUrl, {
      referer,
      waitUntil: "domcontentloaded",
      timeout: remaining(10000),
    }).catch(e => {
      console.log(`[browser-1080p] goto ${label} warning: ${e.message}`);
    });

    // Avoid old resource entries from a previous attempt on the same page.
    await page.evaluate(() => {
      try { performance.clearResourceTimings(); } catch {}
    }).catch(() => {});

    if (isFound()) return;
    if (!hasBudget(`localStorage force ${label}`, 1000)) return;

    const selectedFormat = await page.evaluate(() => {
      try {
        localStorage.setItem("kvsplayer_selected_format", "1080p");
        localStorage.setItem("volume", "1");
        return localStorage.getItem("kvsplayer_selected_format");
      } catch (e) {
        return `ERROR:${e.message}`;
      }
    }).catch(e => `ERROR:${e.message}`);

    console.log(`[browser-1080p] ${label} localStorage selected_format=${selectedFormat || "(none)"}`);

    await waitOrFound(500);
    if (isFound()) return;

    if (!hasBudget(`player start ${label}`, 1000)) return;

    await page.click("#kt_player").catch(() => {});
    await page.mouse.click(200, 300).catch(() => {});

    await waitOrFound(900);
    if (isFound()) return;

    if (!hasBudget(`quality click ${label}`, 1200)) return;

    const clicked1080p = await page.evaluate(() => {
      const isVisible = (el) => {
        const r = el.getBoundingClientRect();
        const s = window.getComputedStyle(el);
        return r.width > 0 && r.height > 0 && s.visibility !== "hidden" && s.display !== "none";
      };

      const clickEl = (el) => {
        try {
          el.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
          el.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
          el.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
          el.click();
          return true;
        } catch {
          return false;
        }
      };

      const all = [...document.querySelectorAll("button, a, li, div, span")];

      const direct1080 = all.find(el =>
        isVisible(el) &&
        /\b1080p\b/i.test((el.textContent || "").trim())
      );

      if (direct1080) {
        return clickEl(direct1080);
      }

      const menuCandidates = all.filter(el => {
        const txt = (el.textContent || "").trim();
        const cls = `${el.className || ""} ${el.id || ""}`;
        const aria = `${el.getAttribute("aria-label") || ""} ${el.getAttribute("title") || ""}`;

        return isVisible(el) && (
          /quality|settings|gear|resolution|hd/i.test(txt) ||
          /quality|settings|gear|resolution|hd/i.test(cls) ||
          /quality|settings|gear|resolution|hd/i.test(aria)
        );
      });

      for (const el of menuCandidates.slice(0, 12)) {
        clickEl(el);
      }

      const afterOpen1080 = [...document.querySelectorAll("button, a, li, div, span")]
        .find(el =>
          isVisible(el) &&
          /\b1080p\b/i.test((el.textContent || "").trim())
        );

      if (afterOpen1080) {
        return clickEl(afterOpen1080);
      }

      return false;
    }).catch(e => {
      console.log(`[browser-1080p] ${label} quality click error: ${e.message}`);
      return false;
    });

    console.log(`[browser-1080p] ${label} clicked 1080p option: ${clicked1080p}`);

    await waitOrFound(700);
    if (isFound()) return;

    if (!hasBudget(`playback nudge ${label}`, 1000)) return;

    await page.evaluate(() => {
      const video = document.querySelector("video");
      if (video) {
        video.muted = true;
        video.volume = 0;
        return video.play().catch(() => null);
      }
      return null;
    }).catch(() => {});

    await page.mouse.click(200, 300).catch(() => {});

    await waitOrFound(3500);
    if (isFound()) return;

    if (!hasBudget(`performance scan ${label}`, 500)) return;

    const perfUrls = await page.evaluate(() =>
      performance.getEntriesByType("resource").map(e => e.name).filter(Boolean)
    ).catch(() => []);

    for (const u of perfUrls) {
      considerUrl(u, `performance:${label}`);
    }
  };

  if (ENABLE_BROWSER_EMBED_FIRST) {
  await runPlayerAttempt(`${BASE_URL}/embed/${videoId}`, pageUrl, "embed player");
} else {
  console.log("[browser-1080p] browser embed attempt skipped; going straight to full page");
}

if (!isFound()) {
  await runPlayerAttempt(pageUrl, BASE_URL + "/", "full page");
}
};

      // Do not race runFlow against sleep(timeout).
      // Promise.race does not cancel runFlow, which was causing detached Frame errors
      // when the page/context closed while quality-click code was still running.
      await runFlow();
	  if (signal?.aborted || foundDoneReason === "abort") {
  console.log(`[browser-1080p] stopped by abort signal`);
  return null;
}

      const getCookiesTarget = typeof context.cookies === "function" ? context : page;
      const cookies = await getCookiesTarget.cookies(BASE_URL).catch(() => []);
      const newCookieStr = mergeCookies(cookieStr, cookies.map(c => `${c.name}=${c.value}`).join("; "));

      if (found.remoteControlUrl || found.getFileUrl) {
        const value = {
          remoteControlUrl: found.remoteControlUrl,
          getFileUrl: found.getFileUrl,
          cookieStr: newCookieStr,
        };

        setCachedBrowser1080p(cacheKey, value);
        return value;
      }

      console.log("[browser-1080p] no 1080p runtime URL captured");
      return null;
    } catch (e) {
      console.log(`[browser-1080p] error: ${e.message}`);
      return null;
    } finally {
  if (getFileGraceTimer) clearTimeout(getFileGraceTimer);
  if (signal && onAbort) {
  signal.removeEventListener("abort", onAbort);
}
  if (page) await page.close().catch(() => {});
  if (context) await context.close().catch(() => {});

  activeBrowserJobs = Math.max(0, activeBrowserJobs - 1);
  scheduleSharedBrowserIdleClose();
}
  });
}

async function resolveCapturedBrowserGetFile(getFileUrl, pageUrl, cookieStr) {
  if (!getFileUrl) return null;

  try {
    const resolveUrl = addRndParam(getFileUrl, "1080p");
    console.log(`[browser-1080p] resolving captured get_file: ${resolveUrl}`);

    const res = await doFetch(resolveUrl, {
      headers: {
        "User-Agent": HEADERS["User-Agent"],
        "Accept": "*/*",
        "Accept-Language": "en-US,en;q=0.9",
        "Accept-Encoding": "identity;q=1, *;q=0",
        "Range": "bytes=0-",
        "Referer": pageUrl,
        "Origin": BASE_URL,
        ...(cookieStr ? { Cookie: cookieStr } : {}),
        "Sec-Fetch-Dest": "video",
        "Sec-Fetch-Mode": "no-cors",
        "Sec-Fetch-Site": "same-origin",
      },
      redirect: "manual",
    }, true);

    const location = res.headers.get("location");
    const contentType = res.headers.get("content-type") || "";
    const status = res.status;

    res.body?.destroy?.();

    console.log(`[browser-1080p] captured get_file status=${status} location=${location || "(none)"}`);

    if (location) {
      const resolved = new URL(location, resolveUrl).toString();

      let decoded = resolved;
      try {
        decoded = decodeURIComponent(resolved);
      } catch {}

      if (/\/remote_control\.php\?/i.test(resolved) && /\.mp4/i.test(decoded)) {
        console.log(`[browser-1080p] ✅ captured get_file resolved to remote_control: ${decoded}`);
        return resolved;
      }

      if (/\.mp4(?:[?#]|$)/i.test(decoded)) {
        console.log(`[browser-1080p] ✅ captured get_file resolved to direct mp4: ${decoded}`);
        return resolved;
      }
    }

    if ((status === 200 || status === 206) && /video|octet-stream/i.test(contentType)) {
      console.log(`[browser-1080p] ✅ captured get_file itself appears playable`);
      return resolveUrl;
    }
  } catch (e) {
    console.log(`[browser-1080p] captured get_file resolve error: ${e.message}`);
  }

  return null;
}

function has1080pUrl(urls) {
  return urls.some(u => {
    let decoded = String(u || "");
    try { decoded = decodeURIComponent(decoded); } catch {}
    return /_1080p\.mp4/i.test(decoded);
  });
}

async function resolveVideoUrlsFromHtml(html, pageUrl, videoId, cookieStr, options = {}) {
  const id = options.id || null;
  let candidates = collectAllGetFileCandidates(html, videoId, "raw-html");

  candidates.sort((a, b) => {
    const q = qualityRank(a.quality) - qualityRank(b.quality);
    if (q !== 0) return q;
    return a.hash.localeCompare(b.hash);
  });

  console.log(`[meta] get_file candidates: ${candidates.map(c => `${c.quality}:${c.hash || "nohash"}:${c.source}`).join(", ") || "(none)"}`);

  if (DEBUG_VERBOSE) {
    for (const c of candidates) {
      console.log(`[meta] candidate ${c.quality} hash=${c.hash} source=${c.source} url=${c.url}`);
    }
  }

  const browserCanTry1080 = ENABLE_BROWSER_1080P && !!videoId;
  const videoUrls = [];

  const dedupeUrls = (urls) => {
    const seenPaths = new Set();

    return urls.filter(u => {
      const path = getFilePathForDedupe(u);
      if (seenPaths.has(path)) return false;
      seenPaths.add(path);
      return true;
    });
  };

  const resolveFallbackCandidates = async (sourceCandidates, label) => {
    const resolveList = sourceCandidates.slice(0, MAX_RESOLVE_CANDIDATES);

    console.log(
      `[meta] ${label} resolve list: ${
        resolveList.map(c => `${c.quality}:${getQualSuffix(c.url)}`).join(", ") || "(none)"
      } (kept ${resolveList.length}/${sourceCandidates.length})`
    );

    for (const candidate of resolveList) {
      const resolved = await resolveGetFileCandidate(candidate, pageUrl, cookieStr, videoId);

      if (resolved) {
        videoUrls.push(resolved);

        // One fallback is enough. Stop before probing stale duplicate 720p/480p URLs.
        if (browserCanTry1080 && !has1080pUrl([resolved])) {
          console.log(`[meta] fallback captured; skipping more lightweight probes`);
          break;
        }
      }
    }
  };

  // First: use only raw page candidates. In your working logs, this gives the good 720p fallback.
  await resolveFallbackCandidates(candidates, "raw");

  // Only fetch /embed/<id> if raw fallback failed. This saves one request on the normal working path.
  if (videoUrls.length === 0 && ENABLE_EMBED_FALLBACK && videoId) {
    console.log("[embed] raw fallback failed; fetching embed fallback");

    const embedCandidates = await fetchEmbedCandidates(videoId, pageUrl, cookieStr);
    const seen = new Set(candidates.map(c => `${c.quality}:${c.hash}:${c.url}`));

    const uniqueEmbedCandidates = [];
    for (const c of embedCandidates) {
      const key = `${c.quality}:${c.hash}:${c.url}`;
      if (!seen.has(key)) {
        seen.add(key);
        uniqueEmbedCandidates.push(c);
      }
    }

    uniqueEmbedCandidates.sort((a, b) => {
      const q = qualityRank(a.quality) - qualityRank(b.quality);
      if (q !== 0) return q;
      return a.hash.localeCompare(b.hash);
    });

    await resolveFallbackCandidates(uniqueEmbedCandidates, "embed");
  } else if (ENABLE_EMBED_FALLBACK) {
    console.log("[embed] fallback skipped; raw fallback already available");
  }

  let deduped = dedupeUrls(videoUrls);
  if (has1080pUrl(deduped)) {
  abort1080pPrewarm(pageUrl, videoId, "lightweight 1080p resolved");
}

if (!has1080pUrl(deduped)) {
  const fast1080 = await tryFast1080FromFallback(deduped, pageUrl, cookieStr);

  if (fast1080) {
    console.log("[meta] ✅ fast direct 1080p verified; browser resolver skipped");
    abort1080pPrewarm(pageUrl, videoId, "fast 1080p verified");

    setPlaybackCookiesForUrl(fast1080, cookieStr);
    deduped.unshift(fast1080);
  }
}

// Before launching the browser, try fetching the embed page to get a fresh
// session-bound 1080p get_file hash — much faster than a full browser session.
if (browserCanTry1080 && !has1080pUrl(deduped) && videoId) {
  console.log("[meta] trying embed page for fresh 1080p hash before browser");
  const embedCookieStr = mergeCookies(cookieStr, deduped.length > 0 ? "" : "");
  const embedFor1080 = await fetchEmbedCandidates(videoId, pageUrl, cookieStr);
  const embed1080Candidates = embedFor1080.filter(c => c.quality === "1080p");

  for (const candidate of embed1080Candidates) {
    const resolved = await resolveGetFileCandidate(candidate, pageUrl, cookieStr, videoId);
    if (resolved) {
      console.log("[meta] ✅ embed page yielded fresh 1080p get_file");
      setPlaybackCookiesForUrl(resolved, cookieStr);
      deduped.unshift(resolved);
      break;
    }
  }
}

if (browserCanTry1080 && !has1080pUrl(deduped)) {
  const prewarmEntry = getActive1080pPrewarm(pageUrl, videoId);

  if (prewarmEntry) {
    console.log(`[meta] awaiting existing 1080p prewarm for ${id || videoId}`);

    const prewarmed = await prewarmEntry.promise;

    if (prewarmed?.url) {
      console.log("[meta] ✅ reused prewarmed 1080p");
      setPlaybackCookiesForUrl(prewarmed.url, prewarmed.cookieStr || cookieStr);
      deduped.unshift(prewarmed.url);
    } else {
      console.log("[meta] prewarm did not produce 1080p");
    }
  }
}

if (browserCanTry1080 && !has1080pUrl(deduped)) {
  console.log("[meta] no 1080p from lightweight/fast/prewarm; trying tiny browser resolver");

  const browser1080p = await resolve1080pViaTinyBrowser(pageUrl, videoId, cookieStr);
  const materialized = await materializeBrowser1080p(browser1080p, pageUrl, cookieStr);

  if (materialized?.url) {
    if (/remote_control\.php/i.test(materialized.url)) {
      console.log("[meta] ✅ tiny browser produced 1080p remote_control");
    } else {
      console.log("[meta] ✅ tiny browser get_file resolved to 1080p");
    }

    setPlaybackCookiesForUrl(materialized.url, materialized.cookieStr || cookieStr);
    deduped.unshift(materialized.url);
  } else {
    console.log("[meta] tiny browser did not produce usable 1080p");
  }
}
  const finalDeduped = dedupeUrls(deduped);

  console.log(
    `[meta] resolved ${finalDeduped.length} playable URL(s) ` +
    `(lightweight=${videoUrls.length}, final=${finalDeduped.length})`
  );

  return finalDeduped;
}

async function scrapeMetaById(id, options = {}) {
  const resolveStreams = options.resolveStreams === true;
  const slug = decodeId(id);
  const pageUrl = absoluteUrl(`/${slug}/`);
  const prefCookies = qualityPreferenceCookies(slug);

  console.log(`[meta] fetching page: ${pageUrl}`);
  const pageRes = await doFetch(pageUrl, {
    headers: {
      ...HEADERS,
      Cookie: prefCookies,
    },
  }, true);

  if (!pageRes.ok) throw new Error(`HTTP ${pageRes.status} for ${pageUrl}`);

  const html = await pageRes.text();
  const sessionCookies = getSetCookiePairs(pageRes);
  const cookieStr = mergeCookies(prefCookies, sessionCookies);

  console.log(`[meta] captured cookies: ${cookieStr || "(none)"}`);

  const $ = cheerio.load(html);
  const title =
    $("meta[property='og:title']").attr("content") ||
    $("h1.entry-title, h1").first().text().trim() ||
    slug.split("/").pop();

  const poster = absoluteUrl(
    $("meta[property='og:image']").attr("content") ||
    $("video").attr("poster") ||
    $("img").first().attr("src")
  );

  const description =
    $("meta[property='og:description']").attr("content") ||
    $(".entry-content p").first().text().trim() ||
    "PimpBunny video";

  const videoId = extractVideoIdFromHtml(html);
  console.log(`[meta] videoId=${videoId || "unknown"}`);

  const meta = {
    id,
    type: "movie",
    name: title,
    poster: poster || undefined,
    posterShape: "landscape",
    background: poster || undefined,
    description,
    website: pageUrl,
    videos: [{ id, title }],
  };

  if (!resolveStreams) {
  console.log(`[meta] metadata-only request; stream resolving skipped`);

  metaCache.set(id, {
    meta,
    videoId,
    pageUrl,
    videoUrl: null,
    videoUrls: [],
    cookieStr,
    updatedAt: Date.now(),
  });

  start1080pPrewarm({
    id,
    pageUrl,
    videoId,
    cookieStr,
  });

  return { meta, videoUrl: null, videoUrls: [], cookieStr };
}

  const videoUrls = await resolveVideoUrlsFromHtml(html, pageUrl, videoId, cookieStr, { id });
  const videoUrl = videoUrls[0] || null;

  metaCache.set(id, {
  meta,
  videoId,
  pageUrl,
  videoUrl,
  videoUrls,
  cookieStr,
  updatedAt: Date.now(),
});

  return { meta, videoUrl, videoUrls, cookieStr };
}

builder.defineCatalogHandler(async ({ type, id, extra }) => {
  if (type !== "movie") return { metas: [] };

  const cacheKey = JSON.stringify({
    id,
    skip: extra?.skip || 0,
    search: extra?.search || "",
    genre: extra?.genre || "",
  });

  try {
    const cached = catalogCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) {
      console.log(`[catalog] cache hit ${cacheKey}`);
      return { metas: cached.metas };
    }

    const metas = await fetchCatalogPage(id, extra?.skip || 0, extra?.search || "", extra?.genre || "");

    catalogCache.set(cacheKey, {
      metas,
      expiresAt: Date.now() + CATALOG_CACHE_MS,
    });

    return { metas };
  } catch (err) {
    console.error("Catalog error:", err.message);
    return { metas: [] };
  }
});

builder.defineMetaHandler(async ({ type, id }) => {
  if (type !== "movie") return { meta: null };

  try {
    const cached = metaCache.get(id);
    if (cached && cached.meta && Date.now() - cached.updatedAt < 10 * 60 * 1000) {
  if (!cached.videoUrls?.length && cached.videoId && cached.pageUrl && cached.cookieStr) {
    start1080pPrewarm({
      id,
      pageUrl: cached.pageUrl,
      videoId: cached.videoId,
      cookieStr: cached.cookieStr,
    });
  }

  return { meta: cached.meta };
}

    const { meta } = await scrapeMetaById(id, { resolveStreams: false });
    return { meta };
  } catch (err) {
    console.error("Meta error:", err.message);
    return {
      meta: {
        id,
        type: "movie",
        name: decodeId(id).split("/").pop() || "Video",
        website: absoluteUrl(`/${decodeId(id)}/`),
      },
    };
  }
});

function buildStreamObjects(videoUrls, pageUrl, cookieStr = "") {
  const qualityLabels = {
    "_1080p": "1080p",
    "_720p": "720p",
    "_480p": "480p",
    "_360p": "360p",
  };

  return videoUrls.map(u => {
    let decoded = u;
    try { decoded = decodeURIComponent(u); } catch {}

    const label = Object.entries(qualityLabels).find(([k]) => decoded.includes(k))?.[1] ?? "HD";

    // Always give Stremio the raw URL directly.
    // remote_control.php URLs are self-signed via query params (time/cv/cv2/cv3/cv4)
    // and do not require Referer or Cookie headers for playback — verified in logs.
    // Routing through /proxy only adds a Render relay hop that causes buffering.
	console.log(`[stream-build] direct stream ${label}: ${decoded.substring(0, 180)}`);
    return {
      name: "PimpBunny 🎥",
      title: label,
      url: u,
      behaviorHints: { notWebReady: false },
    };
  });
}

builder.defineStreamHandler(async ({ type, id }) => {
  if (type !== "movie") return { streams: [] };

  const pageUrl = absoluteUrl(`/${decodeId(id)}/`);

  try {
    const cached = metaCache.get(id);

    if (
      cached &&
      cached.videoUrls &&
      cached.videoUrls.length > 0 &&
      Date.now() - cached.updatedAt < STREAM_CACHE_MS
    ) {
      console.log(`[stream] short cache hit for ${id}`);
      const streams = buildStreamObjects(cached.videoUrls, pageUrl, cached.cookieStr || "");
      return { streams };
    }

    console.log(`[stream] fresh scrape for ${id}`);
    const { videoUrls, cookieStr } = await scrapeMetaById(id, { resolveStreams: true });

    if (!videoUrls || videoUrls.length === 0) {
      console.log(`[stream] no playable URLs found`);
      return { streams: [{ name: "PimpBunny 🔗", title: "Open Page", externalUrl: pageUrl }] };
    }

    const streams = buildStreamObjects(videoUrls, pageUrl, cookieStr || "");

    console.log(`[stream] returning ${streams.length} stream(s), first: ${streams[0]?.url?.substring(0, 80)}`);
    return { streams };
  } catch (err) {
    console.error(`[stream] error ${id}:`, err.message);
    return { streams: [{ name: "PimpBunny 🔗", title: "Open Page", externalUrl: pageUrl }] };
  }
});

const app = express();

app.get("/", (_req, res) => {
  const manifestUrl = PUBLIC_BASE_URL ? `${PUBLIC_BASE_URL}/manifest.json` : "/manifest.json";
  res.type("html").send(
    `<html><body><h1>PimpBunny Stremio Addon</h1><p>Install: <a href="${manifestUrl}">${manifestUrl}</a></p><p>Proxy: ${proxyAgent ? "enabled (" + PROXY_URL.replace(/:[^@]+@/, ":***@") + ")" : "disabled"}</p></body></html>`
  );
});

app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    proxy: !!proxyAgent,
    publicBaseUrl: PUBLIC_BASE_URL || null,
    browser1080p: ENABLE_BROWSER_1080P,
    chromiumPath: PUPPETEER_EXECUTABLE_PATH,
  });
});

app.get("/imgproxy", async (req, res) => {
  const target = req.query.url ? String(req.query.url).replace(/\+/g, "%2B") : null;
  if (!target) return res.status(400).send("missing url");

  try {
    const upstream = await doFetch(target, { headers: { ...HEADERS, Referer: BASE_URL + "/" } }, true);
    if (!upstream.ok) return res.status(upstream.status).send(`upstream ${upstream.status}`);

    res.setHeader("Content-Type", upstream.headers.get("content-type") || "image/jpeg");
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Cache-Control", "public, max-age=86400");
    upstream.body.pipe(res);
  } catch (e) {
    res.status(500).send(e.message);
  }
});

app.get("/proxy", async (req, res) => {
  const rawQuery = req._parsedUrl?.query || require("url").parse(req.url).query || "";

let decodedTarget = null;
let referer = BASE_URL + "/";
let proxyCookieStr = "";

const tokenMatch = rawQuery.match(/(?:^|&)(?:t|token)=([^&]*)/);

if (tokenMatch) {
  const token = decodeURIComponent(tokenMatch[1]);
  const tokenData = getStreamToken(token);

  if (!tokenData) {
    return res.status(410).type("text/plain").send("stream token expired");
  }

  decodedTarget = tokenData.targetUrl;
  referer = tokenData.referer || BASE_URL + "/";
  proxyCookieStr = tokenData.cookieStr || "";
} else {
  const urlMatch = rawQuery.match(/(?:^|&)url=([^&]*)/);
  const target = urlMatch ? urlMatch[1] : null;
  if (!target) return res.status(400).send("missing url");

  const refMatch = rawQuery.match(/(?:^|&)ref=([^&]*)/);
  referer = refMatch ? decodeURIComponent(refMatch[1]) : BASE_URL + "/";

  try {
    decodedTarget = decodeURIComponent(target);
  } catch (e) {
    console.warn(`[proxy] decode error: ${e.message}`);
    decodedTarget = target;
  }
}

  const isSegment = SEGMENT_RE.test(decodedTarget.split("?")[0]);
  const isRemoteControl = /\/remote_control\.php\?/i.test(decodedTarget);

  // Playback bytes are bandwidth-heavy. Do NOT send them through the outbound proxy.
// The outbound proxy should only be used for scraping/resolving pages, images, and lightweight checks.
const useProxy = false;

  console.log(`[proxy] target=${decodedTarget} isSegment=${isSegment} isRemoteControl=${isRemoteControl} useProxy=${useProxy}`);

  try {
    const fetchHeaders = {
  "User-Agent": HEADERS["User-Agent"],
  "Referer": referer,
  "Origin": BASE_URL,
  "Accept": VIDEO_HEADERS.Accept,
  "Accept-Language": "en-US,en;q=0.9",
  "Accept-Encoding": "identity;q=1, *;q=0",
  "Connection": "keep-alive",
  ...(proxyCookieStr ? { Cookie: proxyCookieStr } : {}),
};

    if (req.headers.range) {
      fetchHeaders.Range = req.headers.range;
      console.log(`[proxy] range: ${req.headers.range}`);
    }

    const upstream = await doFetch(decodedTarget, {
      headers: fetchHeaders,
      redirect: "follow",
    }, useProxy);
	console.log(
  `[proxy] upstream status=${upstream.status} ` +
  `type=${upstream.headers.get("content-type") || "(none)"} ` +
  `len=${upstream.headers.get("content-length") || "(none)"} ` +
  `range=${upstream.headers.get("content-range") || "(none)"}`
);

    if (!upstream.ok) {
      const errBody = await upstream.text().catch(() => "");
      console.error(`[proxy] upstream ${upstream.status} for ${decodedTarget} body: ${errBody.substring(0, 300)}`);
      return res.status(upstream.status).type("text/plain").send(`upstream error ${upstream.status}`);
    }

    res.status(upstream.status);

    for (const h of [
      "content-type",
      "content-length",
      "accept-ranges",
      "content-range",
      "cache-control",
      "last-modified",
      "etag",
    ]) {
      const val = upstream.headers.get(h);
      if (val) res.setHeader(h, val);
    }

    res.setHeader("Access-Control-Allow-Origin", "*");
    upstream.body.pipe(res);

    upstream.body.on("error", err => {
      console.error("[proxy] upstream body error:", err.message);
      if (!res.headersSent) {
        res.status(500).send("stream error");
      } else {
        res.destroy(err);
      }
    });
  } catch (e) {
    console.error(`[proxy] error: ${e.message}`);
    if (!res.headersSent) {
      res.status(500).send(e.message);
    } else {
      res.destroy(e);
    }
  }
});

app.use(getRouter(builder.getInterface()));
app.listen(PORT, () => {
  console.log(`PimpBunny addon listening on ${PORT} | proxy ${proxyAgent ? "enabled" : "disabled"}`);
});
