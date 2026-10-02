'use strict';
// Three playback behaviours the library views depend on and none of them used
// to hold. Repeat had no "off", so a queue could never end and Previous walked
// a shuffled array by index into a track nobody had played. And a file that
// had been moved since the scan stalled the queue on a silent 404 — no sound,
// no message, no way forward except restarting the app.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { namedFunctionSource } = require('./helpers/extract-function');

const appRoot = path.resolve(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(appRoot, p), 'utf8');

const controlsSource = read('public/js/modules/05-playback/14-player-controls.js');
const startSource = read('public/js/modules/05-playback/13-playback-start-audio.js');
const listenSource = read('public/js/modules/05-playback/02-listen-stats.js');
const queueSource = read('public/js/modules/05-playback/09-queue-snapshot-autoplay.js');
const guardSource = read('public/js/modules/13-library/06-library-playback-guard.js');
const loaderSource = read('public/js/index-loader.js');
const startupSource = read('public/js/modules/10-shell/05-startup-bindings.js');

const CONTROLS = ['shuffleArrayInPlace', 'reorderQueueForShufflePlaybackOrder',
  'playbackHistoryPush', 'playbackHistoryPop', 'clearPlaybackHistory', 'stopAtQueueEnd',
  'nextTrack', 'prevTrack', 'playModeLabel', 'playModeIconMarkup', 'cyclePlayMode'];

function song(key, over) {
  return Object.assign({ localKey: key, localFileId: key, localUrl: 'mineradio-local://audio/' + key, name: 'Track ' + key, artist: 'A' }, over || {});
}

// A queue of local songs plus the globals the control functions lean on.
function player(opts) {
  opts = opts || {};
  const sandbox = {
    console,
    window: { desktopWindow: { setLocalLibraryUser: async () => null } },
    playQueue: (opts.queue || []).map((k) => song(k)),
    currentIdx: opts.currentIdx == null ? -1 : opts.currentIdx,
    playing: opts.playing !== false,
    playToggleBusy: false,
    playMode: opts.playMode || 'loop',
    playbackHistory: (opts.history || []).slice(),
    PLAYBACK_HISTORY_LIMIT: 120,
    audio: { paused: false, pause() { this.paused = true; } },
    queueHydrationState: null,
    currentLocalSong: null,
    localLibraryStore: { tracks: [], byId: {}, userData: { songs: {}, playlists: [] }, index: null },
    toasts: [],
    showToast(message) { sandbox.toasts.push(message); },
    icon: '',
    played: [],
    stopped: [],
    icons: [],
    forcePlaybackControlsInteractive() {},
    // Both touch the document; the test cares that they are called, not what
    // they paint.
    setPlayIcon(p) { sandbox.icons.push(p); },
    updatePlayModeButton() {},
    safeRenderQueuePanel() {},
    safeShelfRebuild() {},
    saveLastPlaybackSnapshot() {},
    resetCuefieldAutoMix(reason) { sandbox.stopped.push(reason); },
    playQueueAt(index) { sandbox.played.push(index); return Promise.resolve(true); },
    hydratePlaylistQueueNextPage() { return Promise.resolve(null); },
    showToastToastCount() { return sandbox.toasts.length; },
  };
  vm.runInNewContext(
    [
      ...CONTROLS.map((n) => namedFunctionSource(controlsSource, n)),
      namedFunctionSource(queueSource, 'queueItemKey'),
      'var playMode = ' + JSON.stringify(sandbox.playMode) + ';',
    ].join('\n'),
    sandbox
  );
  // The extracted `playMode` is a fresh local binding; the tests drive the one
  // the sandbox holds, so re-expose the functions against it.
  return sandbox;
}

// ---------------------------------------------------------------- play modes

test('repeat cycles through off, and "off" is labelled and drawn distinctly', () => {
  const sandbox = player({ queue: ['a'], playMode: 'loop' });
  assert.equal(sandbox.playModeLabel('off'), 'Play once');
  assert.equal(sandbox.playModeLabel('loop'), 'Repeat all');
  assert.equal(sandbox.playModeLabel('unknown'), 'Repeat all', 'a mode that is not one of ours still reads sensibly');

  // The icon is the whole affordance for a mode with no label until you hover,
  // so each state must be a different path.
  const icons = ['loop', 'shuffle', 'single', 'off'].map((m) => sandbox.playModeIconMarkup(m));
  assert.equal(new Set(icons).size, 4, 'four modes, four distinct icons');
  assert.match(sandbox.playModeIconMarkup('off'), /M4 4l16 16/, 'Play once is the loop, struck through');

  const modes = [];
  for (let i = 0; i < 4; i += 1) {
    sandbox.cyclePlayMode();
    modes.push(sandbox.playMode);
    // cyclePlayMode reassigns its own `playMode`; keep the sandbox in step so
    // the next iteration starts from the right place.
    vm.runInNewContext('playMode = ' + JSON.stringify(sandbox.playMode) + ';', sandbox);
  }
  assert.deepEqual(modes, ['shuffle', 'single', 'off', 'loop'],
    'the cycle has to reach Play once and come back round to Repeat all');
});

test('Play once stops at the end of the queue instead of wrapping', () => {
  const sandbox = player({ queue: ['a', 'b', 'c'], currentIdx: 2, playMode: 'off' });
  vm.runInNewContext("playMode = 'off';", sandbox);

  sandbox.nextTrack(true);
  assert.equal(sandbox.currentIdx, 2, 'the last track stays the last track');
  assert.deepEqual(sandbox.played, [], 'nothing was started');
  assert.equal(sandbox.playing, false, 'the transport shows stopped, not paused mid-track');
  assert.deepEqual(sandbox.toasts, ['End of queue']);
  assert.deepEqual(sandbox.icons, [false], 'the play glyph goes back, so the controls match the state');

  // In the middle of the list Play once still advances.
  vm.runInNewContext('currentIdx = 1;', sandbox);
  sandbox.played = [];
  sandbox.nextTrack(true);
  assert.deepEqual(sandbox.played, [2]);
});

test('the same end-of-queue check applies when the track finishes on its own', () => {
  const sandbox = player({ queue: ['a', 'b'], currentIdx: 1, playMode: 'loop' });
  vm.runInNewContext("playMode = 'off';", sandbox);
  // onended calls nextTrack with no argument — the auto path must stop too,
  // otherwise the mode looks like it works until you look away.
  sandbox.nextTrack();
  assert.deepEqual(sandbox.played, []);
  assert.equal(sandbox.playing, false);
  assert.deepEqual(sandbox.toasts, [], 'an automatic stop does not need to announce itself');
});

// ---------------------------------------------------------------- history

test('Previous walks the history, not the array index', () => {
  // In shuffle the array is physically reordered, so index-1 is frequently a
  // track that was never played. The history holds keys, which survive that.
  const sandbox = player({ queue: ['a', 'b', 'c'], currentIdx: 0, playMode: 'shuffle', history: ['local:c'] });
  sandbox.prevTrack(true);
  assert.deepEqual(sandbox.played, [2], 'back to the track that was actually heard before');
  assert.equal(sandbox.currentIdx, 2);

  // The step it came from must not push itself, or back-navigation ping-pongs.
  assert.deepEqual(sandbox.playbackHistory, [], 'history was consumed, not re-filled with the jump back');
});

test('with no history, Previous restarts the first track rather than jumping', () => {
  const sandbox = player({ queue: ['a', 'b', 'c'], currentIdx: 0, playMode: 'shuffle' });
  sandbox.prevTrack(true);
  assert.deepEqual(sandbox.played, [0], 'the first track of the session restarts');

  const middle = player({ queue: ['a', 'b', 'c'], currentIdx: 1, playMode: 'loop' });
  middle.prevTrack(true);
  assert.deepEqual(middle.played, [0], 'without history it falls back to the previous row');
});

test('history records what was left behind, once', () => {
  const sandbox = player({ queue: ['a', 'b'], currentIdx: 1 });
  const leaving = song('a');
  const staying = song('b');

  sandbox.playbackHistoryPush(staying, null);
  assert.deepEqual(sandbox.playbackHistory, [], 'the first track of a session has nothing behind it');

  sandbox.playbackHistoryPush(staying, leaving);
  assert.deepEqual(sandbox.playbackHistory, ['local:a']);

  // Repeat one and quality switches re-enter the same track: recording that
  // would make Previous a no-op loop on one song.
  sandbox.playbackHistoryPush(staying, staying);
  sandbox.playbackHistoryPush(staying, leaving);
  assert.deepEqual(sandbox.playbackHistory, ['local:a'], 'a repeated key does not stack');

  // Bounded, so a long session cannot grow the list without limit.
  for (let i = 0; i < 200; i += 1) {
    sandbox.playbackHistoryPush(song('x' + i), leaving);
  }
  assert.ok(sandbox.playbackHistory.length <= 120, 'the history has a ceiling');

  // And a key whose track has since left the queue is skipped rather than
  // pinning Previous to a row that no longer exists.
  sandbox.playbackHistory = ['local:gone', 'local:b'];
  assert.equal(sandbox.playbackHistoryPop(), 1);
  assert.deepEqual(sandbox.playbackHistory, ['local:gone'],
    'the dead key was discarded while searching, and the search stopped at the match');
});

test('a shuffle pass prefers tracks that have not been played yet', () => {
  const sandbox = player({
    queue: ['heard1', 'fresh1', 'fresh2', 'heard2', 'fresh3'],
    currentIdx: 0,
    playMode: 'shuffle',
    history: ['local:heard1', 'local:heard2'],
  });

  sandbox.reorderQueueForShufflePlaybackOrder(0, { renderPanel: false, rebuildShelf: false, persistSnapshot: false });

  const order = sandbox.playQueue.map((s) => s.localKey);
  assert.equal(order[0], 'heard1', 'the current track stays where it is');
  const tail = order.slice(1);
  const firstFresh = tail.findIndex((k) => k.startsWith('fresh'));
  const lastHeard = tail.map((k, i) => (k.startsWith('heard') ? i : -1)).filter((i) => i >= 0).pop();
  assert.ok(firstFresh >= 0 && lastHeard >= 0);
  assert.ok(firstFresh < lastHeard,
    'every unheard track comes before one already played — that is what stops the same song coming round again');
  // Nothing is lost or duplicated by the partition.
  assert.deepEqual(tail.slice().sort(), ['fresh1', 'fresh2', 'fresh3', 'heard2'].sort());
});

// ---------------------------------------------------------------- missing files

const GUARD = ['libraryIsLocalKey', 'libraryLocalSongAt', 'libraryMarkTrackMissing',
  'libraryNoteMissingTrack', 'libraryOnMediaError', 'libraryInstallMediaErrorWatch',
  'libraryRecordListenEvent'];

function guardSandbox(opts) {
  opts = opts || {};
  const sandbox = {
    console,
    window: { desktopWindow: { setLocalLibraryUser: async () => null }, listeners: [], addEventListener(type, fn, capture) { this.listeners.push({ type, fn, capture }); } },
    playQueue: (opts.queue || ['a', 'b', 'c']).map((k) => song(k)),
    currentIdx: opts.currentIdx == null ? 0 : opts.currentIdx,
    currentLocalSong: null,
    audio: opts.audio || null,
    localLibraryStore: { tracks: [], byId: {}, userData: { songs: {}, playlists: [] }, index: null },
    LIBRARY_MISSING_SKIP_WINDOW_MS: 8000,
    LIBRARY_MISSING_SKIP_MAX: opts.max == null ? 8 : opts.max,
    LIBRARY_MISSING_SAME_TRACK_MS: 1500,
    libraryMissingGuard: { count: 0, at: 0, key: '' },
    libraryMediaErrorWatchInstalled: false,
    toasts: [],
    showToast(message) { sandbox.toasts.push(message); },
    nextCalls: [],
    nextTrack() { sandbox.nextCalls.push(sandbox.currentIdx); },
    stopCalls: [],
    stopAtQueueEnd(reason) { sandbox.stopCalls.push(reason); },
    recorded: [],
    libraryRecordPlaybackEvent(s, kind) { sandbox.recorded.push([s.localKey, kind]); },
    invalidateLocalLibraryIndex() {},
    localLibrarySongKey(s) { return String(s && (s.localFileId || s.localKey) || '').replace(/^local:/, ''); },
  };
  vm.runInNewContext(
    [...GUARD.map((n) => namedFunctionSource(guardSource, n)),
      namedFunctionSource(queueSource, 'queueItemKey')].join('\n'),
    sandbox
  );
  return sandbox;
}

test('a dead file is marked, announced, counted as a skip, and skipped over', () => {
  const sandbox = guardSandbox({ currentIdx: 0 });
  const target = sandbox.playQueue[0];
  target.__mineradioQueueItemKey = 'local:a';
  const media = Object.assign(target.__proto__ ? {} : {}, { tagName: 'AUDIO', error: { code: 4 }, __mineradioQueueItemKey: 'local:a' });

  sandbox.libraryOnMediaError({ target: media });

  assert.equal(sandbox.playQueue[0].localMissing, true, 'the row knows it is gone, so a rescan can fix it');
  assert.match(sandbox.toasts[0], /File is missing/);
  assert.match(sandbox.toasts[0], /Track a/);
  assert.deepEqual(sandbox.recorded, [['a', 'skip']], 'a file you never heard is a skip, not a play');
  assert.deepEqual(sandbox.nextCalls, [0], 'the queue moves on instead of stalling');
});

test('the error watch ignores everything that is not a dead local track', () => {
  const sandbox = guardSandbox({ currentIdx: 0 });

  // Installed exactly once, on the capture path: media errors do not bubble.
  sandbox.libraryInstallMediaErrorWatch();
  sandbox.libraryInstallMediaErrorWatch();
  assert.equal(sandbox.window.listeners.length, 1);
  assert.equal(sandbox.window.listeners[0].type, 'error');
  assert.equal(sandbox.window.listeners[0].capture, true);

  // A failed cover image must not advance the music.
  sandbox.libraryOnMediaError({ target: { tagName: 'IMG', error: { code: 4 } } });
  // A deliberate track switch reports code 1 (aborted).
  sandbox.libraryOnMediaError({ target: { tagName: 'AUDIO', error: { code: 1 } } });
  // An element from a track we have already left.
  sandbox.libraryOnMediaError({ target: { tagName: 'AUDIO', error: { code: 4 }, __mineradioQueueItemKey: 'local:other' } });
  // An error event with no media element at all.
  sandbox.libraryOnMediaError({ target: null });
  assert.deepEqual(sandbox.nextCalls, [], 'none of those are a missing file');
  assert.deepEqual(sandbox.toasts, []);

  // A stream failing is not a library problem either.
  const remote = player({ queue: ['a'] });
  remote.currentIdx = 0;
  const remoteGuard = guardSandbox({ queue: ['a'] });
  remoteGuard.playQueue[0] = { name: 'A stream', provider: 'spotify', id: 'x' };
  remoteGuard.libraryOnMediaError({ target: { tagName: 'AUDIO', error: { code: 4 }, __mineradioQueueItemKey: 'song:x' } });
  assert.deepEqual(remoteGuard.nextCalls, [], 'streaming failures are handled by the provider fallback, not here');
});

test('a whole folder of dead files stops the queue instead of clicking through it', () => {
  const sandbox = guardSandbox({ max: 2 });
  // The watch only answers for the element the player is using; a discarded
  // one reporting late must not move the queue on.
  const media = { tagName: 'AUDIO', error: { code: 4 }, __mineradioQueueItemKey: '' };
  sandbox.audio = media;

  for (let i = 0; i < 4; i += 1) {
    sandbox.playQueue = [song('dead' + i), song('dead' + (i + 10))];
    sandbox.currentIdx = 0;
    media.__mineradioQueueItemKey = 'local:dead' + i;
    sandbox.libraryOnMediaError({ target: media });
  }

  assert.ok(sandbox.toasts.some((t) => /rescan your music folders/.test(t)),
    'after the limit it says what is actually wrong instead of skipping forever');
  assert.ok(sandbox.stopCalls.length >= 1, 'and it stops');
  assert.ok(sandbox.nextCalls.length <= 2, 'it never walks more than the limit');
});

test('the same failing track reported twice is only skipped once', () => {
  const sandbox = guardSandbox({ max: 8 });
  const media = { tagName: 'AUDIO', error: { code: 4 }, __mineradioQueueItemKey: 'local:a' };
  sandbox.libraryOnMediaError({ target: media });
  sandbox.libraryOnMediaError({ target: media });
  sandbox.libraryOnMediaError({ target: media });
  assert.equal(sandbox.nextCalls.length, 1, 'the fetch failure and the stall retry must not both advance');
  assert.equal(sandbox.recorded.length, 1);
});

// ---------------------------------------------------------------- listen events

test('a listen becomes exactly one library counter event', () => {
  const sandbox = guardSandbox();
  sandbox.window.desktopWindow = { setLocalLibraryUser: async () => ({ ok: true, changed: true }) };

  sandbox.libraryRecordListenEvent('local:abc', true, true);
  sandbox.libraryRecordListenEvent('local:abc', false, true);
  sandbox.libraryRecordListenEvent('local:abc', false, false);
  assert.deepEqual(sandbox.recorded, [
    ['abc', 'complete'],
    ['abc', 'play'],
    ['abc', 'skip'],
  ], 'one listen, one event — the three cases are mutually exclusive');

  // Everything else in the queue is a stream and must not touch the bridge.
  sandbox.recorded = [];
  sandbox.libraryRecordListenEvent('spotify:xyz', true, true);
  sandbox.libraryRecordListenEvent('', true, true);
  sandbox.libraryRecordListenEvent('local:abc', true, true); // still counted, bridge present
  assert.deepEqual(sandbox.recorded, [['abc', 'complete']]);

  // No bridge, no crash: the browser preview has no main process.
  sandbox.recorded = [];
  sandbox.window.desktopWindow = {};
  sandbox.libraryRecordListenEvent('local:abc', true, true);
  assert.deepEqual(sandbox.recorded, []);
});

// ---------------------------------------------------------------- wiring

test('the guard is registered and hooked into playback', () => {
  assert.match(loaderSource, /'js\/modules\/13-library\/06-library-playback-guard\.js'/);
  assert.match(loaderSource, /moduleCacheBust = 'v10-en'/,
    'changed modules need a new cache key or the running app keeps the old ones');

  // The listener is installed by its own module: this script is concatenated,
  // so calling it from an earlier module would run before its state exists.
  assert.match(guardSource, /libraryInstallMediaErrorWatch\(\);\s*$/);

  // Recorded before the early return, because a bail-out is a skip and that
  // return is where skips used to disappear.
  const finalize = namedFunctionSource(listenSource, 'finalizeListenSession');
  assert.match(finalize, /libraryRecordListenEvent\(session\.key, completed, effective\)/);
  const hookAt = finalize.indexOf('libraryRecordListenEvent');
  const bailAt = finalize.indexOf('if (!effective) return;');
  assert.ok(hookAt >= 0 && bailAt >= 0 && hookAt < bailAt,
    'the hook has to run before the early return or skips are never counted');

  // And the track switch remembers where it came from, so Previous can walk it.
  assert.match(namedFunctionSource(startSource, 'playQueueAt'),
    /playbackHistoryPush\(song, previousSongForTransition\)/);
  assert.match(namedFunctionSource(startSource, 'playQueueAt'),
    /if \(!opts\.historyBack\) playbackHistoryPush/,
    'a step backwards must not re-record the track it is leaving');
});
