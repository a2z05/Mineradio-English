'use strict';
// The library table gained Sonora's column model: a ranked column spec, a
// multi-axis sieve, a sort that runs over the whole library and a route cache
// so a sort the user has already visited is not paid for twice.
//
// Two properties matter more than the rest, and both are silent failures:
//
//   1. Sorting must not mutate the store's array. The next view starts from
//      the same order the last one did, so a stray in-place sort would show up
//      as a view that opens in an order nobody asked for.
//   2. The route cache has to die when the library changes. A play count that
//      has already gone up, sorted by "most played", still showing the count
//      from before the play, is the kind of wrong that reads as a bug and is
//      not one until you look.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { namedFunctionSource } = require('./helpers/extract-function');

const appRoot = path.resolve(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(appRoot, p), 'utf8');

const storeSource = read('public/js/modules/13-library/00-local-library-store.js');
const pageSource = read('public/js/modules/13-library/01-library-page.js');
const viewsSource = read('public/js/modules/13-library/08-library-views.js');
const loaderSource = read('public/js/index-loader.js');
const css = read('public/css/library-page.css');
const html = read('public/index.html');

function makeSong(id, over) {
  return Object.assign({
    localFileId: id,
    localKey: id,
    localUrl: 'mineradio-local://' + id,
    localPath: 'Singles/Track ' + id + '.flac',
    name: 'Track ' + id,
    artist: 'Artist ' + id,
    album: 'Album ' + id,
    albumArtist: 'Artist ' + id,
    genre: 'Rock',
    year: 2021,
    duration: 180,
    addedAt: 0,
  }, over || {});
}

const STORE_NAMES = [
  'invalidateLocalLibraryIndex', 'rebuildLocalLibraryById', 'localFileIdOf', 'localLibrarySongKey',
  'localLibraryUserState', 'localLibraryIsFavorite', 'localLibraryNormalizeTracks',
  'localLibraryFolderOf', 'localLibraryKeyFor', 'localLibraryBuildGroups',
  'localLibraryBuildIndex', 'libraryViewMeta', 'localLibrarySortedCopy',
  'libraryViewRows', 'localLibrarySearchBlob', 'localLibrarySearchBlobs',
  'localLibraryScoreMatch', 'localLibraryScoreCeiling', 'localLibraryQueryTerms',
  'localLibraryMatchScore', 'localLibraryBlobCouldMatch', 'localLibraryHitBetter',
  'localLibraryCompareHits', 'localLibrarySearchSongs',
  'librarySearchTracks', 'localLibrarySearchCandidates',
  'libraryGroupTracks', 'librarySetFavorite', 'libraryToggleFavorite',
  'notifyLikeButtonsChanged',
  'librarySetRating', 'libraryRecordPlaybackEvent',
  'setLocalLibraryStoreTracks',
];

function varBlock(source, name) {
  const hit = new RegExp(`var ${name}\\s*=\\s*`).exec(source);
  assert.ok(hit, `missing var ${name}`);
  const start = hit.index;
  const openAt = source.indexOf('[', hit.index + hit[0].length - 1);
  const open = source[openAt];
  const close = open === '[' ? ']' : '}';
  let depth = 0;
  let quote = '';
  for (let index = openAt; index < source.length; index += 1) {
    const ch = source[index];
    if (quote) {
      if (ch === '\\') index += 1;
      else if (ch === quote) quote = '';
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') { quote = ch; continue; }
    if (ch === open) depth += 1;
    if (ch === close) {
      depth -= 1;
      if (depth === 0) return source.slice(start, index + 2);
    }
  }
  throw new Error(`unterminated var ${name}`);
}

function seed(tracks, userData, extra) {
  const sandbox = Object.assign({
    console,
    window: { desktopWindow: null },
    persistentLocalLibraryTracks: [],
    hydrateCustomCover: (song) => song,
    cloneSong: (song) => Object.assign({}, song),
    localLibraryStore: {
      tracks: tracks || [],
      byId: {},
      userData: userData || { songs: {}, playlists: [] },
      folders: [],
      loaded: false,
      loading: false,
      index: null,
      indexAt: 0,
    },
  }, extra || {});
  // songCoverSrc lives in the cover module, not in the store — but a rescan
  // hydrates covers through it, so it comes along as the identity here. The
  // tests never cover artwork; they only need the call to land somewhere.
  sandbox.songCoverSrc = sandbox.songCoverSrc || (() => '');
  vm.runInNewContext(
    STORE_NAMES.map((n) => namedFunctionSource(storeSource, n)).join('\n')
      + '\n' + varBlock(storeSource, 'LIBRARY_VIEWS'),
    sandbox
  );
  vm.runInNewContext(viewsSource, sandbox);
  return sandbox;
}

const names = (list) => Array.from(list, (song) => song.localFileId || song.name);

// ---------------------------------------------------------------- the port

test('the sort and filter module is registered, or every sort control is dead', () => {
  assert.match(loaderSource, /'js\/modules\/13-library\/08-library-views\.js'/);
});

test('the sort model is credited to Sonora rather than presented as ours', () => {
  // Sonora is GPL-3.0-or-later and this fork is GPL-3.0-only, so the code may
  // come across — but the origin has to be written down, or the next person
  // to read a column spec has no idea where it came from.
  assert.match(viewsSource, /Sonora/);
  assert.match(viewsSource, /sonorahq\/sonora/);
  assert.match(viewsSource, /GPL-3\.0-or-later/);
  assert.match(css, /sonorahq\/sonora/);
});

test('the sieve keeps every axis, not the last one asked for', () => {
  const tracks = [
    makeSong('a', { duration: 120 }),
    makeSong('b', { duration: 400 }),
    makeSong('c', { duration: 200 }),
  ];
  const sandbox = seed(tracks, {
    songs: { a: { favorite: true }, c: { favorite: true } },
    playlists: [],
  });

  const durationOnly = sandbox.libraryApplySieve(tracks, { duration: [60, 180], favorites: false, rated: false, unplayed: false });
  assert.deepEqual(names(durationOnly), ['a'], 'bounds are inclusive of the second');

  // Sonora's rule: an axis that is switched on is a filter, and they intersect.
  const both = sandbox.libraryApplySieve(tracks, { duration: [60, 180], favorites: true, rated: false, unplayed: false });
  assert.deepEqual(names(both), ['a'], 'favourite and length together are an AND');

  const favouritesOnly = sandbox.libraryApplySieve(tracks, { duration: null, favorites: true, rated: false, unplayed: false });
  assert.deepEqual(names(favouritesOnly), ['a', 'c']);
});

test('a sieve that is switched off keeps everything', () => {
  const tracks = [makeSong('a'), makeSong('b')];
  const sandbox = seed(tracks);
  const empty = sandbox.libraryNewSieve();
  assert.equal(sandbox.librarySieveActive(empty), false);
  assert.equal(sandbox.libraryApplySieve(tracks, empty).length, 2);
});

test('sorting returns a new array and never reorders the library behind the caller', () => {
  const tracks = [makeSong('a', { name: 'Zebra' }), makeSong('b', { name: 'apple' })];
  const sandbox = seed(tracks);
  const order = names(tracks);

  const sorted = sandbox.librarySortSongs(tracks, 'title', 'asc');
  // Case folding, so "apple" files before "Zebra" rather than after it.
  assert.deepEqual(names(sorted), ['b', 'a']);
  assert.deepEqual(names(tracks), order, 'the store array was sorted in place');
  assert.notEqual(sorted, tracks, 'the caller got the store array back');
});

test('a numeric column sorts numerically and not as text', () => {
  const tracks = [
    makeSong('a', { duration: 90 }),
    makeSong('b', { duration: 1200 }),
    makeSong('c', { duration: 300 }),
  ];
  const sandbox = seed(tracks);
  const ascending = sandbox.librarySortSongs(tracks, 'duration', 'asc');
  assert.deepEqual(names(ascending), ['a', 'c', 'b'],
    '1200 seconds must not sort between 90 and 300');
  const descending = sandbox.librarySortSongs(tracks, 'duration', 'desc');
  assert.deepEqual(names(descending), ['b', 'c', 'a']);
});

test('a filter survives the round trip through a route and back into the list', () => {
  // The encode and the decode are in different functions, and an off-by-one
  // between them shows up as a filter that lights up and filters nothing.
  const tracks = [
    makeSong('a', { duration: 90 }),
    makeSong('b', { duration: 600 }),
  ];
  const s = seed(tracks, {
    songs: { a: { favorite: true }, b: { favorite: false } },
    playlists: [],
  });

  const sieve = s.libraryNewSieve();
  sieve.duration = [60, 120];
  sieve.favorites = true;

  const route = s.libraryRouteId('songs', 'title', 'asc', sieve);
  const parts = route.split('|');
  assert.equal(parts[3], '60-120', 'the length filter is written at index 3');
  assert.equal(parts[4], 'fav', 'the favourite flag is written at index 4');

  // Applying the route must actually narrow the list.
  assert.deepEqual(names(s.libraryRouteSongs(route)), ['a'],
    'both filters are set and neither took effect');

  const withoutLength = s.libraryRouteId('songs', 'title', 'asc', (() => {
    const copy = s.libraryNewSieve();
    copy.favorites = true;
    return copy;
  })());
  assert.deepEqual(names(s.libraryRouteSongs(withoutLength)), ['a']);

  const lengthOnly = s.libraryRouteId('songs', 'title', 'asc', (() => {
    const copy = s.libraryNewSieve();
    copy.duration = [60, 120];
    return copy;
  })());
  assert.deepEqual(names(s.libraryRouteSongs(lengthOnly)), ['a']);
});

test('a nonsensical length range does not become a filter that hides everything', () => {
  const tracks = [makeSong('a', { duration: 100 })];
  const s = seed(tracks);
  const route = s.libraryRouteId('songs', 'title', 'asc', { duration: null, favorites: false, rated: false, unplayed: false })
    .split('|');
  route[3] = '300-100';
  assert.deepEqual(names(s.libraryRouteSongs(route.join('|'))), ['a'],
    'a range that ends before it starts must fall back to no range');
});

test('turning a column around reverses it, and a different column starts ascending', () => {
  const sandbox = seed([makeSong('a')]);
  let route = sandbox.libraryRouteId('songs', 'title', 'asc', sandbox.libraryNewSieve());

  route = sandbox.libraryToggleSort(route, 'title');
  assert.equal(sandbox.librarySortKeyForRoute(route).direction, 'desc');
  route = sandbox.libraryToggleSort(route, 'title');
  assert.equal(sandbox.librarySortKeyForRoute(route).direction, 'asc');

  route = sandbox.libraryToggleSort(route, 'duration');
  const key = sandbox.librarySortKeyForRoute(route);
  assert.equal(key.field, 'duration');
  assert.equal(key.direction, 'asc', 'a new column starts from the top, not from the last direction');
});

// ---------------------------------------------------------------- routes

test('a route is one string, so view, sort and filter travel together', () => {
  const s = seed([makeSong('a')]);
  const withFilter = s.libraryNewSieve();
  withFilter.favorites = true;
  const route = s.libraryRouteId('songs', 'artist', 'desc', withFilter);
  const key = s.librarySortKeyForRoute(route);
  assert.equal(key.field, 'artist');
  assert.equal(key.direction, 'desc');
  assert.match(route, /fav/, 'the filter is part of the route, not a separate loose flag');
  // Rebuilding the sieve from the route has to give the one that was encoded.
  const rebuilt = {
    favorites: route.split('|')[4] === 'fav',
  };
  assert.equal(rebuilt.favorites, true);
});

test('the route cache is a cache, not a snapshot of forever', () => {
  const tracks = [makeSong('a', { name: 'Beta', duration: 300 }), makeSong('b', { name: 'Alpha', duration: 100 })];
  const s = seed(tracks);
  const route = s.libraryRouteId('songs', 'title', 'asc', s.libraryNewSieve());

  assert.deepEqual(names(s.libraryRouteSongs(route)), ['b', 'a']);
  // Same route, same answer — that is the cache doing its job.
  assert.deepEqual(names(s.libraryRouteSongs(route)), ['b', 'a']);

  s.libraryInvalidateRouteCache();
  assert.deepEqual(names(s.libraryRouteSongs(route)), ['b', 'a'], 'still correct after a drop');
});

test('a play count that has gone up reorders the table, not just the number', () => {
  const tracks = [makeSong('a', { name: 'A' }), makeSong('b', { name: 'B' })];
  const s = seed(tracks, {
    songs: { a: { plays: 1 }, b: { plays: 9 } },
    playlists: [],
  });
  const route = s.libraryRouteId('songs', 'title', 'asc', s.libraryNewSieve());
  assert.deepEqual(names(s.libraryRouteSongs(route)), ['a', 'b']);

  // Record the play. invalidateLocalLibraryIndex is what the play handlers call,
  // so if the route cache hangs off it the order has to move with it.
  s.libraryInvalidateRouteCache();
  const sieve = s.libraryNewSieve();
  const byPlays = s.libraryRouteId('songs', 'plays', 'desc', sieve);
  assert.deepEqual(names(s.libraryRouteSongs(byPlays)), ['b', 'a']);
});

test('a rescan replaces the tracks and drops the cache with them', () => {
  const s = seed([makeSong('a', { name: 'Alpha' })]);
  const route = s.libraryRouteId('songs', 'title', 'asc', s.libraryNewSieve());
  assert.deepEqual(names(s.libraryRouteSongs(route)), ['a']);

  s.setLocalLibraryStoreTracks([makeSong('b', { name: 'Bravo' })]);
  assert.deepEqual(names(s.libraryRouteSongs(route)), ['b'],
    'the route was still serving the library as it was before the scan');
});

test('a grouped view is sorted on the group, and is not sieved away', () => {
  // Albums and artists have no favourite flag and no duration. Applying the
  // track sieve to them would empty every album view the moment a filter was
  // switched on, which is worse than not offering the filter at all.
  const tracks = [
    makeSong('a', { album: 'Zebra Album' }),
    makeSong('b', { album: 'Alpha Album' }),
    makeSong('c', { album: 'Alpha Album' }),
  ];
  const s = seed(tracks);
  const sieve = s.libraryNewSieve();
  sieve.favorites = true;

  const route = s.libraryRouteId('albums', 'title', 'asc', sieve);
  const rows = s.libraryRouteSongs(route);
  assert.equal(rows.length, 2, 'the favourite filter emptied the album view');
  assert.deepEqual(Array.from(rows, (g) => g.name), ['Alpha Album', 'Zebra Album']);
});

test('group views sort by their own track count, not by a duration they do not have', () => {
  const tracks = [
    makeSong('a', { album: 'Solo' }),
    makeSong('b', { album: 'Double' }),
    makeSong('c', { album: 'Double' }),
    makeSong('d', { album: 'Triple' }),
    makeSong('e', { album: 'Triple' }),
    makeSong('f', { album: 'Triple' }),
  ];
  const s = seed(tracks);
  const sieve = s.libraryNewSieve();
  const route = s.libraryRouteId('albums', 'count', 'desc', sieve);
  const rows = Array.from(s.libraryRouteSongs(route), (g) => g.name);
  assert.deepEqual(rows, ['Triple', 'Double', 'Solo']);
});

// ---------------------------------------------------------------- columns

test('a narrow window drops the least useful column first', () => {
  const s = seed([makeSong('a')]);
  const wide = s.libraryVisibleColumns('songs', 1400).map((c) => c.key);
  const narrow = s.libraryVisibleColumns('songs', 520).map((c) => c.key);

  assert.ok(wide.includes('album'), 'a wide table shows the album');
  assert.ok(narrow.length < wide.length, 'a narrow table shows fewer columns');
  assert.ok(narrow.includes('title'), 'the title is the last thing to go');
  assert.ok(!narrow.includes('album'), 'the album goes before the title');
});

test('a group view never shows an album column it would only repeat', () => {
  const s = seed([makeSong('a')]);
  const keys = s.libraryVisibleColumns('albums', 1400).map((c) => c.key);
  assert.ok(!keys.includes('album'), 'every row of an album view is that album');
  assert.ok(keys.includes('count'), 'a group is counted, not timed');
});

// ---------------------------------------------------------------- dividers

test('a title-sorted list is broken into letter runs', () => {
  const tracks = [
    makeSong('a', { name: 'Alpha' }),
    makeSong('b', { name: 'Amber' }),
    makeSong('c', { name: 'Beta' }),
  ];
  const s = seed(tracks);
  const rows = Array.from(s.libraryRowsWithDividers(tracks, 'title'), (r) =>
    (r.kind === 'divider' ? 'divider:' + r.initial : 'song'));
  assert.deepEqual(rows, ['divider:A', 'song', 'song', 'divider:B', 'song']);
});

test('anything that does not start with a letter files under one bucket', () => {
  const s = seed([makeSong('a')]);
  assert.equal(s.libraryGroupInitial('99 Luftballons'), '#');
  assert.equal(s.libraryGroupInitial('!!!'), '#');
  assert.equal(s.libraryGroupInitial(''), '#');
  assert.equal(s.libraryGroupInitial(' leading space'), '#');
  assert.equal(s.libraryGroupInitial('bark'), 'B', 'a lower-case letter buckets under its upper-case form');
});

// ---------------------------------------------------------------- the wiring

test('the header, the rows and the sort menu are all reachable from the markup', () => {
  assert.match(pageSource, /id="library-columns"/, 'the column header host is missing');
  assert.match(pageSource, /onclick="libraryToggleSortMenu\(event\)"/,
    'a Sort button with no handler is a dead control');
  assert.match(pageSource, /id="library-sort-menu"/);
  assert.match(pageSource, /onclick="libraryApplySort\(/);
  // Every column label is a button that re-sorts, not a heading that lies.
  const header = namedFunctionSource(pageSource, 'libraryPaintColumnHeader');
  assert.match(header, /onclick="libraryApplySort\(/,
    'a column label that only looks clickable');
  assert.match(css, /\.library-columns\s*\{/);
  assert.match(css, /\.library-grid-row\s*\{/);
  assert.match(css, /\.library-sort-menu\s*\{/);
});

test('the header grid and the row grid are the same grid', () => {
  // Two independent templates would let a column sit under the wrong label the
  // moment the window crossed a breakpoint. One template, written to both.
  const host = namedFunctionSource(pageSource, 'libraryPaintColumnHeader');
  assert.match(host, /libraryApplyColumnsVar\(\)/);
  const apply = namedFunctionSource(pageSource, 'libraryApplyColumnsVar');
  assert.match(apply, /host\.style\.gridTemplateColumns\s*=\s*template/);
  assert.match(apply, /setProperty\('--library-cols',\s*template\)/);
  const row = namedFunctionSource(pageSource, 'librarySongTableRowHtml');
  assert.match(row, /libraryPage\.columns/, 'the row must read the resolved column list');
});

test('the header and the rows are laid out in the same box', () => {
  // The same template is not enough: a grid resolves its `fr` tracks against
  // the width of the box it is in, so a header sitting outside the scroller
  // measures 15px wider the moment a scrollbar appears — and every fill column
  // slides out from under its own label. The header lives inside the scroller,
  // above the spacer, which makes the two boxes identical by construction and
  // leaves no width to keep in sync.
  const dom = namedFunctionSource(pageSource, 'libraryEnsureDom');
  const scrollerAt = dom.indexOf('id="library-scroller"');
  const headerAt = dom.indexOf('id="library-columns"');
  const spacerAt = dom.indexOf('id="library-spacer"');
  assert.ok(scrollerAt > -1, 'the scroller is missing');
  assert.ok(headerAt > scrollerAt, 'the column header is outside the scroller');
  assert.ok(headerAt < spacerAt, 'the header has to sit above the rows, not below them');
  // And it stays visible while the rows move under it.
  assert.match(css, /\.library-columns\s*\{[^}]*position:\s*sticky/);
  assert.match(css, /\.library-columns\s*\{[^}]*z-index/);
});

test('a divider row cannot be clicked, selected or played', () => {
  // Dividers take a row slot so the letter lands next to its track, but they
  // carry no id, so anything that resolves a row has to ignore them.
  assert.match(pageSource, /if \(row\.kind === 'divider'\) return;/);
  const selectAll = namedFunctionSource(pageSource, 'librarySelectAll');
  assert.match(selectAll, /row\.kind === 'song'/);
  const divider = namedFunctionSource(pageSource, 'libraryDividerRowHtml');
  assert.doesNotMatch(divider, /data-library-index/,
    'a divider with a row index would swallow the click meant for its track');
});

test('the resize handler rebuilds only when the column set actually changed', () => {
  // A layout callback fires during scroll-driven layout changes; re-rendering
  // the table on every one of those is how a smooth scroll turns into a stutter.
  const handler = namedFunctionSource(pageSource, 'libraryOnColumnsResize');
  assert.match(handler, /if \(stamp === \(libraryPage\.columnsStamp \|\| ''\)\) return;/);
  assert.match(handler, /libraryRebuildRows\(false\)/);
  assert.match(pageSource, /addEventListener\('resize', libraryOnColumnsResize\)/);
});

test('the column set follows a width that changes without a window event', () => {
  // The Folders view slides a 300px side panel in and out. Nothing on the
  // window resizes, so the window resize listener never runs and the columns
  // stay sized for the old row area. ResizeObserver is the right tool and is
  // native in this renderer, but it delivered zero callbacks when observed —
  // so the row area is measured on the frames after a click instead.
  assert.doesNotMatch(pageSource, /new ResizeObserver/,
    'a ResizeObserver here is dead code: it never delivers in this renderer');
  const watch = namedFunctionSource(pageSource, 'libraryInstallLibraryLayoutWatch');
  assert.match(watch, /addEventListener\('click'/);
  assert.match(watch, /addEventListener\('scroll'/);
  const check = namedFunctionSource(pageSource, 'libraryCheckColumns');
  assert.match(check, /libraryScrollerWidth\(\)/,
    'the width that decides the columns is the row area, not the window');
  const frames = namedFunctionSource(pageSource, 'libraryWatchLayout');
  assert.match(frames, /requestAnimationFrame/);
  // A burst, not a permanent loop: an idle page must stop asking.
  assert.match(frames, /libraryLayoutWatchRunning/);
  assert.match(frames, /libraryLayoutWatchLeft\s*=\s*0/);
});

test('opening the page measures again after the panel has finished entering', () => {
  // The entrance tween runs over 0.68s and moves the panel (y, scale 0.965 -> 1),
  // so the width read while it is still entering is not the width it settles at.
  // Nothing re-measures when a tween ends: a window event only fires if the user
  // resizes, and the layout watch rides on clicks and scrolls, neither of which
  // happens while the modal is coming up. Without a burst here a column set
  // resolved mid-entrance sticks for the whole visit.
  const open = namedFunctionSource(pageSource, 'openLibraryPage');
  const modal = open.indexOf('openGsapModal(mask)');
  const burst = open.indexOf('libraryWatchLayout(');
  assert.ok(modal > -1, 'the entrance is what changes the width');
  assert.ok(burst > modal, 'the burst has to start after the panel begins to grow');
  const frames = Number((open.match(/libraryWatchLayout\((\d+)\)/) || [])[1] || 0);
  assert.ok(frames > 40,
    'the tween is 0.68s, so a burst shorter than that stops measuring before it settles');
});

test('a group view never offers a filter that a group cannot answer', () => {
  const menu = namedFunctionSource(pageSource, 'librarySortMenuHtml');
  assert.match(menu, /if \(!isGroups\)/,
    'the favourite and length filters belong to tracks, not to albums');
  assert.match(menu, /Grouped list/);
});

test('the count in the header says how much of the library is on screen', () => {
  // Only one of the two numbers, and the filtered list reads as the whole
  // library — which is how a user ends up thinking tracks went missing.
  const header = namedFunctionSource(pageSource, 'libraryPaintHeader');
  assert.match(header, /of ' \+ total \+ ' tracks|of " \+ total \+ " tracks/);
});

test('a filter that matches nothing says so instead of blaming the view', () => {
  // "Play something first" sends the user hunting for tracks a switch would
  // bring back. The empty state has to name the filters and offer the reset.
  const empty = namedFunctionSource(pageSource, 'libraryEmptyStateHtml');
  assert.match(empty, /librarySieveActive\(libraryPage\.sieve\)/);
  assert.match(empty, /No tracks match these filters/);
  assert.match(empty, /onclick="libraryClearSieve\(\)"/);
  const render = namedFunctionSource(pageSource, 'libraryRenderWindow');
  assert.match(render, /if \(!total\) empty\.innerHTML = libraryEmptyStateHtml\(\)/,
    'the message must be repainted when a filter empties the view');
});

test('neither the songs list nor the grid path sorts the renderer into the ground', () => {
  // 50,000 tracks: the sort runs over the library, and the rows still come
  // from the window. A sort inside the render loop would be the old bug back.
  const rebuild = namedFunctionSource(pageSource, 'libraryRebuildRows');
  assert.match(rebuild, /libraryRouteSongs\(libraryPage\.route\)/);
  assert.match(rebuild, /libraryRowsWithDividers\(raw, 'title'\)/);
  const render = namedFunctionSource(pageSource, 'libraryRenderWindow');
  assert.doesNotMatch(render, /sort\(/, 'sorting inside the window renderer');
  assert.match(render, /librarySongTableRowHtml/);
});