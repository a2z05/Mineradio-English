'use strict';
// Global search against the local database.
//
// The panel used to fan out to the online providers and stop there: the files
// already on this device were reachable only through a separate surface that
// dumped the whole library unfiltered, so a track you owned never turned up in
// a search for its own title. This file covers what the merge now does about
// that, and the cost of doing it — a scan of fifty thousand tracks has to fit
// inside the panel's 180 ms input debounce or every keystroke stalls.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { functionBundle, namedFunctionSource } = require('./helpers/extract-function');

const appRoot = path.resolve(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(appRoot, p), 'utf8');

const searchSource = read('public/js/modules/05-playback/07-search.js');
const fallbackSource = read('public/js/modules/05-playback/11-provider-fallback.js');
const storeSource = read('public/js/modules/13-library/00-local-library-store.js');
const loaderSource = read('public/js/index-loader.js');
const css = read('public/css/index.css');
const bothSources = [searchSource, fallbackSource];

// The search half: everything the merge and the source tag need, plus the
// fan-out itself. The store half is separate because it is a different module
// and the two are only joined in the running app by script concatenation.
const SEARCH_NAMES = [
  'fetchMusicSearchResults', 'mergeSongSearchResults', 'scoreSongSearchResult',
  'songProviderKey', 'isLocalLibrarySong', 'searchCanonicalSongKey', 'simpleSearchNorm',
  'searchQueryTokens', 'searchTokenCoverage', 'searchVersionSignature',
  'searchMentionsKnownArtist', 'searchLooksLikeDerivative', 'searchPopularityScore',
  'songSourceTagHtml', 'sourceSwitchArtistParts', 'artistNameParts', 'normalizeMatchText',
  'searchProviderPagesHaveMore', 'controlSourceProviderTitle', 'searchSongIsFullLength',
];
const STORE_NAMES = [
  'localLibrarySearchBlob', 'localLibrarySearchBlobs', 'localLibraryScoreMatch',
  'localLibraryQueryTerms', 'localLibraryScoreCeiling', 'localLibraryMatchScore',
  'localLibraryBlobCouldMatch', 'localLibraryHitBetter', 'localLibraryCompareHits',
  'localLibrarySearchSongs', 'librarySearchTracks', 'localLibrarySearchCandidates',
  'localLibrarySortedCopy',
];

const SEARCH_PRELUDE = `
var SONG_SOURCE_TAG_LABELS = { local: 'LC', ytmusic: 'YT', deezer: 'DZ', soundcloud: 'SC',
  spotify: 'SP', itunes: 'AP', archive: 'IA', netease: 'NE', qq: 'QQ', kugou: 'KG', qishui: 'QS' };
var MUSIC_SEARCH_MAX_RESULTS = 180;
var MUSIC_SEARCH_LOCAL_CANDIDATE_LIMIT = 40;
var SEARCH_PROVIDER_TIMEOUT_BY_PROVIDER = { archive: 60000 };
var MUSIC_SEARCH_PROVIDER_TIMEOUT_MS = 12000;
var searchProviderNotice = '';
var activeSearchProvidersForMode = function () { return PROVIDERS; };
var searchProviderLoginNotice = function () { return 'SIGN_IN_REQUIRED'; };
var searchProviderUrl = function () { return '/search'; };
var apiJson = function () { return PROMISE; };
`;

function makeSong(id, over) {
  return Object.assign({
    provider: 'local', source: 'local', type: 'local',
    localFileId: id, localKey: id, localUrl: 'mineradio-local://' + id,
    localPath: 'Singles/Track ' + id + '.flac',
    name: 'Track ' + id, artist: 'Artist ' + id, album: 'Album ' + id,
    albumArtist: 'Artist ' + id, genre: 'Rock', year: 2021, composer: '',
    duration: 180, addedAt: 0,
  }, over || {});
}

// Values that came out of a vm keep that realm's Array.prototype, and
// deepStrictEqual compares prototypes. Round-tripping is how every other test
// in this suite crosses the boundary.
const plain = (value) => JSON.parse(JSON.stringify(value));

function storeSandbox(tracks) {
  const sandbox = { console, localLibraryStore: { tracks: tracks || [] } };
  // Only reached when the store has nothing, which is the startup window.
  sandbox.localLibraryTracksNow = function () { return sandbox.__persistent || []; };
  sandbox.__persistent = [];
  vm.runInNewContext(functionBundle(storeSource, STORE_NAMES, ''), sandbox);
  return sandbox;
}

function searchSandbox(tracks) {
  const sandbox = {
    console, JSON, Promise,
    PROVIDERS: [], PROMISE: Promise.resolve({ value: { songs: [], hasMore: false } }),
    localLibraryStore: { tracks: tracks || [] },
    __persistent: [],
  };
  sandbox.localLibraryTracksNow = function () { return sandbox.__persistent; };
  // The store half first: the search half's expose reaches for
  // localLibrarySearchCandidates, which the concatenated script gets by
  // hoisting and a vm context only gets by running it first.
  vm.runInNewContext(functionBundle(storeSource, STORE_NAMES, ''), sandbox);
  vm.runInNewContext(functionBundle(bothSources, SEARCH_NAMES, SEARCH_PRELUDE, `
    this.fetchMusicSearchResults = fetchMusicSearchResults;
    this.mergeSongSearchResults = mergeSongSearchResults;
    this.songProviderKey = songProviderKey;
    this.songSourceTagHtml = songSourceTagHtml;
    this.isLocalLibrarySong = isLocalLibrarySong;
    this.searchSongIsFullLength = searchSongIsFullLength;
    this.localLibrarySearchCandidates = localLibrarySearchCandidates;
    this.notice = function () { return searchProviderNotice; };
    this.useProviders = function (list) { PROVIDERS = list; };
    this.useResponse = function (promise) { PROMISE = promise; };
  `), sandbox);
  return sandbox;
}

// ---------------------------------------------------------------- identity

test('a track from this device is tagged as one, not as YouTube Music', () => {
  const sandbox = searchSandbox([makeSong('a')]);
  // songProviderKey had no local branch and fell through to its default, so
  // every row in the results panel wore a "YT" badge: the one source that
  // cannot be a stream was the one claiming to be.
  assert.equal(sandbox.songProviderKey(makeSong('a')), 'local');
  assert.equal(sandbox.songProviderKey({ provider: 'local', name: 'x' }), 'local');
  // The generic field-only shapes the main process sometimes hands over.
  assert.equal(sandbox.songProviderKey({ localKey: 'a', name: 'x' }), 'local');
  assert.equal(sandbox.songProviderKey({ provider: 'archive', id: 'y', name: 'x' }), 'archive',
    'the stream keys must be untouched');

  assert.match(sandbox.songSourceTagHtml(makeSong('a')), /tag-source local">LC</);
  assert.match(sandbox.songSourceTagHtml({ provider: 'archive', id: 'y', name: 'x' }),
    /tag-source archive">IA</, 'and a stream still reads as its own source');
  // The badge is styled: an unstyled span would be the same colour as nothing.
  assert.match(css, /\.tag-source\.local\s*\{/);
  assert.match(css, /\.search-result\.local-source:hover\s*\{/);
});

test('a local row counts as a whole track whatever its length', () => {
  // The 45-second floor exists to catch a 30-second preview dressed up as a
  // track. A 30-second file on this device is not dressed up as anything, and
  // treating it as a clip left libraries of short tracks behind the preview
  // grace window waiting on a network that never answers.
  const sandbox = searchSandbox();
  assert.equal(sandbox.searchSongIsFullLength(makeSong('short', { duration: 12 })), true);
  assert.equal(sandbox.searchSongIsFullLength({ provider: 'itunes', duration: 12, playbackMode: 'preview' }), false);
  assert.equal(sandbox.searchSongIsFullLength({ provider: 'archive', duration: 12 }), false,
    'the floor still applies to everything else');
});

// ---------------------------------------------------------------- the merge

test('the copy on this device wins a canonical collision against a better-scored stream', () => {
  const sandbox = searchSandbox();
  const local = makeSong('hotel', {
    name: 'Hotel California', artist: 'Eagles', album: 'Hotel California', duration: 300,
  });
  const stream = {
    provider: 'archive', id: 'eagles::hotel.mp3',
    name: 'Hotel California', artist: 'Eagles', album: 'Hotel California',
    duration: 300, playbackMode: 'direct-url', popularity: 90,
  };
  // The same recording from two places canonicalises to one row, and the tie
  // used to be settled on relevance alone — which the stream wins, because it
  // arrives with popularity and a full-length flag and the local row with
  // neither. On a network where the streaming hosts are blocked that leaves a
  // file the user already owns losing to a URL that will never resolve.
  const merged = sandbox.mergeSongSearchResults(
    null, null, null, null, null, [stream], null, null, null, null,
    180, 'hotel california', [local]);
  assert.deepEqual(plain(merged.map((s) => s.provider)), ['local'],
    'the row that plays must be the row that was kept');

  // Without a local candidate the stream is still what survives — the rule
  // chooses between the two, it does not prefer local over nothing.
  const streamOnly = sandbox.mergeSongSearchResults(
    null, null, null, null, null, [stream], null, null, null, null,
    180, 'hotel california', null);
  assert.deepEqual(plain(streamOnly.map((s) => s.provider)), ['archive']);
});

test('local rows do not swallow different songs, and reach the list at all', () => {
  const sandbox = searchSandbox();
  const local = makeSong('aurora', { name: 'Aurora Borealis', artist: 'Polar' });
  const other = { provider: 'archive', id: 'z', name: 'Something Else Entirely', artist: 'Nobody' };
  const merged = sandbox.mergeSongSearchResults(
    null, null, null, null, null, [other], null, null, null, null,
    180, 'aurora', [local]);
  assert.equal(merged.length, 2, 'distinct recordings keep distinct rows');
  // Local is pushed first, so on an equal relevance score it is the one kept.
  assert.equal(merged[0].provider, 'local');
});

// ---------------------------------------------------------------- the scan

test('the blob filter never drops a track the eight-field scan would keep', () => {
  // The blob is one string per track holding every field, so a term that cannot
  // be matched in it cannot be matched in any field either — that is the claim
  // this checks, and it is what lets the filter exist at all.
  const tracks = [];
  for (let i = 0; i < 600; i += 1) {
    tracks.push(makeSong('t' + i, {
      name: i % 3 === 0 ? 'Greatest Hits ' + i : 'Plain ' + i,
      artist: i % 5 === 0 ? 'Boney M' : 'Artist ' + (i % 40),
      album: i % 7 === 0 ? 'Now That Is What I Call Music' : 'Album ' + (i % 25),
      genre: i % 11 === 0 ? 'Electronic' : 'Rock',
      localPath: (i % 2 ? 'A/B/' : 'C/') + 'Track ' + i + '.flac',
      year: 1990 + (i % 30),
    }));
  }

  const sandbox = storeSandbox(tracks);
  // Reference: score every field of every track with no filter in the way.
  const reference = (query) => {
    const terms = String(query).trim().toLowerCase().split(/\s+/).filter(Boolean);
    const fieldsOf = (s) => [s.name, s.artist, s.album, s.albumArtist, s.genre,
      s.composer, s.localPath, String(s.year || '')];
    return tracks.filter((song) => terms.every((term) =>
      Math.max(...fieldsOf(song).map((f) => sandbox.localLibraryScoreMatch(f, term))) > 0));
  };

  for (const query of ['boney', 'greatest', 'now that', 'electronic', 'flac',
    'artist 12 album 3', 'zzz', 'g t h', '1995']) {
    const got = plain(sandbox.librarySearchTracks(query).map((s) => s.localKey)).sort();
    const want = reference(query).map((s) => s.localKey).sort();
    assert.deepEqual(got, want, `the filter changed the answer for "${query}"`);
  }
});

test('the blob cache follows the track list, not the favourites', () => {
  // Rebuilding on every like would put a 163 ms hitch on a heart tap at 50k, so
  // the cache is keyed on the array it was built from: replacing the list is
  // what invalidates it, and nothing else has to remember to.
  const tracks = [makeSong('a'), makeSong('b')];
  const sandbox = storeSandbox(tracks);
  const first = sandbox.localLibrarySearchBlobs(tracks);
  assert.equal(sandbox.localLibrarySearchBlobs(tracks), first, 'same list, same cache');

  // Everything the store does on a favourite, a rating or a play count.
  sandbox.localLibraryStore.index = null;
  assert.equal(sandbox.localLibrarySearchBlobs(tracks), first, 'a grouping rebuild does not touch it');

  const next = [makeSong('c'), makeSong('d'), makeSong('e')];
  const second = sandbox.localLibrarySearchBlobs(next);
  assert.notEqual(second, first, 'a replaced list is a new cache');
  assert.equal(second.length, 3);
  assert.match(second[0], /track c/, 'and it describes the new list');
  assert.equal(second[0], second[0].toLowerCase(), 'the blob is lowercase, like the query');
});

// ---------------------------------------------------------------- candidates

test('candidates need every term, respect the cap, and answer nothing for an empty query', () => {
  const tracks = [
    makeSong('a', { name: 'Northern Lights', artist: 'Aurora' }),
    makeSong('b', { name: 'Southern Lights', artist: 'Aurora' }),
    makeSong('c', { name: 'Totally Different', artist: 'Someone' }),
    makeSong('d', { name: 'Northern', artist: 'Borealis' }),
  ];
  const sandbox = storeSandbox(tracks);
  const names = (q, limit) => plain(sandbox.localLibrarySearchCandidates(q, limit).map((s) => s.name));

  // Every term has to land — the same AND rule the library page uses, so the
  // two surfaces never disagree about whether a track matches. Both rows here
  // open with the term, so they tie on score and fall back to the title.
  assert.deepEqual(names('northern', 40), ['Northern', 'Northern Lights']);
  assert.deepEqual(names('northern aurora', 40), ['Northern Lights'],
    'the artist term has to match too, and it only does on one row');
  assert.deepEqual(names('lights borealis', 40), [], 'no single track holds both');
  assert.deepEqual(names('', 40), [], 'an empty query is not the whole library');
  assert.deepEqual(names('   ', 40), []);

  const many = [];
  for (let i = 0; i < 90; i += 1) many.push(makeSong('m' + i, { name: 'Common Name ' + i }));
  const sandbox2 = storeSandbox(many);
  assert.equal(sandbox2.localLibrarySearchCandidates('common', 40).length, 40,
    'the cap is what stops a broad query flooding the panel');
  assert.equal(sandbox2.localLibrarySearchCandidates('common', 0).length, 90,
    'and a caller that does not ask for a cap is not given one');
});

test('a search typed before the Library page has hydrated still finds the restore copy', () => {
  // hydrateLocalLibraryStore runs after the restore at startup, so there is a
  // moment where the store is empty and the panel's own copy is not.
  const sandbox = searchSandbox([]);
  sandbox.__persistent = [makeSong('early', { name: 'First Light' })];
  assert.deepEqual(
    plain(sandbox.localLibrarySearchCandidates('first light', 40).map((s) => s.name)),
    ['First Light']);
});

test('a 50k library scores one field per track when nothing matches, and no more than ten when everything does', () => {
  const tracks = [];
  for (let i = 0; i < 50000; i += 1) {
    tracks.push(makeSong('t' + i, {
      name: 'A reasonably long track title number ' + i,
      artist: 'Artist ' + (i % 900), album: 'Album ' + (i % 60),
      localPath: 'Album ' + (i % 60) + '/Track ' + i + '.flac',
    }));
  }
  const sandbox = storeSandbox(tracks);
  sandbox.localLibrarySearchBlobs(tracks);

  // What a query costs, counted rather than timed. Milliseconds move with the
  // machine and this suite shares one — the same query has been seen here at
  // 447 ms and at 679 ms. How many tracks reach the eight-field scorer, and how
  // many times a single field is scored, do not move at all. Those two numbers
  // are what the blob prefilter and the scoring ceiling exist to hold down, so
  // they are what this asserts; the wall clock below is only a sanity ceiling.
  let visited = 0;
  let scanned = 0;
  let fieldScores = 0;
  const realBlobCould = sandbox.localLibraryBlobCouldMatch;
  sandbox.localLibraryBlobCouldMatch = function (blob, terms) {
    visited += 1;
    return realBlobCould(blob, terms);
  };
  const realMatchScore = sandbox.localLibraryMatchScore;
  sandbox.localLibraryMatchScore = function (song, terms) {
    scanned += 1;
    return realMatchScore(song, terms);
  };
  const realScore = sandbox.localLibraryScoreMatch;
  sandbox.localLibraryScoreMatch = function (text, needle) {
    fieldScores += 1;
    return realScore(text, needle);
  };

  const run = (query) => {
    visited = 0; scanned = 0; fieldScores = 0;
    const at = Date.now();
    const hits = plain(sandbox.localLibrarySearchCandidates(query, 40));
    const elapsed = Date.now() - at;
    assert.ok(hits.length <= 40, `"${query}" returned ${hits.length} rows past the cap`);
    // One pass over the list, never two, whatever the query does.
    assert.equal(visited, tracks.length, `"${query}" visited ${visited} of ${tracks.length} tracks`);
    // Far below the 3000 ms the scale suite already allows for a 50k search —
    // this is a ceiling for catastrophes, not the measurement that matters.
    assert.ok(elapsed < 2000, `"${query}" took ${elapsed}ms`);
    return hits;
  };

  // A query no field can match dies on the blob test: one call per track, and
  // not one of them reaches the scorer. That is what most keystrokes look like
  // while you are still narrowing down — roughly 50–150 ms at 50k, against the
  // search box's 180 ms input debounce.
  for (const query of ['zzzz', 'the', 'northern aurora']) {
    run(query);
    assert.equal(scanned, 0, `"${query}" let a dead query reach the eight-field scorer`);
    assert.equal(fieldScores, tracks.length, `"${query}" scored ${fieldScores} fields for ${tracks.length} tracks`);
  }

  // When a query does survive, the ceiling stops the walk as soon as a field
  // has the maximum score the scorer can return. "album" is a prefix of the
  // album field on every track and lands on the third field; without the
  // ceiling these would be nine calls each — 450,000 instead of 200,000.
  run('album');
  assert.equal(scanned, tracks.length, '"album" is in every album field, so every track is scored');
  assert.ok(fieldScores <= tracks.length * 5, `"album" cost ${fieldScores / tracks.length} fields per track`);

  // And the worst case is still one pass at ten calls a track: a term that sits
  // in the middle of every title never hits the prefix ceiling, so all eight
  // fields are asked. Bounded work, no index, no second pass.
  for (const query of ['ar', 'reasonably', 'artist 123 album 7']) {
    run(query);
    assert.ok(fieldScores <= tracks.length * 10,
      `"${query}" cost ${(fieldScores / tracks.length).toFixed(2)} fields per track`);
  }

  // Neither budget is met by returning nothing.
  assert.ok(sandbox.localLibrarySearchCandidates('album 7', 40).length > 0);
  assert.ok(sandbox.localLibrarySearchCandidates('artist 123 album 7', 40).length > 0);
});

test('the panel and the library page draw the same rows in the same order', () => {
  // Two matchers on one query is two answers, and the first version of this had
  // exactly that: candidates scored the memoised blob, whose subsequence walk
  // can step over a newline into the next field, so "northern aurora" matched a
  // track whose fields held "Northern" and "Borealis" — a row the library page
  // rejected. They now share one scan, and this is the regression guard.
  const tracks = [
    makeSong('a', { name: 'Northern Lights', artist: 'Aurora' }),
    makeSong('b', { name: 'Southern Lights', artist: 'Aurora' }),
    makeSong('c', { name: 'Northern', artist: 'Borealis' }),
    makeSong('d', { name: 'Greatest Hits', artist: 'Boney M' }),
  ];
  for (let i = 0; i < 200; i += 1) {
    tracks.push(makeSong('f' + i, { name: 'Filler ' + i, artist: 'Someone' }));
  }
  const sandbox = storeSandbox(tracks);

  for (const query of ['northern', 'northern aurora', 'lights', 'boney m',
    'filler 1', 'zzz', 'northern lights aurora', 'a']) {
    const panel = plain(sandbox.localLibrarySearchCandidates(query, 40).map((s) => s.localKey));
    const page = plain(sandbox.librarySearchTracks(query).slice(0, 40).map((s) => s.localKey));
    assert.deepEqual(panel, page, `the two surfaces disagree about "${query}"`);
  }

  // The cross-field case specifically: no track holds both words.
  assert.deepEqual(plain(sandbox.localLibrarySearchCandidates('northern aurora', 40).map((s) => s.name)),
    ['Northern Lights']);
  assert.deepEqual(plain(sandbox.librarySearchTracks('northern aurora').map((s) => s.name)),
    ['Northern Lights']);
});

// ---------------------------------------------------------------- the fan-out

test('the fan-out searches the database without asking for it, and paints it first', async () => {
  const sandbox = searchSandbox([makeSong('a', { name: 'Aurora Borealis', artist: 'Polar' })]);
  sandbox.useProviders(['archive']);
  // Nothing is ever fetched to search: the list is already in the renderer,
  // which is the whole point of the 50k-in-memory index.
  assert.doesNotMatch(namedFunctionSource(searchSource, 'fetchMusicSearchResults'),
    /listLocalMusicLibrary/);

  const paints = [];
  const result = await sandbox.fetchMusicSearchResults('aurora', 'song', null, (partial) => {
    paints.push(plain(partial.songs.map((s) => s.provider)));
  });
  // Painted before any provider answered: local is the only source that cannot
  // fail, so it is the answer the user gets while the Archive is still
  // resolving its first metadata item.
  assert.ok(paints.length >= 1, 'local results must reach the panel before the fan-out settles');
  assert.deepEqual(plain(paints[0]), ['local']);
  assert.deepEqual(plain(result.songs.map((s) => s.provider)), ['local']);
  assert.equal(sandbox.notice(), '', 'a result means nothing to apologise for');
});

test('with no sign-inable source the database still answers, and says why only if it cannot', async () => {
  const sandbox = searchSandbox([makeSong('a', { name: 'Aurora Borealis' })]);
  sandbox.useProviders([]);

  const withLocal = await sandbox.fetchMusicSearchResults('aurora', 'song', null, null);
  assert.deepEqual(plain(withLocal.songs.map((s) => s.name)), ['Aurora Borealis']);
  assert.equal(sandbox.notice(), '',
    'a "sign in" banner over a list of the user\'s own files is a non sequitur');

  const empty = await sandbox.fetchMusicSearchResults('zzzznotathing', 'song', null, null);
  assert.deepEqual(plain(empty.songs), []);
  assert.equal(sandbox.notice(), 'SIGN_IN_REQUIRED',
    'with nothing to show, the notice is the only explanation there is');
});

test('a local candidate survives a provider that answers with nothing', async () => {
  const sandbox = searchSandbox([makeSong('a', { name: 'Aurora Borealis' })]);
  sandbox.useProviders(['archive']);
  sandbox.useResponse(Promise.resolve({ value: { songs: [], hasMore: false } }));
  const result = await sandbox.fetchMusicSearchResults('aurora', 'song', null, null);
  assert.deepEqual(plain(result.songs.map((s) => s.name)), ['Aurora Borealis']);
});

// ---------------------------------------------------------------- wiring

test('the local candidate limit and the merged argument are the ones the code uses', () => {
  assert.match(searchSource, /MUSIC_SEARCH_LOCAL_CANDIDATE_LIMIT = 40/);
  const fetchSource = namedFunctionSource(searchSource, 'fetchMusicSearchResults');
  assert.match(fetchSource,
    /localLibrarySearchCandidates\(q, MUSIC_SEARCH_LOCAL_CANDIDATE_LIMIT\)/,
    'the cap lives in one place and the caller uses it');
  // Computed ahead of the fan-out, not inside a provider's answer.
  const fanOutAt = fetchSource.indexOf('await Promise.all');
  const localAt = fetchSource.indexOf('localLibrarySearchCandidates');
  assert.ok(localAt >= 0 && fanOutAt > localAt,
    'local has to be in hand before the network is asked anything');
  assert.match(fetchSource, /onProgress\(collect\(\)\)/);

  const mergeSource = namedFunctionSource(searchSource, 'mergeSongSearchResults');
  // Local is pushed ahead of every provider, which is what makes an equal
  // relevance score resolve to the file on this device.
  assert.ok(mergeSource.indexOf('(localSongs || []).forEach') <
    mergeSource.indexOf('(archiveSongs || []).forEach'),
    'local must be merged before the keyless sources');

  // The library page and the global panel must not drift into two matchers.
  assert.match(storeSource, /function localLibrarySearchCandidates\(query, limit\)/);
  assert.match(storeSource, /localLibraryScoreMatch\(blob, terms\[t\]\)/);
  assert.match(loaderSource, /moduleCacheBust = 'v13-en'/,
    'changed modules need a new cache key or the running app keeps the old ones');
});
