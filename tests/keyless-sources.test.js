const test = require('node:test');
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const appRoot = path.resolve(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(appRoot, p), 'utf8');

const serverText = read('server.js');
const searchText = read('public/js/modules/05-playback/07-search.js');
const startText = read('public/js/modules/05-playback/13-playback-start-audio.js');
const fallbackText = read('public/js/modules/05-playback/11-provider-fallback.js');
const qualityText = read('public/js/modules/05-playback/00-api-quality-output.js');
const proxyText = read('app-proxy.js');
const proxyPanelText = read('public/js/modules/12-remote/01-app-proxy-panel.js');

// Load the provider module and call its pure helpers against fixed inputs.
const itunes = require(path.join(appRoot, 'itunes-api.js'));
const archive = require(path.join(appRoot, 'internet-archive-api.js'));

function loadInternals(mod, source) {
  // Re-evaluate the module in a sandbox and hand back its internals so the
  // pure helpers can be tested without any network call.
  const sandbox = { module: { exports: {} }, exports: {}, require, console, fetch, URL, URLSearchParams, AbortController, setTimeout, clearTimeout, Date, Math, JSON, Buffer, process };
  sandbox.exports = sandbox.module.exports;
  const vm = require('vm');
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox);
  return sandbox.module.exports;
}

test('the keyless providers are exposed over HTTP', () => {
  // Each provider needs status/search/song-url/lyric or the player cannot use it.
  for (const route of [
    '/api/itunes/status', '/api/itunes/search', '/api/itunes/song/url', '/api/itunes/lyric',
    '/api/archive/status', '/api/archive/search', '/api/archive/song/url', '/api/archive/lyric',
  ]) {
    assert.ok(serverText.includes(`pn === '${route}'`), 'missing server route ' + route);
  }
  // The server must load both modules and give them a proxy applier, so they
  // go direct by default and can still be proxied if the user asks.
  assert.match(serverText, /require\('\.\/itunes-api'\)/);
  assert.match(serverText, /require\('\.\/internet-archive-api'\)/);
  assert.match(serverText, /setItunesProxyApplier\(/);
  assert.match(serverText, /setInternetArchiveProxyApplier\(/);
});

test('search and playback route the keyless providers to their own endpoints', () => {
  // Search: both the search-mode URL and the source-switcher URL.
  assert.ok(searchText.includes("if (provider === 'itunes') return '/api/itunes/search?"));
  assert.ok(searchText.includes("if (provider === 'archive') return '/api/archive/search?"));
  // Playback: both song/url dispatch sites (preload and the main path).
  assert.strictEqual(startText.split("/api/itunes/song/url").length - 1, 2, 'itunes song/url wired at both dispatch sites');
  assert.strictEqual(startText.split("/api/archive/song/url").length - 1, 2, 'archive song/url wired at both dispatch sites');
  // Song objects must be attributed to the right provider, or the player
  // normalizes them to YouTube Music and asks the wrong endpoint.
  assert.match(searchText, /song\.provider === 'itunes'[\s\S]*?return 'itunes'/);
  assert.match(searchText, /song\.provider === 'archive'[\s\S]*?return 'archive'/);
  // normalizePlaybackProvider must accept them too.
  assert.match(qualityText, /if \(provider === 'itunes'\) return 'itunes';/);
  assert.match(qualityText, /if \(provider === 'archive'\) return 'archive';/);
});

test('the fallback walk can actually search the keyless providers', () => {
  // A chained ternary silently routed anything it did not recognise to
  // YouTube Music — the one source that cannot stream here.
  assert.match(fallbackText, /var SOURCE_FALLBACK_SEARCH_URLS = \{/);
  assert.match(fallbackText, /archive: function \(q\) \{ return '\/api\/archive\/search\?/);
  assert.match(fallbackText, /itunes: function \(q\) \{ return '\/api\/itunes\/search\?/);
  assert.match(fallbackText, /function sourceFallbackSearchUrl\(provider, query\)/);
  // They must be marked as streamable, or the walk skips them.
  assert.match(fallbackText, /archive: \{ canStream: true/);
  assert.match(fallbackText, /itunes: \{ canStream: true/);
});

test('the keyless providers are opt-in for the proxy, not forced through it', () => {
  // They are the sources that work WITHOUT a proxy, so they must default off.
  assert.match(proxyText, /PROXY_APPS = \[[^\]]*'itunes'[^\]]*'archive'/);
  assert.match(proxyText, /itunes: false, archive: false/);
  assert.match(proxyPanelText, /\['itunes', 'Apple Music \(previews\)'\]/);
  assert.match(proxyPanelText, /\['archive', 'Internet Archive'\]/);
});

test('the iTunes bridge ranks the track people asked for above its remixes and covers', () => {
  const source = fs.readFileSync(path.join(appRoot, 'itunes-api.js'), 'utf8');
  const internals = loadInternals(itunes, source);
  const terms = internals.__test.queryTerms('blinding lights');
  // The vm sandbox creates the array in another realm, so compare as JSON.
  assert.strictEqual(JSON.stringify(terms), JSON.stringify(['blinding', 'lights']));

  const exact = { trackName: 'Blinding Lights', artistName: 'The Weeknd' };
  const remix = { trackName: 'Blinding Lights (Remix)', artistName: 'Someone Else' };
  const cover = { trackName: 'Blinding Lights The Weeknd', artistName: 'Pancadao GD Som' };
  const s = internals.__test.scoreTrack;
  assert.ok(s(exact, terms) < s(remix, terms), 'the original must outrank a remix');
  assert.ok(s(exact, terms) < s(cover, terms), 'the original must outrank a cover');

  // Ranking only makes a difference in the output order, so check the sort
  // itself. The original leads; a cover naming the artist in its title
  // outranks a remix, which the score penalties make deliberate.
  const ranked = [{ track: remix }, { track: exact }, { track: cover }]
    .map((entry, index) => ({ entry, index, score: s(entry.track, terms) }))
    .sort((a, b) => (a.score - b.score) || (a.index - b.index))
    .map((r) => r.entry.track.artistName);
  assert.deepStrictEqual(ranked, ['The Weeknd', 'Pancadao GD Som', 'Someone Else']);
});

test('the Internet Archive bridge keeps full-length audio and drops broadcasts', () => {
  const source = fs.readFileSync(path.join(appRoot, 'internet-archive-api.js'), 'utf8');
  const internals = loadInternals(archive, source);
  const t = internals.__test;

  // For music items the mp3 IS the derivative and the "original" is a wav.
  // Rejecting derivatives used to throw away every mp3 on the Archive.
  const music = t.pickAudioFile([
    { name: '01 Song.wav', size: '88388204' },
    { name: '01 Song.mp3', size: '9283043' },
    { name: '01 Song_spectrogram.png', size: '33818' },
  ]);
  assert.strictEqual(music.name, '01 Song.mp3', 'mp3 is the streamable derivative and must be chosen');

  // Broadcasts and spoken word are audio but not music.
  assert.strictEqual(t.looksLikeMusic({ identifier: 'VOA_Africa_20191215_110000', metadata: { subject: 'Radio Program' } }, [{ name: 'x.mp3' }]), false);
  assert.strictEqual(t.looksLikeMusic({ identifier: 'some_podcast_ep12', metadata: { subject: 'Podcast' } }, [{ name: 'x.mp3' }]), false);
  assert.strictEqual(t.looksLikeMusic({ identifier: 'u2atlanta20051', metadata: { subject: 'U2,How To Dismantle An Atomic Bomb' } }, [{ name: '01 City of Blinding Lights.mp3' }]), true);
  // A broadcast can carry a musical subject and still not be music: a radio
  // programme is one whole-file recording, never track-numbered.
  assert.strictEqual(t.looksLikeMusic({ identifier: 'VOA1_The_Hits_20191215', metadata: { subject: 'Radio Program,American pop singers' } }, [{ name: 'VOA1_The_Hits_20191215.mp3' }]), false);

  // The item key must be identifier::file so one item can hold many tracks.
  const song = t.mapItemToSong(
    { identifier: 'u2atlanta20051', metadata: { title: 'U2 2006-12-09', creator: 'U2' } },
    [{ name: '01 City of Blinding Lights.mp3', size: '9283043' }],
    0
  );
  assert.strictEqual(song.id, 'u2atlanta20051::01 City of Blinding Lights.mp3');
  assert.strictEqual(song.playable, true);
  assert.strictEqual(song.playbackMode, 'direct-url');
});

test('the Archive search query is not built with URLSearchParams', () => {
  // URLSearchParams encodes "fl[]" to "fl%5B%5D"; the Archive accepts that but
  // silently omits the fields, so every doc came back with an undefined
  // identifier and the search returned nothing.
  const source = fs.readFileSync(path.join(appRoot, 'internet-archive-api.js'), 'utf8');
  const params = source.slice(source.indexOf('function archiveDocQueryParams'), source.indexOf('async function fetchArchiveDocs'));
  assert.ok(params.length > 0, 'expected the archiveDocQueryParams helper');
  // The field names must be written literally; the comment naming
  // URLSearchParams is the bug this test exists to prevent.
  assert.ok(params.includes("'fl[]=identifier'"), 'field names must be written literally');
  assert.ok(params.includes("'fl[]=title'"));
  assert.ok(params.includes("'fl[]=subject'"));
  assert.ok(!/new URLSearchParams\(/.test(params), 'archiveDocQueryParams must not build params with URLSearchParams');
});

test('the Archive query confines the words to fields instead of OR-ing them bare', () => {
  // This is the reason every result was a 30-second preview. A bare
  // "mediatype:(audio) AND (daft punk)" is an OR over every field of every
  // document: it answered 2204 items whose top was radio mixtapes, so the one
  // full-length source never survived into the results and nothing else on this
  // network can stream. Confining the words to the fields a music item fills in
  // turns the same query into 9-89 documents with the track typed at the top.
  const t = archive.__test;
  assert.deepStrictEqual(t.archiveQueryTerms('Bohemian Rhapsody Queen'), ['bohemian', 'rhapsody', 'queen']);

  const query = t.archiveDocQuery(['daft', 'punk']);
  assert.ok(query.includes('title:(daft punk)'), 'the words must be scoped to title');
  assert.ok(query.includes('creator:(daft punk)'), 'and to creator');
  assert.ok(query.includes('subject:(daft punk)'), 'and to subject');
  // The bare OR-ed form is what produced the junk page; it must not come back.
  assert.ok(!/AND \(daft punk\)/.test(query), 'the words must not be OR-ed bare');

  // Measured on the Archive: mixing AND and OR at the same nesting level
  // collapses the entire query to zero results, and q.op=AND is rejected
  // outright with UNSUPPORTED_VALUE. Every clause must therefore be one
  // operator, and q.op must never be sent. The assertion looks at the request
  // builder, not the file, because this comment names the parameter too.
  const inner = query.slice(query.indexOf('AND (') + 5, query.lastIndexOf(')'));
  assert.ok(!/\bAND\b/.test(inner), 'nested AND inside the OR list collapses the query to zero results');
  const source = fs.readFileSync(path.join(appRoot, 'internet-archive-api.js'), 'utf8');
  const paramsSource = source.slice(source.indexOf('function archiveDocQueryParams'), source.indexOf('function archiveDocQueryParams') + 700);
  assert.ok(!/q\.op/.test(paramsSource), 'the Archive rejects q.op=AND outright');

  // Popularity is the only real ranking signal available, and it comes from the
  // downloads sort rather than a second query — a "creator:\"daft punk\""
  // conjunction was measured returning zero on every attempt.
  assert.match(source, /sort\[\]=downloads desc/);
  assert.ok(source.includes("'fl[]=downloads'"), 'the sort field has to be requested to order the candidates');
});

test('archive ranks the candidates that match what was typed', () => {
  // The document query is popularity-sorted, so a hit on every word has to be
  // able to lead regardless of how many downloads the item has.
  const t = archive.__test;
  const words = ['bohemian', 'rhapsody', 'queen'];
  const match = { identifier: 'a', metadata: { title: 'Queen - Bohemian Rhapsody' }, downloads: 10 };
  const near = { identifier: 'b', metadata: { title: 'Bohemian Folk Night' }, downloads: 5000 };
  const miss = { identifier: 'c', metadata: { title: 'Radio Program 12' }, downloads: 9000 };
  assert.ok(t.archiveSongRelevance(match, words) > t.archiveSongRelevance(near, words));
  assert.ok(t.archiveSongRelevance(match, words) > t.archiveSongRelevance(miss, words));
  // The handler sorts on exactly this score, with downloads as the tie-break.
  const source = fs.readFileSync(path.join(appRoot, 'internet-archive-api.js'), 'utf8');
  assert.match(source, /\.sort\(\(a, b\) => \(b\.score - a\.score\) \|\| \(b\.item\.downloads - a\.item\.downloads\)\)/);
});

test('archive reports a real duration instead of zero', () => {
  const t = archive.__test;
  assert.strictEqual(t.fileDurationMs({ length: '06:42' }), 402000);
  assert.strictEqual(t.fileDurationMs({ length: '1:02:03' }), 3723000);
  assert.strictEqual(t.fileDurationMs({ length: '245' }), 245000);
  assert.strictEqual(t.fileDurationMs({}), 0);
  const song = t.mapItemToSong(
    { identifier: 'u2atlanta20051', metadata: { title: 'U2 2006-12-09', creator: 'U2' } },
    [{ name: '01 City of Blinding Lights.mp3', size: '9283043', length: '06:42' }],
    0
  );
  assert.strictEqual(song.durationMs, 402000);
  assert.strictEqual(song.duration, 402);
  // services/img answers image/jpeg for any identifier, so a missing explicit
  // thumbnail must not leave the row without a cover.
  assert.match(song.cover, /services\/img\/u2atlanta20051$/);
});

test('the search fan-out actually asks the keyless providers', () => {
  // The order list drove the fan-out, so leaving the keyless sources out meant
  // an unproxied machine searched four DNS-blocked hosts and reported
  // "No matching songs found" while two working sources sat unused.
  assert.match(searchText, /var MUSIC_SEARCH_PROVIDER_ORDER = \['archive', 'itunes',/);
  // The merge dropped any provider it had no parameter for, even when the
  // fan-out had fetched its results.
  assert.match(searchText, /function mergeSongSearchResults\(ytmusicSongs, deezerSongs, soundcloudSongs, spotifySongs, itunesSongs, archiveSongs,/);
  assert.match(searchText, /\(itunesSongs \|\| \[\]\)\.forEach/);
  assert.match(searchText, /\(archiveSongs \|\| \[\]\)\.forEach/);
  // Both need a page size and a result bucket or they are skipped.
  assert.match(searchText, /pageLimitByProvider = \{ archive: \d+, itunes: \d+/);
  assert.match(searchText, /songsByProvider = \{ archive: \[\], itunes: \[\]/);
  assert.match(searchText, /songsByProvider\.itunes,\s*songsByProvider\.archive,/);
  // A per-platform search mode has to name them, or the mode falls back to "all".
  assert.match(searchText, /mode === 'itunes' \|\| mode === 'archive'/);
});

test('the fallback walk stops treating the keyless sources as sign-in-only', () => {
  // platformStatus() had no case for them, so both fell through to NetEase's
  // loginStatus (loggedOut) and rendered as "Sign in to use as a fallback".
  assert.match(fallbackText, /SOURCE_FALLBACK_DIRECT_PROVIDERS = \['archive', 'itunes',/);
  assert.match(fallbackText, /if \(provider === 'deezer' \|\| provider === 'soundcloud' \|\| provider === 'itunes' \|\| provider === 'archive'\) return true;/);
  // platformStatus must answer for them, and say they are ready.
  const statusText = read('public/js/modules/08-account/01-login-modal-utils.js');
  assert.match(statusText, /if \(provider === 'itunes' \|\| provider === 'archive'\) return KEYLESS_PLATFORM_STATUS;/);
  assert.match(statusText, /loggedIn: true,[\s\S]*?searchReady: true/);
  // This copy of platformMeta loads last and shadows the search one; leaving
  // the keyless sources out of it labelled them "NetEase Cloud Music".
  assert.match(statusText, /if \(provider === 'itunes'\) return \{ key: 'itunes'/);
  assert.match(statusText, /if \(provider === 'archive'\) return \{ key: 'archive'/);
});

test('a song/url that is already routed is not wrapped a second time', () => {
  // deezer/itunes/archive answer song/url with "/api/audio?url=...". Wrapping
  // that again made the bridge fetch a localhost path: 502, no supported source,
  // nothing playing — for exactly the sources that stream fine on their own.
  assert.match(qualityText, /function audioBridgeUrl\(value\)/);
  assert.match(qualityText, /if \(\/\^https\?:\/i\.test\(raw\) \|\| raw\.charAt\(0\) === '\/'\)/);
  assert.ok(!startText.includes("'/api/audio?url=' + encodeURIComponent(data.url)"), 'playback must not wrap unconditionally');
  assert.strictEqual(startText.split('audioBridgeUrl(').length - 1, 2, 'both playback wrap sites go through the helper');
  const prefetchText = read('public/js/modules/03-beat/00-tempo-worker-cache-prefetch.js');
  assert.ok(!prefetchText.includes("'/api/audio?url=' + encodeURIComponent("), 'beat prefetch must not wrap unconditionally');

  // And the helper has to behave, not just exist.
  const sandbox = { module: { exports: {} }, exports: {}, encodeURIComponent, console };
  sandbox.exports = sandbox.module.exports;
  const vm = require('vm');
  const fn = qualityText.slice(qualityText.indexOf('function audioBridgeUrl'), qualityText.indexOf('function normalizePlaybackQuality'));
  vm.runInNewContext(fn + '\nthis.bridge = audioBridgeUrl;', sandbox);
  const bridge = sandbox.bridge;
  const routed = '/api/audio?url=https%3A%2F%2Farchive.org%2Fx.mp3&app=archive';
  assert.strictEqual(bridge(routed), routed, 'an already-routed url passes through untouched');
  assert.strictEqual(bridge('https://cdn.example/a.mp3'), 'https://cdn.example/a.mp3', 'an absolute url needs no bridge');
  assert.strictEqual(bridge('/local/track.mp3'), '/local/track.mp3', 'a local path is already reachable');
  assert.strictEqual(bridge('audio/mp3;base64,AAAA'), '/api/audio?url=' + encodeURIComponent('audio/mp3;base64,AAAA'), 'anything else still gets wrapped');
  assert.strictEqual(bridge(''), '', 'an empty url stays empty rather than becoming a broken src');
});

test('neither keyless source ever asks the user to sign in', () => {
  // They have no accounts at all, so a sign-in prompt from either is a bug.
  const itunesText = read('itunes-api.js');
  const archiveText = read('internet-archive-api.js');
  for (const [name, text] of [['itunes', itunesText], ['archive', archiveText]]) {
    assert.ok(!/login_required|vip_required|sign in|signin/i.test(text), name + ' must not emit auth categories');
    assert.match(text, /playableUrl: true/, name + ' must advertise that it can stream');
  }
  // openProviderLogin must refuse them rather than falling through to Spotify.
  const loginText = read('public/js/modules/08-account/04-user-modal-logout.js');
  const open = loginText.slice(loginText.indexOf('function openProviderLogin'), loginText.indexOf('var logoutAllAccountsResetBusy'));
  assert.ok(!/itunes|archive/.test(open), 'a keyless provider must never open a sign-in window');
});

test('archive search rejects spoken-word hits before paying for their metadata', () => {
  // A free-text Archive query comes back dominated by podcasts and radio
  // programmes, and every one used to cost a 1.3-2.6s metadata round-trip only
  // to be thrown away on the line after it. The rejection must run on the
  // search document, which the first request already returned.
  const t = archive.__test;
  assert.strictEqual(t.looksLikeSpokenWord({ identifier: 'VOA_Africa_20191215_110000', metadata: { subject: 'Radio Program' } }), true);
  assert.strictEqual(t.looksLikeSpokenWord({ identifier: 'some_podcast_ep12', metadata: { subject: 'Podcast' } }), true);
  assert.strictEqual(t.looksLikeSpokenWord({ identifier: 'u2atlanta20051', metadata: { subject: 'U2,How To Dismantle An Atomic Bomb' } }), false);
  // looksLikeMusic must stay in agreement, or the two filters drift apart.
  assert.strictEqual(t.looksLikeMusic({ identifier: 'some_podcast_ep12', metadata: { subject: 'Podcast' } }, null), false);

  const source = read('internet-archive-api.js');
  assert.match(source, /items\.filter\(\(item\) => !looksLikeSpokenWord\(item\) && !looksLikeDatedBroadcast\(item\)\)/);
});

test('archive resolves item metadata in parallel waves, not one request at a time', () => {
  // Serial lookups were twenty round-trips in a row: ten to thirty seconds
  // before the first search result could render.
  const source = read('internet-archive-api.js');
  assert.match(source, /const META_CONCURRENCY = \d+/);
  assert.match(source, /const details = await Promise\.all\(wave\.map/);
  assert.ok(
    !/for \(const item of[\s\S]{0,300}await fetchItemFiles\(/.test(source),
    'metadata must not be awaited one item at a time'
  );
  // Enough waves to fill the page, then no more. The page used to be filled from
  // the first wave that produced anything, which made result order an accident
  // of where a wave boundary fell: "blinding lights weeknd" returned three hits
  // because the third wave filled it, not because three were the best three.
  assert.match(source, /if \(found\.length >= wanted\) break;/);
  assert.ok(
    !/songs\.length < wanted/.test(source),
    'the page must be ranked after the wave loop, not filled wave by wave'
  );
});

test('archive ranks whole words, and does not let filler words match everything', () => {
  const t = archive.__test;
  // "the" is a substring of half the English language. Counting it as a matched
  // word made "blinding lights the weeknd" a full match for a Chilean chart
  // show whose subject line lists THE WEEKND, BLACKPINK and CAMILO.
  const chartShow = {
    identifier: 'LISTA_10_17-05-2020',
    metadata: { title: 'LISTA 10 - 17/05/2020', creator: '', subject: 'PALOMA MAMI,GOTEO,THE WEEKND' },
  };
  const clubNight = {
    identifier: 'DNA_Lounge_Blinding_Lights_Weeknd_Dance_Party',
    metadata: { title: 'DNA Lounge: Blinding Lights: The Weeknd Dance Party (2025-04-05)', creator: '', subject: 'DNA Lounge' },
  };
  const track = {
    identifier: 'Blinding_lights_signature',
    metadata: { title: 'Blinding lights signature', creator: 'The weeknd', subject: '' },
  };
  const words = t.archiveQueryTerms('blinding lights weeknd');
  assert.ok(t.archiveSongRelevance(track, words) > t.archiveSongRelevance(chartShow, words),
    'the song must outrank a chart show that merely lists the artist in its subject');
  assert.ok(t.archiveSongRelevance(track, words) > t.archiveSongRelevance(clubNight, words),
    'a four-hour club night whose title contains every word must not outrank the song');
  // A word is only a match as a whole word.
  assert.strictEqual(t.fileWordsMatch('tonight.mp3', ['night']), 0);
  assert.strictEqual(t.fileWordsMatch('the night.mp3', ['night']), 1);
});

test('archive offers the track that was searched for, not the first file in the item', () => {
  // An album item holds a dozen files and they were sorted by format and name
  // alone, so "hotel california eagles" came back as "01 Pump It.mp3".
  const album = [
    { name: '01 Pump It.mp3', size: 3000000, length: '2:30' },
    { name: 'eagles-hotel california.mp3', size: 5000000, length: '6:30' },
  ];
  const words = archive.__test.archiveQueryTerms('hotel california eagles');
  const picked = archive.__test.pickAudioFile(album, words);
  assert.strictEqual(picked.name, 'eagles-hotel california.mp3');
  // With no query to match, the old format-then-name order still applies.
  assert.strictEqual(archive.__test.pickAudioFile(album).name, '01 Pump It.mp3');
});

test('archive keeps unnumbered audio instead of dropping it, but ranks it below a track', () => {
  // "01 - HOTEL CALIFORNIA" was read as a 2-character name and the item was
  // thrown away; a bare unnumbered file is a weaker candidate, not no candidate.
  const t = archive.__test;
  const item = { identifier: 'eagles_hotel_california_1977', metadata: { subject: 'Eagles,Hotel California' } };
  const numbered = t.archiveMusicScore(item, [{ name: '01 - HOTEL CALIFORNIA.flac', size: 1, length: '6:30' }]);
  const unnumberedSingle = t.archiveMusicScore(item, [{ name: 'hotel california.mp3', size: 1, length: '6:30' }]);
  assert.ok(numbered > 0, 'a "01 - Name" file must not be read as a two-character name');
  assert.ok(unnumberedSingle > 0, 'an unnumbered but correctly-named file must survive');
  assert.ok(numbered > unnumberedSingle);
  assert.strictEqual(t.archiveMusicScore({ identifier: 'x', metadata: {} }, [{ name: 'notes.txt', size: 1 }]), 0);
});

test('archive reuses one metadata cache and never stores a failure', () => {
  const source = read('internet-archive-api.js');
  assert.match(source, /function cachedItemFiles\(identifier\)/);
  // Definition plus both call sites: the search wave and song/url.
  assert.strictEqual(source.split('cachedItemFiles(').length - 1, 3, 'search and song/url must share the cache');
  assert.match(source, /if \(value == null\) return value;/);
  // A transient archive.org error answered null; pinning it for thirty minutes
  // made that track unplayable until the app was restarted.
  assert.ok(!/cacheMap\.set\(key, \{ value, expiresAt: Date\.now\(\) \+ ttlMs \}\);\s*if \(value == null\)/.test(source));
});

test('the iTunes bridge retries a dropped connection instead of failing the search', async () => {
  // itunes.apple.com drops TCP connections on this network (measured: ~1 in 6
  // requests answers "fetch failed"). That is environmental and cannot be
  // fixed in code, so the bridge must absorb it rather than hand the fan-out a
  // 502 and leave one source contributing nothing.
  itunes.resetItunesRuntimeStateForTests();
  const originalFetch = global.fetch;
  let calls = 0;
  global.fetch = async () => {
    calls += 1;
    if (calls === 1) throw new TypeError('fetch failed');
    return {
      status: 200,
      text: async () => JSON.stringify({
        results: [{
          wrapperType: 'track',
          kind: 'song',
          trackId: 910305122,
          trackName: 'Blinding Lights',
          artistName: 'The Weeknd',
          collectionName: 'After Hours',
          primaryGenreName: 'Pop',
          trackTimeMillis: 200040,
          previewUrl: 'https://audio-ssl.itunes.apple.com/preview.m4a',
          artworkUrl100: 'https://is1-ssl.mzstatic.com/art.jpg/100x100bb.jpg',
        }],
      }),
    };
  };
  try {
    const result = await itunes.handleItunesSearch('blinding lights', 5, 0);
    assert.strictEqual(calls, 2, 'a network failure must be retried once before giving up');
    assert.strictEqual(result.songs.length, 1);
    assert.strictEqual(result.songs[0].playable, true);
  } finally {
    global.fetch = originalFetch;
    itunes.resetItunesRuntimeStateForTests();
  }
});

test('the login modal never claims a provider is ready when it cannot be reached', () => {
  // Deezer, YT Music and SoundCloud are keyless, so the modal used to say "no
  // sign-in needed — search and play instantly" and stop. On this network all
  // three are DNS-sinkholed: their /status route still answers
  // configured:true, loggedIn:true from a hardcoded default, and only the
  // search itself fails. The promise is kept by nothing, so the modal has to
  // probe reachability and say so.
  const loginText = read('public/js/modules/08-account/03-login-modal-flows.js');
  assert.match(loginText, /async function probeProviderReachability\(provider\)/);
  assert.match(loginText, /\/api\/' \+ provider \+ '\/status/);
  assert.match(loginText, /function providerReachabilityStatus\(provider, overrideReachable\)/);
  // An unreachable provider must not be shown as ready, and its button must not
  // stay a dead control.
  const branch = loginText.slice(
    loginText.indexOf('if (loginProvider === \'ytmusic\''),
    loginText.lastIndexOf('updateLoginNodeGraphUi();'));
  assert.ok(branch.length > 0, 'expected the keyless-provider branch of updateLoginProviderUi');
  assert.match(branch, /providerReachabilityStatus\(loginProvider\)/);
  assert.ok(!/provMeta\.label \|\| loginProvider\) \+ ' — no sign-in needed\. Search and play instantly\.'/.test(branch),
    'the unconditional "play instantly" copy must be gone');

  // The account panel rows are the other place that printed "ready".
  const modalText = read('public/js/modules/08-account/04-user-modal-logout.js');
  for (const provider of ['ytmusic', 'deezer', 'soundcloud']) {
    assert.match(modalText, new RegExp("providerReachabilityStatus\\('" + provider + "'\\)"),
      provider + ' row must reflect reachability');
  }
  assert.ok(!/addDeezer\.textContent = 'Deezer — ready'/.test(modalText), 'an unconditional "ready" must be gone');
});

test('the iTunes bridge waits long enough to answer instead of 502ing', () => {
  const source = read('itunes-api.js');
  const match = /REQUEST_TIMEOUT_MS = (\d+)/.exec(source);
  assert.ok(match, 'a request timeout must be declared');
  const timeout = Number(match[1]);
  assert.ok(timeout >= 15000, 'the host needs more than 8s here; got ' + timeout);
  // A track with no preview can never play through this provider, and the
  // search API ranks those first — the top result became a dead click.
  assert.match(source, /if \(!mapped \|\| !mapped\.playable \|\| seen\.has\(mapped\.id\)\) continue;/);
});

test('an empty archive result is never cached, and one slow search never gets thrown away', () => {
  // Both of these were found from the same live symptom. Searching "blinding
  // lights" returned zero songs in 3 MILLISECONDS, twenty times in a row, while
  // "hotel california eagles" took 36s and returned twelve — through a proxy
  // that was answering HTTP 200. Two separate defects were stacked on top of
  // each other here, and both had to be fixed or the query stayed dead:
  //
  //   1. cacheWrap stored `[]` for thirty minutes. fetchArchiveDocs throws when
  //      the 15s request timeout fires, and the catch that swallowed it returns
  //      [] — an empty ARRAY, which is not null, so it was cached. One timeout
  //      during the initial burst turned that query into a permanent 3ms "no
  //      results" for the rest of the session, and every later retry just
  //      re-read the poison.
  //   2. SEARCH_PROVIDER_TIMEOUT_BY_PROVIDER.archive is 25s, but the archive
  //      fan-out is ~12 HTTP round-trips (1 search + ~10 metadata) and each one
  //      costs 2-6s through this network's proxy, so the total lands at 35-40s.
  //      The frontend gave up at 25s and discarded results that were seconds from
  //      arrival — which is why the very first search of a session showed
  //      previews only and a repeat search (now served from cache) showed the
  //      full-length tracks all along.
  const source = read('internet-archive-api.js');
  assert.match(
    source,
    /return \[\];\s*\}/,
    'expected the search producer to still return an empty list on failure'
  );
  // The fix: an empty search is a failure to learn, not an answer. Storing it
  // is what turned a 15s timeout into a permanent 3ms empty result.
  assert.match(
    source,
    /if \(Array\.isArray\(value\) && value\.length === 0\) return value;/,
    'an empty search result must not be cached'
  );

  const search = read('public/js/modules/05-playback/07-search.js');
  const budget = /SEARCH_PROVIDER_TIMEOUT_BY_PROVIDER = \{ archive: (\d+) \}/.exec(search);
  assert.ok(budget, 'the archive needs its own timeout budget');
  const ms = Number(budget[1]);
  // Measured worst case on this network through the proxy: 38s. The old 25s
  // budget threw those results away and the UI fell back to 30-second previews.
  assert.ok(ms >= 45000, 'archive fan-out must outlast its own round-trips; got ' + ms + 'ms');

  // The inner request timeout is what produces the cached-empty in the first
  // place, so it has to leave room for the waves to run.
  const inner = /REQUEST_TIMEOUT_MS = (\d+)/.exec(source);
  assert.ok(inner, 'the archive request timeout must be declared');
  assert.ok(Number(inner[1]) >= 20000, 'a 15s per-request timeout expires mid-wave; got ' + inner[1]);
});

test('a dead proxy can no longer take down the sources that reach the network on their own', () => {
  // THE root cause of "every song is a 30-second preview", found by probing the
  // live app rather than reading it. Three measurements, all at once:
  //
  //   proxy 192.168.1.99:10808 -> TCP connect TIMES OUT entirely
  //   archive.org DIRECT       -> 200 in 1362ms
  //   itunes.apple.com DIRECT  -> 200 in 1046ms
  //   lrclib.net DIRECT        -> 200 in 565ms
  //
  // The two sources that need no account were still being routed through that
  // dead proxy (data/app-proxy.json had archive:true and itunes:true, written at
  // 21:04). So a proxy the user had stopped running silently removed the only
  // two full-length sources on the machine: every request hung until it timed
  // out, the archive search caught the failure and reported zero results, and
  // the UI fell back to Deezer/iTunes previews — which is exactly the "all songs
  // still preview" report. Same single cause for the broken login modal and the
  // empty lyrics, which is why three unrelated features failed together.
  //
  // A user-selected proxy stays a user-selected proxy, and an explicit "off"
  // is still honoured. What must not happen is a dead proxy taking a working
  // direct route with it — the two keyless sources always have one.
  const source = read('app-proxy.js');
  assert.match(
    source,
    /function isSelectedFor\(/,
    'expected the per-app proxy selector'
  );
  assert.match(
    source,
    /KEYLESS_DIRECT_FALLBACK_APPS/,
    'the keyless sources must be able to bypass a dead proxy'
  );
  // The fallback has to be an actual retry, not a flag: the applier runs before
  // the request exists, so the decision has to be made from a live probe.
  assert.match(
    source,
    /function markProxyHostUnreachable\(/,
    'a failed tunnel must mark the proxy host unreachable'
  );
  assert.match(
    source,
    /function proxyHostIsUnreachable\(/,
    'the applier must be able to skip a proxy already known to be dead'
  );
  // And the panel has to stop reporting a dead proxy as "Active".
  const panel = read('public/js/modules/12-remote/01-app-proxy-panel.js');
  assert.match(panel, /proxyHostIsUnreachable|hostUnreachable|unreachable/,
    'the proxy panel must not report a dead proxy as active');
});

test('a proxy proven dead stays out of the way until something re-probes it', () => {
  const source = read('app-proxy.js');
  // Measured live: this proxy needs ~12s to fail a CONNECT. With a dead-verdict
  // TTL shorter than the probe interval, there is a window where nothing has
  // re-tested it but the keyless sources are being routed back through it —
  // an archive search then takes 40s and returns zero songs, which is the
  // original symptom. The verdict has to outlast the probe interval.
  const sticky = /const PROXY_DEAD_STICKY_TTL_MS\s*=\s*2\s*\*\s*PROXY_PROBE_TTL_MS/.test(source);
  assert.ok(sticky,
    'the dead-verdict TTL must be derived from (and longer than) the probe TTL');
  // Both places that ask "is it dead?" must use the sticky one, not a shorter
  // ad-hoc window that would reopen the same request every minute.
  const callers = source.match(/PROXY_[A-Z_]*TTL_MS/g) || [];
  assert.ok(!/PROXY_UNREACHABLE_TTL_MS/.test(source),
    'no shorter unreachable TTL may survive alongside the sticky one');
  assert.ok(callers.length > 0, 'expected TTL usages in app-proxy.js');
  assert.match(source, /function proxyHostIsUnreachable\([\s\S]{0,1400}PROXY_DEAD_STICKY_TTL_MS/,
    'the bypass decision must honour the sticky verdict');
});

test('a proxy with nothing listening on its port is skipped by every app', () => {
  // Measured live, same machine: /api/spotify/status took 21.1s because the
  // request was still being tunnelled to 192.168.1.99:10808, while a bare
  // https request to api.spotify.com answered in 719ms. The keyless bypass
  // above only rescues itunes and archive, so every other app — Spotify's
  // search, its login token exchange, the audio bridge — was paying a
  // guaranteed connect timeout for a route that cannot exist. Nothing is
  // listening: that is not a region block to be respected, it is a dead port.
  const source = read('app-proxy.js');
  assert.match(source, /function proxyHostIsTcpDead\(/,
    'the applier needs a stronger verdict than "not answering"');

  // The tcp-dead branch must sit inside applyToOptions, before any transport is
  // attached, and must return opts untouched — no dispatcher, no tunnel agent.
  const apply = source.slice(source.indexOf('function applyToOptions'), source.indexOf('function status()'));
  assert.match(apply, /proxyHostIsUnreachable\(config\) && KEYLESS_DIRECT_FALLBACK_APPS/,
    'the keyless bypass must survive');
  const tcpBranch = apply.indexOf('proxyHostIsTcpDead(config)');
  assert.ok(tcpBranch !== -1, 'applyToOptions must consult the tcp-dead verdict');
  assert.ok(tcpBranch < apply.indexOf('getDispatcher()'),
    'the bypass must run before a transport is built');
  assert.match(apply.slice(tcpBranch, tcpBranch + 120), /return opts;/,
    'a dead port must leave the options untouched for every app');
  assert.match(apply, /KEYLESS_DIRECT_FALLBACK_APPS\.indexOf\(appName\)/,
    'the weak verdict still applies only to the keyless apps');

  // Only a TCP-level failure earns it. A CONNECT that was issued and then
  // failed only says the proxy could not reach THAT target, which is exactly
  // the case where routing around it would dodge a region block.
  assert.match(source, /markProxyHostUnreachable\(config, \{ tcp: true \}\)/,
    'the bare-socket probe must record a tcp verdict');
  assert.match(source, /markProxyHostUnreachable\(config, \{ tcp: !connectIssued \}\)/,
    'a tunnel failure must report tcp only when CONNECT was never written');
  assert.match(source, /if \(err\) markProxyHostUnreachable\(config, \{ tcp: !connectIssued \}\)/);
  // …and that verdict must not be downgraded by a later vaguer one.
  const mark = source.slice(source.indexOf('function markProxyHostUnreachable'), source.indexOf('function markProxyHostReachable'));
  assert.match(mark, /if \(proxyHostState\.tcp\) return true;/,
    'a tcp verdict outranks any later CONNECT failure');

  // The verdict has to exist before the first request, not be learned from it:
  // applyToOptions is synchronous and can only launch a probe in the
  // background, so without a probe on load the first call after every restart
  // races a 20s+ connect timeout.
  const load = source.slice(source.indexOf('function loadConfig'), source.indexOf('function saveConfig'));
  assert.match(load, /startProxyHostProbe\(cachedConfig\)/,
    'loadConfig must start probing a saved proxy immediately');

  // status() reports it separately, and only the tcp-dead case may claim that
  // every app is going direct.
  assert.match(source, /const hostNotListening = proxyHostIsTcpDead\(config\);/);
  assert.match(source, /hostNotListening,/);
  const panel = proxyPanelText;
  assert.match(panel, /status\.hostNotListening \? ' · nothing is listening there/,
    'the panel may only say "nothing is listening" on a tcp verdict');
  assert.ok(!/status\.hostUnreachable \? ' · nothing is listening there/.test(panel),
    'a weak CONNECT failure must not claim every app went direct');
  assert.match(panel, /hostNotListening/,
    'the titlebar toggle needs the same distinction');
});
