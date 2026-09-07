'use strict';

// saavn-api — Mineradio bridge to JioSaavn's public web API.
// No account, no key: www.jiosaavn.com/api.php exposes open search and
// per-track metadata. Track media URLs arrive DES-ECB encrypted with a
// public static key; decrypting yields full-length AAC streams hosted on
// aac.saavncdn.com (the _96 variant is the complete track at ~96kbps,
// NOT a 30s clip). The API and CDN are directly reachable from networks
// where most Western services are blocked. Conventions follow spotify-api.js.

const crypto = require('crypto');

const SAAVN_API_BASE = (process.env.SAAVN_API_BASE || 'https://www.jiosaavn.com/api.php').replace(/\/+$/, '');
const SAAVN_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const SAAVN_DECRYPT_KEY = Buffer.from('38346591');
const REQUEST_TIMEOUT_MS = 9000;
const SEARCH_LIMIT_MAX = 30;

let applyProxyOptions = null;
function setSaavnProxyApplier(fn) {
  applyProxyOptions = typeof fn === 'function' ? fn : null;
}

function normalizeText(value) {
  return String(value == null ? '' : value).trim();
}

const cacheMap = new Map();
const CACHE_TTL_MS = 10 * 60 * 1000;
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

async function apiGet(params, attempt) {
  attempt = attempt || 0;
  const query = new URLSearchParams(Object.assign({ _format: 'json', _marker: '0' }, params));
  const target = `${SAAVN_API_BASE}?${query.toString()}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  const options = {
    method: 'GET',
    signal: controller.signal,
    headers: { 'User-Agent': SAAVN_UA, Accept: 'application/json', Referer: 'https://www.jiosaavn.com/' },
  };
  let fetchOptions = applyProxyOptions ? applyProxyOptions(options, 'saavn') : options;
  fetchOptions.signal = controller.signal;
  try {
    const resp = await fetch(target, fetchOptions);
    if ((resp.status === 429 || resp.status >= 500) && attempt < 2) {
      await new Promise((resolve) => setTimeout(resolve, 600 * (attempt + 1)));
      return apiGet(params, attempt + 1);
    }
    const text = await resp.text();
    let body = {};
    try { body = JSON.parse(text || '{}'); } catch (_) {}
    return { status: resp.status, body };
  } finally {
    clearTimeout(timer);
  }
}

// Legacy OpenSSL provider is required for DES-ECB on Node >= 17 unless the
// runtime flag is set. Fall back to a pure-JS implementation when needed so
// packaged builds work without flags.
let desEcbDecrypt = (() => {
  try {
    return (key, data) => {
      const decipher = crypto.createDecipheriv('des-ecb', key, Buffer.alloc(0));
      decipher.setAutoPadding(true);
      return Buffer.concat([decipher.update(data), decipher.final()]);
    };
  } catch (_) {
    // Pure-JS DES fallback (ECB, PKCS#7). Compact implementation of the
    // standard algorithm — only used when OpenSSL blocks DES.
    return buildPureJsDesDecrypt();
  }
})();

function buildPureJsDesDecrypt() {
  // Standard DES tables.
  const PC1 = [57,49,41,33,25,17,9,1,58,50,42,34,26,18,10,2,59,51,43,35,27,19,11,3,60,52,44,36,63,55,47,39,31,23,15,7,62,54,46,38,30,22,14,6,61,53,45,37,29,21,13,5,28,20,12,4];
  const PC2 = [14,17,11,24,1,5,3,28,15,6,21,10,23,19,12,4,26,8,16,7,27,20,13,2,41,52,31,37,47,55,30,40,51,45,33,48,44,49,39,56,34,53,46,42,50,36,29,32];
  const SHIFTS = [1,1,2,2,2,2,2,2,1,2,2,2,2,2,2,1];
  const IP = [58,50,42,34,26,18,10,2,60,52,44,36,28,20,12,4,62,54,46,38,30,22,14,6,64,56,48,40,32,24,16,8,57,49,41,33,25,17,9,1,59,51,43,35,27,19,11,3,61,53,45,37,29,21,13,5,63,55,47,39,31,23,15,7];
  const FP = [40,8,48,16,56,24,64,32,39,7,47,15,55,23,63,31,38,6,46,14,54,22,62,30,37,5,45,13,53,21,61,29,36,4,44,12,52,20,60,28,35,3,43,11,51,19,59,27,34,2,42,10,50,18,58,26,33,1,41,9,49,17,57,25];
  const E = [32,1,2,3,4,5,4,5,6,7,8,9,8,9,10,11,12,13,12,13,14,15,16,17,16,17,18,19,20,21,20,21,22,23,24,25,24,25,26,27,28,29,28,29,30,31,32,1];
  const P = [16,7,20,21,29,12,28,17,1,15,23,26,5,18,31,10,2,8,24,14,32,27,3,9,19,13,30,6,22,11,4,25];
  const SBOX = [
    [14,4,13,1,2,15,11,8,3,10,6,12,5,9,0,7,0,15,7,4,14,2,13,1,10,6,12,11,9,5,3,8,4,1,14,8,13,6,2,11,15,12,9,7,3,10,5,0,15,12,8,2,4,9,1,7,5,11,3,14,10,0,6,13],
    [15,1,8,14,6,11,3,4,9,7,2,13,12,0,5,10,3,13,4,7,15,2,8,14,12,0,1,10,6,9,11,5,0,14,7,11,10,4,13,1,5,8,12,6,9,3,2,15,13,8,10,1,3,15,4,2,11,6,7,12,0,5,14,9],
    [10,0,9,14,6,3,15,5,1,13,12,7,11,4,2,8,13,7,0,9,3,4,6,10,2,8,5,14,12,11,15,1,13,6,4,9,8,15,3,0,11,1,2,12,5,10,14,7,1,10,13,0,6,9,8,7,4,15,14,3,11,5,2,12],
    [7,13,14,3,0,6,9,10,1,2,8,5,11,12,4,15,13,8,11,5,6,15,0,3,4,7,2,12,1,10,14,9,10,6,9,0,12,11,7,13,15,1,3,14,5,2,8,4,3,15,0,6,10,1,13,8,9,4,5,11,12,7,2,14],
    [2,12,4,1,7,10,11,6,8,5,3,15,13,0,14,9,14,11,2,12,4,7,13,1,5,0,15,10,3,9,8,6,4,2,1,11,10,13,7,8,15,9,12,5,6,3,0,14,11,8,12,7,1,14,2,13,6,15,0,9,10,4,5,3],
    [12,1,10,15,9,2,6,8,0,13,3,4,14,7,5,11,10,15,4,2,7,12,9,5,6,1,13,14,0,11,3,8,9,14,15,5,2,8,12,3,7,0,4,10,1,13,11,6,4,3,2,12,9,5,15,10,11,14,1,7,6,0,8,13],
    [4,11,2,14,15,0,8,13,3,12,9,7,5,10,6,1,13,0,11,7,4,9,1,10,14,3,5,12,2,15,8,6,1,4,11,13,12,3,7,14,10,15,6,8,0,5,9,2,6,11,13,8,1,4,10,7,9,5,0,15,14,2,3,12],
    [13,2,8,4,6,15,11,1,10,9,3,14,5,0,12,7,1,15,13,8,10,3,7,4,12,5,6,11,0,14,9,2,7,11,4,1,9,12,14,2,0,6,10,13,15,3,5,8,2,1,14,7,4,10,8,13,15,12,9,0,3,5,6,11],
  ];
  function bytesToBits(bytes) {
    const bits = new Uint8Array(bytes.length * 8);
    for (let i = 0; i < bytes.length; i++) {
      for (let j = 0; j < 8; j++) bits[i * 8 + j] = (bytes[i] >> (7 - j)) & 1;
    }
    return bits;
  }
  function permute(input, table) {
    const out = new Uint8Array(table.length);
    for (let i = 0; i < table.length; i++) out[i] = input[table[i] - 1];
    return out;
  }
  function rotateLeft(bits, n) {
    const left = bits.slice(0, 28);
    const right = bits.slice(28);
    const rotl = (arr) => arr.slice(n).concat(arr.slice(0, n));
    return rotl(left).concat(rotl(right));
  }
  function xor(a, b) {
    const out = new Uint8Array(a.length);
    for (let i = 0; i < a.length; i++) out[i] = a[i] ^ b[i];
    return out;
  }
  function sboxSubstitute(bits) {
    const out = new Uint8Array(32);
    for (let box = 0; box < 8; box++) {
      const chunk = bits.slice(box * 6, box * 6 + 6);
      const row = (chunk[0] << 1) | chunk[5];
      const col = (chunk[1] << 3) | (chunk[2] << 2) | (chunk[3] << 1) | chunk[4];
      const value = SBOX[box][row * 16 + col];
      for (let j = 0; j < 4; j++) out[box * 4 + j] = (value >> (3 - j)) & 1;
    }
    return out;
  }
  function desBlock(blockBits, subkeys, decrypt) {
    let bits = permute(blockBits, IP);
    let left = bits.slice(0, 32);
    let right = bits.slice(32);
    for (let round = 0; round < 16; round++) {
      const subkey = subkeys[decrypt ? 15 - round : round];
      const expanded = permute(right, E);
      const mixed = xor(expanded, subkey);
      const substituted = sboxSubstitute(mixed);
      const permuted = permute(substituted, P);
      const newRight = xor(left, permuted);
      left = right;
      right = newRight;
    }
    return permute(right.concat(left), FP);
  }
  return function decryptEcb(keyBytes, cipherBytes) {
    const keyBits = permute(bytesToBits(keyBytes), PC1);
    const subkeys = [];
    let current = keyBits;
    for (let i = 0; i < 16; i++) {
      current = rotateLeft(current, SHIFTS[i]);
      subkeys.push(permute(current, PC2));
    }
    const plain = new Uint8Array(cipherBytes.length);
    for (let off = 0; off + 8 <= cipherBytes.length; off += 8) {
      const block = desBlock(bytesToBits(cipherBytes.slice(off, off + 8)), subkeys, true);
      for (let j = 0; j < 8; j++) {
        let byte = 0;
        for (let k = 0; k < 8; k++) byte = (byte << 1) | block[j * 8 + k];
        plain[off + j] = byte;
      }
    }
    // Strip PKCS#7 padding.
    const padLen = plain.length ? plain[plain.length - 1] : 0;
    const end = padLen >= 1 && padLen <= 8 ? plain.length - padLen : plain.length;
    return plain.slice(0, Math.max(0, end));
  };
}

function decryptSaavnUrl(encryptedBase64) {
  const raw = normalizeText(encryptedBase64);
  if (!raw) return '';
  try {
    const cipherBuf = Buffer.from(raw, 'base64');
    let decrypted;
    try {
      decrypted = desEcbDecrypt(SAAVN_DECRYPT_KEY, cipherBuf);
    } catch (_) {
      // Retry through the pure-JS path if the native one errored mid-stream.
      desEcbDecrypt = buildPureJsDesDecrypt();
      decrypted = desEcbDecrypt(SAAVN_DECRYPT_KEY, cipherBuf);
    }
    return normalizeText(decrypted.toString('binary'));
  } catch (_) {
    return '';
  }
}

function decodeHtmlEntities(text) {
  return String(text || '')
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
}

function saavnImage(url) {
  const src = normalizeText(url);
  if (!src) return '';
  return src.replace('150x150', '500x500');
}

function mapSaavnSong(entry, index, query) {
  entry = entry || {};
  const id = normalizeText(entry.id);
  // Search results use snake_case (song/primary_artists); song detail uses
  // camelCase (name/primaryArtists). Accept both.
  const rawName = entry.song || entry.name || entry.title || '';
  const name = decodeHtmlEntities(rawName);
  if (!id || !name) return null;
  // DRM-locked entries expose no decryptable media URL — skip them.
  if (entry.is_drm === true || entry.is_drm === 1) return null;
  const primaryRaw = entry.primary_artists || entry.primaryArtists || [];
  const artistList = Array.isArray(primaryRaw)
    ? primaryRaw.map((a) => ({ name: decodeHtmlEntities(a && (a.name || a)) })).filter((a) => a.name)
    : String(primaryRaw).split(', ').filter(Boolean).map((artistName) => ({ name: decodeHtmlEntities(artistName) }));
  const artists = artistList.filter((a) => a.name);
  const durationSec = Math.max(0, Number(entry.duration) || 0);
  const encryptedUrl = normalizeText(entry.encrypted_media_url || entry.encryptedMediaUrl || '');
  const streamUrl = decryptSaavnUrl(encryptedUrl);
  const has320 = entry['320kbps'] === true || entry['320kbps'] === 'true';
  return {
    provider: 'saavn',
    source: 'saavn',
    type: 'song',
    id,
    providerSongId: id,
    name,
    displayName: name,
    artist: artists.map((a) => a.name).join(' / ') || decodeHtmlEntities(entry.singers || '') || 'Unknown artist',
    artists,
    album: decodeHtmlEntities(entry.album || ''),
    albumId: normalizeText(entry.albumid),
    cover: saavnImage(entry.image),
    duration: durationSec,
    durationMs: durationSec * 1000,
    popularity: Number(entry.play_count) || 0,
    fee: 0,
    playable: !!streamUrl,
    playbackMode: streamUrl ? 'direct-url' : 'recommend-match',
    recommendationSource: 'jiosaavn-public-api',
    saavnRank: index,
    saavnQuery: query || '',
    language: normalizeText(entry.language),
    has320,
    restriction: streamUrl ? undefined : {
      category: 'provider_limited',
      reason: 'no_decodable_stream',
      message: 'This Saavn entry could not be resolved — switching source automatically.',
      action: 'switch_source',
    },
  };
}

async function handleSaavnSearch(keywords, limit, offset) {
  const query = normalizeText(keywords);
  limit = Math.max(1, Math.min(SEARCH_LIMIT_MAX, Number(limit) || 20));
  offset = Math.max(0, Number(offset) || 0);
  if (!query) {
    return { provider: 'saavn', configured: true, songs: [], total: 0, offset, nextOffset: offset, hasMore: false, message: 'Empty query.' };
  }
  const payload = await cacheWrap(`search|${query}`, CACHE_TTL_MS, async () => {
    const { status, body } = await apiGet({ __call: 'search.getResults', q: query, p: '1', n: '30' });
    if (status >= 400) throw new Error(`Saavn search failed (${status})`);
    return body;
  });
  const results = Array.isArray(payload.results) ? payload.results : [];
  const seen = new Set();
  const songs = [];
  for (let i = offset; i < results.length && songs.length < limit; i++) {
    const mapped = mapSaavnSong(results[i], i - offset, query);
    if (!mapped || seen.has(mapped.id)) continue;
    seen.add(mapped.id);
    songs.push(mapped);
  }
  return {
    provider: 'saavn',
    configured: true,
    songs,
    total: results.length,
    offset,
    limit,
    nextOffset: offset + songs.length,
    hasMore: offset + songs.length < results.length,
  };
}

async function handleSaavnSongUrl(id) {
  const songId = normalizeText(id);
  const missPayload = (reason, message) => ({
    provider: 'saavn',
    source: 'saavn',
    id: songId,
    url: '',
    playable: false,
    playbackMode: 'recommend-match',
    reason,
    restriction: { category: 'provider_limited', reason, message, action: 'switch_source' },
  });
  if (!songId) return missPayload('resolve_failed', 'Missing Saavn track id.');
  try {
    const payload = await cacheWrap(`song|${songId}`, CACHE_TTL_MS, async () => {
      const { status, body } = await apiGet({ __call: 'webapi.get', token: songId, type: 'song' });
      if (status >= 400) throw new Error(`Saavn song lookup failed (${status})`);
      return body;
    });
    const entry = payload && payload.songs && Array.isArray(payload.songs) ? payload.songs[0] : null;
    const streamUrl = entry ? decryptSaavnUrl(normalizeText(entry.encrypted_media_url || entry.encryptedMediaUrl || '')) : '';
    if (!entry) return missPayload('resolve_failed', 'This Saavn entry could not be found.');
    if (!streamUrl) return missPayload('no_free_stream', 'No resolvable stream exists for this entry — switching source automatically.');
    const mapped = mapSaavnSong(entry, 0, '');
    return {
      provider: 'saavn',
      source: 'saavn',
      id: songId,
      url: `/api/audio?url=${encodeURIComponent(streamUrl)}&app=saavn`,
      directUrl: streamUrl,
      playable: true,
      trial: false,
      level: mapped.has320 ? 'high' : 'standard',
      br: mapped.has320 ? 320 : 96,
      playbackMode: 'direct-url',
      name: mapped.name,
      artist: mapped.artist,
      cover: mapped.cover,
      durationMs: mapped.durationMs,
      restriction: undefined,
    };
  } catch (err) {
    return missPayload('url_unavailable', 'Could not reach Saavn for this track — switching source automatically.');
  }
}

async function handleSaavnLyric(id) {
  return {
    provider: 'saavn',
    source: 'none',
    id: normalizeText(id),
    lyric: '',
    tlyric: '',
    yrc: '',
    ytlrc: '',
    message: 'Saavn provides no lyrics; Mineradio will fall back to global lyric providers.',
  };
}

function getSaavnCapabilities() {
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

function resetSaavnRuntimeStateForTests() {
  cacheMap.clear();
}

module.exports = {
  setSaavnProxyApplier,
  decryptSaavnUrl,
  handleSaavnSearch,
  handleSaavnSongUrl,
  handleSaavnLyric,
  getSaavnCapabilities,
  resetSaavnRuntimeStateForTests,
};
