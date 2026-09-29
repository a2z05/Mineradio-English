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
// Ten seconds was shorter than archive.org itself: a single metadata lookup
// measured 1.3-2.6s on this network, and the doc search that opens every query
// costs another 1.3s, so requests were being aborted just as they answered.
//
// Fifteen seconds was the next attempt and was still too short for the same
// reason at a worse moment: routed through the local proxy, a single
// advancedsearch request measured 3.1-6.4s, and a metadata lookup on a cold
// connection 5-11s. At 15s the timer fired mid-wave, the abort was swallowed by
// the search's own catch, and the query reported zero results — which the cache
// then stored for thirty minutes. The budget now has to cover the slowest single
// request this network produces, not the average one.
const REQUEST_TIMEOUT_MS = 45000;
const SEARCH_LIMIT_MAX = 40;
const ITEMS_PER_SEARCH = 20;
// How many archive.org metadata lookups to run at once. Measured on this
// network, resolving twelve items takes: 29.3s serially, 9.3s three at a time,
// 6.3s six at a time, and 12.4s twelve at a time. Bursts past six make every
// request in the wave slower rather than making the wave shorter — at twelve the
// last request was still running 12.4s after the first had finished — so the
// wave size is the point where the marginal request stops being free.
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
      //
      // An empty ARRAY is the same failure wearing a success hat, and caching
      // one is what made a whole query die. fetchArchiveDocs throws when the
      // request timeout fires; the catch below turns that into [], the guard
      // above only rejected null, so the throw was stored. The observable
      // symptom was "blinding lights" returning zero songs in THREE
      // MILLISECONDS, twenty times in a row, while another query through the
      // same warm connection took 36s and returned twelve — a cache hit is the
      // only thing on this path fast enough to answer in 3ms, so that instant
      // empty answer could only have been a stored one. Not knowing is not
      // knowing; re-ask next time.
      if (value == null) return value;
      if (Array.isArray(value) && value.length === 0) return value;
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
// The separators between a track number and its name. Archive music uses " - "
// far more than the plain space its own comment above assumed: "01 - HOTEL
// CALIFORNIA" was being read as a 2-character name, so the item was dropped.
const TRACK_SEPARATOR_RE = /^\s*\d{1,3}\s*(?:[-._)\]]+\s*|\s+)\S/;

// How many of the typed words a blob contains. Returns 0 for a query of "The
// Weeknd": the word "the" is inside "the weeknd" as a substring, and counting it
// made every single item in the Archive look like an all-word match, which
// flattened the ranking and pushed 2.8-hour dance-party uploads over 3-minute
// singles. "The" and "ft" mean nothing in a search and never count.
const QUERY_STOPWORDS = new Set(['the', 'a', 'an', 'and', 'ft', 'feat', 'featuring']);
const WORD_RE = /[^\p{L}\p{N}']+/u;

function wordList(text) {
  return String(text == null ? '' : text).toLowerCase().split(WORD_RE).filter(Boolean);
}

function searchableWords(words) {
  const list = (words || []).map((w) => String(w).toLowerCase());
  const kept = list.filter((w) => !QUERY_STOPWORDS.has(w));
  return kept.length ? kept : list;
}

function fileWordsMatch(name, words) {
  const needles = searchableWords(words);
  if (!needles.length) return 0;
  const haystack = String(name == null ? '' : name).toLowerCase();
  let matched = 0;
  for (const word of needles) {
    if (new RegExp(`(?<![\\p{L}\\p{N}])${word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\p{L}\\p{N}])`, 'iu').test(haystack)) {
      matched += 1;
    }
  }
  return matched;
}

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

function audioFileNames(files) {
  return (files || [])
    .map((f) => String((f && f.name) || '').split('/').pop())
    .filter((n) => /\.(mp3|m4a|ogg|flac|wav|aac|opus)$/i.test(n));
}

// The cheap, always-safe rejection. A free-text Archive query comes back mostly
// with podcasts and radio programmes, and every one of those used to cost a
// 1.5-2.6s metadata round-trip only to be discarded on the line below it. This
// runs the same NON_MUSIC_RE test before any request is made.
function looksLikeSpokenWord(item) {
  return NON_MUSIC_RE.test(searchHaystack(item));
}

// How music-like an item is, from 3 (a plainly track-numbered music item) down
// to 0 (not music at all). This replaced a boolean, because a boolean threw
// away the difference between a three-minute single and a two-hour live set —
// and since the candidates are walked in order and the page fills at the first
// acceptable hit, a live set sitting at position 3 was beating a real track at
// position 34. Ranking rather than filtering is what lets the cheap single win.
function archiveMusicScore(item, files) {
  const metadata = (item && item.metadata) || {};
  if (NON_MUSIC_RE.test(searchHaystack(item))) return 0;
  const subject = normalizeText(metadata.subject);
  const names = audioFileNames(files);
  if (!names.length) return 0;
  if (MUSIC_SUBJECT_RE.test(subject)) return 3;
  if (names.some((n) => TRACK_NUMBER_RE.test(n))) return 3;
  if (TRACK_SEPARATOR_RE.test(names[0])) return 2;
  if (names.length > 1) return 2;
  // One unnumbered audio file and no music subject: probably a set, a show or a
  // whole-album dump, but it may still be the only thing matching, so it is
  // ranked last rather than discarded.
  return 1;
}

function looksLikeMusic(item, files) {
  return archiveMusicScore(item, files) > 0;
}

function pickAudioFile(files, words) {
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
    // An album item holds a dozen tracks and the first one alphabetically is
    // rarely the one that was searched for: "hotel california eagles" returned
    // "01 Pump It.mp3" out of a twelve-track upload. The file whose own name
    // carries the typed words wins first; format preference is only the
    // tie-break inside a set of equally relevant files.
    const relevance = fileWordsMatch(b.name, words) - fileWordsMatch(a.name, words);
    if (relevance !== 0) return relevance;
    const rank = extensionRank(a.name) - extensionRank(b.name);
    if (rank !== 0) return rank;
    return String(a.name).localeCompare(String(b.name));
  });
  return audio[0];
}

// archive.org reports a file's length as "06:42" (or "1:02:03"), and as a bare
// number of seconds for some formats. Every duration used to be written as 0,
// so the player had no idea how long a full-length Archive track was.
function fileDurationMs(file) {
  const raw = file && (file.length || file.track_length);
  if (raw == null || raw === '') return 0;
  if (typeof raw === 'number' || /^\d+(\.\d+)?$/.test(String(raw).trim())) {
    return Math.max(0, Math.round(Number(raw) * 1000));
  }
  const parts = String(raw).trim().split(':').map((part) => Number(part));
  if (parts.some((part) => !isFinite(part))) return 0;
  return parts.reduce((total, part) => total * 60 + part, 0) * 1000;
}

function mapItemToSong(item, files, words) {
  const identifier = normalizeText(item && item.identifier);
  if (!identifier) return null;
  const metadata = (item && item.metadata) || {};
  const file = pickAudioFile(files, words);
  if (!file) return null;
  const size = Number(file.size || file.length || 0);
  const durationMs = fileDurationMs(file);
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
    // services/img answers image/jpeg for every identifier, so it is always a
    // better cover than the empty string the old conditional produced for any
    // item that did not carry an explicit thumbnail.
    cover: (/^https?:/i.test(String(metadata.thumbnail || '')) && metadata.thumbnail)
      || `${IA_BASE}/services/img/${encodeURIComponent(identifier)}`,
    duration: Math.round(durationMs / 1000),
    durationMs,
    size,
    popularity: 0,
    fee: 0,
    genre: normalizeText(metadata.subject).split(/[;,(]/)[0].trim(),
    explicit: false,
    playable: true,
    url: '',
    playbackMode: 'direct-url',
    recommendationSource: 'internet-archive',
    archiveRank: 0,
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

// The Archive's own search treats a bare "daft punk" as an OR over every field
// of every document, so it answered 2204 items and the top of the page was radio
// mixtapes and news bulletins — the reason the only full-length source never
// reached the results list. Confining the words to the three fields a music
// item actually populates turns the same query into 9-89 documents with the
// track people typed at the top.
//
// Two parser rules were established by measurement and must not be undone:
//   * Mixing "AND" and "OR" at the same nesting level collapses the whole
//     query to zero results, so every clause below is one operator only.
//   * "q.op=AND" is rejected outright with UNSUPPORTED_VALUE, and
//     "creator:\"daft punk\"" is one bigram rather than a conjunction, so it
//     cannot be used to narrow this. Narrowing is done by confining the words
//     to the fields and by the downloads sort, never by a second operator.
function archiveQueryTerms(text) {
  return normalizeText(text)
    .toLowerCase()
    .split(/[^\p{L}\p{N}']+/u)
    .filter(Boolean);
}

function archiveLucenePhrase(field, words) {
  return field + ':(' + words.join(' ') + ')';
}

// The document query. One operator, three fielded phrases, so it parses.
function archiveDocQuery(queryWords) {
  return 'mediatype:(audio) AND (' + [
    archiveLucenePhrase('title', queryWords),
    archiveLucenePhrase('creator', queryWords),
    archiveLucenePhrase('subject', queryWords),
  ].join(' OR ') + ')';
}

// archive.org does rank its results, and its ordering is popularity. A bare
// "creator:" conjunction is not usable — every measurement of it returned zero,
// because creators are indexed as a whole "Name, Name" string rather than
// per-word — so popularity is read from the downloads sort on the document
// query instead and the fetched candidates are ordered by it before any
// metadata is paid for.
const ARCHIVE_DOWNLOADS_SORT = 'sort[]=downloads desc';

function archiveDocQueryParams(page, rows) {
  // URLSearchParams percent-encodes the brackets in "fl[]" to "fl%5B%5D",
  // which the Archive accepts but silently drops from the response — every doc
  // then comes back with an undefined identifier. Write the field list
  // literally instead.
  return [
    'fl[]=identifier',
    'fl[]=title',
    'fl[]=creator',
    'fl[]=subject',
    'fl[]=downloads',
    ARCHIVE_DOWNLOADS_SORT,
    'rows=' + (rows || ITEMS_PER_SEARCH),
    'page=' + (page || 1),
    'output=json',
  ].join('&');
}

// How much of the document list to pull. The Archive caps rows at 10000, so a
// wider first page costs the same single request while giving the metadata
// waves more to choose from — "blinding lights" yielded only three usable items
// out of twenty, because most of the first page was long sets and stubs.
function archiveDocRows() {
  return 40;
}

async function fetchArchiveDocs(queryString, page, rows) {
  const params = 'q=' + encodeURIComponent(queryString) + '&' + archiveDocQueryParams(page, rows);
  const { status, body } = await requestJson(`/advancedsearch.php?${params}`);
  if (status >= 400) throw new Error(`Internet Archive search failed (${status})`);
  const docs = body && body.response && Array.isArray(body.response.docs) ? body.response.docs : [];
  return docs
    .filter((doc) => doc && doc.identifier)
    .map((doc) => ({
      identifier: doc.identifier,
      downloads: Number(doc.downloads) || 0,
      metadata: { title: doc.title, creator: doc.creator, subject: doc.subject },
    }));
}

// Relevance has to read the creator as well: the artist half of a typed query
// ("daft punk get lucky") lives in creator, not title, and searchHaystack omits
// it. Without this the real track was tied with an item that merely shared the
// album's subject line.
function archiveRelevanceHaystack(item) {
  const metadata = (item && item.metadata) || {};
  return [
    normalizeText(item && item.identifier),
    normalizeText(metadata.title),
    normalizeText(metadata.creator),
    normalizeText(metadata.subject),
  ].join(' ');
}

// Relevance is field-weighted, not a flat count over one concatenated string.
// The query's artist half ("weeknd", "eagles") lives in creator, the track half
// in title, and subject is a bag of tags shared by everything uploaded next to
// the song — a Chilean chart show listing "THE WEEKND,BLACKPINK,CAMILO" scored
// exactly like the track itself did and beat it on download count.
//
// A whole-word test is required as well as the weighting: "weeknd" occurs inside
// "blinding" nowhere, but "night" occurs inside "tonight", and "eag" inside
// "eagles" only by luck. The word "the" is the worse case — it is a substring of
// half the English language, so matching it made nearly every item report a
// full match and the bonus that is supposed to mark the real track never did.
//
// Finally the title is penalised for words it does not use. An item titled
// "DNA Lounge: Blinding Lights: The Weeknd Dance Party (2025-04-05)" contains
// every word of "blinding lights weeknd" and is a four-hour club night; a short
// title containing them is far more likely to be the song.
function archiveSongRelevance(item, words) {
  const needles = searchableWords(words);
  if (!needles.length) return 0;
  const metadata = (item && item.metadata) || {};
  const title = normalizeText(metadata.title).toLowerCase();
  const creator = normalizeText(metadata.creator).toLowerCase();
  const identifier = normalizeText(item && item.identifier).toLowerCase();
  const subject = normalizeText(metadata.subject).toLowerCase();
  const wordIn = (haystack) => {
    let matched = 0;
    for (const word of needles) {
      if (new RegExp(`(?<![\\p{L}\\p{N}])${word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\p{L}\\p{N}])`, 'iu').test(haystack)) {
        matched += 1;
      }
    }
    return matched;
  };
  const titleMatched = wordIn(title);
  const creatorMatched = wordIn(creator);
  const identifierMatched = wordIn(identifier);
  const subjectMatched = wordIn(subject);
  let score = titleMatched * 120 + creatorMatched * 90 + identifierMatched * 50 + subjectMatched * 10;
  const covered = titleMatched + creatorMatched;
  if (covered >= needles.length) score += 100;
  else if (covered + identifierMatched >= needles.length) score += 60;
  const titleWords = wordList(title).length;
  score -= Math.max(0, titleWords - needles.length - 2) * 15;
  return Math.max(0, score);
}

// A live set or a radio show stored under a date is music, so it clears the
// spoken-word filter, but nobody searches for it. Those items were costing a
// full metadata round-trip each and then filling the page ahead of the track
// that was typed — "blinding lights" returned an item named "2024-05-25".
const DATED_BROADCAST_RE = /^\s*(?:\d{4}[-._]\d{1,2}[-._]\d{1,2}|\d{8}|[a-z]{3}\s+\d{2},?\s+\d{4}|\d{1,2}[-._]\d{1,2}[-._]\d{2,4})\s*$/i;

function looksLikeDatedBroadcast(item) {
  const metadata = (item && item.metadata) || {};
  const title = normalizeText(metadata.title);
  const identifier = normalizeText(item && item.identifier);
  return DATED_BROADCAST_RE.test(title) || DATED_BROADCAST_RE.test(identifier);
}

// Anything longer than this is a whole set or a broadcast, not a song. The
// Archive happily returns 4.8-hour items for a single-track query, and the
// player had no way to tell until it was already queued.
const MAX_TRACK_MS = 20 * 60 * 1000;
// Ten minutes, as the ceiling the "shorter first" tie-break counts down from.
// It is deliberately far below the million that separates that tie-break from
// the one above it, so a short file can only ever win a tie.
const LENGTH_RANK_CEILING_MS = 10 * 60 * 1000;

async function handleInternetArchiveSearch(keywords, limit, offset) {
  const query = normalizeText(keywords);
  limit = Math.max(1, Math.min(SEARCH_LIMIT_MAX, Number(limit) || 25));
  offset = Math.max(0, Number(offset) || 0);
  if (!query) {
    return { provider: 'archive', configured: true, songs: [], total: 0, offset, nextOffset: offset, hasMore: false, message: 'Empty query.' };
  }
  const words = archiveQueryTerms(query);
  const items = await cacheWrap(`search|${query}`, CACHE_TTL_MS, async () => {
    // One page of the fielded query. The old code walked three pages serially
    // (measured: 3.5s before the first result could even be considered) and the
    // third page was always junk, because the words were OR-ed rather than
    // confined to the fields a music item fills in.
    let docs = [];
    try {
      docs = await fetchArchiveDocs(archiveDocQuery(words), 1, archiveDocRows());
    } catch (_) {
      return [];
    }
    // The Archive's own ordering is by download count, which is the only real
    // popularity signal here; the query words rank whatever the sort left
    // outside the page.
    return docs
      .map((item) => ({ item, score: archiveSongRelevance(item, words) }))
      .sort((a, b) => (b.score - a.score) || (b.item.downloads - a.item.downloads))
      .map((entry) => entry.item)
      .slice(0, ITEMS_PER_SEARCH);
  });

  // Drop the podcasts and radio programmes straight off the search document
  // before any metadata lookup is paid for, then resolve what is left in waves.
  // Each lookup costs 1.3-2.6s and used to run one at a time, so twenty items
  // meant thirty seconds before the first result could render — the whole of the
  // "search is slow" complaint.
  const candidates = items.filter((item) => !looksLikeSpokenWord(item) && !looksLikeDatedBroadcast(item));
  const wanted = offset + limit;
  // Filler words never count as query words for matching (see searchableWords);
  // the ceiling for "a title with nothing extra in it" is this many.
  const needles = searchableWords(words);
  // Every candidate's metadata is fetched, but the page is not filled from the
  // first wave that happens to produce playable items. It used to be, and since
  // candidates arrive in relevance order that made the ordering of the results
  // a side effect of where a wave boundary happened to fall: "blinding lights
  // weeknd" returned three results because the third wave filled the page, not
  // because three items were the best three. Ranking the whole wave lets a
  // track-numbered single in wave 2 outrank a dance-party upload in wave 1.
  const found = [];
  let examined = 0;
  for (let i = 0; i < candidates.length; i += META_CONCURRENCY) {
    const wave = candidates.slice(i, i + META_CONCURRENCY);
    examined += wave.length;
    const details = await Promise.all(wave.map((item) =>
      cachedItemFiles(item.identifier).catch(() => null)
    ));
    for (let j = 0; j < wave.length; j += 1) {
      const item = wave[j];
      const files = details[j] && details[j].files;
      if (!files) continue;
      const musicScore = archiveMusicScore(item, files);
      if (!musicScore) continue;
      const song = mapItemToSong(item, files, words);
      if (!song) continue;
      // A whole concert or a four-hour broadcast is not the track that was
      // typed, and it was reaching the results ahead of it.
      if (song.durationMs > MAX_TRACK_MS) continue;
      // Ranked as three separate digits rather than one sum, because the
      // components have different units: adding a duration in milliseconds to a
      // word count let an eight-second advantage outrank a better-matching
      // file, which put "814361344.mp3" (a Trump cover, a file name that
      // carries none of the words) above "01 Blinding Lights - Instrumental".
      // Each term is bounded well under the next one's step, so a term can only
      // break a tie, never override the one above it.
      //   1. how music-like the item is;
      //   2. how well the file it actually offers matches the words, less the
      //      words it did not need: a title carrying every word plus a heap of
      //      others is a cover, a nightcore or a whole-album dump, and those
      //      were beating the plain studio track on the heap;
      //   3. shorter first, so a studio cut beats a nine-minute live version.
      const fileScore = fileWordsMatch(song.archiveFile, words);
      const fileName = baseName(song.archiveFile);
      const fileExtra = Math.max(0, wordList(fileName).length - Math.max(needles.length, 2));
      const shortestFirst = Math.max(0, LENGTH_RANK_CEILING_MS - song.durationMs);
      found.push({ song, rank: musicScore * 1e9 + (fileScore * 1e6 - fileExtra * 1e4) + shortestFirst });
    }
    if (found.length >= wanted) break;
  }
  const songs = found
    .sort((a, b) => b.rank - a.rank)
    .map((entry, index) => Object.assign(entry.song, { archiveRank: index }))
    .sort((a, b) => a.archiveRank - b.archiveRank);
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
    const song = mapItemToSong({ identifier, metadata: details.metadata }, [file]);
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
      durationMs: song ? song.durationMs : fileDurationMs(file),
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
  __test: { pickAudioFile, looksLikeMusic, looksLikeSpokenWord, looksLikeDatedBroadcast, archiveMusicScore, fileWordsMatch, searchableWords, mapItemToSong, baseName, artistFromItem, extensionRank, archiveQueryTerms, archiveDocQuery, archiveSongRelevance, fileDurationMs, fetchArchiveDocs },
};
