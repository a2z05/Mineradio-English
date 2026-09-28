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
  const fetchDocs = source.slice(source.indexOf('const fetchDocs = async'), source.indexOf('const seen = new Set();'));
  assert.ok(fetchDocs.length > 0, 'expected the fetchDocs helper');
  // The field names must be written literally; the comment naming
  // URLSearchParams is the bug this test exists to prevent.
  assert.ok(fetchDocs.includes("'fl[]=identifier'"), 'field names must be written literally');
  assert.ok(fetchDocs.includes("'fl[]=title'"));
  assert.ok(fetchDocs.includes("'fl[]=subject'"));
  assert.ok(!/new URLSearchParams\(/.test(fetchDocs), 'fetchDocs must not build params with URLSearchParams');
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
  assert.match(source, /items\.filter\(\(item\) => !looksLikeSpokenWord\(item\)\)/);
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
  // Stop as soon as the requested page is full rather than resolving all twenty.
  assert.match(source, /songs\.length < wanted/);
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
