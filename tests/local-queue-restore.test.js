'use strict';
// A queue that only exists until you quit is not a queue. The snapshot writer
// saves up to 120 entries, but the local restore path read only snapshot.current
// to find a cursor and then overwrote playQueue with the entire library — so a
// five-track queue came back as 984 tracks, and the play mode it was built for
// came back as Repeat all.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { namedFunctionSource } = require('./helpers/extract-function');

const appRoot = path.resolve(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(appRoot, p), 'utf8');

const uploadSource = read('public/js/modules/06-lyrics/05-upload-dragdrop.js');
const queueSource = read('public/js/modules/05-playback/09-queue-snapshot-autoplay.js');
const controlsSource = read('public/js/modules/05-playback/14-player-controls.js');
const loaderSource = read('public/js/index-loader.js');

const LIBRARY = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'];

// A helper the fix has not introduced yet must not stop the test from reaching
// the behaviour it is actually about; the last test asserts it exists.
function optionalSource(source, name) {
  try {
    return namedFunctionSource(source, name);
  } catch (e) {
    return '';
  }
}

function entry(key, over) {
  return Object.assign({
    type: 'local',
    localKey: key,
    localFileId: key,
    name: 'Track ' + key,
    artist: 'Artist ' + key,
    localMissing: true,
  }, over || {});
}

function onDisk(keys) {
  return (keys || LIBRARY).map((key) => ({
    type: 'local',
    localKey: key,
    localFileId: key,
    localUrl: 'mineradio-local://audio/' + key,
    name: 'Track ' + key,
    artist: 'Artist ' + key,
    duration: 200,
  }));
}

function snapshotOf(queueKeys, currentKey, over) {
  const at = queueKeys.indexOf(currentKey);
  return Object.assign({
    version: 1,
    savedAt: 1770000000000,
    reason: 'beforeunload',
    currentIdx: at,
    currentTime: 31,
    duration: 200,
    playing: false,
    current: entry(currentKey),
    queue: queueKeys.map((key) => entry(key)),
  }, over || {});
}

// The startup restore, with the desktop bridge answering from disk.
function boot(opts) {
  opts = opts || {};
  const disk = onDisk(opts.library);
  const removed = [];
  const sandbox = {
    console,
    window: {
      desktopWindow: {
        listLocalMusicLibrary: async () => ({ ok: true, tracks: disk.map((song) => Object.assign({}, song)) }),
      },
    },
    restoredLastPlaybackSnapshot: opts.snapshot === undefined ? null : opts.snapshot,
    playQueue: opts.queue === undefined ? [] : opts.queue,
    currentIdx: opts.currentIdx == null ? -1 : opts.currentIdx,
    currentLocalSong: opts.localSong || null,
    pendingPlaybackResumeAt: 0,
    startupRestoreHomePending: false,
    miniQueueOpen: false,
    LAST_PLAYBACK_STORE_KEY: 'mineradio-last-playback-v1',
    localStorage: { removeItem(key) { removed.push(key); } },
    persistentLocalLibraryTracks: [],
    hydrateCustomCover: (song) => song,
    cloneSong: (song) => Object.assign({}, song),
    document: { getElementById: () => null },
    audio: null,
    calls: [],
    updateControlTrackInfo() { sandbox.calls.push('trackInfo'); },
    applyRestoredPlaybackProgressUi() { sandbox.calls.push('progress'); },
    safeRenderQueuePanel(what) { sandbox.calls.push('panel:' + what); },
    updateEmptyHomeVisibility() { sandbox.calls.push('home'); },
  };
  sandbox.removed = removed;
  vm.runInNewContext([
    ...['queueItemKey', 'playbackRestoreSongSnapshot'].map((n) => namedFunctionSource(queueSource, n)),
    ...['isLocalPlaybackSnapshot', 'restoredLocalTrackIndex', 'restorePersistedLocalLibrary']
      .map((n) => namedFunctionSource(uploadSource, n)),
    optionalSource(uploadSource, 'restoredQueueTracks'),
    optionalSource(uploadSource, 'restoredTrackId'),
    'this.booted = restorePersistedLocalLibrary;',
  ].join('\n'), sandbox);
  return sandbox;
}

// Spread into a literal before comparing: playQueue is built inside the vm, so
// it carries that realm's Array.prototype and deepStrictEqual would reject an
// array whose contents match on prototype alone.
const queueKeys = (sandbox) => [...(sandbox.playQueue || [])].map((song) => song.localKey);

test('a saved queue comes back as that queue, not as the whole library', async () => {
  // Three tracks, deliberately not in library order: the queue order is the
  // thing the user arranged, so it is what has to survive.
  const sandbox = boot({
    snapshot: snapshotOf(['d', 'b', 'a'], 'b'),
    queue: [],
    currentIdx: -1,
    localSong: entry('b'),
  });

  assert.strictEqual(await sandbox.booted(), true, 'the restore reports success');

  assert.deepEqual(queueKeys(sandbox), ['d', 'b', 'a'],
    'the queue came back as the whole library — the snapshot.queue entries were discarded');
  assert.strictEqual(sandbox.currentIdx, 1, 'the cursor lands on the track that was playing');
  assert.strictEqual(sandbox.playQueue.length, 3,
    'the library has ' + LIBRARY.length + ' tracks; a queue of that length is not the saved one');

  // Restored from disk, so every entry is playable again rather than flagged.
  for (const song of sandbox.playQueue) {
    assert.ok(song.localUrl, 'each entry was rehydrated from the library on disk');
    assert.ok(!song.localMissing, 'localMissing is a save-time marker, not a restore-time one');
  }
  assert.strictEqual(sandbox.persistentLocalLibraryTracks.length, LIBRARY.length,
    'the browse cache still holds the whole library; only the queue is narrow');
  assert.equal(sandbox.removed.length, 0, 'a restorable snapshot must not be thrown away');
});

test('a queue entry whose file was deleted drops out instead of replaying dead', async () => {
  const sandbox = boot({
    snapshot: snapshotOf(['d', 'b', 'a'], 'd'),
    queue: [],
    currentIdx: -1,
    localSong: entry('d'),
    library: ['a', 'c', 'd', 'e'], // 'b' is gone
  });

  assert.strictEqual(await sandbox.booted(), true);
  assert.deepEqual(queueKeys(sandbox), ['d', 'a'],
    'a missing file must not be kept as a row that will fail to play');
  assert.strictEqual(sandbox.currentIdx, 0, 'the current track survived, at the head of the rebuilt queue');
});

test('a snapshot with no queue still falls back to the whole library', async () => {
  // Older snapshots, and the case where the queue was never captured: the
  // cursor still has to land somewhere true.
  const snapshot = snapshotOf(['c'], 'c');
  delete snapshot.queue;
  const sandbox = boot({ snapshot, queue: [], currentIdx: -1, localSong: entry('c') });

  assert.strictEqual(await sandbox.booted(), true);
  assert.strictEqual(sandbox.playQueue.length, LIBRARY.length,
    'with no queue to rebuild there is nothing narrower to restore');
  assert.strictEqual(sandbox.currentIdx, LIBRARY.indexOf('c'),
    'the cursor finds the current track inside the library it fell back to');
});

test('a snapshot whose current track is gone is discarded, queue or no queue', async () => {
  const sandbox = boot({
    snapshot: snapshotOf(['d', 'b', 'a'], 'b'),
    queue: [],
    currentIdx: -1,
    localSong: entry('b'),
    library: ['a', 'c', 'd', 'e'], // 'b' is gone
  });

  assert.strictEqual(await sandbox.booted(), false);
  assert.ok(sandbox.removed.includes('mineradio-last-playback-v1'),
    'a snapshot pointing at a file that no longer exists must not be restored again on the next launch');
});

test('the snapshot writer actually saves the queue the restore reads', () => {
  const save = namedFunctionSource(queueSource, 'saveLastPlaybackSnapshot');
  assert.match(save, /queue: queue/, 'the saved payload carries the queue');
  assert.match(save, /playQueue\.slice\(0, 120\)/, 'capped, so a 50k library cannot fill localStorage');
  // The mode decides what the restored order *means*, so it rides along.
  assert.match(save, /playMode: playMode/, 'the play mode is part of the session being saved');

  const restore = namedFunctionSource(queueSource, 'restoreLastPlaybackSnapshot');
  assert.match(restore, /PLAY_MODES\.indexOf/, 'the restored mode is validated before it is applied');
  assert.match(restore, /updatePlayModeButton\(\)/, 'the chip has to be redrawn with the mode it came back as');
});

test('the restore is wired into startup, not left to a button press', () => {
  assert.match(loaderSource, /'js\/modules\/06-lyrics\/05-upload-dragdrop\.js'/,
    'the module has to be registered or restorePersistedLocalLibrary is never defined');
  assert.match(read('public/js/modules/10-shell/05-startup-bindings.js'),
    /Promise\.resolve\(restorePersistedLocalLibrary\(\)\)/,
    'the queue rebuild runs at startup');
  assert.match(namedFunctionSource(uploadSource, 'restorePersistedLocalLibrary'),
    /restoredQueueTracks\(tracks, snapshot\)/,
    'the queue is rebuilt from the snapshot rather than replaced by the library');
  assert.match(namedFunctionSource(controlsSource, 'cyclePlayMode'),
    /reorderQueueForShufflePlaybackOrder\(currentIdx, \{ reason: 'play-mode-shuffle' \}\)/,
    'shuffling must not become a no-op just because the mode was restored');
});
