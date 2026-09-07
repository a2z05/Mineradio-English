'use strict';

// yt-music-api — Mineradio bridge to YouTube Music via the public InnerTube
// endpoints (the same ones the music.youtube.com web player calls, using its
// public WEB_REMIX client context). No account needed for search; streams
// resolve through the player endpoint with an alternate client. YouTube
// extraction is inherently fragile — every failure path returns a
// recommend-match restriction so the renderer falls back to another source
// instead of surfacing an error.

const https = require('https');

const YTMUSIC_BASE = 'https://music.youtube.com';
const INNER_TUBE_KEY = 'AIzaSyC9XL3ZjWddXya6X74dJoCTL-WEYFDNX30';
const INNERTUBE_CONTEXT_WEB = {
  client: {
    clientName: 'WEB_REMIX',
    clientVersion: '1.20240401.01.00',
    hl: 'en',
    gl: 'US',
  },
};
const INNERTUBE_CONTEXT_ANDROID = {
  client: {
    clientName: 'ANDROID',
    clientVersion: '19.09.37',
    androidSdkVersion: 30,
    hl: 'en',
    gl: 'US',
  },
};
const YTMUSIC_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const ANDROID_UA = 'com.google.android.apps.youtube.music/19.09.37 (Linux; U; Android 11) gzip';
const REQUEST_TIMEOUT_MS = 9000;
const SEARCH_LIMIT_MAX = 30;

let applyProxyOptions = null;
function setYtMusicProxyApplier(fn) {
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

async function innertubePost(endpoint, body, clientContext, userAgent) {
  const url = `${YTMUSIC_BASE}/youtubei/v1/${endpoint}?key=${INNER_TUBE_KEY}&prettyPrint=false`;
  const payload = JSON.stringify(Object.assign({}, body, { context: clientContext }));
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  const fetchOptions = {
    method: 'POST',
    signal: controller.signal,
    headers: {
      'User-Agent': userAgent || YTMUSIC_UA,
      'Content-Type': 'application/json',
      Origin: YTMUSIC_BASE,
      Referer: `${YTMUSIC_BASE}/`,
      Accept: 'application/json',
      'Content-Length': String(Buffer.byteLength(payload)),
    },
    body: payload,
  };
  if (applyProxyOptions) {
    // applyToOptions returns a new object rather than mutating its argument.
    Object.assign(fetchOptions, applyProxyOptions(fetchOptions, 'ytmusic'));
  }
  let resp;
  try {
    resp = await fetch(url, fetchOptions);
  } finally {
    // keep timer alive until body read below; cleared in the tail
  }
  try {
    const text = await resp.text();
    let json = {};
    try { json = JSON.parse(text || '{}'); } catch (_) {}
    return { status: resp.status, body: json };
  } finally {
    clearTimeout(timer);
  }
}

// --- Search parsing -------------------------------------------------------

function walkJson(root, visitor) {
  const stack = [root];
  while (stack.length) {
    const node = stack.pop();
    if (!node || typeof node !== 'object') continue;
    if (Array.isArray(node)) {
      for (const item of node) stack.push(item);
      continue;
    }
    visitor(node);
    for (const key of Object.keys(node)) stack.push(node[key]);
  }
}

function textRunText(node) {
  if (!node) return '';
  if (typeof node === 'string') return normalizeText(node);
  if (typeof node.simpleText === 'string') return normalizeText(node.simpleText);
  if (node.runs && Array.isArray(node.runs)) {
    return normalizeText(node.runs.map((run) => run && run.text).join(''));
  }
  return '';
}

function bestThumb(thumbnailRenderer) {
  const thumbs = thumbnailRenderer && thumbnailRenderer.thumbnails;
  if (!Array.isArray(thumbs) || !thumbs.length) return '';
  const sorted = thumbs.slice().sort((a, b) => (Number(b.width) || 0) - (Number(a.width) || 0));
  return normalizeText(sorted[0].url);
}

function parseDurationMs(text) {
  const raw = normalizeText(text);
  const match = raw.match(/^(\d+):(\d{1,2})(?::(\d{1,2}))?$/);
  if (!match) return 0;
  if (match[3] !== undefined) {
    return ((Number(match[1]) * 60 + Number(match[2])) * 1000) + Number(match[3]) * 1000;
  }
  return (Number(match[1]) * 60 + Number(match[2])) * 1000;
}

function mapSearchListItem(renderer, index, query) {
  renderer = renderer || {};
  const flexColumns = Array.isArray(renderer.flexColumns) ? renderer.flexColumns : [];
  let videoId = '';
  let title = '';
  let artist = '';
  let artistId = '';
  let album = '';
  let albumId = '';
  let durationMs = 0;

  const playlistData = (((flexColumns[0] || {}).musicResponsiveListItemFlexColumnRenderer || {}).text || {}).runs || [];
  for (const run of playlistData) {
    const nav = run && run.navigationEndpoint && run.navigationEndpoint.watchEndpoint;
    if (nav && nav.videoId) {
      videoId = String(nav.videoId);
      break;
    }
  }
  title = textRunText(((flexColumns[0] || {}).musicResponsiveListItemFlexColumnRenderer || {}).text);

  for (let i = 1; i < flexColumns.length; i++) {
    const column = flexColumns[i] && flexColumns[i].musicResponsiveListItemFlexColumnRenderer;
    const runs = (column && column.text && Array.isArray(column.text.runs)) ? column.text.runs : [];
    for (const run of runs) {
      const browseId = run && run.navigationEndpoint && run.navigationEndpoint.browseEndpoint && run.navigationEndpoint.browseEndpoint.browseId;
      const pageType = run && run.navigationEndpoint && run.navigationEndpoint.browseEndpoint
        && run.navigationEndpoint.browseEndpoint.webBrowseEndpoint
        && run.navigationEndpoint.browseEndpoint.webBrowseEndpoint.browsePageType;
      const isArtist = (browseId && /^UC/.test(browseId) && textRunText({ runs: [run] }))
        || (pageType === 'MUSIC_PAGE_TYPE_ARTIST')
        || (browseId && run.navigationEndpoint.browseEndpoint.webPageType === 'MUSIC_PAGE_TYPE_ARTIST');
      const text = textRunText({ runs: [run] });
      if (!text) continue;
      if (/^\d+:\d{1,2}(:\d{1,2})?$/.test(text)) {
        durationMs = parseDurationMs(text);
      } else if (isArtist && !artist) {
        artist = text;
        artistId = browseId || '';
      } else if (!album) {
        album = text;
        albumId = browseId || '';
      }
    }
  }

  const fixedColumns = Array.isArray(renderer.fixedColumns) ? renderer.fixedColumns : [];
  for (const column of fixedColumns) {
    const fixedText = textRunText(column && column.musicResponsiveListItemFixedColumnRenderer && column.musicResponsiveListItemFixedColumnRenderer.text);
    if (/^\d+:\d{1,2}(:\d{1,2})?$/.test(fixedText) && !durationMs) {
      durationMs = parseDurationMs(fixedText);
    }
  }

  if (!videoId || !title) return null;
  const cover = bestThumb(renderer.thumbnail && renderer.thumbnail.musicThumbnailRenderer);
  const artists = artist ? [{ id: artistId, name: artist }] : [];
  const playableHint = !/video/i.test(normalizeText(renderer.badge && JSON.stringify(renderer.badge)));
  return {
    provider: 'ytmusic',
    source: 'ytmusic',
    type: 'song',
    id: videoId,
    providerSongId: videoId,
    videoId,
    name: title.replace(/\s*\((official|lyric|audio|video)[^)]*\)/ig, '').trim() || title,
    displayName: title,
    artist: artist || 'Unknown artist',
    artists,
    artistId,
    album,
    albumId,
    cover,
    duration: Math.round(durationMs / 1000),
    durationMs,
    popularity: 0,
    fee: 0,
    playable: true,
    playbackMode: playableHint ? 'direct-url' : 'recommend-match',
    recommendationSource: 'ytmusic-innertube',
    ytmusicRank: index,
    ytmusicQuery: query || '',
    restriction: undefined,
  };
}

const SONGS_FILTER = 'EgWKAQIIAWoKEAkQBRAKEAMQBA%3D%3D';

async function handleYtMusicSearch(keywords, limit, offset) {
  const query = normalizeText(keywords);
  limit = Math.max(1, Math.min(SEARCH_LIMIT_MAX, Number(limit) || 20));
  offset = Math.max(0, Number(offset) || 0);
  if (!query) {
    return { provider: 'ytmusic', configured: true, songs: [], total: 0, offset, nextOffset: offset, hasMore: false, message: 'Empty query.' };
  }
  const cacheKey = `${query}|${limit}|${offset}`;
  const results = await cacheWrap(searchCache, cacheKey, SEARCH_CACHE_TTL_MS, async () => {
    const params = offset > 0 ? '' : SONGS_FILTER;
    const { status, body } = await innertubePost('search', {
      query,
      params,
    }, INNERTUBE_CONTEXT_WEB, null);
    if (status >= 400) throw new Error(`YT Music search failed (${status})`);
    const items = [];
    walkJson(body, (node) => {
      if (node && node.musicResponsiveListItemRenderer && items.length < limit * 3) {
        items.push(node.musicResponsiveListItemRenderer);
      }
    });
    return items;
  });
  const seen = new Set();
  const songs = [];
  for (let index = 0; index < results.length && songs.length < limit; index++) {
    const mapped = mapSearchListItem(results[index], index, query);
    if (!mapped || seen.has(mapped.videoId)) continue;
    seen.add(mapped.videoId);
    songs.push(mapped);
  }
  return {
    provider: 'ytmusic',
    configured: true,
    songs,
    total: songs.length + offset,
    offset,
    limit,
    nextOffset: offset + songs.length,
    hasMore: false,
  };
}

// --- Stream resolution ----------------------------------------------------

function itagPreference(itag) {
  // Prefer progressive audio containers <audio> can play directly.
  const order = { 140: 0, 139: 1, 141: 2, 18: 3, 22: 4, 251: 10, 250: 11, 249: 12 };
  return order[itag] !== undefined ? order[itag] : 50;
}

async function handleYtMusicSongUrl(videoId) {
  const id = normalizeText(videoId);
  const fallbackRestriction = (reason, message) => ({
    provider: 'ytmusic',
    source: 'ytmusic',
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
  if (!id) return fallbackRestriction('resolve_failed', 'Missing YouTube Music track id.');
  try {
    const { status, body } = await innertubePost('player', {
      videoId: id,
      contentCheckOk: true,
      racyCheckOk: true,
    }, INNERTUBE_CONTEXT_ANDROID, ANDROID_UA);
    if (status >= 400 || !body) {
      return fallbackRestriction('url_unavailable', 'YouTube Music did not return a stream — switching source automatically.');
    }
    const playability = body.playabilityStatus || {};
    if (playability.status && playability.status !== 'OK') {
      return fallbackRestriction('provider_limited', playability.reason || 'This entry is not streamable on YouTube Music — switching source automatically.');
    }
    const streamingData = body.streamingData || {};
    const formats = Array.isArray(streamingData.formats) ? streamingData.formats : [];
    const adaptive = Array.isArray(streamingData.adaptiveFormats) ? streamingData.adaptiveFormats : [];
    const candidates = formats.concat(adaptive)
      .filter((format) => format && format.url && (String(format.mimeType || '').startsWith('audio/') || Number(format.itag) === 18))
      .sort((a, b) => itagPreference(Number(a.itag) || 0) - itagPreference(Number(b.itag) || 0));
    const chosen = candidates[0];
    if (!chosen || !chosen.url) {
      return fallbackRestriction('no_progressive_stream', 'YouTube Music only offered encrypted streams for this entry — switching source automatically.');
    }
    const videoDetails = body.videoDetails || {};
    const thumbs = Array.isArray(videoDetails.thumbnail && videoDetails.thumbnail.thumbnails) ? videoDetails.thumbnail.thumbnails : [];
    const cover = thumbs.length ? normalizeText(thumbs[thumbs.length - 1].url) : '';
    const author = normalizeText(videoDetails.author);
    return {
      provider: 'ytmusic',
      source: 'ytmusic',
      id,
      url: `/api/audio?url=${encodeURIComponent(chosen.url)}&app=ytmusic`,
      directUrl: chosen.url,
      playable: true,
      trial: false,
      level: 'standard',
      br: Number(chosen.bitrate) || 0,
      playbackMode: 'direct-url',
      name: normalizeText(videoDetails.title) || '',
      artist: author || 'Unknown artist',
      cover,
      durationMs: Number(chosen.approxDurationMs) || Number(videoDetails.lengthMilliseconds) || 0,
      restriction: undefined,
    };
  } catch (err) {
    return fallbackRestriction('url_unavailable', 'Could not reach YouTube Music for this track — switching source automatically.');
  }
}

// --- Lyrics ("Google lyrics") --------------------------------------------

async function handleYtMusicLyric(videoId) {
  const id = normalizeText(videoId);
  if (!id) {
    return { provider: 'ytmusic', source: 'none', id, lyric: '', tlyric: '', yrc: '', ytlrc: '', message: 'Missing video id.' };
  }
  try {
    const { status, body } = await innertubePost('next', { videoId: id }, INNERTUBE_CONTEXT_WEB, null);
    if (status >= 400) throw new Error(`YT Music lyric failed (${status})`);
    let lyric = '';
    walkJson(body, (node) => {
      if (lyric) return;
      const shelf = node && node.musicDescriptionShelfRenderer;
      if (shelf && shelf.description) {
        lyric = textRunText(shelf.description);
      }
    });
    if (!lyric) {
      return {
        provider: 'ytmusic',
        source: 'none',
        id,
        lyric: '',
        tlyric: '',
        yrc: '',
        ytlrc: '',
        message: 'No description lyrics on YouTube Music for this entry.',
      };
    }
    return {
      provider: 'ytmusic',
      source: 'ytmusic-description',
      id,
      lyric,
      tlyric: '',
      yrc: '',
      ytlrc: '',
    };
  } catch (err) {
    return {
      provider: 'ytmusic',
      source: 'none',
      id,
      lyric: '',
      tlyric: '',
      yrc: '',
      ytlrc: '',
      message: 'YouTube Music lyrics unavailable.',
      error: err.message,
    };
  }
}

function getYtMusicCapabilities() {
  return {
    configured: true,
    loggedIn: true,
    capabilities: {
      search: true,
      metadata: true,
      lyric: true,
      lyricMode: 'description',
      playableUrl: true,
      playableMode: 'direct-url',
      userPlaylists: false,
      likedTracks: false,
      chart: false,
    },
  };
}

function resetYtMusicRuntimeStateForTests() {
  searchCache.clear();
}

module.exports = {
  setYtMusicProxyApplier,
  handleYtMusicSearch,
  handleYtMusicSongUrl,
  handleYtMusicLyric,
  getYtMusicCapabilities,
  resetYtMusicRuntimeStateForTests,
};
