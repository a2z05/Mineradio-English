'use strict';

// lyrics-resolver — unified lyric lookup for the global providers.
// Tries, in order: LRCLIB (free synced LRC), YouTube Music description
// lyrics, Apple Music TTML (self-scraping web token), NetEase cloud search
// + lyric, QQ Music search + QRC. Every step is best-effort with a timeout;
// the first source returning usable lyrics wins. Payload shape matches the
// existing /api/lyric contract so the renderer pipeline needs no changes:
// { provider, source, id?, lyric, tlyric, yrc, ytlrc, romalrc }.

const https = require('https');

const LRCLIB_BASE = 'https://lrclib.net/api';
const LYRICS_UA = 'Mineradio/2.1.0 (https://github.com/a2z05/Mineradio-English)';
const STEP_TIMEOUT_MS = 6500;
const TOTAL_BUDGET_MS = 22000;

let applyProxyOptions = null;
function setLyricsResolverProxyApplier(fn) {
  applyProxyOptions = typeof fn === 'function' ? fn : null;
}

function normalizeText(value) {
  return String(value == null ? '' : value).trim();
}

const resolveCache = new Map();
const RESOLVE_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const RESOLVE_CACHE_MAX = 600;
// EN-FORK: a miss is worth remembering for a while too, but for much less time
// than a hit. LRCLIB's catalogue is community-edited and Apple/NetEase/QQ come
// and go, so a track nothing had an hour ago can have lyrics now — this is a
// "stop asking for a while", not "never ask again". The same three calls for
// one unknown title used to cost 7.9s, 7.7s and 7.2s because every one of them
// walked all five providers before admitting defeat.
const MISS_CACHE_TTL_MS = 60 * 60 * 1000;

// Only so the expiry above can be reached in a test instead of slept through.
let nowMs = () => Date.now();
function setLyricsResolverClockForTests(fn) {
  nowMs = typeof fn === 'function' ? fn : () => Date.now();
}

function cacheWrap(key, ttlMs, producer) {
  const hit = resolveCache.get(key);
  const now = nowMs();
  if (hit && hit.expiresAt > now) return Promise.resolve(hit.value);
  if (hit) resolveCache.delete(key);
  return Promise.resolve()
    .then(producer)
    .then((value) => {
      if (value && value.source) {
        const isMiss = value.source === 'none';
        resolveCache.set(key, {
          value,
          expiresAt: nowMs() + (isMiss ? MISS_CACHE_TTL_MS : ttlMs),
        });
        if (resolveCache.size > RESOLVE_CACHE_MAX) {
          const oldest = resolveCache.keys().next().value;
          if (oldest !== undefined) resolveCache.delete(oldest);
        }
      }
      return value;
    });
}

function fetchText(url, headers, appName) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), STEP_TIMEOUT_MS);
  const options = {
    method: 'GET',
    signal: controller.signal,
    headers: Object.assign({ 'User-Agent': LYRICS_UA, Accept: 'application/json, text/plain;q=0.9' }, headers || {}),
  };
  let finalOptions = applyProxyOptions && appName ? applyProxyOptions(options, appName) : options;
  // The proxy applier returns a new object; keep our signal.
  finalOptions.signal = controller.signal;
  return fetch(url, finalOptions).then(async (resp) => ({
    status: resp.status,
    text: await resp.text(),
  })).finally(() => clearTimeout(timer));
}

async function fetchJson(url, headers, appName) {
  const { status, text } = await fetchText(url, headers, appName);
  if (status >= 400) throw new Error(`HTTP_${status}`);
  try {
    return JSON.parse(text || 'null');
  } catch (_) {
    throw new Error('PARSE_FAILED');
  }
}

// --- Step 1: LRCLIB --------------------------------------------------------

function lrcTimestampedToLrcFormat(synced) {
  // LRCLIB already returns standard [mm:ss.xx] lines.
  return normalizeText(synced);
}

async function tryLrclib(title, artist, albumName, durationSec) {
  const params = new URLSearchParams();
  params.set('track_name', title.slice(0, 120));
  if (artist) params.set('artist_name', artist.split('/')[0].slice(0, 80));
  if (albumName) params.set('album_name', String(albumName).slice(0, 80));
  let data = null;
  try {
    data = await fetchJson(`${LRCLIB_BASE}/get?${params.toString()}`);
  } catch (_) {
    // /get requires a close match; fall through to fuzzy /search.
  }
  if (!data || (!data.syncedLyrics && !data.plainLyrics)) {
    const searchParams = new URLSearchParams({ q: `${title} ${artist}`.trim().slice(0, 160) });
    const list = await fetchJson(`${LRCLIB_BASE}/search?${searchParams.toString()}`);
    if (Array.isArray(list) && list.length) {
      // Prefer entries whose duration is close when we know it.
      let best = list[0];
      if (durationSec > 0) {
        let bestDelta = Infinity;
        for (const entry of list) {
          const delta = Math.abs((Number(entry.duration) || 0) - durationSec);
          if (delta < bestDelta) { bestDelta = delta; best = entry; }
        }
      }
      data = best;
    }
  }
  if (!data || (!data.syncedLyrics && !data.plainLyrics)) {
    throw new Error('LRCLIB_NO_MATCH');
  }
  return {
    provider: 'lrclib',
    source: data.syncedLyrics ? 'lrclib-synced' : 'lrclib-plain',
    lyric: data.syncedLyrics ? lrcTimestampedToLrcFormat(data.syncedLyrics) : '',
    plainLyric: normalizeText(data.plainLyrics),
    tlyric: '',
    yrc: '',
    ytlrc: '',
    romalrc: '',
  };
}

// --- Step 2/3 adapters are injected to avoid circular requires ------------

let ytmusicLyricLookup = null;
function setYtMusicLyricLookup(fn) {
  ytmusicLyricLookup = typeof fn === 'function' ? fn : null;
}

let appleMusicLyricLookup = null;
function setAppleMusicLyricLookup(fn) {
  appleMusicLyricLookup = typeof fn === 'function' ? fn : null;
}

let neteaseLyricLookup = null;
function setNeteaseLyricLookup(fn) {
  neteaseLyricLookup = typeof fn === 'function' ? fn : null;
}

let qqLyricLookup = null;
function setQqLyricLookup(fn) {
  qqLyricLookup = typeof fn === 'function' ? fn : null;
}

function emptyPayload(source, message) {
  return {
    provider: 'global',
    source: source || 'none',
    lyric: '',
    tlyric: '',
    yrc: '',
    ytlrc: '',
    romalrc: '',
    message: message || 'No lyrics found for this track.',
  };
}

function payloadHasLyrics(payload) {
  return !!(payload && (normalizeText(payload.lyric) || normalizeText(payload.yrc) || normalizeText(payload.plainLyric)));
}

async function withTimeout(promise, ms, label) {
  let timer = null;
  try {
    return await Promise.race([
      Promise.resolve(promise),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label}_TIMEOUT`)), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function resolveGlobalLyrics(options) {
  const opts = options || {};
  const title = normalizeText(opts.title || opts.name);
  const artist = normalizeText(opts.artist);
  const album = normalizeText(opts.album);
  const durationSec = Math.max(0, Math.round(Number(opts.duration) || 0));
  const videoId = normalizeText(opts.videoId);
  const steps = [];
  const deadline = Date.now() + TOTAL_BUDGET_MS;

  const key = `lyrics-v2|${title.toLowerCase()}|${artist.toLowerCase()}|${durationSec}`;
  const cached = await cacheWrap(key, RESOLVE_CACHE_TTL_MS, async () => {
    // 1. LRCLIB — free synced lyrics.
    steps.push('lrclib');
    try {
      const lrclibPayload = await withTimeout(tryLrclib(title, artist, album, durationSec), Math.min(STEP_TIMEOUT_MS * 2, Math.max(1000, deadline - Date.now())), 'LRCLIB');
      if (payloadHasLyrics(lrclibPayload)) return lrclibPayload;
    } catch (_) { /* next */ }

    // 2. YouTube Music description lyrics ("Google lyrics") — exact videoId
    //    when known, otherwise a quick YTM search for the title+artist.
    if (ytmusicLyricLookup) {
      steps.push('ytmusic');
      try {
        const ytPayload = await withTimeout(
          ytmusicLyricLookup({ videoId, title, artist, durationSec }),
          Math.min(STEP_TIMEOUT_MS * 2, Math.max(1000, deadline - Date.now())),
          'YTMUSIC'
        );
        if (payloadHasLyrics(ytPayload)) return ytPayload;
      } catch (_) { /* next */ }
    }

    // 3. Apple Music TTML (syllable-lyrics via scraped web bearer).
    if (appleMusicLyricLookup) {
      steps.push('apple');
      try {
        const applePayload = await withTimeout(
          appleMusicLyricLookup({ title, artist, durationSec }),
          Math.min(STEP_TIMEOUT_MS * 2, Math.max(1000, deadline - Date.now())),
          'APPLE'
        );
        if (payloadHasLyrics(applePayload)) return applePayload;
      } catch (_) { /* next */ }
    }

    // 4. NetEase (translations + synced Chinese lyrics) — lyric-only backend.
    if (neteaseLyricLookup) {
      steps.push('netease');
      try {
        const neteasePayload = await withTimeout(
          neteaseLyricLookup({ title, artist, durationSec }),
          Math.min(STEP_TIMEOUT_MS * 2, Math.max(1000, deadline - Date.now())),
          'NETEASE'
        );
        if (payloadHasLyrics(neteasePayload)) return neteasePayload;
      } catch (_) { /* next */ }
    }

    // 5. QQ Music QRC (karaoke-style synced lyrics) — lyric-only backend.
    if (qqLyricLookup) {
      steps.push('qq');
      try {
        const qqPayload = await withTimeout(
          qqLyricLookup({ title, artist, durationSec }),
          Math.min(STEP_TIMEOUT_MS * 2, Math.max(1000, deadline - Date.now())),
          'QQ'
        );
        if (payloadHasLyrics(qqPayload)) return qqPayload;
      } catch (_) { /* next */ }
    }

    // EN-FORK: the miss is built INSIDE the cache wrapper, not after it. It
    // used to be returned as null and answered just outside, which meant the
    // wrapper saw nothing worth storing and the whole walk ran again on the
    // next play of the same track.
    return emptyPayload('none', `No lyrics found (tried ${steps.join(' → ') || 'no providers'}).`);
  });
  return cached || emptyPayload('none', 'No lyrics found (tried no providers).');
}

function resetLyricsResolverRuntimeStateForTests() {
  resolveCache.clear();
  nowMs = () => Date.now();
}

module.exports = {
  setLyricsResolverProxyApplier,
  setYtMusicLyricLookup,
  setAppleMusicLyricLookup,
  setNeteaseLyricLookup,
  setQqLyricLookup,
  resolveGlobalLyrics,
  resetLyricsResolverRuntimeStateForTests,
  setLyricsResolverClockForTests,
  MISS_CACHE_TTL_MS,
};
