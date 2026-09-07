'use strict';

// itunes-api — Mineradio bridge to Apple's free iTunes Search API.
// No key, no account: itunes.apple.com/search exposes Apple's full catalog
// metadata plus 30-second preview MP4/AAC streams for nearly every track.
// The API and its media CDNs are reachable from networks where most Western
// services are blocked, making it the default always-available source here.
// Module conventions follow spotify-api.js: injected proxy applier, small
// TTL caches, handler functions exported.

const https = require('https');

const ITUNES_API_BASE = (process.env.ITUNES_API_BASE || 'https://itunes.apple.com').replace(/\/+$/, '');
const ITUNES_UA = 'Mineradio/2.1.0 (iTunes Search API bridge)';
const REQUEST_TIMEOUT_MS = 8000;
const SEARCH_LIMIT_MAX = 50;

let applyProxyOptions = null;
function setItunesProxyApplier(fn) {
  applyProxyOptions = typeof fn === 'function' ? fn : null;
}

function normalizeText(value) {
  return String(value == null ? '' : value).trim();
}

const cacheMap = new Map();
const CACHE_TTL_MS = 30 * 60 * 1000;
const CACHE_MAX = 300;

function cacheWrap(key, ttlMs, producer) {
  const hit = cacheMap.get(key);
  const now = Date.now();
  if (hit && hit.expiresAt > now) return Promise.resolve(hit.value);
  if (hit) cacheMap.delete(key);
  return Promise.resolve()
    .then(producer)
    .then((value) => {
      cacheMap.set(key, { value, expiresAt: Date.now() + ttlMs });
      if (cacheMap.size > CACHE_MAX) {
        const oldest = cacheMap.keys().next().value;
        if (oldest !== undefined) cacheMap.delete(oldest);
      }
      return value;
    });
}

async function requestJson(pathAndQuery) {
  const target = `${ITUNES_API_BASE}${pathAndQuery.startsWith('/') ? pathAndQuery : `/${pathAndQuery}`}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  const options = {
    method: 'GET',
    signal: controller.signal,
    headers: { 'User-Agent': ITUNES_UA, Accept: 'application/json' },
  };
  let fetchOptions = applyProxyOptions ? applyProxyOptions(options, 'itunes') : options;
  fetchOptions.signal = controller.signal;
  try {
    const resp = await fetch(target, fetchOptions);
    const text = await resp.text();
    let body = {};
    try { body = JSON.parse(text || '{}'); } catch (_) {}
    return { status: resp.status, body };
  } finally {
    clearTimeout(timer);
  }
}

function upscaleArtwork(url) {
  const src = normalizeText(url);
  if (!src) return '';
  return src.replace(/\/\d+x\d+bb\./, '/600x600bb.');
}

function mapItunesTrack(track, index, query) {
  track = track || {};
  const id = String(track.trackId == null ? '' : track.trackId);
  const name = normalizeText(track.trackName);
  if (!id || !name || track.trackViewUrl === undefined && false) { /* keep */ }
  if (!id || !name) return null;
  const artist = normalizeText(track.artistName);
  const wrapperType = normalizeText(track.wrapperType);
  const kind = normalizeText(track.kind);
  // Skip non-song entries (ringtones, podcasts, ebooks…).
  if (kind && kind !== 'song') return null;
  if (wrapperType && wrapperType === 'ebook') return null;
  const durationMs = Math.max(0, Number(track.trackTimeMillis) || 0);
  const preview = normalizeText(track.previewUrl);
  return {
    provider: 'itunes',
    source: 'itunes',
    type: 'song',
    id,
    providerSongId: id,
    name: name.replace(/\s*-\s*(single|ep version|remaster(ed)?[^)]*)$/i, '').trim() || name,
    displayName: name,
    artist: artist || 'Unknown artist',
    artists: artist ? [{ id: normalizeText(track.artistId), name: artist }] : [],
    artistId: normalizeText(track.artistId),
    album: normalizeText(track.collectionName),
    albumId: normalizeText(track.collectionId),
    cover: upscaleArtwork(track.artworkUrl100 || track.artworkUrl60),
    duration: Math.round(durationMs / 1000),
    durationMs,
    popularity: 0,
    fee: track.trackPrice > 0 ? 1 : 0,
    genre: normalizeText(track.primaryGenreName),
    explicit: track.trackExplicitness === 'explicit',
    playable: !!preview,
    url: '',
    playbackMode: preview ? 'preview' : 'recommend-match',
    recommendationSource: 'itunes-search-api',
    itunesRank: index,
    itunesQuery: query || '',
    restriction: preview ? undefined : {
      category: 'provider_limited',
      reason: 'no_preview_available',
      message: 'This entry has no preview stream — switching source automatically.',
      action: 'switch_source',
    },
  };
}

async function handleItunesSearch(keywords, limit, offset) {
  const query = normalizeText(keywords);
  limit = Math.max(1, Math.min(SEARCH_LIMIT_MAX, Number(limit) || 25));
  offset = Math.max(0, Number(offset) || 0);
  if (!query) {
    return { provider: 'itunes', configured: true, songs: [], total: 0, offset, nextOffset: offset, hasMore: false, message: 'Empty query.' };
  }
  const cacheKey = `${query}|${limit}|${offset}`;
  const payload = await cacheWrap(cacheKey, CACHE_TTL_MS, async () => {
    const params = new URLSearchParams({
      term: query,
      media: 'music',
      entity: 'song',
      limit: String(Math.min(SEARCH_LIMIT_MAX, limit * 3)),
      country: process.env.ITUNES_COUNTRY || 'US',
    });
    const { status, body } = await requestJson(`/search?${params.toString()}`);
    if (status >= 400) throw new Error(`iTunes search failed (${status})`);
    return body;
  });
  const results = Array.isArray(payload.results) ? payload.results : [];
  const seen = new Set();
  const songs = [];
  for (let i = offset; i < results.length && songs.length < limit; i++) {
    const mapped = mapItunesTrack(results[i], i - offset, query);
    if (!mapped || seen.has(mapped.id)) continue;
    seen.add(mapped.id);
    songs.push(mapped);
  }
  return {
    provider: 'itunes',
    configured: true,
    songs,
    total: results.length,
    offset,
    limit,
    nextOffset: offset + songs.length,
    hasMore: offset + songs.length < results.length,
  };
}

async function handleItunesSongUrl(id) {
  const trackId = normalizeText(id);
  const missPayload = (reason, message) => ({
    provider: 'itunes',
    source: 'itunes',
    id: trackId,
    url: '',
    playable: false,
    playbackMode: 'recommend-match',
    reason,
    restriction: {
      category: 'provider_limited',
      reason,
      message,
      action: 'switch_source',
    },
  });
  if (!trackId) return missPayload('resolve_failed', 'Missing iTunes track id.');
  try {
    const payload = await cacheWrap(`track|${trackId}`, CACHE_TTL_MS, async () => {
      const { status, body } = await requestJson(`/lookup?id=${encodeURIComponent(trackId)}&entity=song`);
      if (status >= 400) throw new Error(`iTunes lookup failed (${status})`);
      return body;
    });
    const entry = payload && Array.isArray(payload.results) ? payload.results.find((item) => item && item.kind === 'song') : null;
    const preview = entry && normalizeText(entry.previewUrl);
    if (!entry) return missPayload('resolve_failed', 'This iTunes entry could not be found.');
    if (!preview) return missPayload('no_free_stream', 'No free preview stream exists for this entry — switching source automatically.');
    const mapped = mapItunesTrack(entry, 0, '');
    return {
      provider: 'itunes',
      source: 'itunes',
      id: trackId,
      url: `/api/audio?url=${encodeURIComponent(preview)}&app=itunes`,
      directUrl: preview,
      playable: true,
      trial: true,
      level: 'preview',
      br: 256,
      playbackMode: 'preview',
      name: mapped.name,
      artist: mapped.artist,
      cover: mapped.cover,
      durationMs: mapped.durationMs,
      restriction: {
        category: 'trial_only',
        reason: 'itunes_preview',
        message: 'Playing the free iTunes preview.',
        action: 'none',
      },
    };
  } catch (err) {
    return missPayload('url_unavailable', 'Could not reach iTunes for this track — switching source automatically.');
  }
}

async function handleItunesLyric(id) {
  return {
    provider: 'itunes',
    source: 'none',
    id: normalizeText(id),
    lyric: '',
    tlyric: '',
    yrc: '',
    ytlrc: '',
    message: 'iTunes provides no lyrics through its public API; Mineradio will fall back to global lyric providers.',
  };
}

function getItunesCapabilities() {
  return {
    configured: true,
    loggedIn: true,
    capabilities: {
      search: true,
      metadata: true,
      lyric: false,
      playableUrl: true,
      playableMode: 'preview',
      userPlaylists: false,
      likedTracks: false,
      chart: false,
    },
  };
}

function resetItunesRuntimeStateForTests() {
  cacheMap.clear();
}

module.exports = {
  setItunesProxyApplier,
  handleItunesSearch,
  handleItunesSongUrl,
  handleItunesLyric,
  getItunesCapabilities,
  resetItunesRuntimeStateForTests,
};
