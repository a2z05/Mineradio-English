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
const { namedFunctionSource } = require('./helpers/extract-function');
const vm = require('node:vm');

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

// A scan indexes directories that were not roots when it started: drop a file
// in a subdirectory beside an indexed one and that subdirectory becomes an
// orphan root of its own. The watcher's own scans never leave the watcher, so
// this is the path where nothing else re-reads the list.
test('a scan that changes the orphan roots re-applies the watch set', async () => {
  let roots = ['C:/Music/Album'];
  const library = {
    scans: 0,
    async scanFolders() {
      this.scans += 1;
      // First walk finds Album/Disc 2/Two.mp3; the second finds nothing under
      // Album at all, so its root goes away again.
      roots = this.scans === 1
        ? ['C:/Music/Album', 'C:/Music/Album/Disc 2']
        : [];
      return { ok: true, added: this.scans === 1 ? 1 : 0 };
    },
    watchDirectories() { return roots.slice(); },
  };
  const watcher = new LocalLibraryWatcher({ library, debounceMs: 40, intervalMs: 60000 });
  watcher.applyWatchRoots(roots);
  try {
    assert.equal(watcher.watchRoots.length, 1, 'starts on the root the index had');
    watcher.note('C:/Music', 'Two.mp3');
    await wait(320);
    assert.equal(library.scans, 1);
    assert.deepEqual(watcher.watchRoots.slice(),
      ['C:/Music/Album', 'C:/Music/Album/Disc 2'],
      'the walk just created that root; fs.watch has to be holding it, or a file '
      + 'dropped there is only ever seen by the two-minute sweep');

    // And the other direction: a root the index no longer points at must be
    // given up rather than watched forever.
    watcher.note('C:/Music', 'Gone.mp3');
    await wait(320);
    assert.equal(library.scans, 2);
    assert.deepEqual(watcher.watchRoots.slice(), [], 'a root with no records left is not watched');
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
  assert.match(loaderSource, /moduleCacheBust = 'v13-en'/);
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

  // The watcher has to be handed the directories the scanner walks. Passing
  // localMusicLibrary.folders alone left any library with no registered folder
  // — a legacy index, or anything imported by file picker — watching nothing,
  // so its files were only noticed by the two-minute sweep.
  assert.match(mainSource,
    /localLibraryWatcher\.applyWatchRoots\(localMusicLibrary\.watchDirectories\(\)\)/,
    'the watcher follows the scan roots, not just the registered folders');
});

// The body of one handler, ending where the next one begins — asserting that a
// call exists "somewhere in main.js" is not asserting that this handler makes it.
function ipcHandlerBody(source, channel) {
  const at = source.indexOf("ipcMain.handle('" + channel + "'");
  if (at < 0) return null;
  const next = source.indexOf('ipcMain.handle(', at + 1);
  return source.slice(at, next < 0 ? source.length : next);
}

test('every folder mutation resyncs the watcher', () => {
  // Adding or removing a root changes what fs.watch has to hold. A handler that
  // mutates the folder list without re-syncing leaves the watcher on the old
  // set: a newly added folder is then only noticed by the two-minute sweep, and
  // a removed one keeps a handle open on a directory nobody scans any more.
  for (const channel of [
    'mineradio-local-library-folder-add',
    'mineradio-local-library-folder-remove',
    'mineradio-local-library-folder-rescan',
    'mineradio-local-library-scan',
    'mineradio-local-library-sync',
  ]) {
    const body = ipcHandlerBody(mainSource, channel);
    assert.ok(body, 'the ' + channel + ' handler must exist');
    assert.match(body, /syncLocalLibraryWatcher\(\)/,
      channel + ' changes what is watched and has to tell the watcher');
  }

  // And the two that actually change the list do change it, so the resync is
  // not resyncing a list that never moved.
  assert.match(ipcHandlerBody(mainSource, 'mineradio-local-library-folder-add'),
    /localMusicLibrary\.addFolder\(/);
  assert.match(ipcHandlerBody(mainSource, 'mineradio-local-library-folder-remove'),
    /localMusicLibrary\.removeFolder\(/);

  // The renderer's half: both handlers repaint the header button, whose label
  // is the only thing telling the user whether they are being asked to add or
  // to add another. Forgetting it left "Add music folder" under a library that
  // already had one.
  for (const fn of ['libraryAddMusicFolder', 'libraryRemoveMusicFolder']) {
    const at = pageSource.indexOf('async function ' + fn + '(');
    assert.ok(at > 0, fn + ' must exist');
    const next = pageSource.indexOf('\nasync function ', at + 1);
    const body = pageSource.slice(at, next < 0 ? pageSource.length : next);
    assert.match(body, /libraryUpdateFolderControls\(\)/, fn + ' must relabel the folder button');
  }
  assert.match(pageSource,
    /localLibraryStore\.folders\.length \? 'Add folder' : 'Add music folder'/,
    'the label is derived from the folder count, not set once');
});

test('the folder tree lists its roots when nothing is selected', () => {
  // The rows were built from the selected node's children only, and the only
  // thing that selects a node is clicking a row — so the folders view opened
  // onto an empty pane with no first node to click, and could not be entered.
  const build = namedFunctionSource(browserSource, 'libraryBuildFolderRows');
  assert.match(build, /else if \(!selected\)/, 'nothing renders above the first node');
  assert.match(build, /libraryFolderBrowser\.tree/,
    'the roots are the only thing to show before a node is open');
  assert.match(build, /kind: 'node', entry: roots\[r\]/);
});

test('a folder row carries the name the tree gave it', () => {
  // A tree node has `label`; a browsed directory and a file have `name`.
  // Reading `name` for every kind left each indexed folder as a bare chevron
  // and a count — the rows were there, with nothing to tell them apart.
  const row = namedFunctionSource(browserSource, 'libraryFolderRowHtml');
  assert.match(row, /kind === 'node' \? entry\.label : entry\.name/);
});

test('a drilled folder lists its tracks as song rows', () => {
  // The drill branch pushed raw songs into libraryPage.rows while every reader
  // — the renderer, librarySelectAll, the drag start — expects { kind, song }.
  // librarySongRowHtml was handed undefined and threw with the spacer already
  // resized, which is how a crumb could claim 92 tracks over the group rows
  // still sitting in the window.
  const rebuild = namedFunctionSource(pageSource, 'libraryRebuildRows');
  assert.match(rebuild, /libraryPage\.rows = libraryPage\.songs\.map/,
    'the drill branch still stores unwrapped songs');
  assert.match(rebuild, /\{ kind: 'song', song: song \}/);
});

// ---------------------------------------------------------------- the open folder

// The pane reads two sources: the selected node's tree children, and the Browse
// answer for the directory itself. Files are not tree nodes, so a folder of
// tracks has no children at all and is filled entirely by Browse — which means
// dropping the Browse answer empties it, whatever the path bar still says.
function folderBrowserSandbox() {
  const elements = {};
  const element = (id) => {
    if (!elements[id]) {
      const listeners = {};
      elements[id] = {
        id, innerHTML: '', textContent: '', hidden: false, dataset: {},
        listeners,
        addEventListener(type, fn) { (listeners[type] || (listeners[type] = [])).push(fn); },
        // The handlers are installed with addEventListener, so a test that only
        // replaces innerHTML would never reach them. This is the other half.
        fire(type, event) { (listeners[type] || []).slice().forEach((fn) => fn(event)); },
      };
    }
    return elements[id];
  };
  const state = {
    tree: [], browseCalls: 0, hydrateCalls: 0, announcements: [],
    listeners: [],
  };
  const sandbox = {
    Date, Promise, setTimeout, clearTimeout, console,
    libraryPage: { open: true, view: 'folders', query: '', status: '', scanning: false },
    elements,
    state,
    escHtml: (value) => String(value == null ? '' : value)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'),
    libraryFormatDuration: () => '0:00',
    localLibraryStore: { tracks: [] },
    localLibrarySongKey: (song) => song.id,
    // The broadcast handler's collaborators all live in other modules, so the
    // bundle never defines them here — they are called unguarded (except the
    // playlist pane, which is feature-detected), and every one has to exist or
    // the handler throws before it can be observed.
    localLibrarySetFolders: (folders) => { state.folders = folders; },
    hydrateLocalLibraryStore: async () => { state.hydrateCalls += 1; },
    libraryPaintNav: () => {},
    libraryPaintHeader: () => {},
    libraryRebuildRows: () => {},
    libraryPaintPlaylistPane: () => { state.playlistPainted = (state.playlistPainted || 0) + 1; },
    window: {
      desktopWindow: {
        getLocalMusicTree: async () => ({ ok: true, tree: JSON.parse(JSON.stringify(state.tree)) }),
        browseLocalMusicFolder: async () => {
          state.browseCalls += 1;
          return { ok: true, directories: [], files: ['One.mp3', 'Two.mp3', 'Three.mp3'], childIds: {} };
        },
        // Main announces every scan here. Capturing the callback is what lets a
        // test deliver an announcement the way the app does — through the real
        // subscription — instead of calling the handler's internals.
        onLocalLibraryChanged: (fn) => {
          state.listeners.push(fn);
          return () => { state.listeners = state.listeners.filter((l) => l !== fn); };
        },
      },
    },
    document: { getElementById: element },
  };
  vm.runInNewContext(browserSource, sandbox);
  return sandbox;
}

const paintedRows = (sandbox) =>
  (sandbox.elements['library-folder-scroll'].innerHTML.match(/data-library-folder-index/g) || []).length;

const until = async (fn, ms = 600) => {
  const end = Date.now() + ms;
  for (;;) {
    if (fn()) return true;
    if (Date.now() >= end) return fn();
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};

test('a background scan does not empty the folder the user is reading', async () => {
  // Every scan announces itself, and the handler invalidates the tree. It threw
  // the Browse answer away with the old tree and repainted — but nothing asked
  // for the listing again, so a folder still holding all three of its files
  // read "Nothing in this folder" while its own path bar counted 3 indexed.
  // The scan runs on a timer, so this was a folder silently going blank while
  // the user was looking at it, with no way back but re-clicking the crumb.
  const sandbox = folderBrowserSandbox();
  sandbox.state.tree = [
    { id: 'leaf', label: 'ASHES & ECHOES', count: 3, childCount: 0, depth: 0, children: [] },
    { id: 'other', label: 'Other', count: 1, childCount: 0, depth: 0, children: [] },
  ];
  await sandbox.libraryLoadFolderTree(true);
  await sandbox.libraryFolderSelect('leaf');

  assert.equal(paintedRows(sandbox), 3, 'the folder opens with its three files');
  assert.deepEqual(Array.from(sandbox.libraryFolderBrowser.rows, (row) => row.kind),
    ['file', 'file', 'file'], 'a folder of tracks has no tree children, only files');

  const before = sandbox.state.browseCalls;
  sandbox.libraryInvalidateFolderTree();
  await until(() => sandbox.state.browseCalls > before);

  assert.equal(paintedRows(sandbox), 3,
    'the folder still holds three files after the scan rebuilt the tree');
  assert.match(sandbox.elements['library-folder-scroll'].innerHTML, /One\.mp3/);
  assert.doesNotMatch(sandbox.elements['library-folder-scroll'].innerHTML,
    /Nothing in this folder/);
  assert.equal(sandbox.libraryFolderBrowser.nodeId, 'leaf', 'the selection survives');
  // And the path bar and the rows must not be describing different folders.
  assert.match(sandbox.elements['library-folder-path'].innerHTML, /ASHES &amp; ECHOES/);
});

test('a folder the rebuilt tree no longer has falls back to the roots', async () => {
  // Node ids are digests, so a renamed or removed folder comes back under a
  // different one. Keeping the old id left the path bar blank, the toolbar's
  // six actions still enabled, and every one of them acting on a node that
  // resolves to nothing — a pane that looks live and answers nobody.
  const sandbox = folderBrowserSandbox();
  sandbox.state.tree = [
    { id: 'leaf', label: 'Gone', count: 3, childCount: 0, depth: 0, children: [] },
  ];
  await sandbox.libraryLoadFolderTree(true);
  await sandbox.libraryFolderSelect('leaf');
  assert.equal(paintedRows(sandbox), 3);

  sandbox.state.tree = [
    { id: 'fresh', label: 'Other', count: 1, childCount: 0, depth: 0, children: [] },
  ];
  sandbox.libraryInvalidateFolderTree();
  await until(() => sandbox.libraryFolderBrowser.tree.length === 1
    && sandbox.libraryFolderBrowser.tree[0].id === 'fresh'
    && sandbox.libraryFolderBrowser.nodeId === '');

  assert.equal(sandbox.libraryFolderBrowser.nodeId, '');
  assert.match(sandbox.elements['library-folder-path'].innerHTML, /Every music folder/,
    'the path bar names a folder that exists, not the one that was deleted');
  assert.deepEqual(Array.from(sandbox.libraryFolderBrowser.rows, (row) => row.kind), ['node'],
    'the roots are shown, so there is a first node to click again');
  assert.match(sandbox.elements['library-folder-actions'].innerHTML, / disabled/);
});

test('a folder is reached by clicking a row and left by the breadcrumb', async () => {
  // Click wiring and the path bar, on a tree this library can actually produce:
  // a root that holds subfolders as well as files. The user's library is flat —
  // every directory is an orphan root — so a nested pane is unreachable by hand,
  // and it was only ever going to be tested through the browser's own DOM.
  const sandbox = folderBrowserSandbox();
  sandbox.state.tree = [{
    id: 'parent',
    label: 'Vnerxy Music',
    count: 4,
    childCount: 2,
    depth: 0,
    registered: true,
    children: [
      { id: 'child-a', label: 'Lost signal', count: 2, childCount: 0, depth: 1, children: [] },
      { id: 'child-b', label: 'idk', count: 2, childCount: 0, depth: 1, children: [] },
    ],
  }];
  await sandbox.libraryLoadFolderTree(true);
  sandbox.libraryInstallFolderBrowser();
  sandbox.libraryPaintFolderBrowser();

  const scroll = sandbox.elements['library-folder-scroll'];
  const row = (id) => new RegExp('data-library-folder-id="' + id + '"').exec(scroll.innerHTML);
  assert.ok(row('parent'), 'the root has a row');
  assert.match(scroll.innerHTML, /data-library-folder-child="1"/,
    'a node with subfolders must say so, or the chevron has nothing to open');

  // The handler walks out from the event target to the row, so the click has to
  // arrive the way the DOM would deliver it: a target whose closest() answers
  // for the row, and for the chevron half of it.
  const clickRow = (attrs, { chevron = false } = {}) => {
    scroll.fire('click', {
      target: {
        closest: (sel) => {
          if (sel === '.library-folder-chevron') return chevron ? {} : null;
          if (sel.indexOf('data-library-folder-index') >= 0) {
            return { getAttribute: (name) => (name in attrs ? attrs[name] : null) };
          }
          return null;
        },
      },
    });
  };
  const parentIndex = /data-library-folder-index="(\d+)"[^>]*data-library-folder-id="parent"/.exec(scroll.innerHTML)
    || /data-library-folder-id="parent"[^>]*data-library-folder-index="(\d+)"/.exec(scroll.innerHTML);
  assert.ok(parentIndex, 'the root row carries its index');
  clickRow({
    'data-library-folder-index': parentIndex[1],
    'data-library-folder-id': 'parent',
    'data-library-folder-kind': 'node',
    'data-library-folder-child': '1',
  });
  await until(() => sandbox.libraryFolderBrowser.nodeId === 'parent');
  assert.equal(sandbox.libraryFolderBrowser.nodeId, 'parent',
    'clicking the name opens the folder');
  await until(() => scroll.innerHTML.includes('Lost signal'));

  assert.match(scroll.innerHTML, /Lost signal/, 'the subfolders are listed');
  assert.match(scroll.innerHTML, /--folder-depth:1/,
    'a child is indented under its parent');
  assert.equal((scroll.innerHTML.match(/data-library-folder-kind="file"/g) || []).length, 3,
    'the files sit alongside the subfolders, not instead of them');

  // And the way out: the first crumb, which names the whole set rather than
  // re-opening the folder already shown.
  const home = /data-library-folder=""/.test(sandbox.elements['library-folder-path'].innerHTML);
  assert.ok(home, 'the path bar has a crumb that goes to the folder list');
  const crumbs = [...sandbox.elements['library-folder-path'].innerHTML.matchAll(
    /data-library-folder="([^"]*)"[^>]*>([^<]*)</g)];
  assert.equal(crumbs[0][1], '', 'and it is the first one, so it is the one that is pressed');
  assert.equal(crumbs[0][2], 'Every music folder');

  // Press it through the path bar's own handler, so the wiring is under test
  // and not just the function it happens to call.
  sandbox.elements['library-folder-path'].fire('click', {
    target: {
      closest: (sel) => (sel === '[data-library-folder]'
        ? { getAttribute: (name) => (name === 'data-library-folder' ? '' : null) }
        : null),
    },
  });
  await until(() => sandbox.libraryFolderBrowser.nodeId === '');
  assert.equal(sandbox.libraryFolderBrowser.nodeId, '');
  assert.deepEqual(Array.from(sandbox.libraryFolderBrowser.rows, (row) => row.kind), ['node'],
    'the root list is back, and it is the only thing in the pane');
  assert.doesNotMatch(scroll.innerHTML, /One\.mp3/,
    'the listing for the folder just left is not left underneath the roots');
});

// A change is announced whenever the folder set moves, which is not the same
// moment as the counts moving: adding a folder that was already scanned
// reports nothing added, and removing one reports nothing removed.
const folderSetChanged = (before, after) =>
  (Array.isArray(before) ? before : []).join('')
  !== (Array.isArray(after) ? after : []).join('');

test('a sweep that changed nothing does not throw the open folder away', async () => {
  const sandbox = folderBrowserSandbox();
  sandbox.state.tree = [
    { id: 'leaf', label: 'ASHES & ECHOES', count: 3, childCount: 0, depth: 0, children: [] },
  ];
  await sandbox.libraryLoadFolderTree(true);
  await sandbox.libraryFolderSelect('leaf');
  assert.equal(paintedRows(sandbox), 3, 'the folder opens with its three files');

  const before = sandbox.state.browseCalls;
  const listing = sandbox.libraryFolderBrowser.browse;
  sandbox.libraryWatchLibraryChanges();
  assert.equal(sandbox.state.listeners.length, 1, 'the announce is subscribed once');

  // The two-minute sweep: nothing added, nothing removed, nothing re-tagged.
  sandbox.state.listeners[0]({
    reason: 'interval', count: 984, added: 0, changed: 0, removed: 0, folders: [],
  });
  // Long enough for the tree reload and the re-fetch it would trigger to land.
  await new Promise((resolve) => setTimeout(resolve, 300));

  // Throwing the listing away and reading it again also fights the user for the
  // pane: every repaint rewrites the row list, so a long album list jumps back
  // to the top twice a minute while it is being read.
  assert.equal(sandbox.state.browseCalls, before,
    'a sweep that found nothing does not re-read the folder the user has open');
  assert.equal(sandbox.libraryFolderBrowser.browse, listing,
    'and leaves the listing it is showing alone');
  assert.equal(paintedRows(sandbox), 3, 'the folder still holds its three files');
});

test('an announce that only moved the folder set still rebuilds the tree', async () => {
  // The counts are all zero here, and `count` is a total rather than a delta:
  // a folder added that was already scanned, or one removed whose files went
  // with it, both move the root list with nothing to add or remove. Guarding
  // this on the counts alone leaves a root the index no longer has.
  const sandbox = folderBrowserSandbox();
  sandbox.state.tree = [
    { id: 'leaf', label: 'ASHES & ECHOES', count: 3, childCount: 0, depth: 0, children: [] },
  ];
  await sandbox.libraryLoadFolderTree(true);
  sandbox.libraryPaintFolderBrowser();
  assert.equal(paintedRows(sandbox), 1, 'one root to start with');

  // The folder set moved, so main's tree has a root it did not have before.
  sandbox.state.tree = [
    { id: 'leaf', label: 'ASHES & ECHOES', count: 3, childCount: 0, depth: 0, children: [] },
    { id: 'added', label: 'Newly added', count: 0, childCount: 0, depth: 0, children: [] },
  ];
  sandbox.libraryWatchLibraryChanges();
  sandbox.state.listeners[0]({
    reason: 'sync', count: 984, added: 0, changed: 0, removed: 0,
    folders: ['C:/Users/a2z/Music/Newly added'],
  });

  await until(() => paintedRows(sandbox) === 2, 800);
  assert.equal(paintedRows(sandbox), 2, 'the rebuilt tree is painted');
  assert.match(sandbox.elements['library-folder-scroll'].innerHTML, /Newly added/);
  assert.deepEqual(sandbox.state.folders, ['C:/Users/a2z/Music/Newly added'],
    'the new folder list reaches the store');
});
