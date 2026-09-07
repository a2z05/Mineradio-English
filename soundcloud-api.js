'use strict';

// soundcloud-api — Mineradio bridge to SoundCloud's public web API.
// No login required: the same client_id the soundcloud.com web player uses
// grants open search + track/streams endpoints. Client IDs rotate, so this
// module scrapes fresh candidates from the site's JS assets, caches them,
// and rotates to the next candidate on auth rejection. Only progressive
// MP3 transcodings are used (Electron <audio> has no native HLS), so some
// catalog entries are metadata-only and fall back cross-provider.

const https = require('https');

const SOUNDCLOUD_BASE = 'https://soundcloud.com';
const SOUNDCLOUD_API_BASE = 'https://api-v2.soundcloud.com';
const SOUNDCLOUD_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const REQUEST_TIMEOUT_MS = 8000;
const ASSET_SCAN_LIMIT = 8;
const CLIENT_ID_TTL_MS = 6 * 60 * 60 * 1000;
const SEARCH_LIMIT_MAX = 30;

let applyProxyOptions = null;
function setSoundCloudProxyApplier(fn) {
  applyProxyOptions = typeof fn === 'function' ? fn : null;
}

function normalizeText(value) {
  return String(value == null ? '' : value).trim();
}

let clientIdState = { ids: [], index: 0, acquiredAt: 0, pending: null };

function extractClientIds(text) {
  const out = [];
  const seen = new Set();
  const regex = /client_id\s*[:=]\s*"([a-zA-Z0-9]{28,40})"/g;
  let match;
  while ((match = regex.exec(String(text || ''))) !== null) {
    if (!seen.has(match[1])) {
      seen.add(match[1]);
      out.push(match[1]);
    }
  }
  return out;
}

function requestRaw(url, options) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  const fetchOptions = {
    method: 'GET',
    signal: controller.signal,
    headers: Object.assign({ 'User-Agent': SOUNDCLOUD_UA, Accept: 'application/json, text/html;q=0.9,*/*;q=0.5' }, (options && options.headers) || {}),
  };
  if (applyProxyOptions) {
    // applyToOptions returns a new object rather than mutating its argument.
    Object.assign(fetchOptions, applyProxyOptions(fetchOptions, 'soundcloud'));
  }
  return fetch(url, fetchOptions).then(async (resp) => ({
    status: resp.status,
    text: await resp.text(),
  })).finally(() => clearTimeout(timer));
}

async function acquireClientIds() {
  const home = await requestRaw(`${SOUNDCLOUD_BASE}/`, {});
  if (!home.ok !== false && home.status >= 400) throw new Error(`SOUNDCLOUD_HOME_FAILED_${home.status}`);
  const scriptUrls = [];
  const regex = /(https:\/\/a-v2\.sndcdn\.com\/assets\/[^"']+?\.js)/g;
  let match;
  while ((match = regex.exec(home.text)) !== null && scriptUrls.length < ASSET_SCAN_LIMIT * 3) {
    scriptUrls.push(match[1]);
  }
  // Main app bundles tend to sit near the end of the list.
  const candidates = scriptUrls.reverse().slice(0, ASSET_SCAN_LIMIT);
  const found = [];
  for (const assetUrl of candidates) {
    try {
      const asset = await requestRaw(assetUrl, { headers: { Referer: `${SOUNDCLOUD_BASE}/` } });
      const ids = extractClientIds(asset.text);
      for (const id of ids) {
        if (found.indexOf(id) < 0) found.push(id);
      }
      if (found.length >= 3) break;
    } catch (_) { /* asset failures are non-fatal */ }
  }
  if (!found.length) throw new Error('SOUNDCLOUD_CLIENT_ID_UNAVAILABLE');
  return found;
}

async function ensureSoundCloudClientId(force) {
  const now = Date.now();
  if (!force && clientIdState.ids.length && now - clientIdState.acquiredAt < CLIENT_ID_TTL_MS) {
    return clientIdState.ids[clientIdState.index % clientIdState.ids.length];
  }
  if (!force && clientIdState.pending) return clientIdState.pending;
  clientIdState.pending = (async () => {
    try {
      const ids = await acquireClientIds();
      const previousFirst = clientIdState.ids[0];
      clientIdState.ids = ids;
      // Keep pointing at a working id when refreshing mid-session.
      if (previousFirst && !force) {
        const kept = ids.indexOf(previousFirst);
        clientIdState.index = kept >= 0 ? kept : 0;
      } else {
        clientIdState.index = 0;
      }
      clientIdState.acquiredAt = Date.now();
      return ids[clientIdState.index % ids.length];
    } finally {
      clientIdState.pending = null;
    }
  })();
  return clientIdState.pending;
}

function markCurrentClientIdRejected() {
  clientIdState.acquiredAt = 0;
  if (clientIdState.ids.length > 1) {
    clientIdState.index = (clientIdState.index + 1) % clientIdState.ids.length;
    return true;
  }
  return false;
}

async function apiGet(pathAndQuery, attempt) {
  attempt = attempt || 0;
  const clientId = await ensureSoundCloudClientId(attempt > 0);
  const separator = pathAndQuery.includes('?') ? '&' : '?';
  const target = `${SOUNDCLOUD_API_BASE}${pathAndQuery.startsWith('/') ? pathAndQuery : `/${pathAndQuery}`}${separator}client_id=${encodeURIComponent(clientId)}`;
  const response = await requestRaw(target, {});
  if ((response.status === 401 || response.status === 403) && attempt < 3) {
    markCurrentClientIdRejected();
    return apiGet(pathAndQuery, attempt + 1);
  }
  if (response.status >= 400) {
    const err = new Error(`SoundCloud API failed (${response.status})`);
    err.code = `SOUNDCLOUD_HTTP_${response.status}`;
    throw err;
  }
  try {
    return JSON.parse(response.text || '{}');
  } catch (err) {
    throw new Error(`SoundCloud response parse failed: ${err.message}`);
  }
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

function soundcloudArtwork(artworkUrl) {
  const url = normalizeText(artworkUrl);
  if (!url) return '';
  return url.replace('-large.', '-t500x500.');
}

function isPlayablePolicy(policy) {
  return policy !== 'SNIPPET' && policy !== 'BLOCKED';
}

function mapSoundCloudTrack(track, index, query) {
  track = track || {};
  const id = normalizeText(track.id) || normalizeText(track.urn);
  const name = normalizeText(track.title);
  if (!id || !name) return null;
  const publisher = track.publisher_metadata || {};
  const artist = normalizeText(publisher.artist) || normalizeText(track.user && track.user.username) || '';
  const artists = artist ? [{ id: normalizeText(track.user && track.user.permalink), name: artist }] : [];
  const durationMs = Math.max(0, Number(track.full_duration || track.duration) || 0);
  const snippetOnly = !isPlayablePolicy(track.policy);
  const hasTranscodings = Array.isArray(track.media && track.media.transcodings) && track.media.transcodings.some((t) => t && t.format && t.format.mime_type === 'audio/mpeg' && t.protocol === 'progressive');
  const playable = hasTranscodings && !snippetOnly;
  return {
    provider: 'soundcloud',
    source: 'soundcloud',
    type: 'song',
    id,
    providerSongId: id,
    permalink: normalizeText(track.permalink_url),
    name,
    artist,
    artists,
    artistId: artists[0] && artists[0].id,
    album: normalizeText(track.publisher_metadata && track.publisher_metadata.album_title),
    cover: soundcloudArtwork(track.artwork_url) || soundcloudArtwork(track.visuals && track.visuals[0] && track.visuals[0].visual_url),
    duration: Math.round(durationMs / 1000),
    durationMs,
    popularity: Number(track.likes_count) || 0,
    plays: Number(track.playback_count) || 0,
    explicit: !!((track.publisher_metadata || {}).explicit),
    fee: 0,
    playable,
    playbackMode: playable ? 'direct-url' : 'recommend-match',
    recommendationSource: 'soundcloud-public-api',
    soundcloudRank: index,
    soundcloudQuery: query || '',
    restriction: playable ? undefined : {
      category: 'provider_limited',
      reason: snippetOnly ? 'snippet_only' : 'no_progressive_stream',
      message: snippetOnly
        ? 'This SoundCloud entry only offers a preview — switching source automatically.'
        : 'This SoundCloud entry streams via HLS which the player cannot use — switching source automatically.',
      action: 'switch_source',
    },
  };
}

async function handleSoundCloudSearch(keywords, limit, offset) {
  const query = normalizeText(keywords);
  limit = Math.max(1, Math.min(SEARCH_LIMIT_MAX, Number(limit) || 20));
  offset = Math.max(0, Number(offset) || 0);
  if (!query) {
    return { provider: 'soundcloud', configured: true, songs: [], total: 0, offset, nextOffset: offset, hasMore: false, message: 'Empty query.' };
  }
  const cacheKey = `${query}|${limit}|${offset}`;
  const payload = await cacheWrap(searchCache, cacheKey, SEARCH_CACHE_TTL_MS, async () => {
    const path = `/search?q=${encodeURIComponent(query)}&limit=${limit}&offset=${offset}`;
    return apiGet(path);
  });
  const collection = Array.isArray(payload.collection) ? payload.collection : [];
  const songs = collection
    .filter((entry) => entry && entry.kind === 'track')
    .map((track, index) => mapSoundCloudTrack(track, index, query))
    .filter(Boolean);
  const total = Number(payload.total_results) || offset + songs.length;
  return {
    provider: 'soundcloud',
    configured: true,
    songs,
    total,
    offset,
    limit,
    nextOffset: offset + songs.length,
    hasMore: !!payload.next_href || offset + songs.length < total,
  };
}

async function resolveProgressiveStream(track) {
  const transcodings = track && track.media && Array.isArray(track.media.transcodings) ? track.media.transcodings : [];
  const progressive = transcodings.find((entry) => entry && entry.format && entry.format.mime_type === 'audio/mpeg' && entry.protocol === 'progressive');
  if (!progressive || !progressive.url) return null;
  const clientId = await ensureSoundCloudClientId(false);
  const separator = progressive.url.includes('?') ? '&' : '?';
  const mediaResponse = await requestRaw(`${progressive.url}${separator}client_id=${encodeURIComponent(clientId)}`, {});
  if (mediaResponse.status === 401 || mediaResponse.status === 403) {
    markCurrentClientIdRejected();
    return resolveProgressiveStreamRetry(track);
  }
  if (mediaResponse.status >= 400) return null;
  try {
    const body = JSON.parse(mediaResponse.text || '{}');
    return normalizeText(body.url) || null;
  } catch (_) {
    return null;
  }
}

async function resolveProgressiveStreamRetry(track) {
  const transcodings = track && track.media && Array.isArray(track.media.transcodings) ? track.media.transcodings : [];
  const progressive = transcodings.find((entry) => entry && entry.format && entry.format.mime_type === 'audio/mpeg' && entry.protocol === 'progressive');
  if (!progressive || !progressive.url) return null;
  const clientId = await ensureSoundCloudClientId(true);
  const separator = progressive.url.includes('?') ? '&' : '?';
  const mediaResponse = await requestRaw(`${progressive.url}${separator}client_id=${encodeURIComponent(clientId)}`, {});
  if (mediaResponse.status >= 400) return null;
  try {
    const body = JSON.parse(mediaResponse.text || '{}');
    return normalizeText(body.url) || null;
  } catch (_) {
    return null;
  }
}

async function handleSoundCloudSongUrl(idOrPermalink) {
  const id = normalizeText(idOrPermalink);
  const restrictionFallback = (reason, message) => ({
    provider: 'soundcloud',
    source: 'soundcloud',
    id,
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
  if (!id) return restrictionFallback('resolve_failed', 'Missing SoundCloud track id.');

  try {
    let track = null;
    if (/^\d+$/.test(id)) {
      track = await apiGet(`/tracks/${id}`);
    } else {
      track = await apiGet(`/resolve?url=${encodeURIComponent(id)}`);
    }
    if (!track || !track.media) {
      return restrictionFallback('no_progressive_stream', 'This SoundCloud entry cannot be streamed in the player — switching source automatically.');
    }
    const streamUrl = await resolveProgressiveStream(track);
    if (!streamUrl) {
      return restrictionFallback('no_progressive_stream', 'No free full-length stream is available on SoundCloud for this entry — switching source automatically.');
    }
    const mapped = mapSoundCloudTrack(track, 0, '');
    return {
      provider: 'soundcloud',
      source: 'soundcloud',
      id: normalizeText(track.id) || id,
      url: `/api/audio?url=${encodeURIComponent(streamUrl)}&app=soundcloud`,
      directUrl: streamUrl,
      playable: true,
      trial: false,
      level: 'standard',
      br: 128,
      playbackMode: 'direct-url',
      name: mapped.name,
      artist: mapped.artist,
      cover: mapped.cover,
      durationMs: mapped.durationMs,
      restriction: undefined,
    };
  } catch (err) {
    return restrictionFallback('url_unavailable', 'Could not resolve this SoundCloud track — switching source automatically.');
  }
}

async function handleSoundCloudLyric(id) {
  return {
    provider: 'soundcloud',
    source: 'none',
    id: normalizeText(id),
    lyric: '',
    tlyric: '',
    yrc: '',
    ytlrc: '',
    message: 'SoundCloud provides no lyrics; Mineradio will fall back to global lyric providers.',
  };
}

function getSoundCloudCapabilities() {
  return {
    configured: !!clientIdState.ids.length,
    loggedIn: true,
    capabilities: {
      search: true,
      metadata: true,
      lyric: false,
      playableUrl: true,
      playableMode: 'direct-url',
      userPlaylists: false,
      likedTracks: false,
      chart: false,
    },
  };
}

function resetSoundCloudRuntimeStateForTests() {
  clientIdState = { ids: [], index: 0, acquiredAt: 0, pending: null };
  searchCache.clear();
}

module.exports = {
  setSoundCloudProxyApplier,
  ensureSoundCloudClientId,
  handleSoundCloudSearch,
  handleSoundCloudSongUrl,
  handleSoundCloudLyric,
  getSoundCloudCapabilities,
  resetSoundCloudRuntimeStateForTests,
};
