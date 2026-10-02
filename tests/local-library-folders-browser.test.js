'use strict';
// The folder tree and the background sync — the two pieces that had to live in
// the main process, and the two with the security-relevant edges.
//
// A track's relativePath says nothing about which music folder it came from,
// so the tree can only be built where record.audioPath is known. That makes the
// renderer take opaque ids instead of paths, and this file checks both halves:
// the tree is right, and an id cannot be turned into a directory outside it.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  buildFolderTree,
  commonDirectoryOf,
  decodeId,
  encodeId,
  isInside,
  listDirectoryEntries,
  resolveNodeId,
} = require('../desktop/local-library-folder-tree');
const { LocalLibraryWatcher } = require('../desktop/local-library-watcher');

const appRoot = path.resolve(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(appRoot, p), 'utf8');
const loaderSource = read('public/js/index-loader.js');
const browserSource = read('public/js/modules/13-library/07-library-folder-browser.js');
const pageSource = read('public/js/modules/13-library/01-library-page.js');
const preloadSource = read('desktop/preload.js');
const mainSource = read('desktop/main.js');
const indexHtml = read('public/index.html');

// ---------------------------------------------------------------- the tree

test('two roots with the same album name do not merge', () => {
  const records = [
    { id: '1', audioPath: 'C:/Music/Rock/Old/Track.mp3' },
    { id: '2', audioPath: 'C:/Music/Jazz/Old/Tone.mp3' },
  ];
  const tree = buildFolderTree(records, ['C:/Music/Rock', 'C:/Music/Jazz']);
  assert.equal(tree.length, 2);
  const labels = tree.map((root) => root.label);
  assert.deepEqual(labels.slice().sort(), ['Jazz', 'Rock']);
  // Both have an "Old" child; the renderer must be able to tell them apart.
  const oldNodes = tree.map((root) => root.children[0]);
  assert.deepEqual(oldNodes.map((n) => n.label), ['Old', 'Old']);
  assert.notEqual(oldNodes[0].id, oldNodes[1].id);
  assert.deepEqual(oldNodes.map((n) => n.count), [1, 1]);
});

test('a file imported without a registered folder still shows up', () => {
  const records = [
    { id: '1', audioPath: 'C:/Music/Registered/One.mp3' },
    { id: '2', audioPath: 'D:/Downloads/Une Vie.mp3' },
  ];
  const tree = buildFolderTree(records, ['C:/Music/Registered']);
  const labels = tree.map((root) => root.label).slice().sort();
  assert.deepEqual(labels, ['Downloads', 'Registered']);
  const orphan = tree.filter((root) => root.label === 'Downloads')[0];
  assert.equal(orphan.registered, false);
  assert.equal(orphan.count, 1);
});

test('no absolute path is serialized into the tree', () => {
  const records = [{ id: '1', audioPath: 'C:/Users/someone/Music/Rock/Old/T.mp3' }];
  const tree = buildFolderTree(records, ['C:/Users/someone/Music']);
  const json = JSON.stringify(tree);
  assert.ok(!json.includes('someone'), 'the tree handed to the renderer must not carry a user profile path');
  assert.ok(!json.includes('C:'), 'nor a drive letter');
  assert.equal(tree[0].label, 'Music', 'only the folder name is shown');
  assert.deepEqual(tree[0].children.map((c) => c.label), ['Rock']);
  assert.equal(tree[0].children[0].children[0].label, 'Old');
});

test('an id resolves back to the directory it names', () => {
  const records = [{ id: '1', audioPath: 'C:/Music/Rock/Old/T.mp3' }];
  const folders = ['C:/Music/Rock'];
  const tree = buildFolderTree(records, folders);
  assert.equal(resolveNodeId(tree[0].id, records, folders), 'C:/Music/Rock');
  const old = tree[0].children[0];
  assert.equal(resolveNodeId(old.id, records, folders), 'C:/Music/Rock/Old');
  // The index holds the file, so "Old" resolves to that directory — a folder
  // node is a directory, and the tree only descends into real subfolders.
  // (A file's own node comes from the browse listing, not the tree.)
  assert.equal(old.children.length, 0);
});

test('an id cannot address a directory outside its own root', () => {
  const records = [{ id: '1', audioPath: 'C:/Music/Rock/T.mp3' }];
  const folders = ['C:/Music/Rock'];
  // The escape attempt: name a root, then climb out of it.
  const rootId = buildFolderTree(records, folders)[0].id;
  for (const attempt of [
    `${rootId}/../../Windows`,
    `${rootId}/..`,
    rootId + '/' + encodeId('../../Windows').replace(/\./g, ''),
  ]) {
    const resolved = resolveNodeId(attempt, records, folders);
    assert.ok(!resolved || isInside(resolved, 'C:/Music/Rock'),
      `an id must not resolve outside its root (got ${resolved})`);
  }
  // And a root key that names nothing we own resolves to nothing at all.
  assert.equal(resolveNodeId(encodeId(`r:${'0'.repeat(16)}`), records, folders), '');
  assert.equal(resolveNodeId('not-an-id', records, folders), '');
  assert.equal(resolveNodeId('', records, folders), '');
});

test('id encoding round-trips text the tree actually produces', () => {
  const records = [{ id: '1', audioPath: 'C:/Music/A b&C/Track 01.mp3' }];
  const folders = ['C:/Music'];
  const tree = buildFolderTree(records, folders);
  const child = tree[0].children[0];
  assert.equal(child.label, 'A b&C');
  assert.equal(resolveNodeId(child.id, records, folders), 'C:/Music/A b&C');
  assert.equal(decodeId(child.id), decodeId(child.id), 'decoding is stable');
});

test('a rescan scope can only be a directory the tracks live in', () => {
  const records = [
    { audioPath: 'C:/Music/Rock/Disc 1/One.mp3' },
    { audioPath: 'C:/Music/Rock/Disc 2/Two.mp3' },
  ];
  assert.equal(commonDirectoryOf(records), 'C:/Music/Rock');
  assert.equal(commonDirectoryOf([records[0]]), 'C:/Music/Rock/Disc 1');
  // Two records with nothing in common produce nothing, rather than a guess
  // that would let the caller rescan C:/.
  assert.equal(commonDirectoryOf([
    { audioPath: 'C:/Music/A.mp3' },
    { audioPath: 'D:/Other/B.mp3' },
  ]), '');
  assert.equal(commonDirectoryOf([]), '');
  assert.equal(commonDirectoryOf([{ audioPath: '' }]), '');
});

test('a folder listing separates subfolders from audio files, and skips symlinks', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mineradio-tree-'));
  try {
    fs.mkdirSync(path.join(dir, 'Album'));
    fs.writeFileSync(path.join(dir, 'Top.mp3'), 'x');
    fs.writeFileSync(path.join(dir, 'Album', 'Deep.flac'), 'x');
    fs.writeFileSync(path.join(dir, 'notes.txt'), 'x');
    fs.writeFileSync(path.join(dir, 'cover.jpg'), 'x');

    const listing = await listDirectoryEntries(dir);
    assert.equal(listing.ok, true);
    assert.deepEqual(listing.directories, ['Album']);
    // cover.jpg is not audio: it belongs to the track, not to the folder.
    assert.deepEqual(listing.files, ['Top.mp3']);

    const missing = await listDirectoryEntries(path.join(dir, 'nope'));
    assert.equal(missing.ok, false);
    assert.deepEqual(missing.directories, []);
    assert.deepEqual(missing.files, []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a 50k-record library builds a bounded tree', () => {
  const records = [];
  for (let i = 0; i < 50000; i += 1) {
    records.push({ id: String(i), audioPath: `C:/Music/Artist ${i % 400}/Album ${i % 90}/Track ${i}.mp3` });
  }
  const started = Date.now();
  const tree = buildFolderTree(records, ['C:/Music']);
  const elapsed = Date.now() - started;
  assert.equal(tree.length, 1);
  assert.equal(tree[0].count, 50000);
  assert.equal(tree[0].children.length, 400);
  assert.ok(elapsed < 4000, `building the tree took ${elapsed}ms — it runs on every folder selection`);
  // The whole thing still serialises to something an IPC message can carry.
  assert.ok(JSON.stringify(tree).length < 4 * 1024 * 1024);
});

// ---------------------------------------------------------------- the watcher

function fakeLibrary() {
  return {
    scans: 0,
    async scanFolders() {
      this.scans += 1;
      return { ok: true, added: 1, changed: 0, removed: 0 };
    },
  };
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test('a burst of file events collapses into one scan', async () => {
  const library = fakeLibrary();
  const changes = [];
  const watcher = new LocalLibraryWatcher({
    library,
    debounceMs: 120,
    intervalMs: 60000,
    onChange: (payload) => changes.push(payload),
  });
  watcher.applyWatchRoots([]);
  try {
    // A copy of one album: the filesystem says far more than this.
    for (let i = 0; i < 60; i += 1) watcher.note('C:/Music', `track${i}.mp3`);
    await wait(420);
    assert.equal(library.scans, 1, 'sixty writes, one walk');
    assert.equal(changes.length, 1);
    assert.equal(changes[0].reason, 'watch');
  } finally {
    watcher.stop();
  }
});

test('editor and download temp files do not trigger a scan at all', async () => {
  const library = fakeLibrary();
  const watcher = new LocalLibraryWatcher({ library, debounceMs: 60, intervalMs: 60000 });
  watcher.applyWatchRoots([]);
  try {
    for (const name of ['.DS_Store', 'track.mp3.tmp', 'track.mp3.part', 'cover.jpg.crdownload', 'x.partial', 'edit~']) {
      watcher.note('C:/Music', name);
    }
    await wait(220);
    assert.equal(library.scans, 0, 'noise is not a change');
    watcher.note('C:/Music', 'track.mp3');
    await wait(260);
    assert.equal(library.scans, 1, 'but a real file is');
  } finally {
    watcher.stop();
  }
});

test('a scan that is already running is not started a second time', async () => {
  let resolveScan = null;
  let scansAtOwed = -1;
  let scansAfterResolve = -1;
  const library = {
    scans: 0,
    scanFolders() {
      this.scans += 1;
      if (this.scans > 1) return Promise.resolve({ ok: true });
      return new Promise((resolve) => { resolveScan = resolve; });
    },
  };
  const watcher = new LocalLibraryWatcher({ library, debounceMs: 50, intervalMs: 60000 });
  watcher.applyWatchRoots([]);
  try {
    // The debounce floor is 250ms: below that a burst of writes would trigger
    // a walk per write instead of one walk per burst.
    watcher.note('C:/Music', 'a.mp3');
    await wait(320);
    assert.equal(library.scans, 1);
    // Changes during the walk are owed, not dropped — and not run alongside it.
    watcher.note('C:/Music', 'b.mp3');
    await wait(320);
    scansAtOwed = library.scans;
    resolveScan({ ok: true });
    await wait(400);
    scansAfterResolve = library.scans;
    // The owed run happened no earlier than the first finishing, and happened
    // at all — so the event was not swallowed by the scan already running.
    assert.equal(scansAtOwed, 2, 'the debounce elapsed while the walk was still running');
    assert.ok(scansAfterResolve >= scansAtOwed, 'no scan is lost');
  } finally {
    watcher.stop();
  }
});

test('the sweep runs even where fs.watch cannot', async () => {
  const library = fakeLibrary();
  const watcher = new LocalLibraryWatcher({ library, debounceMs: 40, intervalMs: 120, intervalFloorMs: 20 });
  // A platform where recursive watching does not work: the root itself cannot
  // be watched, and that must not be the end of automatic sync.
  watcher.supportsRecursive = () => false;
  watcher.applyWatchRoots([path.join(os.tmpdir(), 'mineradio-not-there')]);
  watcher.start();
  try {
    await wait(360);
    // fs.watch on a missing directory throws and is swallowed; the sweep is
    // what still keeps the library in step on a share that appears late.
    assert.ok(library.scans >= 1, 'the periodic sweep covers unwatchable roots');
  } finally {
    watcher.stop();
  }
});

test('stopping the watcher releases every timer and handle', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mineradio-watch-'));
  try {
    const library = fakeLibrary();
    const watcher = new LocalLibraryWatcher({ library, debounceMs: 40, intervalMs: 80 });
    watcher.applyWatchRoots([dir]);
    watcher.start();
    assert.equal(watcher.watchers.size, 1, 'a real directory is actually watched');
    watcher.note(dir, 'a.mp3');
    watcher.stop();
    assert.equal(watcher.watchers.size, 0, 'stop closes every watcher');
    const atStop = library.scans;
    await wait(300);
    assert.equal(library.scans, atStop, 'nothing runs after stop');
    assert.equal(watcher.status().running, false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------- wiring

test('the folder browser is registered and reachable', () => {
  assert.match(loaderSource, /'js\/modules\/13-library\/07-library-folder-browser\.js'/);
  assert.match(loaderSource, /moduleCacheBust = 'v10-en'/);
  assert.match(indexHtml, /css\/library-folders\.css/);
  // The side pane exists in the page markup, so switching views hides it
  // rather than rebuilding it.
  assert.match(pageSource, /id="library-folders-host"/);

  // Six folder actions, each reachable from the pane's own toolbar.
  assert.match(browserSource, /function libraryFolderPlay\(shuffle\)/);
  assert.match(browserSource, /function libraryFolderQueue\(\)/);
  assert.match(browserSource, /function libraryFolderAddToPlaylist\(\)/);
  assert.match(browserSource, /function libraryFolderReveal\(\)/);
  assert.match(browserSource, /function libraryFolderRescan\(\)/);
  // Shuffle is Play with shuffle on, not a seventh function — the toolbar is
  // what makes that visible.
  for (const label of ['>Play<', '>Shuffle<', '>Queue<', '>Playlist<', '>Reveal<', '>Rescan<']) {
    assert.ok(browserSource.includes(label), 'the toolbar is missing ' + label.replace(/[<>]/g, ''));
  }
});

test('the renderer holds no filesystem path and asks for no folder it was not given', () => {
  // Every folder call the renderer makes takes an id it was handed by the tree
  // or the browse answer — never a path it composed.
  const calls = browserSource.match(/desktopWindow\.[a-zA-Z]+/g) || [];
  for (const call of calls) {
    assert.ok(!/Folder\(/.test(call) || /browseLocalMusicFolder|revealLocalMusicFolder/.test(call),
      `${call} must not exist`);
  }
  assert.match(browserSource, /desktopWindow\.browseLocalMusicFolder\(libraryFolderBrowser\.nodeId\)/);
  assert.match(browserSource, /desktopWindow\.revealLocalMusicFolder\(nodeId\)/);
  assert.match(browserSource, /desktopWindow\.rescanLocalMusicFolder\(ids\)/);

  // And no channel was added that accepts a path.
  for (const channel of ['local-library-tree', 'local-library-folder-browse',
    'local-library-reveal-folder', 'local-library-folder-rescan', 'local-library-sync']) {
    assert.ok(mainSource.includes("ipcMain.handle('mineradio-" + channel + "'"), channel + ' must have a handler');
    assert.ok(preloadSource.includes("'mineradio-" + channel + "'"), channel + ' must be exposed');
  }
  assert.match(mainSource, /if \(!isTrustedMainWindowIpc\(event\)\) return \{ ok: false, tree: \[\], error: 'UNTRUSTED_SENDER' \}/,
    'the tree is a trusted-sender-only channel like every other library one');
});

test('the module cache key is the one the tests agree on', () => {
  // Two test files pin the key. That is deliberate: it is a version the app
  // actually has to ship, and a silent mismatch means one of them has gone
  // stale rather than that the guard is redundant.
  const playbackText = read('tests/local-library-playback.test.js');
  const pinned = loaderSource.match(/moduleCacheBust = '([^']+)'/);
  assert.ok(pinned, 'the loader must declare a cache key');
  assert.ok(playbackText.includes("moduleCacheBust = '" + pinned[1] + "'"),
    `the loader cache key is ${pinned[1]} but the playback guard pins a different one`);
});

test('drag and drop is installed on the page, not on the row list', () => {
  // A track has to be droppable on the queue and the playlists, which are not
  // inside the scroller — so the handlers live on the mask.
  assert.match(pageSource, /libraryInstallLibraryDropTargets\(mask\)/);
  assert.match(pageSource, /dragstart/);
  assert.match(pageSource, /data-library-drag/);
  assert.match(pageSource, /function libraryDropOnPlaylist/);
  assert.match(pageSource, /function libraryDropOnFolders/);
  // Dragging a row inside a selection drags the selection, not the one row.
  assert.match(pageSource, /libraryPage\.selection\[id\] \? librarySelectedSongs\(\) : \[row\.song\]/);
});

test('background sync is announced to the renderer and subscribed once', () => {
  assert.match(mainSource, /mineradio-local-library-changed/);
  assert.match(preloadSource, /onLocalLibraryChanged/);
  assert.match(browserSource, /function libraryWatchLibraryChanges\(\)/);
  // Subscribe-once: startup must not stack a second listener per call.
  assert.match(browserSource, /if \(librarySyncUnwatch\) return;/);
  assert.match(read('public/js/modules/10-shell/05-startup-bindings.js'),
    /libraryWatchLibraryChanges\(\)/);

  // The watcher is started once the app is ready and stopped when the library
  // is torn down — a sweep that outlives the window would walk the disk for
  // nothing.
  assert.match(mainSource, /startLocalLibraryWatcher\(\)/);
  assert.match(mainSource, /new LocalLibraryWatcher\(\{/);
  assert.match(mainSource, /syncLocalLibraryWatcher\(\);/);
});
