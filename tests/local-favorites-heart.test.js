'use strict';
// The library page can favourite a file on disk — librarySetFavorite writes it
// through IPC and the row shows a filled heart — but every transport heart read
// only the cloud like-map and every transport click bailed out because a local
// file has no cloud adapter. So the console heart, the mini-player heart and
// the Now Playing heart were all dead controls for the only files this build
// can actually play offline, and they stayed unlit for tracks the library had
// already saved.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { functionBundle } = require('./helpers/extract-function');

const appRoot = path.resolve(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(appRoot, p), 'utf8');

const actionsSource = read('public/js/modules/05-playback/06-track-detail-lyrics-actions.js');
const storeSource = read('public/js/modules/13-library/00-local-library-store.js');
const loaderSource = read('public/js/index-loader.js');

function localSong(key, over) {
  return Object.assign({
    type: 'local',
    localKey: key,
    localFileId: key,
    localUrl: 'mineradio-local://audio/' + key,
    id: 'cloud-id-' + key,
    name: 'Track ' + key,
    artist: 'Artist ' + key,
  }, over || {});
}

// The main-process side of setLocalLibraryUser, which is what the store is
// written against. A record only exists once something has touched it, which is
// why the read path has to tolerate a missing entry rather than assume one.
function fakeDesktopWindow(store) {
  return {
    setLocalLibraryUser: async function (payload) {
      const id = payload && payload.id;
      if (!id) return { changed: false };
      const entry = store.songs[id] || {};
      if (payload.action === 'favorite') entry.favorite = payload.value !== false;
      else if (payload.action === 'favorite-toggle') entry.favorite = !entry.favorite;
      else if (payload.action === 'rating') entry.rating = Number(payload.value) || 0;
      else return { changed: false };
      store.songs[id] = entry;
      return { changed: true, favorite: !!entry.favorite, rating: entry.rating || 0 };
    },
  };
}

// Everything the extracted code touches — the call log, the fake buttons, the
// current song — is created inside the vm and handed back out. Splitting them
// across the boundary would let a test assert on a button object the code never
// painted.
function boot(opts) {
  const options = opts || {};
  const store = { songs: options.songs || {}, playlists: [] };
  const prelude = `
    var likedSongMap = Object.create(null);
    var likeBusyMap = Object.create(null);
    var SONG_ACCOUNT_ACTION_ADAPTERS = {};
    var playlist = null;
    var $results = null;
    var miniQueueOpen = false;
    var collectBusy = false;
    // Shared with the host by reference: the fake IPC writes into this object
    // and the store reads from it, so a copy made here would let the write
    // "succeed" against state the assertion never sees. Left unset it matches
    // the bundle's real state while module 10 runs and module 13 has not yet
    // executed its own initializer.
    var localLibraryStore = ${options.uninitialized ? 'undefined'
      : '{ loaded: true, tracks: [], index: null, userData: __userStore }'};
    var __calls = { toast: [], rendered: [], api: [] };
    var __currentSong = null;
    var __buttons = {
      'heart-btn': __makeButton(),
      'collect-btn': __makeButton()
    };
    var document = {
      getElementById: function (id) { return __buttons[id] || null; },
      body: { classList: { toggle: function () {}, add: function () {}, remove: function () {}, contains: function () { return false; } } }
    };
    function __makeButton() {
      var names = [];
      return {
        className: '',
        title: '',
        classList: {
          toggle: function (name, on) {
            var has = names.indexOf(name) >= 0;
            var want = on === undefined ? !has : !!on;
            if (want && !has) names.push(name);
            if (!want && has) names.splice(names.indexOf(name), 1);
          },
          contains: function (name) { return names.indexOf(name) >= 0; },
          add: function (name) { this.toggle(name, true); },
          remove: function (name) { this.toggle(name, false); }
        }
      };
    }
    var currentCoverSong = function () { return __currentSong; };
    var showToast = function (message) { __calls.toast.push(String(message)); };
    var apiJson = function (url) { __calls.api.push(String(url)); return Promise.reject(new Error('apiJson must not run for a local file')); };
    var safeRenderQueuePanel = function (reason) { __calls.rendered.push(String(reason)); };
    var refreshSearchResultActionStates = function () {};
    var ensureLoggedInForAction = function () { return true; };
    var showLoginModal = function () {};
    var loginStatus = {};
    var spotifyLoginStatus = {};
    var qishuiLoginStatus = {};
    var kugouLoginStatus = {};
    var qqLoginStatus = {};
  `;
  const expose = `
    return {
      calls: __calls,
      buttons: __buttons,
      store: localLibraryStore,
      likedSongMap: likedSongMap,
      isSongLiked: isSongLiked,
      localLibraryIsFavorite: localLibraryIsFavorite,
      repaint: updateLikeButtons,
      toggleLikeSong: toggleLikeSong,
      toggleLikeCurrent: toggleLikeCurrent,
      librarySetFavorite: librarySetFavorite,
      libraryToggleFavorite: libraryToggleFavorite,
      songActionHtml: songActionHtml,
      setSong: function (song) { __currentSong = song; }
    };
  `;

  const bundle = functionBundle(
    [actionsSource, storeSource],
    [
      'songAccountProvider',
      'songAccountIdentityValues',
      'songAccountId',
      'songAccountStateKey',
      'songAccountAdapter',
      'songAccountUnsupportedMessage',
      'isSongLiked',
      'isLocalFavoriteSong',
      'updateLikeButtons',
      'toggleLikeSong',
      'toggleLikeCurrent',
      'heartIconSvg',
      'songActionHtml',
      'invalidateLocalLibraryIndex',
      'notifyLikeButtonsChanged',
      'localFileIdOf',
      'localLibrarySongKey',
      'localLibraryUserState',
      'localLibraryIsFavorite',
      'librarySetFavorite',
      'libraryToggleFavorite',
    ],
    prelude,
    expose
  );
  // The expose block ends in a return, so the bundle has to be a function body
  // rather than the top level of a script, where a return is a syntax error.
  const wrapped = '(function () {\n' + bundle + '\n})()';

  const sandbox = {
    console,
    Promise,
    Object,
    Array,
    String,
    Number,
    JSON,
    setTimeout,
    clearTimeout,
    window: { desktopWindow: fakeDesktopWindow(store) },
    __userStore: store,
  };
  vm.createContext(sandbox);
  return vm.runInContext(wrapped, sandbox);
}

test('a local track is liked when the library store says so', () => {
  const app = boot({ songs: { 'a1': { favorite: true } } });
  assert.equal(app.isSongLiked(localSong('a1')), true, 'favourited on disk must read as liked');
  assert.equal(app.isSongLiked(localSong('a2')), false, 'a track with no record is not liked');
  assert.equal(app.isSongLiked(localSong('a3', { localKey: undefined, localFileId: undefined, localUrl: undefined, type: 'local' })), false,
    'a type-only entry with no store id has no favourite to read');
});

test('cloud likes keep coming from the cloud map', () => {
  const app = boot({ songs: { 'cloud-id-s1': { favorite: true } } });
  app.likedSongMap['netease:cloud-id-s1'] = true;
  assert.equal(app.isSongLiked({ id: 'cloud-id-s1', provider: 'netease' }), true);
  assert.equal(app.isSongLiked({ id: 'cloud-id-s2', provider: 'netease' }), false);
  // The store record must not leak into a cloud track that shares an id.
  assert.equal(app.isSongLiked({ id: 'cloud-id-s1', provider: 'spotify' }), false);
});

test('clicking a transport heart saves and clears a local favourite', async () => {
  const app = boot();
  const song = localSong('b7');
  app.setSong(song);

  await app.toggleLikeCurrent();
  assert.equal(app.store.userData.songs['b7'] && app.store.userData.songs['b7'].favorite, true, 'first click must save');
  assert.equal(app.isSongLiked(song), true);
  // Length, not deepEqual: the array is created inside the vm, so it carries
  // that realm's Array.prototype and would never be deep-equal to a host [].
  assert.equal(app.calls.api.length, 0, 'a local file must not be sent through the cloud like endpoint');
  assert.ok(app.calls.toast.length, 'the click must say what it did: '
    + JSON.stringify({ toast: app.calls.toast, api: app.calls.api, rendered: app.calls.rendered }));
  assert.equal(/do not support/i.test(app.calls.toast[app.calls.toast.length - 1]), false,
    'a supported action must not report itself unsupported: ' + app.calls.toast.join(' | '));
  assert.equal(app.buttons['heart-btn'].classList.contains('liked'), true, 'the console heart must light up');

  await app.toggleLikeCurrent();
  assert.equal(app.store.userData.songs['b7'].favorite, false, 'second click must clear');
  assert.equal(app.isSongLiked(song), false);
  assert.equal(app.buttons['heart-btn'].classList.contains('liked'), false);
});

test('favouriting from the library lights the transport heart', async () => {
  const app = boot();
  const song = localSong('c4');
  app.setSong(song);

  const saved = await app.librarySetFavorite(song, true);
  assert.ok(saved && saved.changed, 'the library write itself must go through');
  assert.equal(app.isSongLiked(song), true);
  assert.equal(app.buttons['heart-btn'].classList.contains('liked'), true,
    'setting the favourite outside the player must repaint the heart, not wait for the next track');
  assert.equal(app.calls.api.length, 0);
});

test('row hearts render in the liked state for a saved local file', () => {
  const app = boot({ songs: { 'd9': { favorite: true } } });
  const html = app.songActionHtml('like', 'Queue', 0, localSong('d9'));
  assert.match(html, /liked/, 'the row heart must carry the liked class');
  assert.match(html, /Unlike/);
  const cold = app.songActionHtml('like', 'Queue', 1, localSong('d10'));
  assert.doesNotMatch(cold, /"song-action-btn liked"/);
});

test('reading a favourite before the store is filled in answers false', () => {
  const app = boot({ uninitialized: true });
  const song = localSong('z1');
  assert.doesNotThrow(() => app.localLibraryIsFavorite(song),
    'an unfilled store is a valid early state, not an error');
  assert.equal(app.localLibraryIsFavorite(song), false);
  assert.equal(app.isSongLiked(song), false);
});

test('the startup repaint does not abort the bundle', () => {
  // Every module ships in one classic script, so updateLikeButtons() running
  // from module 10's top level reaches it before module 13's initializer has
  // executed. A throw there does not just break the hearts: an uncaught error
  // stops the script, and everything declared after that line — including the
  // store itself, the library page and the views table — never gets created.
  const app = boot({ uninitialized: true });
  app.setSong(localSong('z2'));
  assert.doesNotThrow(() => app.repaint());
  assert.equal(app.buttons['heart-btn'].classList.contains('liked'), false,
    'an unknown favourite reads as not liked, not as an error');
});

test('the like path branches on local before it looks for a cloud adapter', () => {
  // A local file has no adapter by design, so a local branch that sits after
  // the adapter check is unreachable — the exact shape that made the control
  // dead. Both functions have to reach the store first.
  const isLikedIndex = actionsSource.indexOf('function isSongLiked(');
  const toggleIndex = actionsSource.indexOf('async function toggleLikeSong(');
  assert.ok(isLikedIndex >= 0 && toggleIndex >= 0);

  const isLikedBody = actionsSource.slice(isLikedIndex, actionsSource.indexOf('\nfunction ', isLikedIndex + 10));
  assert.match(isLikedBody, /isLocalFavoriteSong\(/, 'isSongLiked must consult the local store');
  assert.match(isLikedBody, /localLibraryIsFavorite\(/, 'isSongLiked must read the persisted favourite');

  const toggleBody = actionsSource.slice(toggleIndex, actionsSource.indexOf('\nfunction ', toggleIndex + 10));
  const adapterGuard = toggleBody.indexOf('songAccountAdapter(');
  const localGuard = toggleBody.indexOf('isLocalFavoriteSong(');
  assert.ok(localGuard >= 0, 'toggleLikeSong must handle local files');
  assert.ok(adapterGuard < 0 || localGuard < adapterGuard,
    'the local branch has to come before the adapter lookup, or it can never run');
  assert.doesNotMatch(toggleBody, /songAccountUnsupportedMessage\(provider, 'like'\)[\s\S]*\n\s*if \(isLocalFavoriteSong/,
    'local files must not be reported as unsupported before they are handled');
});

test('the store module repaints the like buttons after a write', () => {
  assert.match(storeSource, /updateLikeButtons\(/,
    'a favourite set anywhere has to reach the transport hearts');
  assert.match(storeSource, /typeof updateLikeButtons === 'function'/,
    'the store loads after the module that defines it at startup, so the call has to be guarded');
});

test('the heart wiring is registered in the loader', () => {
  assert.match(loaderSource, /05-playback\/06-track-detail-lyrics-actions\.js/);
  assert.match(loaderSource, /13-library\/00-local-library-store\.js/);
});
