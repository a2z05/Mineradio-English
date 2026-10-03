'use strict';
// A track no provider knows should cost the user its chain walk once, not on
// every replay. The resolver caches a hit for a day; it used to throw the miss
// away, so the same unknown title paid all five providers again each time —
// measured at 7.9s / 7.7s / 7.2s for three consecutive requests of one 3-second
// game sound. These tests pin the two halves of the fix: the miss is remembered
// and served instantly, and a miss still lets a later hit win.

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  resolveGlobalLyrics,
  setQqLyricLookup,
  resetLyricsResolverRuntimeStateForTests,
  setLyricsResolverClockForTests,
  MISS_CACHE_TTL_MS,
} = require('../lyrics-resolver');

// LRCLIB is the only provider this module reaches over the network itself, so
// it is the only one a test has to stand in for. Steps 2-5 are injected and
// left null by default, which is already the "nothing else to try" shape.
function stubLrclib(t) {
  t.mock.method(globalThis, 'fetch', async (url) => {
    const href = String(url);
    if (href.indexOf('/search') >= 0) return { status: 200, text: async () => '[]' };
    return { status: 404, text: async () => '' };
  });
}

// What the tests below know that the first one did not: LRCLIB answers a miss
// with two requests, /get then the fuzzy /search, so a count of "zero" means a
// remembered answer and a count of 2 means the chain actually walked.
const LRCLIB_MISS_FETCHES = 2;

function lookup(overrides) {
  return resolveGlobalLyrics(Object.assign({
    title: 'Zzzqx Nonexistent Mnemonicsong',
    artist: 'Zzqx Nonexistent Mnemonians',
    album: 'Zzzqx Vol. 1',
    duration: 3,
    videoId: '',
  }, overrides || {}));
}

test('a miss is remembered rather than paying the chain on every call', async (t) => {
  resetLyricsResolverRuntimeStateForTests();
  stubLrclib(t);

  const first = await lookup();
  assert.equal(first.source, 'none');
  assert.equal(first.lyric, '');
  // The honest message still names every provider it tried.
  assert.match(first.message, /lrclib/);

  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    calls += 1;
    return { status: 404, text: async () => '' };
  });
  const second = await lookup();
  assert.equal(second.source, 'none');
  assert.equal(second.message, first.message);
  assert.equal(calls, 0, 'a remembered miss must not reach the network again');
});

test('a remembered miss expires, so a track that gains lyrics later still gets them', async (t) => {
  resetLyricsResolverRuntimeStateForTests();
  stubLrclib(t);
  const missed = await lookup();
  assert.equal(missed.source, 'none');

  // Someone syncs the lyrics on LRCLIB an hour later. The answer the user sees
  // must follow that, so the miss cannot outlive its own TTL — this is the one
  // thing a negative cache is allowed to get wrong, and it is why the miss is
  // remembered for an hour rather than for a day like a hit.
  let served = 0;
  t.mock.method(globalThis, 'fetch', async (url) => {
    const href = String(url);
    if (href.indexOf('/get') >= 0) {
      served += 1;
      return {
        status: 200,
        text: async () => JSON.stringify({
          syncedLyrics: '[00:01.00]now it resolves',
          plainLyrics: 'now it resolves',
        }),
      };
    }
    return { status: 200, text: async () => '[]' };
  });

  const clock = { now: Date.now() };
  setLyricsResolverClockForTests(() => clock.now);
  t.after(() => setLyricsResolverClockForTests(null));

  const stillRemembered = await lookup();
  assert.equal(stillRemembered.source, 'none');
  assert.equal(served, 0, 'inside the window nothing re-asks');

  clock.now += MISS_CACHE_TTL_MS + 1;
  const found = await lookup();
  assert.equal(found.provider, 'lrclib');
  assert.match(found.lyric, /now it resolves/);
  assert.equal(served, 1);
});

test('a remembered miss keeps its own shape, never a stale hit', async (t) => {
  resetLyricsResolverRuntimeStateForTests();
  stubLrclib(t);
  const fresh = await lookup();
  const replay = await lookup();
  assert.deepEqual(replay, fresh, 'a remembered miss is handed back unchanged');
  assert.equal(replay.lyric, '');
  assert.equal(replay.tlyric, '');
  assert.equal(replay.yrc, '');
});

test('resetting the resolver state forgets the remembered misses', async (t) => {
  resetLyricsResolverRuntimeStateForTests();
  stubLrclib(t);
  await lookup();

  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    calls += 1;
    return { status: 404, text: async () => '' };
  });
  resetLyricsResolverRuntimeStateForTests();
  await lookup();
  // One walk, not none — LRCLIB asks /get and then falls back to /search.
  assert.equal(calls, LRCLIB_MISS_FETCHES, 'a reset must put the chain back to walking');
});

test('the injected lyric-only providers still take part in the search', async (t) => {
  resetLyricsResolverRuntimeStateForTests();
  stubLrclib(t);
  const seen = [];
  setQqLyricLookup(async (input) => {
    seen.push(String(input && input.title));
    return { provider: 'qq', source: 'qq-qrc', lyric: '[00:02.00]from qq', tlyric: '', yrc: '', ytlrc: '', romalrc: '' };
  });
  t.after(() => setQqLyricLookup(null));

  const payload = await lookup();
  assert.deepEqual(seen, ['Zzzqx Nonexistent Mnemonicsong']);
  assert.equal(payload.provider, 'qq');
  assert.equal(payload.source, 'qq-qrc');
  assert.match(payload.lyric, /from qq/);

  // And it is cached as a hit, not as a miss: nothing walks the chain again.
  const replay = await lookup();
  assert.equal(replay.provider, 'qq');
  assert.deepEqual(seen, ['Zzzqx Nonexistent Mnemonicsong']);
});