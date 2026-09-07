'use strict';

// deezer-api — Mineradio bridge to Deezer's public Web API.
// No account, no API key: api.deezer.com exposes open search/chart/album/
// playlist endpoints. Full-length streaming is not available without a paid
// subscription, so tracks resolve to the free 30-second preview MP3; the
// renderer's cross-provider fallback treats anything beyond that as
// recommend-match. Follows the spotify-api.js module conventions:
// injected proxy options, small TTL caches, handler functions exported.

const https = require('https');

const DEEZER_API_BASE = (process.env.DEEZER_API_BASE || 'https://api.deezer.com').replace(/\/+$/, '');
const DEEZER_UA = 'Mineradio/2.1.0 (Deezer public API bridge)';
const REQUEST_TIMEOUT_MS = 8000;
const SEARCH_LIMIT_MAX = 25;

let applyProxyOptions = null;
function setDeezerProxyApplier(fn) {
  applyProxyOptions = typeof fn === 'function' ? fn : null;
}

function normalizeText(value) {
  return String(value == null ? '' : value).trim();
}

const searchCache = new Map();
const SEARCH_CACHE_TTL_MS = 5 * 60 * 1000;
const SEARCH_CACHE_MAX = 200;

function cacheWrap(cache, key, ttlMs, producer) {
  const hit = cache.get(key);
  const now = Date.now();
  if (hit && hit.expiresAt > now) return Promise.resolve(hit.value);
  if (hit) cache.delete(key);
  return Promise.resolve()
    .then(producer)
    .then((value) => {
      cache.set(key, { value, expiresAt: Date.now() + ttlMs });
      if (cache.size > SEARCH_CACHE_MAX) {
        const oldest = cache.keys().next().value;
        if (oldest !== undefined) cache.delete(oldest);
      }
      return value;
    });
}

function requestJson(pathAndQuery, appName) {
  const target = `${DEEZER_API_BASE}${pathAndQuery.startsWith('/') ? pathAndQuery : `/${pathAndQuery}`}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  const options = {
    method: 'GET',
    signal: controller.signal,
    headers: { 'User-Agent': DEEZER_UA, Accept: 'application/json' },
  };
  if (applyProxyOptions) applyProxyOptions(options, appName || 'deezer');
  let extraOptions = applyProxyOptions
    ? applyProxyOptions(options, appName || 'deezer')
    : options;
  // The applier may attach an undici dispatcher (global fetch) and/or a
  // CONNECT agent (https.request); route accordingly like spotify-api does.
  if (extraOptions.agent && !extraOptions.dispatcher) {
    return new Promise((resolve, reject) => {
      const req = https.request(target, options, (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          clearTimeout(timer);
          try {
            resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') });
          } catch (err) {
            reject(new Error(`Deezer response parse failed: ${err.message}`));
          }
        });
      });
      req.on('error', (err) => { clearTimeout(timer); reject(err); });
      req.end();
    });
  }
  return fetch(target, extraOptions).then(async (resp) => {
    const text = await resp.text();
    let body = {};
    try { body = JSON.parse(text || '{}'); } catch (_) { body = {}; }
    return { status: resp.status, body };
  }).finally(() => clearTimeout(timer));
}

function deezerError(body, status) {
  if (body && body.error && body.error.type) {
    const message = normalizeText(body.error.message) || 'Deezer API error';
    const err = new Error(message);
    err.code = 'DEEZER_API_ERROR';
    err.status = status;
    return err;
  }
  return null;
}

function mapDeezerTrack(track, index, query) {
  track = track || {};
  const id = normalizeText(track.id);
  const name = normalizeText(track.title || track.title_short);
  if (!id || !name) return null;
  const artist = track.artist || {};
  const artists = Array.isArray(track.contributors) && track.contributors.length
    ? track.contributors.map((entry) => ({ id: normalizeText(entry && entry.id), name: normalizeText(entry && entry.name) })).filter((entry) => entry.name)
    : [{ id: normalizeText(artist.id), name: normalizeText(artist.name) }].filter((entry) => entry.name);
  const album = track.album || {};
  const cover = normalizeText(track.album_cover_xl || album.cover_xl || track.album_cover_big || album.cover_big || album.cover_medium || '');
  const durationSec = Math.max(0, Math.round(Number(track.duration) || 0));
  const preview = normalizeText(track.preview);
  return {
    provider: 'deezer',
    source: 'deezer',
    type: 'song',
    id,
    providerSongId: id,
    name,
    artist: artists.map((entry) => entry.name).join(' / ') || normalizeText(track.artist_name),
    artists,
    artistId: artists[0] && artists[0].id,
    album: normalizeText(album.title),
    albumId: normalizeText(album.id),
    cover,
    duration: durationSec,
    durationMs: durationSec * 1000,
    popularity: Number(track.rank) || 0,
    explicit: track.explicit_lyrics === true,
    fee: 0,
    playable: !!preview,
    url: preview || '',
    playbackMode: preview ? 'preview' : 'recommend-match',
    recommendationSource: 'deezer-public-api',
    deezerRank: index,
    deezerQuery: query || '',
    restriction: {
      category: preview ? '' : 'provider_limited',
      reason: preview ? '' : 'no_preview_available',
      message: preview
        ? ''
        : 'This Deezer entry has no free preview; playback will automatically find a playable version elsewhere.',
      action: preview ? '' : 'switch_source',
    },
  };
}

async function handleDeezerSearch(keywords, limit, offset) {
  const query = normalizeText(keywords);
  limit = Math.max(1, Math.min(SEARCH_LIMIT_MAX, Number(limit) || 20));
  offset = Math.max(0, Number(offset) || 0);
  if (!query) {
    return { provider: 'deezer', configured: true, songs: [], total: 0, offset, nextOffset: offset, hasMore: false, message: 'Empty query.' };
  }
  const cacheKey = `${query}|${limit}|${offset}`;
  const payload = await cacheWrap(searchCache, cacheKey, SEARCH_CACHE_TTL_MS, async () => {
    const path = `/search?q=${encodeURIComponent(query)}&limit=${limit}&offset=${offset}&output=json`;
    const { status, body } = await requestJson(path);
    if (status >= 400) throw deezerError(body, status) || new Error(`Deezer search failed (${status})`);
    return body;
  });
  const data = Array.isArray(payload.data) ? payload.data : [];
  const songs = data.map((track, index) => mapDeezerTrack(track, index, query)).filter(Boolean);
  const total = Number(payload.total) || songs.length;
  return {
    provider: 'deezer',
    configured: true,
    songs,
    total,
    offset,
    limit,
    nextOffset: offset + songs.length,
    hasMore: offset + songs.length < total,
  };
}

async function handleDeezerChart(limit) {
  limit = Math.max(1, Math.min(30, Number(limit) || 12));
  const payload = await cacheWrap(searchCache, `chart|${limit}`, 15 * 60 * 1000, async () => {
    const { status, body } = await requestJson(`/chart/0/tracks?limit=${limit}&output=json`);
    if (status >= 400) throw deezerError(body, status) || new Error(`Deezer chart failed (${status})`);
    return body;
  });
  const entries = payload && payload.data;
  const items = Array.isArray(entries) ? entries.map((entry) => entry && entry.album ? entry : entry) : [];
  const songs = items.map((entry, index) => {
    const track = entry && (entry.track || entry);
    return mapDeezerTrack(track, index, '');
  }).filter(Boolean);
  return { provider: 'deezer', songs, offset: 0, limit: songs.length, nextOffset: songs.length, hasMore: false };
}

async function handleDeezerAlbum(albumId) {
  const id = normalizeText(albumId);
  if (!id) return { provider: 'deezer', error: 'ALBUM_ID_REQUIRED', songs: [] };
  const payload = await cacheWrap(searchCache, `album|${id}`, 30 * 60 * 1000, async () => {
    const { status, body } = await requestJson(`/album/${encodeURIComponent(id)}&output=json`);
    if (status >= 400) throw deezerError(body, status) || new Error(`Deezer album failed (${status})`);
    return body;
  });
  const album = payload || {};
  const tracks = Array.isArray(album.tracks) ? album.tracks.data : [];
  const cover = normalizeText(album.cover_xl || album.cover_big || album.cover_medium || '');
  const songs = tracks.map((track, index) => mapDeezerTrack({
    ...track,
    album: { id: album.id, title: album.title, cover_xl: cover },
    contributors: track.contributors || (album.artist ? [album.artist] : []),
  }, index, '')).filter(Boolean);
  return {
    provider: 'deezer',
    type: 'playlist',
    id,
    name: normalizeText(album.title),
    cover,
    trackCount: songs.length,
    songs,
  };
}

async function handleDeezerPlaylist(playlistId) {
  const id = normalizeText(playlistId);
  if (!id) return { provider: 'deezer', error: 'PLAYLIST_ID_REQUIRED', songs: [] };
  const payload = await cacheWrap(searchCache, `playlist|${id}`, 10 * 60 * 1000, async () => {
    const { status, body } = await requestJson(`/playlist/${encodeURIComponent(id)}&output=json`);
    if (status >= 400) throw deezerError(body, status) || new Error(`Deezer playlist failed (${status})`);
    return body;
  });
  const playlist = payload || {};
  const tracks = playlist.tracks && Array.isArray(playlist.tracks.data) ? playlist.tracks.data : [];
  const songs = tracks.map((track, index) => mapDeezerTrack(track, index, '')).filter(Boolean);
  return {
    provider: 'deezer',
    type: 'playlist',
    id,
    name: normalizeText(playlist.title),
    cover: normalizeText(playlist.picture_xl || playlist.picture_big || ''),
    owner: playlist.creator && normalizeText(playlist.creator.name) || '',
    trackCount: Number(playlist.nb_tracks) || songs.length,
    songs,
  };
}

async function handleDeezerSongUrl(id) {
  const trackId = normalizeText(id);
  if (!trackId) {
    return { provider: 'deezer', url: '', playable: false, error: 'TRACK_ID_REQUIRED' };
  }
  try {
    const payload = await cacheWrap(searchCache, `track|${trackId}`, 30 * 60 * 1000, async () => {
      const { status, body } = await requestJson(`/track/${encodeURIComponent(trackId)}&output=json`);
      if (status >= 400) throw deezerError(body, status) || new Error(`Deezer track failed (${status})`);
      return body;
    });
    const preview = normalizeText(payload.preview);
    const track = mapDeezerTrack(payload, 0, '');
    if (!preview) {
      return {
        provider: 'deezer',
        source: 'deezer',
        id: trackId,
        url: '',
        playable: false,
        playbackMode: 'recommend-match',
        reason: 'provider_limited',
        restriction: {
          category: 'provider_limited',
          reason: 'no_free_stream',
          message: 'Deezer offers no free full-length stream for this track — switching source automatically.',
          action: 'switch_source',
        },
      };
    }
    return {
      provider: 'deezer',
      source: 'deezer',
      id: trackId,
      url: `/api/audio?url=${encodeURIComponent(preview)}&app=deezer`,
      directUrl: preview,
      playable: true,
      trial: true,
      level: 'preview',
      br: 128,
      playbackMode: 'preview',
      name: track.name,
      artist: track.artist,
      cover: track.cover,
      durationMs: track.durationMs,
      restriction: {
        category: 'trial_only',
        reason: 'deezer_preview',
        message: 'Playing the free Deezer preview.',
        action: 'none',
      },
    };
  } catch (err) {
    return {
      provider: 'deezer',
      source: 'deezer',
      id: trackId,
      url: '',
      playable: false,
      playbackMode: 'recommend-match',
      reason: 'url_unavailable',
      restriction: {
        category: 'url_unavailable',
        reason: 'resolve_failed',
        message: 'Could not resolve this Deezer track — switching source automatically.',
        action: 'switch_source',
      },
      error: err.message,
    };
  }
}

async function handleDeezerLyric(id) {
  return {
    provider: 'deezer',
    source: 'none',
    id: normalizeText(id),
    lyric: '',
    tlyric: '',
    yrc: '',
    ytlrc: '',
    message: 'Deezer provides no lyrics through its public API; Mineradio will fall back to global lyric providers.',
  };
}

function getDeezerCapabilities() {
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
      chart: true,
    },
  };
}

function resetDeezerRuntimeStateForTests() {
  searchCache.clear();
}

module.exports = {
  setDeezerProxyApplier,
  handleDeezerSearch,
  handleDeezerChart,
  handleDeezerAlbum,
  handleDeezerPlaylist,
  handleDeezerSongUrl,
  handleDeezerLyric,
  getDeezerCapabilities,
  resetDeezerRuntimeStateForTests,
};
