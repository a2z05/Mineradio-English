'use strict';
// The library had tracks but no place to stand: no page over it, no grouping,
// no favourites view, no playlists that survived a restart. These tests cover
// the renderer half — the entry point, the views, the search that must work off
// a cached index instead of a 50k row list, and the two things that must never
// happen quietly: writing tags without consent, and a context-menu item that
// paints a label and then does nothing when it is clicked.

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
const menuSource = read('public/js/modules/13-library/02-library-context-menu.js');
const playlistSource = read('public/js/modules/13-library/03-library-playlists.js');
const editorSource = read('public/js/modules/13-library/04-metadata-editor.js');
const transferSource = read('public/js/modules/13-library/05-library-transfer.js');
const startupSource = read('public/js/modules/10-shell/05-startup-bindings.js');
const loaderSource = read('public/js/index-loader.js');
const html = read('public/index.html');
const css = read('public/css/library-page.css');

const STORE_NAMES = [
  'invalidateLocalLibraryIndex', 'localFileIdOf', 'localLibrarySongKey',
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
];

function makeSong(id, over) {
  return Object.assign({
    localFileId: id,
    localKey: id,
    localUrl: 'mineradio-local://' + id,
    // localPath is the path relative to its music folder, always '/'-separated —
    // that is what the grouping keys are cut from.
    localPath: 'Singles/Track ' + id + '.flac',
    name: 'Track ' + id,
    artist: 'Artist ' + id,
    album: 'Album ' + id,
    albumArtist: 'Artist ' + id,
    genre: 'Rock',
    year: 2021,
    composer: '',
    duration: 180,
    addedAt: 0,
  }, over || {});
}

// A sandbox seeded with a store and the globals the extracted functions lean
// on. Everything they call through is either real (from the source) or a stub
// the test asserts against.
function seed(tracks, userData, extra) {
  const sandbox = Object.assign({
    console,
    window: { desktopWindow: null },
    persistentLocalLibraryTracks: [],
    hydrateCustomCover: (song) => song,
    cloneSong: (song) => Object.assign({}, song),
    songCoverSrc: () => '',
    toasts: [],
    showToast(message) { sandbox.toasts.push(message); },
    // Values built inside the vm belong to a different realm, so an array that
    // is element-for-element equal still fails deepStrictEqual against a host
    // array. Every assertion pulls them back across first.
    host: (value) => (Array.isArray(value) ? Array.from(value, (item) => (item && typeof item === 'object' ? Object.assign(Array.isArray(item) ? [] : {}, item) : item)) : value),
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
    libraryPage: {
      open: false, view: 'songs', query: '', rows: [], songs: [],
      rowHeight: 54, scrollTop: 0, loading: false, scanning: false, scanAt: 0,
      selection: {}, selectedOrder: [], anchor: -1, drill: null, drillStamp: 0, status: '',
    },
  }, extra || {});
  vm.runInNewContext(
    STORE_NAMES.map((n) => namedFunctionSource(storeSource, n)).join('\n')
      + '\n' + varBlock(storeSource, 'LIBRARY_VIEWS'),
    sandbox
  );
  // The sort/filter module ships whole: it declares its own column tables and
  // its own route cache, and pulling it apart name by name would mean the
  // constants the page leans on were never seeded at all.
  vm.runInNewContext(viewsSource, sandbox);
  return sandbox;
}

// Pull a `var X = [...]` declaration out the same way namedFunctionSource
// pulls a function: the view table is data, not behaviour, but the page still
// needs it to answer "what is this view called".
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

// ---------------------------------------------------------------- entry point

test('the import hub opens the library page, and the page is registered', () => {
  assert.match(html, /id="local-library-page-choice"[^>]*onclick="openLibraryPage\(\)"/);
  assert.match(html, /href="css\/library-page\.css/);
  for (const name of ['00-local-library-store', '01-library-page', '02-library-context-menu',
    '03-library-playlists', '04-metadata-editor', '05-library-transfer']) {
    assert.match(loaderSource, new RegExp(`'js/modules/13-library/${name}\\.js'`),
      `${name} must be registered or its onclick is a dead control`);
  }
  // Cached before the first open: three IPC round-trips while the modal is up
  // is exactly the freeze this page exists to avoid.
  assert.match(startupSource, /hydrateLocalLibraryStore\(\)/);
  assert.match(startupSource, /libraryPaintPlaylistPane\(\)/);
  // The styling ships as its own file — a heredoc append into an 18k-line
  // stylesheet is the kind of write that silently never lands.
  assert.match(css, /\.library-page-mask/);
  assert.match(css, /\.library-context-menu\.show/);
  assert.match(css, /\.local-playlist-block/);
});

// ---------------------------------------------------------------- views

test('every view the nav promises is backed by real rows', () => {
  const sandbox = seed([
    makeSong('a', { addedAt: 3, name: 'Alpha' }),
    makeSong('b', {
      addedAt: 1, name: 'Beta',
      localPath: 'Album One/Beta.flac',
      relativePath: 'Album One/Beta.flac',
    }),
    makeSong('c', { addedAt: 2, name: 'Gamma', genre: 'Jazz' }),
  ], {
    songs: {
      a: { favorite: true, rating: 5, plays: 4, skips: 0, completed: 4, lastPlayedAt: 90 },
      b: { favorite: false, rating: 3, plays: 1, skips: 2, completed: 0, lastPlayedAt: 10 },
      c: { favorite: false, rating: 0, plays: 0, skips: 0, completed: 0, lastPlayedAt: 0 },
    },
    playlists: [],
  });

  const rowIds = (view) => Array.from(sandbox.libraryViewRows(view), (song) => song.localFileId);
  const groupKeys = (view) => Array.from(sandbox.libraryViewRows(view), (g) => g.key);

  assert.deepEqual(rowIds('songs'), ['a', 'b', 'c'], 'Songs is title order, not disk order');
  assert.deepEqual(rowIds('favorites'), ['a']);
  assert.deepEqual(rowIds('top-rated'), ['a', 'b'], 'rating decides the order, not the title');
  assert.deepEqual(rowIds('most-played'), ['a', 'b']);
  assert.deepEqual(rowIds('recent-played'), ['a', 'b'],
    'a track that was never played does not belong in Recently played');
  assert.deepEqual(rowIds('recent-added'), ['a', 'c', 'b'], 'newest first');

  // Grouping is where the folder work shows: one relative path, one group.
  assert.equal(sandbox.libraryViewMeta('folders').kind, 'groups');
  assert.deepEqual(groupKeys('folders'), ['Album One', 'Singles']);
  assert.deepEqual(groupKeys('albums'), ['Album a', 'Album b', 'Album c']);
  assert.deepEqual(groupKeys('genres'), ['Jazz', 'Rock']);
  assert.deepEqual(groupKeys('artists'), ['Artist a', 'Artist b', 'Artist c']);

  // An unknown id falls back to Songs instead of an empty page that reads as
  // "the library was wiped".
  assert.equal(sandbox.libraryViewRows('nope').length, 3);
  assert.equal(sandbox.libraryViewMeta('nope').id, 'songs');
});

// The sidebar is the only way to reach nine of the eleven views, and it was the
// one control in the modal with no handler on it: the buttons painted a label
// and a count and then absorbed every click. That reads as working right up
// until somebody clicks Albums and nothing happens, so the markup is the
// contract — each button has to carry the call itself, like every other button
// in this modal does.
test('every view in the sidebar nav is wired to actually switch', () => {
  // varBlock only parses array and object literals, and this key is a string.
  const viewStorageKey = /^var LIBRARY_PAGE_STORAGE_KEY = '([^']+)';?$/m.exec(pageSource);
  assert.ok(viewStorageKey, 'the library no longer remembers which view it was on');

  const sandbox = seed([makeSong('a')], undefined, {
    escHtml: (value) => String(value),
    libraryPaintNav() {},
    libraryRebuildRows() {},
    librarySyncFolderPane() {},
    libraryPlaylists: () => [],
    LIBRARY_PAGE_STORAGE_KEY: viewStorageKey[1],
  });
  sandbox.window.localStorage = { setItem() {} };
  vm.runInNewContext(
    ['libraryNavHtml', 'libraryViewCount', 'librarySetView']
      .map((name) => namedFunctionSource(pageSource, name)).join('\n'),
    sandbox
  );

  const navHtml = sandbox.libraryNavHtml();
  const buttons = navHtml.match(/<button[^>]*>/g) || [];
  assert.equal(buttons.length, sandbox.LIBRARY_VIEWS.length,
    'the nav renders one button per view');

  for (const view of sandbox.LIBRARY_VIEWS) {
    const button = buttons.find((tag) => tag.includes(`data-library-view="${view.id}"`));
    assert.ok(button, `no button rendered for ${view.id}`);
    assert.ok(button.includes(`onclick="librarySetView('${view.id}')"`),
      `${view.label} renders a button nobody listens to`);
  }

  // And the call they make has to be the one that moves the page.
  sandbox.librarySetView('albums');
  assert.equal(sandbox.libraryPage.view, 'albums');
  assert.equal(sandbox.libraryPage.drill, null, 'switching views drops any drill-down');
});

// The badge beside each view label is the only number the sidebar states, and
// it was echoing the track total for every grouped view: Albums read 984 on the
// same screen whose crumb above the rows read 370 groups. A count that
// contradicts the list directly under it is a number nobody can check, so a
// grouped view has to report the length of the rows it is about to paint.
test('a grouped view badge counts groups, not tracks', () => {
  const sandbox = seed([
    makeSong('a', { album: 'Album a' }),
    makeSong('b', { album: 'Album a' }),
    makeSong('c', { album: 'Album c' }),
  ], undefined, { libraryPlaylists: () => [] });
  vm.runInNewContext(namedFunctionSource(pageSource, 'libraryViewCount'), sandbox);

  const grouped = sandbox.LIBRARY_VIEWS.filter((view) => view.kind === 'groups');
  assert.ok(grouped.length >= 4, 'the grouped views are gone');
  assert.notEqual(sandbox.libraryViewCount('albums'), String(3),
    'seed check: Albums is two groups over three tracks, so a track total would be visible');

  for (const view of grouped) {
    const rows = sandbox.libraryViewRows(view.id).length;
    assert.equal(sandbox.libraryViewCount(view.id), String(rows),
      `${view.label} badge reports the track total beside a ${rows}-row list`);
  }

  // Songs and recent-added are both "every track", and reaching that number
  // through libraryViewRows would sort the whole library on every nav repaint —
  // which is the one place a 50k library would pay for a badge.
  assert.equal(sandbox.libraryViewCount('songs'), '3');
  assert.equal(sandbox.libraryViewCount('recent-added'), '3');
});

// The pane sync and the folder browser reach for the same node under two
// different names. When the sync's name matches no element it returns before it
// can hide anything, so the tree never gets installed and every other view
// keeps a dead column the CSS was written to collapse.
test('the folder pane sync looks up a node this page actually builds', () => {
  const syncBody = namedFunctionSource(pageSource, 'librarySyncFolderPane');
  const lookups = Array.from(syncBody.matchAll(/getElementById\('([^']+)'\)/g), (hit) => hit[1]);
  assert.ok(lookups.length, 'librarySyncFolderPane stopped looking up its pane at all');

  for (const id of lookups) {
    assert.ok(pageSource.includes(`id="${id}"`),
      `librarySyncFolderPane asks for #${id}, but the markup builds `
      + `${(pageSource.match(/id="[^"]*folders[^"]*"/) || ['no folders id'])[0]}`);
  }

  // And it has to be the node the folder browser installs into, or hiding one
  // element and filling another leaves an empty column beside the rows.
  const host = /getElementById\('([^']+)'\)/.exec(
    namedFunctionSource(read('public/js/modules/13-library/07-library-folder-browser.js'),
      'libraryInstallFolderBrowser'));
  assert.ok(host, 'the folder browser no longer names its host');
  assert.ok(lookups.includes(host[1]),
    `librarySyncFolderPane manages #${lookups.join(', #')} but the tree installs into #${host[1]}`);
});

test('search ranks a tight match above a scattered one', () => {
  const sandbox = seed([makeSong('a')]);
  const score = sandbox.localLibraryScoreMatch;

  assert.equal(score('greatest hits', 'greatest hits'), 1000, 'an exact hit outranks everything');
  assert.ok(score('hits of greatest', 'hits') > score('greatest hits', 'hits'),
    'a leading match beats one buried mid-string');
  assert.ok(score('greatest hits', 'grt hits') > score('greatest hits', 'g r e a t'),
    'a consecutive run beats letters found scattered');
  assert.equal(score('greatest hits', 'zzz'), 0,
    'letters that are not there score nothing, so the row drops out of the list');
  assert.equal(score('anything', ''), 1, 'an empty query keeps everything');
});

test('the search checks every field a person would actually type', () => {
  const sandbox = seed([
    makeSong('a', { name: 'Helplessness Blues', artist: 'Fleet Foxes', album: 'Helplessness Blues' }),
    makeSong('b', { name: 'Somebody That I Used to Know', artist: 'Gotye', genre: 'Indie', composer: 'Wally De Backer' }),
    makeSong('c', { name: 'Untitled', artist: 'Nobody', album: 'Nowhere', genre: 'Ambient' }),
  ]);

  const names = (query) => Array.from(sandbox.librarySearchTracks(query), (song) => song.name);
  assert.deepEqual(names('fleet'), ['Helplessness Blues'], 'artist is searchable, not just the title');
  assert.deepEqual(names('indie'), ['Somebody That I Used to Know'], 'genre too');
  assert.deepEqual(names('backer'), ['Somebody That I Used to Know'], 'composer too');
  assert.equal(names('helpless blues').length, 1, 'every term has to match, not just one of them');
  assert.deepEqual(names('zzz nothing'), [], 'a term nothing matches empties the result');
  assert.equal(names('').length, 3, 'an empty query is the whole library, sorted');

  // Album and artist names come back as groups, so a search for the artist can
  // offer the artist row alongside the songs beneath it.
  assert.deepEqual(Array.from(sandbox.libraryGroupTracks('gotye'), (g) => g.key), ['Gotye']);
  assert.equal(sandbox.libraryGroupTracks(''), null,
    'an idle box offers no groups at all, rather than forty of them');
});

// ---------------------------------------------------------------- favourites / counters

test('a favourite is adopted from the answer, not guessed in the renderer', async () => {
  const calls = [];
  const sandbox = seed([makeSong('a')]);
  sandbox.window.desktopWindow = {
    setLocalLibraryUser: async (request) => {
      calls.push(request);
      if (request.action === 'rating') return { ok: true, changed: true, rating: Math.min(5, request.value) };
      return { ok: true, changed: true, favorite: request.value !== false, rating: 0 };
    },
  };

  const song = sandbox.localLibraryStore.tracks[0];
  await sandbox.librarySetFavorite(song, true);
  assert.equal(calls[0].action, 'favorite');
  assert.equal(calls[0].id, 'a', 'the store keys everything by the id the main process knows');
  assert.equal(sandbox.localLibraryStore.userData.songs.a.favorite, true,
    'the cache adopts the answer, so the star lights on the same frame');
  assert.equal(sandbox.localLibraryIsFavorite(song), true);

  await sandbox.librarySetRating(song, 7);
  assert.equal(sandbox.localLibraryStore.userData.songs.a.rating, 5,
    'a rating past five is clamped before it is cached');

  // Counters are recorded from the playback start path; a dead bridge there
  // must never take playback down with it.
  sandbox.window.desktopWindow.setLocalLibraryUser = async () => { throw new Error('bridge down'); };
  assert.equal(await sandbox.libraryRecordPlaybackEvent(song, 'play'), null,
    'a dead bridge returns null instead of throwing');

  sandbox.window.desktopWindow = {};
  assert.equal(await sandbox.libraryRecordPlaybackEvent(song, 'play'), null,
    'the browser preview has no bridge and must not crash');
  assert.equal(await sandbox.librarySetFavorite(song, true), null);
});

// ---------------------------------------------------------------- playlists

test('playlist operations go to the main process and adopt its answer', async () => {
  const ops = [];
  const sandbox = seed([makeSong('a')]);
  sandbox.window.desktopWindow = {
    localPlaylistOp: async (request) => {
      ops.push(request);
      if (request.op === 'create') {
        return { ok: true, playlists: [{ id: 'p1', name: request.name, tracks: [] }] };
      }
      return { ok: true, playlists: [{ id: 'p1', name: request.name || 'Road trip', tracks: ['a'] }] };
    },
  };
  sandbox.painted = 0;
  vm.runInNewContext(
    [
      ...['libraryPlaylists', 'libraryFindPlaylist', 'libraryAdoptPlaylistResult',
        'libraryCleanTrackIds', 'libraryPlaylistCreate', 'libraryPlaylistAddTracks',
        'libraryPlaylistRemoveTracks', 'libraryPlaylistRename', 'libraryPlaylistDelete',
        'libraryPlaylistDuplicate', 'libraryPlaylistReorder'].map((n) => namedFunctionSource(playlistSource, n)),
      'function libraryPaintPlaylistPane() { this.painted += 1; }',
    ].join('\n'),
    sandbox
  );

  const created = await sandbox.libraryPlaylistCreate('Road trip');
  assert.deepEqual(Array.from(created.playlists, (p) => p.name), ['Road trip']);
  assert.equal(sandbox.libraryPlaylists().length, 1,
    'the store holds it straight away, so the page and the sidebar agree');
  assert.equal(ops[0].op, 'create');
  assert.ok(sandbox.painted >= 1, 'the sidebar block repaints after every mutation');

  await sandbox.libraryPlaylistAddTracks('p1', ['a', '']);
  assert.equal(ops[1].op, 'add');
  assert.deepEqual(Array.from(ops[1].trackIds), ['a'],
    'an empty id never crosses the bridge — it would play as silence');

  await sandbox.libraryPlaylistRename('p1', 'Renamed');
  assert.equal(ops[2].op, 'rename');
  assert.equal(sandbox.libraryFindPlaylist('p1').name, 'Renamed');
  assert.equal(sandbox.libraryFindPlaylist('nope'), null);
});

test('no bridge means a message, not a thrown TypeError', async () => {
  const sandbox = seed([]);
  sandbox.window.desktopWindow = {};
  vm.runInNewContext(
    ['libraryPlaylists', 'libraryAdoptPlaylistResult', 'libraryPlaylistCreate']
      .map((n) => namedFunctionSource(playlistSource, n))
      .concat(['function libraryPaintPlaylistPane() {}'])
      .join('\n'),
    sandbox
  );

  assert.equal(await sandbox.libraryPlaylistCreate('Anything'), null);
  assert.match(sandbox.toasts[0], /desktop app/);
});

// ---------------------------------------------------------------- metadata editor

test('the editor reports a change only when a field really moved', () => {
  const sandbox = seed([]);
  sandbox.window.confirm = () => true;
  vm.runInNewContext(
    [
      namedFunctionSource(editorSource, 'libraryMetadataChanges'),
      namedFunctionSource(editorSource, 'canWriteTagsFor'),
      `var LIBRARY_EDITOR_FIELDS = ${JSON.stringify([
        ['name', 'Title'], ['artist', 'Artist'], ['album', 'Album'], ['albumArtist', 'Album artist'],
        ['genre', 'Genre'], ['year', 'Year', true], ['track', 'Track', true],
        ['disc', 'Disc', true], ['composer', 'Composer'], ['comment', 'Comment'],
      ]).replace(/\],\[/g, '],[')
        .replace(/\["(\w+)","([^"]+)",true\]/g, '{ key: "$1", label: "$2", numeric: true }')
        .replace(/\["(\w+)","([^"]+)"\]/g, '{ key: "$1", label: "$2" }')};`,
    ].join('\n'),
    sandbox
  );

  assert.equal(sandbox.canWriteTagsFor({ localPath: 'C:/a/b.mp3' }), 'mp3');
  assert.equal(sandbox.canWriteTagsFor({ localPath: 'C:/a/b.flac' }), 'flac');
  assert.equal(sandbox.canWriteTagsFor({ localPath: 'C:/a/b.m4a' }), '',
    'a container that cannot be rewritten does not claim it can be');
  assert.equal(sandbox.canWriteTagsFor({ name: 'a stream' }), '');

  const blank = { artist: '', album: '', albumArtist: '', genre: '', year: '2001',
    track: '', disc: '', composer: '', comment: '' };
  sandbox.libraryEditorState = {
    songs: [{ localPath: 'C:/a/b.mp3' }],
    baseline: Object.assign({ name: 'Old title' }, blank),
    draft: Object.assign({ name: 'New title' }, blank),
  };
  const changes = sandbox.libraryMetadataChanges();
  assert.equal(changes.length, 1, 'untouched fields are not offered as changes');
  assert.equal(changes[0].before, 'Old title');
  assert.equal(changes[0].after, 'New title');

  // A typo'd year is caught before it reaches the file, not after.
  sandbox.libraryEditorState.draft.year = 'twenty';
  sandbox.libraryEditorState.draft.track = '99999';
  const clamped = sandbox.libraryMetadataChanges();
  const byKey = (key) => clamped.filter((c) => c.field.key === key)[0];
  assert.equal(byKey('year').after, '', 'a non-numeric year becomes empty rather than "twenty"');
  assert.equal(byKey('track').after, '9999', 'a track number is clamped into range');
});

// 0 is how "no year", "no track number" and "no disc" are stored — 923 of 984
// tracks in a real library. Reading it back through String() made the baseline
// "0" while libraryMetadataChanges normalises "0" to "", so every one of those
// tracks offered three changes nobody made, and saving a title rewrite also
// wrote year=0, track=0 and disc=0 into the file.
test('an unset numeric field starts empty, not zero', () => {
  const sandbox = seed([]);
  vm.runInNewContext(
    [
      namedFunctionSource(editorSource, 'libraryEditorBaselineValue'),
      namedFunctionSource(editorSource, 'libraryMetadataChanges'),
      `var LIBRARY_EDITOR_FIELDS = ${JSON.stringify([
        ['name', 'Title'], ['artist', 'Artist'], ['album', 'Album'], ['albumArtist', 'Album artist'],
        ['genre', 'Genre'], ['year', 'Year', true], ['track', 'Track', true],
        ['disc', 'Disc', true], ['composer', 'Composer'], ['comment', 'Comment'],
      ]).replace(/\],\[/g, '],[')
        .replace(/\["(\w+)","([^"]+)",true\]/g, '{ key: "$1", label: "$2", numeric: true }')
        .replace(/\["(\w+)","([^"]+)"\]/g, '{ key: "$1", label: "$2" }')};`,
      'var libraryEditorState = { songs: [], draft: {}, baseline: {} };',
    ].join('\n'),
    sandbox
  );

  const fields = sandbox.LIBRARY_EDITOR_FIELDS;
  const year = fields.filter((f) => f.key === 'year')[0];
  const title = fields.filter((f) => f.key === 'name')[0];
  assert.equal(sandbox.libraryEditorBaselineValue(year, 0), '');
  assert.equal(sandbox.libraryEditorBaselineValue(year, '0'), '');
  assert.equal(sandbox.libraryEditorBaselineValue(year, undefined), '');
  assert.equal(sandbox.libraryEditorBaselineValue(year, null), '');
  assert.equal(sandbox.libraryEditorBaselineValue(year, 2011), '2011');
  // A title that is literally 0 is a title — only the numeric fields lose it.
  assert.equal(sandbox.libraryEditorBaselineValue(title, 0), '0');
  assert.equal(sandbox.libraryEditorBaselineValue(title, 'Faint'), 'Faint');

  // The whole open-then-edit path: a track with no tags at all reports nothing
  // to save, and editing the title alone reports exactly one change.
  const untagged = {};
  for (let i = 0; i < fields.length; i += 1) {
    const field = fields[i];
    untagged[field.key] = sandbox.libraryEditorBaselineValue(
      field, field.numeric ? 0 : ''
    );
  }
  sandbox.libraryEditorState = {
    songs: [{ localPath: 'C:/a/b.mp3' }],
    baseline: untagged,
    draft: Object.assign({}, untagged),
  };
  assert.equal(sandbox.libraryMetadataChanges().length, 0,
    'a track with no year, track or disc tags has nothing to write');

  sandbox.libraryEditorState.draft.name = 'Rewritten title';
  const changes = sandbox.libraryMetadataChanges();
  assert.equal(changes.length, 1, 'editing the title must not drag year=0, track=0 and disc=0 along');
  assert.equal(changes[0].field.key, 'name');
});

test('the write path states the change and the bridge needs the opt-in', async () => {
  const writes = [];
  const sandbox = seed([]);
  sandbox.window.desktopWindow = {
    writeLocalMusicTags: async (id, fields, optIn) => {
      writes.push({ id, fields, optIn });
      return { ok: true, tracks: [] };
    },
  };
  sandbox.window.confirm = () => true;
  sandbox.written = 0;
  sandbox.closed = 0;
  vm.runInNewContext(
    [
      namedFunctionSource(editorSource, 'libraryMetadataChanges'),
      namedFunctionSource(editorSource, 'librarySaveMetadata'),
      `var LIBRARY_EDITOR_FIELDS = [
        { key: 'name', label: 'Title' }, { key: 'artist', label: 'Artist' },
        { key: 'album', label: 'Album' }, { key: 'albumArtist', label: 'Album artist' },
        { key: 'genre', label: 'Genre' }, { key: 'year', label: 'Year', numeric: true },
        { key: 'track', label: 'Track', numeric: true }, { key: 'disc', label: 'Disc', numeric: true },
        { key: 'composer', label: 'Composer' }, { key: 'comment', label: 'Comment' }
      ];`,
      'function canWriteTagsFor(song) { return /\\.mp3$/i.test(song.localPath || "") ? "mp3" : ""; }',
      'function localFileIdOf(s) { return String(s.localFileId || ""); }',
      'function setLocalLibraryStoreTracks() { this.written += 1; }',
      'function libraryPaintNav() {}',
      'function libraryRebuildRows() {}',
      'function closeLibraryMetadataEditor() { this.closed += 1; }',
    ].join('\n'),
    sandbox
  );

  const baseline = { name: 'Same', artist: '', album: '', albumArtist: '', genre: '',
    year: '', track: '', disc: '', composer: '', comment: '' };
  const song = { localFileId: 'a', localPath: 'C:/a.ogg', name: 'Same' };
  sandbox.libraryEditorState = {
    songs: [song],
    baseline: Object.assign({}, baseline),
    draft: Object.assign({}, baseline),
  };

  // Nothing changed: no confirm, no write.
  await sandbox.librarySaveMetadata();
  assert.equal(writes.length, 0);
  assert.match(sandbox.toasts[0], /Nothing changed/);

  // A change on a format that cannot hold it: refused before the confirm.
  sandbox.libraryEditorState.draft.name = 'Renamed';
  await sandbox.librarySaveMetadata();
  assert.equal(writes.length, 0, 'no write was even offered');
  assert.match(sandbox.toasts[1], /MP3 and FLAC/);
  assert.equal(sandbox.confirmFor, undefined, 'the user was never asked to approve a no-op');

  // The real thing: the id, the payload, and the consent flag.
  song.localPath = 'C:/a.mp3';
  await sandbox.librarySaveMetadata();
  assert.equal(writes.length, 1);
  assert.equal(writes[0].id, 'a');
  assert.equal(writes[0].fields.name, 'Renamed');
  assert.equal(writes[0].optIn, true, 'the main process rejects the call without it');
  assert.ok(sandbox.written > 0 && sandbox.closed === 1, 'the row reloads, then the dialog closes');
});

// ---------------------------------------------------------------- transfer

test('exporting a playlist sends ids, never paths', async () => {
  const sandbox = seed([makeSong('a'), makeSong('b')]);
  sandbox.window.desktopWindow = {
    exportLocalLibraryM3u: async (ids) => { sandbox.exported = ids; return { ok: true, count: ids.length, text: '#EXTM3U' }; },
    exportTextFile: async (payload) => { sandbox.textPayload = payload; return { ok: true }; },
  };
  vm.runInNewContext(
    [...['libraryCurrentM3uIds', 'libraryExportM3u'].map((n) => namedFunctionSource(transferSource, n)),
      `var LIBRARY_VIEWS = [{ id: 'songs', label: 'Songs', kind: 'songs' }];`,
      'function libraryViewMeta() { return LIBRARY_VIEWS[0]; }'].join('\n'),
    sandbox
  );

  // A selection wins, so "export" means the rows the user is looking at.
  sandbox.libraryPage.selectedOrder = ['b'];
  sandbox.libraryPage.songs = sandbox.localLibraryStore.tracks;
  await sandbox.libraryExportM3u();
  assert.deepEqual(sandbox.exported, ['b'], 'the bridge builds the paths from ids, not the renderer');
  assert.equal(sandbox.textPayload.extension, 'm3u8',
    'the extension is what keeps the saved file from becoming .txt');
});

test('restoring refuses a file that is not one of ours', async () => {
  const sandbox = seed([]);
  sandbox.window.desktopWindow = {
    importJsonFile: async () => sandbox.pick,
    restoreLocalLibraryUserData: async (payload, replace) => {
      sandbox.restored = { payload, replace };
      return { ok: true, songs: {}, playlists: [], tracks: [] };
    },
  };
  vm.runInNewContext(
    [namedFunctionSource(transferSource, 'libraryRestoreUserData'),
      'function localLibrarySetUserData() {}',
      'function setLocalLibraryStoreTracks() {}',
      'function libraryPaintPlaylistPane() {}',
      'function libraryPaintNav() {}',
      'function libraryRebuildRows() {}',
      // The settings half is covered on its own in
      // library-transfer-settings-backup.test.js; here it only has to exist.
      'function librarySettingsApply() { return 0; }'].join('\n'),
    sandbox
  );

  // Truncated / non-JSON: caught in the renderer, before any bridge call.
  sandbox.pick = { text: '{ not json' };
  await sandbox.libraryRestoreUserData(false);
  assert.equal(sandbox.restored, undefined, 'an unreadable file never reaches the bridge');
  assert.match(sandbox.toasts.pop(), /not a Mineradio backup/);

  // A well-formed JSON file of some other app's: also refused.
  sandbox.pick = { text: JSON.stringify({ kind: 'someone-elses-backup' }) };
  await sandbox.libraryRestoreUserData(false);
  assert.equal(sandbox.restored, undefined);
  assert.match(sandbox.toasts.pop(), /not a Mineradio backup/);

  // Ours does go through, carrying the replace flag the user chose.
  sandbox.pick = { text: JSON.stringify({ kind: 'mineradio-local-library', songs: {}, playlists: [] }) };
  await sandbox.libraryRestoreUserData(true);
  assert.equal(sandbox.restored.replace, true);

  // And a cancelled picker changes nothing at all.
  sandbox.restored = undefined;
  sandbox.pick = { canceled: true };
  await sandbox.libraryRestoreUserData(true);
  assert.equal(sandbox.restored, undefined);
});

test('clearing history keeps what the user chose to keep', async () => {
  const sandbox = seed([makeSong('a')], {
    songs: { a: { favorite: true, rating: 5, plays: 9, skips: 3, completed: 7, lastPlayedAt: 11 } },
    playlists: [{ id: 'p1', name: 'Keep me', tracks: ['a'] }],
  });
  sandbox.window.desktopWindow = {
    setLocalLibraryUser: async (request) => {
      sandbox.clearRequest = request;
      return { ok: true };
    },
  };
  sandbox.window.confirm = () => true;
  vm.runInNewContext(
    [namedFunctionSource(transferSource, 'libraryClearHistory'),
      'function invalidateLocalLibraryIndex() { this.invalid = true; }',
      'function libraryPaintNav() {}',
      'function libraryRebuildRows() {}'].join('\n'),
    sandbox
  );

  await sandbox.libraryClearHistory();
  assert.equal(sandbox.clearRequest.action, 'clear-history');
  assert.equal(sandbox.clearRequest.id, '', 'one call for the whole library, not one per row');
  const entry = sandbox.localLibraryStore.userData.songs.a;
  assert.equal(entry.plays, 0);
  assert.equal(entry.lastPlayedAt, 0);
  assert.equal(entry.favorite, true, 'a favourite is a choice; a play count is not');
  assert.equal(entry.rating, 5, 'ratings survive — they were never history');
  assert.equal(sandbox.localLibraryStore.userData.playlists.length, 1);
  assert.ok(sandbox.invalid, 'the groupings are rebuilt so Most played is not stale');
});

// ---------------------------------------------------------------- menus

test('every context-menu item actually does something when clicked', () => {
  const sandbox = seed([makeSong('a')]);
  sandbox.invoked = [];
  const names = ['libraryMenuPlay', 'libraryMenuQueueAll', 'libraryMenuQueueNext',
    'libraryMenuAddToPlaylist', 'libraryMenuFavorite', 'libraryMenuRating',
    'libraryMenuEditMetadata', 'libraryMenuRevealFirst', 'libraryMenuRescan',
    'libraryMenuRemove'];
  vm.runInNewContext(
    [
      namedFunctionSource(menuSource, 'libraryMenuDispatch'),
      ...names.map((n) => `function ${n}() { this.invoked.push('${n}'); }`),
      'var libraryMenuState = { songs: [], group: null };',
    ].join('\n'),
    sandbox
  );

  // The labels are built as calls (`libraryMenuQueueNext()`), so the table has
  // to accept them as they are written. Before this, every item that carried a
  // `()` looked up a key that did not exist and quietly did nothing.
  const wanted = ['libraryMenuPlay(false)', 'libraryMenuPlay(true)', 'libraryMenuQueueNext()',
    'libraryMenuQueueAll()', 'libraryMenuAddToPlaylist()', 'libraryMenuFavorite(true)',
    'libraryMenuFavorite(false)', 'libraryMenuRating()', 'libraryMenuEditMetadata()',
    'libraryMenuRevealFirst()', 'libraryMenuRescan()', 'libraryMenuRemove()'];
  for (const name of wanted) {
    sandbox.invoked = [];
    sandbox.libraryMenuDispatch(name);
    assert.equal(sandbox.invoked.length, 1, `${name} painted a label but did not run`);
  }

  sandbox.invoked = [];
  sandbox.libraryMenuDispatch('not-a-real-action');
  assert.deepEqual(sandbox.invoked, [], 'an unknown name is a no-op, not a crash');
});

test('every literal the menu can paint is a key the dispatcher accepts', () => {
  // Checked at the source rather than by clicking: the items are built as
  // `libraryMenuQueueNext()`, and the table is keyed by whatever the author
  // typed. A mismatch between the two is invisible until someone clicks.
  const runs = new Set();
  let match;
  const pipeForm = /\|([A-Za-z0-9_]+\([^)]*\))'/g;
  while ((match = pipeForm.exec(menuSource))) runs.add(match[1]);
  const arrayForm = /\['[^']*',\s*'([A-Za-z0-9_]+\([^)]*\))'\]/g;
  while ((match = arrayForm.exec(menuSource))) runs.add(match[1]);
  assert.ok(runs.size >= 10, `only found ${runs.size} menu literals`);

  const tableBlock = /var table = \{([\s\S]*?)\n  \};/.exec(menuSource)[1];
  const keys = new Set();
  const keyPattern = /'([^']+)'\s*:/g;
  while ((match = keyPattern.exec(tableBlock))) keys.add(match[1]);

  for (const run of runs) {
    assert.ok(keys.has(run),
      `"${run}" is painted in the menu but is not a key the dispatcher accepts — it would do nothing when clicked`);
  }
});

test('a dragged track lands on a destination this page can actually reach', () => {
  // Every destination outside this page is unreachable while it is open. The
  // queue drawer sits inside #desktop-window-shell, whose transform makes a
  // stacking context that the full-screen mask covers for good — no z-index on
  // the drawer can lift it above a body-level 900 — and the folder tree only
  // exists in a view where no track row is draggable. So the destinations are
  // painted on this page and revealed for the length of the drag.
  assert.match(pageSource, /data-library-drop="queue"/);
  assert.match(pageSource, /data-library-drop="playlist"/);
  assert.match(pageSource, /id: 'library-drop-bar-queue'/);
  assert.match(pageSource, /id: 'library-drop-bar-playlist'/);
  assert.match(css, /^\.library-drop-bar \{[^}]*display: none/m,
    'the drop bar is permanent furniture, so it would sit under every list');
  assert.match(css, /^body\.library-dragging \.library-drop-bar \{[^}]*display: flex/m,
    'nothing reveals the drop bar, so a drag would have nowhere to land');

  // The class that reveals it is set here and nowhere else, and a reveal that
  // opens the drawer instead is dead code with a live side effect: it rewrites
  // the tab the user last chose for a drop that can never arrive.
  const start = namedFunctionSource(pageSource, 'libraryDragStartReveal');
  const end = namedFunctionSource(pageSource, 'libraryDragEndReveal');
  assert.match(start, /classList\.add\('library-dragging'\)/);
  assert.match(end, /classList\.remove\('library-dragging'\)/);
  assert.doesNotMatch(start, /playlist-panel|setPeek|switchPlaylistTab/,
    'libraryDragStartReveal still opens the queue drawer, which it cannot reach');
  assert.doesNotMatch(end, /closePlaylistPanelSoft|switchPlaylistTab/);
});

test('a modal opened from the library paints above it', () => {
  // Both are body-level .modal-mask elements at the shared 50, and the library
  // mask is 900 — so "Add to playlist" and "Edit metadata" opened a dialog
  // painted underneath the page that opened it, visible and unclickable.
  assert.match(css, /\.library-page-mask \{[^}]*z-index: 900/m);
  assert.match(css, /#library-metadata-modal,\s*#library-playlist-picker \{\s*z-index: 960;/,
    'the picker and the editor are below the library page they are opened from');
  assert.match(css, /^\.library-context-menu \{[^}]*z-index: 960/m,
    'the context menu is the precedent for clearing the library mask');
});

test('right-clicking a playlist row opens the playlist menu', () => {
  // The song menu falls through to row.song, which a playlist row does not
  // have — so without this branch right-clicking a playlist did nothing.
  const sandbox = seed([makeSong('a')]);
  sandbox.invoked = [];
  sandbox.document = { getElementById: () => null };
  sandbox.libraryRowAt = () => sandbox.row;
  vm.runInNewContext(
    [
      namedFunctionSource(menuSource, 'libraryOnRowContextMenu'),
      `function libraryShowPlaylistMenu(event, playlist) {
         this.invoked.push('playlist:' + (playlist && playlist.id));
       }`,
      `function libraryOpenContextMenu() { this.invoked.push('open'); }`,
    ].join('\n'),
    sandbox
  );

  const handle = { closest: () => handle, getAttribute: () => '0' };
  const event = { target: handle, preventDefault() {}, clientX: 10, clientY: 10 };

  sandbox.row = { kind: 'playlist', playlist: { id: 'p7' } };
  sandbox.libraryOnRowContextMenu(event);
  assert.equal(sandbox.invoked.join(','), 'playlist:p7',
    'a playlist row opened the generic menu instead');

  sandbox.invoked = [];
  sandbox.row = { kind: 'group', group: { title: 'Album' } };
  sandbox.libraryOnRowContextMenu(event);
  assert.equal(sandbox.invoked.join(','), 'open', 'a group row no longer opens its menu');
});
