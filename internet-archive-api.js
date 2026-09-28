'use strict';

// internet-archive-api — Mineradio bridge to the Internet Archive's public
// metadata and file APIs. No key, no account, no client id: archive.org serves
// full-length audio over plain HTTPS and resolves on networks where the
// streaming services are DNS-blocked, which makes it the only keyless source
// here that plays whole tracks rather than 30-second previews.
// Module conventions follow itunes-api.js: injected proxy applier, TTL caches,
// handler functions exported.

const IA_BASE = (process.env.IA_BASE || 'https://archive.org').replace(/\/+$/, '');
const IA_UA = 'Mineradio/2.1.0 (Internet Archive bridge)';
const REQUEST_TIMEOUT_MS = 10000;
const SEARCH_LIMIT_MAX = 40;
const ITEMS_PER_SEARCH = 20;
// How many archive.org metadata lookups to run at once. High enough to collapse
// a thirty-second serial loop into a few seconds, low enough not to hammer a
// public archive that has no rate-limit budget for us.
const META_CONCURRENCY = 6;
// Audio formats in the order we prefer them. mp3 first: every Archive item has
// one, so a search almost always yields something playable.
const AUDIO_FORMAT_RANK = ['mp3', 'm4a', 'ogg', 'flac', 'wav', 'aac', 'opus'];

let applyProxyOptions = null;
function setInternetArchiveProxyApplier(fn) {
  applyProxyOptions = typeof fn === 'function' ? fn : null;
}

function normalizeText(value) {
  return String(value == null ? '' : value).trim();
}

const cacheMap = new Map();
const CACHE_TTL_MS = 30 * 60 * 1000;
const CACHE_MAX = 200;

function cacheWrap(key, ttlMs, producer) {
  const hit = cacheMap.get(key);
  const now = Date.now();
  if (hit && hit.expiresAt > now) return Promise.resolve(hit.value);
  if (hit) cacheMap.delete(key);
  return Promise.resolve()
    .then(producer)
    .then((value) => {
      // fetchItemFiles answers null when archive.org errors. Caching that would
      // pin a transient 500 for thirty minutes and make one track unplayable
      // until the app restarts, so failures are simply not stored.
      if (value == null) return value;
      cacheMap.set(key, { value, expiresAt: Date.now() + ttlMs });
      if (cacheMap.size > CACHE_MAX) {
        const oldest = cacheMap.keys().next().value;
        if (oldest !== undefined) cacheMap.delete(oldest);
      }
      return value;
    });
}

async function requestJson(pathAndQuery) {
  const target = `${IA_BASE}${pathAndQuery.startsWith('/') ? pathAndQuery : `/${pathAndQuery}`}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  const options = {
    method: 'GET',
    signal: controller.signal,
    headers: { 'User-Agent': IA_UA, Accept: 'application/json' },
  };
  const fetchOptions = applyProxyOptions ? applyProxyOptions(options, 'archive') : options;
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

function extensionRank(name) {
  const ext = String(name || '').toLowerCase().split('.').pop();
  const index = AUDIO_FORMAT_RANK.indexOf(ext);
  return index === -1 ? AUDIO_FORMAT_RANK.length : index;
}

// "item-name/03 - Track.mp3" → "03 - Track"; archive paths put tracks in
// subfolders, so take the last segment.
function baseName(fileName) {
  return String(fileName || '').split('/').pop().replace(/\.[a-z0-9]{2,5}$/i, '').trim();
}

function artistFromItem(metadata) {
  const value = normalizeText(metadata && metadata.creator);
  if (!value) return 'Unknown artist';
  // Archive creators are often "First Last (performer)" or comma-joined lists.
  return value.replace(/\s*\((?:performer|composer|author)\)\s*$/i, '').split(/,\s*/)[0].trim() || 'Unknown artist';
}

// Open Archive search is dominated by radio archives, news bulletins and
// spoken-word items. They are audio but not music, so drop them.
// Note: separators must be explicit rather than \b — "_" is a word character,
// so /\bvoa\b/ does not match the identifier "VOA_Africa_20191215_110000".
const NON_MUSIC_RE = new RegExp(
  [
    'radio[ _-]?program',
    'voice of america',
    '(?:^|[^a-z0-9])voa[a-z0-9_]',
    'podcast',
    'news ?bulletin',
    'news ?update',
    'weather report',
    'interview',
    'speech',
    'sermon',
    'lecture',
    'vocation',
  ].join('|'),
  'i'
);
const MUSIC_SUBJECT_RE = new RegExp(
  '(music|rock|jazz|blues|folk|pop|metal|hip hop|rap|classical|punk|indie|edm|electronic|guitar|drum|bass|song|album|live)',
  'i'
);
// Real music items are track-numbered ("01 City of Blinding Lights.mp3" or
// "01 - Sweet Child.mp3"); broadcasts and spoken word are a single whole-file
// recording. Requiring a separator after the number would reject the bare
// "01 Song.mp3" form that most Archive music actually uses.
const TRACK_NUMBER_RE = /^\s*\d{1,3}\s*(?:[-._)\]]\s*)?\S/;

// The searchable half of an item: everything archive.org already told us in the
// search document, no second request required.
function searchHaystack(item) {
  const metadata = (item && item.metadata) || {};
  return [
    normalizeText(item && item.identifier),
    normalizeText(metadata.title),
    normalizeText(metadata.subject),
  ].join(' ');
}

// The cheap, always-safe rejection. A free-text Archive query comes back mostly
// with podcasts and radio programmes, and every one of those used to cost a
// 1.5-2.6s metadata round-trip only to be discarded on the line below it. This
// runs the same NON_MUSIC_RE test before any request is made.
function looksLikeSpokenWord(item) {
  return NON_MUSIC_RE.test(searchHaystack(item));
}

function looksLikeMusic(item, files) {
  const metadata = (item && item.metadata) || {};
  const subject = normalizeText(metadata.subject);
  if (NON_MUSIC_RE.test(searchHaystack(item))) return false;
  if (MUSIC_SUBJECT_RE.test(subject)) return true;
  const audioNames = (files || [])
    .map((f) => String((f && f.name) || '').split('/').pop())
    .filter((n) => /\.(mp3|m4a|ogg|flac|wav|aac|opus)$/i.test(n));
  return audioNames.some((n) => TRACK_NUMBER_RE.test(n));
}

function pickAudioFile(files) {
  const audio = (files || []).filter((file) => {
    if (!file) return false;
    // Do NOT filter on source:'derivative'. For music items the mp3 *is* the
    // derivative and the "original" is a lossless wav; rejecting derivatives
    // would throw away every mp3 on the Archive.
    const name = String(file.name || '');
    if (!/\.(mp3|m4a|ogg|flac|wav|aac|opus)$/i.test(name)) return false;
    if (/(sample|preview|thumb|spectrogram)/i.test(name)) return false;
    return Number(file.size || file.length || 0) > 0;
  });
  if (!audio.length) return null;
  audio.sort((a, b) => {
    const rank = extensionRank(a.name) - extensionRank(b.name);
    if (rank !== 0) return rank;
    return String(a.name).localeCompare(String(b.name));
  });
  return audio[0];
}

function mapItemToSong(item, files, rank) {
  const identifier = normalizeText(item && item.identifier);
  if (!identifier) return null;
  const metadata = (item && item.metadata) || {};
  const file = pickAudioFile(files);
  if (!file) return null;
  const size = Number(file.size || file.length || 0);
  const trackTitle = baseName(file.name) || normalizeText(metadata.title) || identifier;
  const artist = artistFromItem(metadata);
  const direct = `${IA_BASE}/download/${encodeURIComponent(identifier)}/${encodeURIComponent(String(file.name).split('/').map(encodeURIComponent).join('/'))}`;
  return {
    provider: 'archive',
    source: 'archive',
    type: 'song',
    // identifier + file name: one item can hold many tracks, so the pair is
    // the only stable key.
    id: `${identifier}::${file.name}`,
    providerSongId: `${identifier}::${file.name}`,
    name: trackTitle,
    displayName: trackTitle,
    artist,
    artists: [{ id: normalizeText(metadata.creator), name: artist }],
    artistId: normalizeText(metadata.creator),
    album: normalizeText(metadata.title) || identifier,
    albumId: identifier,
    cover: metadata.thumbnail
      ? (/^https?:/i.test(metadata.thumbnail) ? metadata.thumbnail : `${IA_BASE}/services/img/${encodeURIComponent(identifier)}`)
      : '',
    duration: 0,
    durationMs: 0,
    size,
    popularity: 0,
    fee: 0,
    genre: normalizeText(metadata.subject).split(/[;,(]/)[0].trim(),
    explicit: false,
    playable: true,
    url: '',
    playbackMode: 'direct-url',
    recommendationSource: 'internet-archive',
    archiveRank: rank,
    archiveIdentifier: identifier,
    archiveFile: file.name,
  };
}

async function fetchItemFiles(identifier) {
  const { status, body } = await requestJson(`/metadata/${encodeURIComponent(identifier)}`);
  if (status >= 400) return null;
  return { metadata: (body && body.metadata) || {}, files: (body && body.files) || [] };
}

// The 30-minute cache already existed for song/url; search went back to
// archive.org for the same items on every run instead of reusing it, so a
// repeated search still cost over a second after the first had paid for it.
function cachedItemFiles(identifier) {
  return cacheWrap(`meta|${identifier}`, CACHE_TTL_MS, () => fetchItemFiles(identifier));
}

async function handleInternetArchiveSearch(keywords, limit, offset) {
  const query = normalizeText(keywords);
  limit = Math.max(1, Math.min(SEARCH_LIMIT_MAX, Number(limit) || 25));
  offset = Math.max(0, Number(offset) || 0);
  if (!query) {
    return { provider: 'archive', configured: true, songs: [], total: 0, offset, nextOffset: offset, hasMore: false, message: 'Empty query.' };
  }
  // Search every audio collection, then keep only items that actually carry a
  // playable file. Free-text matches hit books and video constantly.
  const items = await cacheWrap(`search|${query}`, CACHE_TTL_MS, async () => {
    const fetchDocs = async (q, page) => {
      // URLSearchParams percent-encodes the brackets in "fl[]" to "fl%5B%5D",
      // which the Archive accepts but silently drops from the response — every
      // doc then comes back with an undefined identifier. Write the field list
      // literally instead.
      const params = [
        'q=' + encodeURIComponent(`mediatype:(audio) AND ${q}`),
        'fl[]=identifier',
        'fl[]=title',
        'fl[]=creator',
        'fl[]=subject',
        'rows=' + ITEMS_PER_SEARCH,
        'page=' + (page || 1),
        'output=json',
      ].join('&');
      const { status, body } = await requestJson(`/advancedsearch.php?${params}`);
      if (status >= 400) throw new Error(`Internet Archive search failed (${status})`);
      const docs = body && body.response && Array.isArray(body.response.docs) ? body.response.docs : [];
      return docs.map((doc) => ({
        identifier: doc.identifier,
        metadata: { title: doc.title, creator: doc.creator, subject: doc.subject },
      }));
    };
    const seen = new Set();
    const merged = [];
    // Open search only. Scoping to named music collections is tempting but
    // unreliable: collection:(etree) returns nothing at all any more, and the
    // rest still surface radio shows and news broadcasts. Instead take a wide
    // slice of hits and keep the ones that really are music.
    for (let page = 1; merged.length < ITEMS_PER_SEARCH && page <= 3; page += 1) {
      let docs = [];
      try {
        docs = await fetchDocs(`(${query})`, page);
      } catch (_) {
        break;
      }
      for (const doc of docs) {
        if (seen.has(doc.identifier)) continue;
        seen.add(doc.identifier);
        merged.push(doc);
      }
      if (!docs.length) break;
    }
    return merged.slice(0, ITEMS_PER_SEARCH);
  });

  // Drop the podcasts and radio programmes straight off the search document
  // before any metadata lookup is paid for, then resolve what is left in waves.
  // Each lookup costs 1.3-2.6s and used to run one at a time, so twenty items
  // meant thirty seconds before the first result could render — the whole of the
  // "search is slow" complaint.
  const candidates = items.filter((item) => !looksLikeSpokenWord(item));
  const wanted = offset + limit;
  const songs = [];
  let examined = 0;
  for (let i = 0; i < candidates.length && songs.length < wanted; i += META_CONCURRENCY) {
    const wave = candidates.slice(i, i + META_CONCURRENCY);
    examined += wave.length;
    const details = await Promise.all(wave.map((item) =>
      cachedItemFiles(item.identifier).catch(() => null)
    ));
    for (let j = 0; j < wave.length; j += 1) {
      if (songs.length >= wanted) break;
      const files = details[j] && details[j].files;
      if (!files) continue;
      if (!looksLikeMusic(wave[j], files)) continue;
      const song = mapItemToSong(wave[j], files, songs.length);
      if (song) songs.push(song);
    }
  }
  const page = songs.slice(offset, offset + limit);
  return {
    provider: 'archive',
    configured: true,
    songs: page,
    total: songs.length,
    offset,
    limit,
    nextOffset: offset + page.length,
    // Work stops as soon as this page is full, so candidates that were never
    // examined have to count as "more" or the next page would never be offered.
    hasMore: offset + page.length < songs.length || examined < candidates.length,
  };
}

async function handleInternetArchiveSongUrl(id) {
  const key = normalizeText(id);
  const missPayload = (reason, message) => ({
    provider: 'archive',
    source: 'archive',
    id: key,
    url: '',
    playable: false,
    playbackMode: 'recommend-match',
    reason,
    restriction: { category: 'provider_limited', reason, message, action: 'switch_source' },
  });
  const splitAt = key.indexOf('::');
  const identifier = splitAt > 0 ? key.slice(0, splitAt) : key;
  const wantedFile = splitAt > 0 ? key.slice(splitAt + 2) : '';
  if (!identifier) return missPayload('resolve_failed', 'Missing Internet Archive item id.');
  try {
    const details = await cachedItemFiles(identifier);
    if (!details) return missPayload('resolve_failed', 'This Internet Archive item could not be found.');
    let file = null;
    if (wantedFile) {
      file = (details.files || []).find((entry) => entry && entry.name === wantedFile) || null;
    }
    if (!file) file = pickAudioFile(details.files);
    if (!file) return missPayload('no_free_stream', 'This Internet Archive item has no downloadable audio — switching source automatically.');
    const encodedPath = String(file.name).split('/').map(encodeURIComponent).join('/');
    const direct = `${IA_BASE}/download/${encodeURIComponent(identifier)}/${encodedPath}`;
    const song = mapItemToSong({ identifier, metadata: details.metadata }, [file], 0);
    return {
      provider: 'archive',
      source: 'archive',
      id: key,
      url: `/api/audio?url=${encodeURIComponent(direct)}&app=archive`,
      directUrl: direct,
      playable: true,
      trial: false,
      level: 'full',
      br: 128,
      playbackMode: 'direct-url',
      name: song ? song.name : baseName(file.name),
      artist: song ? song.artist : 'Unknown artist',
      cover: song ? song.cover : '',
      durationMs: 0,
      archiveIdentifier: identifier,
      archiveFile: file.name,
    };
  } catch (err) {
    return missPayload('url_unavailable', 'Could not reach the Internet Archive for this track — switching source automatically.');
  }
}

async function handleInternetArchiveLyric(id) {
  return {
    provider: 'archive',
    source: 'none',
    id: normalizeText(id),
    lyric: '',
    tlyric: '',
    yrc: '',
    ytlrc: '',
    message: 'The Internet Archive serves audio only; Mineradio falls back to global lyric providers.',
  };
}

function getInternetArchiveCapabilities() {
  return {
    configured: true,
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

function resetInternetArchiveRuntimeStateForTests() {
  cacheMap.clear();
}

module.exports = {
  setInternetArchiveProxyApplier,
  handleInternetArchiveSearch,
  handleInternetArchiveSongUrl,
  handleInternetArchiveLyric,
  getInternetArchiveCapabilities,
  resetInternetArchiveRuntimeStateForTests,
  __test: { pickAudioFile, looksLikeMusic, looksLikeSpokenWord, mapItemToSong, baseName, artistFromItem, extensionRank },
};
