const { addonBuilder, getRouter } = require("stremio-addon-sdk");
const express = require("express");
const fetch = require("node-fetch");
const cheerio = require("cheerio");
const { HttpsProxyAgent } = require("https-proxy-agent");

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
const BROWSER_1080P_TIMEOUT_MS = Number(process.env.BROWSER_1080P_TIMEOUT_MS || 9000);
const BROWSER_1080P_CACHE_MS = Number(process.env.BROWSER_1080P_CACHE_MS || 180 * 1000);
const BROWSER_IDLE_TTL_MS = Number(process.env.BROWSER_IDLE_TTL_MS || 30 * 1000);
const PUPPETEER_EXECUTABLE_PATH = process.env.PUPPETEER_EXECUTABLE_PATH || "/usr/bin/chromium";

const browser1080pCache = new Map();
let sharedBrowser = null;
let sharedBrowserLaunchPromise = null;
let browserIdleTimer = null;
let browserJobQueue = Promise.resolve();

const GENRE_TAG_SLUGS = {
  "OnlyFans": ["onlyfans"],
  "Amateur": ["amateur"],
  "Milf": ["milf"],
  "Teen": ["teen"],
  "Anal": ["anal"],
  "Blowjob": ["blowjob"],
  "Lesbian": ["lesbian"],
  "Interracial": ["interracial"],
  "Solo": ["solo"],
  "BDSM": ["bdsm"],
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
          options: ["OnlyFans", "Amateur", "Milf", "Teen", "Anal", "Blowjob", "Lesbian", "Interracial", "Solo", "BDSM"],
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

setInterval(() => {
  const cutoff = Date.now() - 60 * 60 * 1000;
  for (const [key, val] of metaCache.entries()) {
    if (val.updatedAt < cutoff) metaCache.delete(key);
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

function makeIdFromPath(pathname) {
  return `pb:${pathname.replace(/^\/+|\/+$/g, "")}`;
}

function decodeId(id) {
  return String(id || "").replace(/^pb:/, "");
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

function extractPostCards(html, baseUrl) {
  const $ = cheerio.load(html);
  const siteBase = baseUrl || BASE_URL;
  const siteHostname = (() => {
    try { return new URL(siteBase).hostname; } catch { return ""; }
  })();

  const results = [];
  const seenHref = new Set();

  $("a[href]").each((_, el) => {
    const a = $(el);
    const rawHref = a.attr("href");
    if (!rawHref) return;

    let href;
    try { href = new URL(rawHref, siteBase).toString(); } catch { return; }

    let u;
    try {
      u = new URL(href);
      if (u.hostname !== siteHostname) return;
    } catch { return; }

    if (/^\/(page|tag|tags|category|categories|author|search|wp-|feed|#|genre|niche)/i.test(u.pathname)) return;
    if (/\/page\/\d+/i.test(u.pathname)) return;
    if (u.pathname === "/" || u.pathname === "") return;
    if (!/-/.test(u.pathname)) return;

    const segments = u.pathname.replace(/^\/|\/$/g, "").split("/");
    if (segments.length === 1 && segments[0].length < 5) return;

    if (seenHref.has(href)) return;
    seenHref.add(href);

    const container = a.closest(
      "article, .post, [class*='post'], [class*='item'], [class*='card'], [class*='thumb'], [class*='entry'], li, div"
    );

    const title =
      a.attr("title") ||
      container.find("h1, h2, h3, h4, [class*='title'], [class*='name']").first().text().trim() ||
      a.find("h1, h2, h3, h4, [class*='title']").first().text().trim() ||
      a.text().trim() ||
      segments[segments.length - 1].replace(/-/g, " ");

    if (!title || title.length < 3) return;
    if (/^(home|about|contact|blog|videos|models|categories|tags|search|login|register|privacy|terms|dmca|sitemap)$/i.test(title.trim())) return;

    const imgNode = container.find("img").first();
    const rawImg = absoluteUrl(
      imgNode.attr("data-src") ||
      imgNode.attr("data-lazy-src") ||
      imgNode.attr("data-original") ||
      imgNode.attr("data-thumb") ||
      (() => {
        const ss = imgNode.attr("srcset");
        if (!ss) return null;
        const m = ss.match(/https?:\/\/[^ ,]+/);
        return m ? m[0] : null;
      })() ||
      imgNode.attr("src")
    );

    const imgOk = rawImg && !/(placeholder|avatar|logo|icon|blank|spacer|pixel|\.gif)/i.test(rawImg);
    const img = imgOk
      ? (PUBLIC_BASE_URL ? `${PUBLIC_BASE_URL}/imgproxy?url=${encodeURIComponent(rawImg)}` : rawImg)
      : undefined;

    const description = container
      .find("[class*='desc'], [class*='excerpt'], [class*='summary'], p")
      .first().text().trim().substring(0, 200);

    const date =
      container.find("time").attr("datetime") ||
      container.find("[class*='date'], [class*='time']").first().text().trim();

    results.push({
      id: makeIdFromPath(u.pathname),
      type: "movie",
      name: title,
      poster: img,
      posterShape: "landscape",
      background: img,
      description: [date, description].filter(Boolean).join(" • "),
      website: href,
    });
  });

  const seen = new Set();
  const deduped = results.filter(x => x.id && !seen.has(x.id) && (seen.add(x.id), true));
  console.log(`[catalog] extractPostCards found ${deduped.length} items`);
  return deduped.slice(0, 24);
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
    const prefix = await getTaxonomyPrefix(GENRE_TAG_SLUGS[genre][0]);
    const allMetas = [];
    const seen = new Set();

    for (const slug of GENRE_TAG_SLUGS[genre]) {
      const urls = [
        `${BASE_URL}/${prefix}/${slug}/${page > 1 ? `page/${page}/` : ""}`,
        `${BASE_URL}/${prefix}/${slug}${page > 1 ? `/?paged=${page}` : "/"}`,
      ];

      for (const genreUrl of urls) {
        try {
          const html = await fetchHtml(genreUrl);
          const metas = extractPostCards(html);
          for (const m of metas) {
            if (!seen.has(m.id)) {
              seen.add(m.id);
              allMetas.push(m);
            }
          }
          if (allMetas.length > 0) break;
        } catch (err) {
          console.warn(`Genre "${slug}" @ ${genreUrl} failed: ${err.message}`);
        }
      }
    }

    if (allMetas.length > 0) return allMetas;
  }

  const candidates = [
    `${BASE_URL}/${page > 1 ? `?paged=${page}` : ""}`,
    `${BASE_URL}/${page > 1 ? `page/${page}` : ""}`,
    `${BASE_URL}/videos${page > 1 ? `?paged=${page}` : ""}`,
    `${BASE_URL}/videos/${page > 1 ? `page/${page}/` : ""}`,
  ];

  let lastError = null;
  for (const url of candidates) {
    try {
      const html = await fetchHtml(url);
      const metas = extractPostCards(html);
      if (metas.length > 0) return metas;
    } catch (err) {
      lastError = err;
      console.warn(`Catalog candidate failed: ${url} -> ${err.message}`);
    }
  }

  throw lastError || new Error("No catalog pages could be fetched");
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
  const sep = base.includes("?") ? "&" : "?";
  const resParam = ADD_RES_PARAM_FOR_1080 && quality === "1080p" ? "&res=1080p" : "";
  return `${base}${sep}rnd=${Date.now()}${resParam}`;
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
    closeSharedBrowser("idle-timeout").catch(() => {});
  }, BROWSER_IDLE_TTL_MS);
}

async function getSharedBrowser() {
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

async function resolve1080pViaTinyBrowser(pageUrl, videoId, cookieStr) {
  if (!ENABLE_BROWSER_1080P) {
    console.log("[browser-1080p] disabled");
    return null;
  }

  if (!pageUrl || !videoId) return null;

  const cacheKey = `${videoId}:${pageUrl}`;
  const cached = getCachedBrowser1080p(cacheKey);
  if (cached) return cached;

  return enqueueBrowserJob(async () => {
    const cachedInsideQueue = getCachedBrowser1080p(cacheKey);
    if (cachedInsideQueue) return cachedInsideQueue;

    let context = null;
    let page = null;

    try {
      // IMPORTANT:
      // Launch can be slow on Render cold starts. Do not count launch time
      // against the page/player runtime budget.
      const browser = await getSharedBrowser();
      if (!browser) return null;

      const startedAt = Date.now();
      const deadline = startedAt + BROWSER_1080P_TIMEOUT_MS;
      const timeLeft = () => Math.max(750, deadline - Date.now());

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
      });

      const found = {
        remoteControlUrl: null,
        getFileUrl: null,
      };

      let resolveFound;
      const foundPromise = new Promise(resolve => {
        resolveFound = resolve;
      });

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
            resolveFound("remote");
          }
        }

        if (/\/get_file\//i.test(rawUrl) && /_1080p\.mp4/i.test(decoded)) {
          if (!found.getFileUrl) {
            found.getFileUrl = rawUrl;
            console.log(`[browser-1080p] captured 1080p get_file from ${source}: ${decoded}`);
            resolveFound("get_file");
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

      const targetUrl = videoId ? `${BASE_URL}/embed/${videoId}` : pageUrl;
console.log(`[browser-1080p] opening lightweight embed ${targetUrl}`);

const runFlow = async () => {
  // Use the full page, not /embed/<id>.
  // The embed page is lighter, but logs show it only requests the base .mp4.
  const targetUrl = pageUrl;

  console.log(`[browser-1080p] opening lightweight full page ${targetUrl}`);

  await page.goto(targetUrl, {
    referer: BASE_URL + "/",
    waitUntil: "domcontentloaded",
    timeout: Math.min(8000, timeLeft()),
  }).catch(e => {
    console.log(`[browser-1080p] goto warning: ${e.message}`);
  });

  // Force localStorage after navigation too.
  const selectedFormat = await page.evaluate(() => {
    try {
      localStorage.setItem("kvsplayer_selected_format", "1080p");
      localStorage.setItem("volume", "1");
      return localStorage.getItem("kvsplayer_selected_format");
    } catch (e) {
      return `ERROR:${e.message}`;
    }
  }).catch(e => `ERROR:${e.message}`);

  console.log(`[browser-1080p] localStorage selected_format=${selectedFormat || "(none)"}`);

  await sleep(Math.min(600, timeLeft()));

  // Start player.
  await page.click("#kt_player").catch(() => {});
  await page.mouse.click(200, 300).catch(() => {});

  await sleep(Math.min(900, timeLeft()));

  // Actively try to open quality/settings and click 1080p.
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

    // Direct 1080p button/menu item.
    const direct1080 = all.find(el =>
      isVisible(el) &&
      /\b1080p\b/i.test((el.textContent || "").trim())
    );

    if (direct1080) {
      return clickEl(direct1080);
    }

    // Open settings/quality/HD menu candidates.
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
    console.log(`[browser-1080p] quality click error: ${e.message}`);
    return false;
  });

  console.log(`[browser-1080p] clicked 1080p option: ${clicked1080p}`);

  // Nudge playback after selecting quality.
  await page.evaluate(() => {
    const video = document.querySelector("video");
    if (video) {
      video.muted = true;
      return video.play().catch(() => null);
    }
    return null;
  }).catch(() => {});

  await page.mouse.click(200, 300).catch(() => {});

  await sleep(Math.min(4500, timeLeft()));

  const perfUrls = await page.evaluate(() =>
    performance.getEntriesByType("resource").map(e => e.name).filter(Boolean)
  ).catch(() => []);

  for (const u of perfUrls) {
    considerUrl(u, "performance");
  }
};

      await Promise.race([
        runFlow(),
        foundPromise,
        sleep(BROWSER_1080P_TIMEOUT_MS),
      ]);

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
      if (page) await page.close().catch(() => {});
      if (context) await context.close().catch(() => {});
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
    const status = res.status;
    res.body?.destroy?.();

    console.log(`[browser-1080p] captured get_file status=${status} location=${location || "(none)"}`);

    if (location && /remote_control\.php/i.test(location)) {
      return new URL(location, resolveUrl).toString();
    }

    if (status === 200 || status === 206) {
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

async function resolveVideoUrlsFromHtml(html, pageUrl, videoId, cookieStr) {
  let candidates = collectAllGetFileCandidates(html, videoId, "raw-html");

  if (ENABLE_EMBED_FALLBACK) {
    const embedCandidates = await fetchEmbedCandidates(videoId, pageUrl, cookieStr);
    const seen = new Set(candidates.map(c => `${c.quality}:${c.hash}:${c.url}`));
    for (const c of embedCandidates) {
      const key = `${c.quality}:${c.hash}:${c.url}`;
      if (!seen.has(key)) {
        seen.add(key);
        candidates.push(c);
      }
    }
  }

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

  // The localStorage discovery means the real browser chooses 1080p first.
  // Server-side, this is the equivalent: resolve 1080p first, then fall back.
  const resolveList = candidates.slice(0, MAX_RESOLVE_CANDIDATES);
  console.log(`[meta] resolve list: ${resolveList.map(c => `${c.quality}:${getQualSuffix(c.url)}`).join(", ")} (kept ${resolveList.length}/${candidates.length})`);

  const videoUrls = [];
  for (const candidate of resolveList) {
    const resolved = await resolveGetFileCandidate(candidate, pageUrl, cookieStr, videoId);
    if (resolved) videoUrls.push(resolved);
  }

  const seenPaths = new Set();
  const deduped = videoUrls.filter(u => {
    const path = getFilePathForDedupe(u);
    if (seenPaths.has(path)) return false;
    seenPaths.add(path);
    return true;
  });

  if (!has1080pUrl(deduped)) {
    console.log("[meta] no 1080p from lightweight resolver; trying tiny browser resolver");
    const browser1080p = await resolve1080pViaTinyBrowser(pageUrl, videoId, cookieStr);

    if (browser1080p?.remoteControlUrl) {
      console.log("[meta] ✅ tiny browser produced 1080p remote_control");
      deduped.unshift(browser1080p.remoteControlUrl);
    } else if (browser1080p?.getFileUrl) {
      const resolvedBrowserGetFile = await resolveCapturedBrowserGetFile(
        browser1080p.getFileUrl,
        pageUrl,
        mergeCookies(cookieStr, browser1080p.cookieStr)
      );

      if (resolvedBrowserGetFile) {
        console.log("[meta] ✅ tiny browser get_file resolved to 1080p");
        deduped.unshift(resolvedBrowserGetFile);
      } else {
        console.log("[meta] tiny browser get_file did not resolve");
      }
    } else {
      console.log("[meta] tiny browser resolver found no 1080p URL");
    }
  }

  const finalSeenPaths = new Set();
  const finalDeduped = deduped.filter(u => {
    const path = getFilePathForDedupe(u);
    if (finalSeenPaths.has(path)) return false;
    finalSeenPaths.add(path);
    return true;
  });

  console.log(`[meta] resolved ${finalDeduped.length} playable URL(s) (deduped from ${videoUrls.length})`);
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
      videoUrl: null,
      videoUrls: [],
      cookieStr,
      updatedAt: Date.now(),
    });
    return { meta, videoUrl: null, videoUrls: [], cookieStr };
  }

  const videoUrls = await resolveVideoUrlsFromHtml(html, pageUrl, videoId, cookieStr);
  const videoUrl = videoUrls[0] || null;

  metaCache.set(id, {
    meta,
    videoUrl,
    videoUrls,
    cookieStr,
    updatedAt: Date.now(),
  });

  return { meta, videoUrl, videoUrls, cookieStr };
}

builder.defineCatalogHandler(async ({ type, id, extra }) => {
  if (type !== "movie") return { metas: [] };

  try {
    const metas = await fetchCatalogPage(id, extra?.skip || 0, extra?.search || "", extra?.genre || "");
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

builder.defineStreamHandler(async ({ type, id }) => {
  if (type !== "movie") return { streams: [] };

  const pageUrl = absoluteUrl(`/${decodeId(id)}/`);

  try {
    console.log(`[stream] fresh scrape for ${id}`);
    const { videoUrls } = await scrapeMetaById(id, { resolveStreams: true });

    if (!videoUrls || videoUrls.length === 0) {
      console.log(`[stream] no playable URLs found`);
      return { streams: [{ name: "PimpBunny 🔗", title: "Open Page", externalUrl: pageUrl }] };
    }

    const qualityLabels = {
      "_1080p": "1080p",
      "_720p": "720p",
      "_480p": "480p",
      "_360p": "360p",
    };

    const streams = videoUrls.map(u => {
      let decoded = u;
      try { decoded = decodeURIComponent(u); } catch {}

      const label = Object.entries(qualityLabels).find(([k]) => decoded.includes(k))?.[1] ?? "HD";
      const streamUrl = PUBLIC_BASE_URL
        ? `${PUBLIC_BASE_URL}/proxy?url=${encodeURIComponent(u)}&ref=${encodeURIComponent(pageUrl)}`
        : u;

      return {
        name: "PimpBunny 🎥",
        title: label,
        url: streamUrl,
        behaviorHints: { notWebReady: false },
      };
    });

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

  const urlMatch = rawQuery.match(/(?:^|&)url=([^&]*)/);
  const target = urlMatch ? urlMatch[1] : null;
  if (!target) return res.status(400).send("missing url");

  const refMatch = rawQuery.match(/(?:^|&)ref=([^&]*)/);
  const referer = refMatch ? decodeURIComponent(refMatch[1]) : BASE_URL + "/";

  let decodedTarget;
  try {
    decodedTarget = decodeURIComponent(target);
  } catch (e) {
    console.warn(`[proxy] decode error: ${e.message}`);
    decodedTarget = target;
  }

  const isSegment = SEGMENT_RE.test(decodedTarget.split("?")[0]);
  const isRemoteControl = /\/remote_control\.php\?/i.test(decodedTarget);

  // Keep this conservative: segments direct, signed remote_control/direct MP4 through the outbound proxy.
  // If your proxy bandwidth is a problem and remote_control works direct for you, change this to:
  // const useProxy = !isSegment && !isRemoteControl;
  const useProxy = !isSegment;

  console.log(`[proxy] target=${decodedTarget} isSegment=${isSegment} isRemoteControl=${isRemoteControl} useProxy=${useProxy}`);

  try {
    const fetchHeaders = {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36",
      "Referer": referer,
      "Origin": BASE_URL,
      "Accept": VIDEO_HEADERS.Accept,
      "Accept-Language": "en-US,en;q=0.9",
      "Connection": "keep-alive",
    };

    if (req.headers.range) {
      fetchHeaders.Range = req.headers.range;
      console.log(`[proxy] range: ${req.headers.range}`);
    }

    const upstream = await doFetch(decodedTarget, {
      headers: fetchHeaders,
      redirect: "follow",
    }, useProxy);

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
