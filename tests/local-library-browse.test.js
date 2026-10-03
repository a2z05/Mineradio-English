'use strict';
// The local library could be written to and restored from disk, but never
// looked at: the only reachable actions were "load everything into the queue"
// and "import more". A saved library was a pile you could only play from the
// top. These tests cover surfacing it as a browsable list in the results
// panel, through the same rows search uses.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { namedFunctionSource } = require('./helpers/extract-function');

const appRoot = path.resolve(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(appRoot, p), 'utf8');

const librarySource = read('public/js/modules/06-lyrics/07-local-library.js');
const uploadSource = read('public/js/modules/06-lyrics/05-upload-dragdrop.js');
const homeSource = read('public/js/modules/05-playback/03a-home-dashboard.js');
const startupSource = read('public/js/modules/10-shell/05-startup-bindings.js');
const loaderSource = read('public/js/index-loader.js');
const html = read('public/index.html');

test('the import hub offers a way in to the saved library', () => {
  // EN-FORK: the hub button used to open the flat results list. It now opens
  // the full Library browser, which is the thing that grew eleven views and is
  // the only way to reach albums, artists, genres, folders and playlists. The
  // flat list is still reachable from the home library card, so it is not dead
  // — it just stopped being what the main menu hands you first.
  assert.match(html, /id="local-library-choice"[^>]*onclick="openLibraryPage\(\)"/);
  assert.doesNotMatch(html, /id="local-library-choice"[^>]*openLocalLibraryResults/,
    'the main-menu button must not still point at the flat list');
  assert.match(html, /id="local-library-choice-sub"/,
    'the entry states how many tracks are saved, so it needs its own slot');
  assert.match(loaderSource, /'js\/modules\/06-lyrics\/07-local-library\.js'/,
    'the module has to be registered or the onclick is a dead control');
  // Whatever it opens has to be defined somewhere the renderer actually loads,
  // or the button is a dead control with a better label.
  const libraryPageSource = read('public/js/modules/13-library/01-library-page.js');
  assert.match(libraryPageSource, /function openLibraryPage\(/);
  assert.match(loaderSource, /'js\/modules\/13-library\/01-library-page\.js'/);
});

test('the library is rendered as normal result rows, so a row plays that track', () => {
  // Going through renderSongSearchResults is what makes a click on row 7 play
  // track 7: rows are built with playSearchResult(i) against `playlist`, which
  // that function owns. A bespoke list would have needed its own play wiring.
  assert.match(librarySource, /renderSongSearchResults\(tracks, \{ animate: true \}\)/);
  assert.match(namedFunctionSource(librarySource, 'renderLocalLibraryResults'),
    /\$results\.insertAdjacentHTML\('afterbegin', localLibraryHeadHtml\(tracks\.length\)\)/,
    'the count and Play all sit above the rows, not after them');

  // Scrolling grows the list locally: with remoteHasMore false the sentinel
  // never asks the search API for page two of a folder on this machine.
  const rendered = namedFunctionSource(librarySource, 'renderLocalLibraryResults');
  assert.match(rendered, /key: LOCAL_LIBRARY_RESULT_KEY/);
  assert.match(rendered, /hasMore: false/);
  assert.match(rendered, /searchLastResultQuery = LOCAL_LIBRARY_RESULT_KEY/);
});

test('opening the library prefers the restored copy and falls back to the bridge', async () => {
  const sandbox = {
    console,
    window: {},
    persistentLocalLibraryTracks: [],
    hydrateCustomCover: (song) => song,
    cloneSong: (song) => Object.assign({}, song),
  };
  vm.runInNewContext(`${namedFunctionSource(librarySource, 'localLibraryTracksNow')}
    ${namedFunctionSource(librarySource, 'fetchLocalLibraryTracks')}
    this.fetch = fetchLocalLibraryTracks;
    this.now = localLibraryTracksNow;
  `, sandbox);

  // Cache already populated by the startup restore: no round-trip.
  const cached = [{ localUrl: 'blob:1', localKey: 'a', name: 'One' }];
  sandbox.persistentLocalLibraryTracks = cached;
  assert.strictEqual(await sandbox.fetch(), cached, 'a restored library must be used as-is');

  // Empty cache and no desktop bridge (browser preview): an empty list, not a throw.
  sandbox.persistentLocalLibraryTracks = [];
  assert.strictEqual((await sandbox.fetch()).length, 0);

  // Empty cache with the bridge: ask for it, and keep what comes back.
  const fromDisk = [{ localUrl: 'blob:2', localKey: 'b', name: 'Two' }];
  let listed = 0;
  sandbox.window.desktopWindow = {
    listLocalMusicLibrary: async () => { listed += 1; return { ok: true, tracks: fromDisk }; },
  };
  const fetched = await sandbox.fetch();
  assert.strictEqual(fetched.length, 1, 'the bridge answer must be used when the cache is empty');
  assert.strictEqual(listed, 1);
  assert.strictEqual(sandbox.now()[0].name, 'Two', 'the fetched list must be cached for next time');
});

test('Play all hands the whole saved list to the local importer', () => {
  const sandbox = {
    console,
    window: {},
    persistentLocalLibraryTracks: [{ localUrl: 'blob:1', localKey: 'a' }, { localUrl: 'blob:2', localKey: 'b' }],
    cloneSong: (song) => Object.assign({}, song),
    showToast(message) { sandbox.toast = message; },
    imported: null,
    importLocalAudioSongs(songs, opts) { sandbox.imported = { songs, opts }; return true; },
  };
  vm.runInNewContext(`${namedFunctionSource(librarySource, 'localLibraryTracksNow')}
    ${namedFunctionSource(librarySource, 'playAllLocalLibraryTracks')}
    this.playAll = playAllLocalLibraryTracks;
  `, sandbox);

  assert.strictEqual(sandbox.playAll(), true);
  assert.strictEqual(sandbox.imported.songs.length, 2, 'every saved track, not a window of them');
  assert.strictEqual(sandbox.imported.opts.mode, 'persistent-library');

  // Nothing saved: say so rather than emptying the queue.
  sandbox.persistentLocalLibraryTracks = [];
  sandbox.imported = null;
  assert.strictEqual(sandbox.playAll(), false);
  assert.strictEqual(sandbox.imported, null);
  assert.match(sandbox.toast, /No local tracks/);
});

test('the count reaches the import hub and the home library card', () => {
  // The label is only true after the startup restore has run, so that is where
  // it has to be refreshed — the static markup cannot know the number.
  assert.match(startupSource, /updateLocalLibraryChoiceLabel\(localLibraryTracksNow\(\)\.length\)/);
  // Importing is the other moment the number changes.
  assert.match(uploadSource, /updateLocalLibraryChoiceLabel\(localLibraryTracksNow\(\)\.length\)/);
  // And the count must be recomputed from the same store the panel lists, or
  // the two disagree after a restore that produced no snapshot.
  assert.match(librarySource, /persistentLocalLibraryTracks = tracks\.map\(cloneSong\)/);

  // The home card promised "local music" and, with no platform signed in,
  // opened the import buttons even when a library was already on disk.
  const card = namedFunctionSource(homeSource, 'openHomeDashboardLibrary');
  assert.match(card, /openLocalLibraryResults\(\)/);
  assert.match(card, /localLibraryTracksNow\(\)\.length/);
  assert.ok(card.indexOf('openLocalLibraryResults()') < card.indexOf('openUploadPanel()'),
    'an existing library wins over the import buttons');
});

test('an empty library sends the user to the importers instead of a blank panel', () => {
  const empty = namedFunctionSource(librarySource, 'localLibraryEmptyHtml');
  // Both buttons are built from an escaped onclick inside a single-quoted
  // string, so count the calls rather than matching the quoting.
  assert.strictEqual((empty.match(/triggerUploadInput/g) || []).length, 2);
  assert.match(empty, /audio/);
  assert.match(empty, /folder/);
  assert.match(namedFunctionSource(librarySource, 'showLocalLibraryEmpty'),
    /resetSearchMusicRenderState\(\)/, 'the previous search rows must not survive');
  assert.match(namedFunctionSource(librarySource, 'showLocalLibraryEmpty'),
    /playlist = \[\]/, 'the old result list must not stay playable');
});
