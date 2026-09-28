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
// Eight seconds was shorter than the host itself: itunes.apple.com routinely
// takes 3s to answer here and often longer, so requests were being aborted at
// the deadline and surfaced as HTTP 502 "iTunes search failed (abort)". One
// provider that needs ~1.5s on a good run is not worth a budget that tight.
const REQUEST_TIMEOUT_MS = 20000;
const SEARCH_LIMIT_MAX = 50;
// Apple's search ranks remixes, live and karaoke versions of the exact title
// above the original, so pull a wide slice and re-rank. A search for "blinding
// lights" otherwise returns the remix first and buries the track people meant.
const SEARCH_FETCH_FACTOR = 4;
const SEARCH_FETCH_MAX = 200;

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

// itunes.apple.com drops TCP connections on this network — roughly one request
// in six answers "fetch failed" — and that is environmental, not a bug here.
// Absorb it with one bounded retry instead of handing the fan-out a 502 and
// leaving a working source contributing nothing.
const TRANSIENT_RETRY_DELAY_MS = 500;

function isDroppedConnection(err) {
  // Timeouts are deliberately excluded. The search fan-out has already
  // abandoned this provider at its own deadline, so paying another twenty
  // seconds would only delay the fallback every other source is waiting on.
  if (!err || err.statusCode) return false;
  if (err.name === 'AbortError' || err.code === 'ABORT_ERR') return false;
  return true;
}

async function requestJson(pathAndQuery) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await requestJsonOnce(pathAndQuery);
    } catch (err) {
      if (!isDroppedConnection(err) || attempt >= 1) throw err;
      await new Promise((resolve) => setTimeout(resolve, TRANSIENT_RETRY_DELAY_MS));
    }
  }
}

async function requestJsonOnce(pathAndQuery) {
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

// "blinding lights remix live karaoke version" → the words people actually
// typed, with the noise words removed.
function queryTerms(query) {
  return normalizeText(query)
    .toLowerCase()
    .split(/[^\p{L}\p{N}']+/u)
    .filter(Boolean);
}

// Title words that mean "this is a different recording of the same song".
const VARIANT_WORDS = new Set([
  'remix', 'remixed', 'live', 'acoustic', 'cover', 'karaoke', 'instrumental',
  'demo', 'radioedit', 'edit', 'mix', 'version', 'reprise', 'unplugged',
  'instrumentalversion',
]);

// Score lower is better. An exact title match always beats a variant of it.
function scoreTrack(track, terms) {
  if (!terms.length) return 0;
  const title = String((track && track.trackName) || '').toLowerCase();
  const artist = String((track && track.artistName) || '').toLowerCase();
  let score = 0;
  let artistMatches = 0;
  // A title that equals the whole typed phrase outranks one that merely
  // contains its words, which demotes "Blinding Lights (Remix)" and covers
  // whose title embeds extra words.
  const phrase = terms.join(' ');
  if (phrase && title === phrase) score -= 12;
  for (const term of terms) {
    // An artist-name hit is the strongest relevance signal available, so it
    // outranks a title hit and is not also counted in the title. Without this,
    // a cover titled "Blinding Lights The Weeknd" outscores the real track.
    if (artist.includes(term)) {
      score -= 4;
      artistMatches += 1;
      continue;
    }
    if (title === term) score -= 6;
    else if (title.startsWith(term)) score -= 3;
    else if (title.includes(term)) score -= 2;
    else score += 4;
  }
  if (artistMatches) score -= 2;
  const variant = tokensOf(title).filter((t) => VARIANT_WORDS.has(t));
  if (variant.length) score += variant.length * 3;
  return score;
}

function tokensOf(text) {
  return String(text || '')
    .toLowerCase()
    .split(/[^\p{L}\p{N}']+/u)
    .filter(Boolean);
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
      limit: String(Math.min(SEARCH_FETCH_MAX, limit * SEARCH_FETCH_FACTOR)),
      country: process.env.ITUNES_COUNTRY || 'US',
    });
    const { status, body } = await requestJson(`/search?${params.toString()}`);
    if (status >= 400) throw new Error(`iTunes search failed (${status})`);
    return body;
  });
  const results = Array.isArray(payload.results) ? payload.results : [];
  const terms = queryTerms(query);
  const ranked = results
    .map((entry, index) => ({ entry, index, score: scoreTrack(entry, terms) }))
    .sort((a, b) => (a.score - b.score) || (a.index - b.index));
  const seen = new Set();
  const songs = [];
  for (const item of ranked) {
    if (songs.length >= limit) break;
    const mapped = mapItunesTrack(item.entry, item.index, query);
    // This provider can only ever play a preview, so a track without one is a
    // result the user can click and get nothing from. The search API happily
    // ranks those first (they are often the exact title match), which is how
    // the top row of results turned out to be unplayable.
    if (!mapped || !mapped.playable || seen.has(mapped.id)) continue;
    seen.add(mapped.id);
    songs.push(mapped);
  }
  return {
    provider: 'itunes',
    configured: true,
    songs,
    total: ranked.length,
    offset,
    limit,
    nextOffset: offset + songs.length,
    hasMore: songs.length < ranked.length,
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
  __test: { queryTerms, scoreTrack, tokensOf, mapItunesTrack },
};
