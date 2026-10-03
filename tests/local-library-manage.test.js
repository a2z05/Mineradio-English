'use strict';
// The saved local library could be filled but never emptied, and it could only
// ever be re-filled by re-picking every folder. That shape came from the
// original release: the main process has had removeTracks() the whole time and
// nothing could reach it — tests/local-music-library-persistence.test.js:270
// actually asserted the IPC channel did NOT exist, on the grounds that
// deleting a library entry was too easy to do by accident. These tests are the
// other half of that decision: removal and refresh exist, both are reachable
// from the browsable panel, and neither touches a file on disk.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { namedFunctionSource } = require('./helpers/extract-function');
const { LocalMusicLibrary } = require('../desktop/local-music-library');

const appRoot = path.resolve(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(appRoot, p), 'utf8');

const librarySource = read('public/js/modules/06-lyrics/07-local-library.js');
const searchSource = read('public/js/modules/05-playback/07-search.js');
const mainSource = read('desktop/main.js');
const preloadSource = read('desktop/preload.js');

function fakeMetadata(library) {
  library.parseMetadata = async (filePath) => ({
    common: { title: path.basename(filePath, path.extname(filePath)), artist: 'Local Artist' },
    format: { duration: 1 },
  });
}

function withLibrary(t, run) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mineradio-local-manage-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const library = new LocalMusicLibrary({ userDataPath: path.join(root, 'profile') });
  fakeMetadata(library);
  return run(library, root);
}

test('removeTracks drops the index entry and its cached cover, and never the audio file', async (t) => {
  await withLibrary(t, async (library, root) => {
    const audioPath = path.join(root, 'Keep.flac');
    const doomedPath = path.join(root, 'Doomed.flac');
    fs.writeFileSync(audioPath, Buffer.from('keep'));
    fs.writeFileSync(doomedPath, Buffer.from('doomed'));
    const imported = await library.importFiles([{ path: audioPath }, { path: doomedPath }]);
    assert.equal(imported.count, 2);
    const doomedId = localIdFor(imported.tracks, 'Doomed');
    const doomedRecord = library.records.get(doomedId);

    // Give it a cover the way an import with an embedded picture would, so the
    // cleanup path is actually exercised.
    const coverPath = path.join(library.coverDirectory, `${doomedId}.png`);
    fs.mkdirSync(library.coverDirectory, { recursive: true });
    fs.writeFileSync(coverPath, Buffer.from('cover-bytes'));
    doomedRecord.coverPath = coverPath;

    const after = await library.removeTracks([`local:${doomedId}`]);
    assert.equal(after.removed, 1);
    assert.equal(after.count, 1);
    assert.deepEqual(after.tracks.map((track) => track.name), ['Keep']);
    assert.equal(fs.existsSync(coverPath), false, 'our cached cover copy is ours to delete');
    assert.equal(fs.existsSync(doomedPath), true, 'the user file must survive being forgotten');
    assert.equal(fs.existsSync(audioPath), true);

    // The removal is committed to disk, not just to memory.
    const reopened = new LocalMusicLibrary({ userDataPath: path.join(root, 'profile') }).listTracksSync();
    assert.deepEqual(reopened.tracks.map((track) => track.name), ['Keep']);
  });
});

test('removeTracks ignores anything that is not a library id', async (t) => {
  await withLibrary(t, async (library, root) => {
    const audioPath = path.join(root, 'Song.flac');
    fs.writeFileSync(audioPath, Buffer.from('audio'));
    await library.importFiles([{ path: audioPath }]);
    // Paths, ids of the wrong shape, and an empty request must all be no-ops:
    // a renderer bug must not be able to turn this into a file operation.
    for (const junk of [[], [''], ['C:\\Windows\\System32\\drivers\\etc\\hosts'], ['../../etc/passwd'], ['ZZZZ' + 'a'.repeat(20)]]) {
      const result = await library.removeTracks(junk);
      assert.equal(result.removed, 0, `unexpected removal for ${JSON.stringify(junk)}`);
      assert.equal(result.count, 1);
    }
  });
});

test('rescan picks up new files, re-reads edited ones and forgets deleted ones', async (t) => {
  await withLibrary(t, async (library, root) => {
    const albumDirectory = path.join(root, 'music', 'Album');
    fs.mkdirSync(albumDirectory, { recursive: true });
    const first = path.join(albumDirectory, 'One.flac');
    const second = path.join(albumDirectory, 'Two.flac');
    fs.writeFileSync(first, Buffer.from('one'));
    await library.importFiles([{ path: first, relativePath: 'Album/One.flac' }]);

    // Unchanged: nothing is re-parsed and nothing changes.
    let parsed = 0;
    const counting = library.parseMetadata;
    library.parseMetadata = async (filePath) => { parsed += 1; return counting(filePath); };
    const noop = await library.rescan();
    assert.equal(noop.added, 0);
    assert.equal(noop.changed, 0);
    assert.equal(noop.removed, 0);
    assert.equal(parsed, 0, 'a rescan of a 500-track library must not re-read every tag');

    // A file dropped in beside its siblings arrives in the same folder, not as
    // a bare filename — the relative path is the only grouping the index has.
    fs.writeFileSync(second, Buffer.from('two'));
    const added = await library.rescan();
    assert.equal(added.added, 1);
    assert.equal(added.count, 2);
    assert.deepEqual(added.tracks.map((track) => track.localPath), ['Album/One.flac', 'Album/Two.flac']);

    // An edited file is re-tagged, and its media revision changes with it.
    const twoId = localIdFor(added.tracks, 'Two');
    const revisionBefore = library.records.get(twoId).revision;
    fs.writeFileSync(second, Buffer.from('two-edited-and-longer'));
    const edited = await library.rescan();
    assert.equal(edited.changed, 1);
    assert.equal(edited.added, 0);
    assert.notEqual(library.records.get(twoId).revision, revisionBefore);

    // A deleted file stops being a row that can never play.
    fs.unlinkSync(first);
    const pruned = await library.rescan();
    assert.equal(pruned.removed, 1);
    assert.deepEqual(pruned.tracks.map((track) => track.name), ['Two']);
    assert.equal(fs.existsSync(second), true);

    // ...and the result is committed, not just held in memory.
    const reopened = new LocalMusicLibrary({ userDataPath: path.join(root, 'profile') }).listTracksSync();
    assert.deepEqual(reopened.tracks.map((track) => track.name), ['Two']);
  });
});

test('rescan leaves the library alone when a folder cannot be read', async (t) => {
  await withLibrary(t, async (library, root) => {
    const directory = path.join(root, 'Music');
    fs.mkdirSync(directory, { recursive: true });
    const audioPath = path.join(directory, 'Song.flac');
    fs.writeFileSync(audioPath, Buffer.from('audio'));
    await library.importFiles([{ path: audioPath, relativePath: 'Song.flac' }]);

    // A folder that has gone away is "gone" in the same way a deleted file is —
    // but a folder that is merely unreadable (unplugged drive, permissions) is
    // NOT evidence that the tracks are gone, and must not empty the library.
    const readdir = fs.promises.readdir;
    fs.promises.readdir = async (target, ...rest) => {
      if (path.resolve(String(target)) === path.resolve(directory)) throw new Error('EPERM');
      return readdir(target, ...rest);
    };
    t.after(() => { fs.promises.readdir = readdir; });
    const result = await library.rescan();
    assert.equal(result.removed, 0);
    assert.equal(result.count, 1);
  });
});

test('rescan on an empty library is a no-op rather than an error', async (t) => {
  await withLibrary(t, async (library) => {
    const result = await library.rescan();
    assert.equal(result.ok, true);
    assert.equal(result.count, 0);
    assert.equal(result.added, 0);
  });
});

test('a folder that has gone away takes its rows with it, as the comment above says', async (t) => {
  await withLibrary(t, async (library, root) => {
    const directory = path.join(root, 'Music');
    fs.mkdirSync(directory, { recursive: true });
    const audioPath = path.join(directory, 'Song.flac');
    fs.writeFileSync(audioPath, Buffer.from('audio'));
    await library.importFiles([{ path: audioPath, relativePath: 'Song.flac' }]);

    // The folder is renamed away. Nothing here is a permissions problem and
    // nothing will bring the path back, so the row under it can never play —
    // which is what the test above's own comment says a rescan is for.
    //
    // No folder was ever registered, so this directory reaches the walk as an
    // orphan root: the case a library gets into when it was filled by file
    // picker rather than by adding a folder, and the only case the real index
    // was in.
    fs.renameSync(directory, path.join(root, 'Music renamed'));
    const pruned = await library.rescan();
    assert.equal(pruned.removed, 1, 'the row under a folder that is not there any more');
    assert.equal(pruned.count, 0);
  });
});

test('a registered folder that is missing keeps its rows — an unplugged drive comes back', async (t) => {
  await withLibrary(t, async (library, root) => {
    const directory = path.join(root, 'Music');
    fs.mkdirSync(directory, { recursive: true });
    const audioPath = path.join(directory, 'Song.flac');
    fs.writeFileSync(audioPath, Buffer.from('audio'));
    await library.addFolder(directory);
    await library.importFiles([{ path: audioPath, relativePath: 'Song.flac' }]);

    // The folder the user chose is not there this instant. That is the shape a
    // missing drive letter and a permissions failure both take, and the rows
    // under it carry play counts that nothing can rebuild once they are gone.
    fs.renameSync(directory, path.join(root, 'Music away'));
    const result = await library.rescan();
    assert.equal(result.removed, 0, 'a folder the user registered is not emptied because it is briefly absent');
    assert.equal(result.count, 1);
  });
});

test('both channels are reachable from the renderer, and neither takes a path', () => {
  assert.match(preloadSource, /removeLocalMusicTracks/);
  assert.match(preloadSource, /rescanLocalMusicLibrary/);
  assert.match(mainSource, /ipcMain\.handle\('mineradio-local-library-remove'/);
  assert.match(mainSource, /ipcMain\.handle\('mineradio-local-library-rescan'/);
  // The rescanner walks only directories its own index already points at, so
  // there is deliberately nothing for the renderer to name a path with.
  const rescanHandler = mainSource.slice(
    mainSource.indexOf("ipcMain.handle('mineradio-local-library-rescan'"),
    mainSource.indexOf('function pruneLocalMusicImportCapabilities')
  );
  assert.doesNotMatch(rescanHandler, /payload/);
  assert.doesNotMatch(rescanHandler, /readdir|glob|walk/i);
});

test('the refresh button re-reads the folders and says what changed', () => {
  assert.match(namedFunctionSource(librarySource, 'refreshLocalLibraryResults'),
    /rescanLocalMusicLibrary/);
  assert.match(namedFunctionSource(librarySource, 'localLibraryHeadHtml'),
    /refreshLocalLibraryResults\(\)/);
  // A second press while one is running must not fire a second disk walk.
  assert.match(librarySource, /if \(localLibraryRefreshing\) return;/);
  // Both buttons live in one flex row now, so the two of them cannot push the
  // count out of the panel.
  assert.match(namedFunctionSource(librarySource, 'localLibraryHeadHtml'),
    /search-local-head-actions/);
  // An emptied library must fall through to the empty state, not render nothing.
  assert.match(namedFunctionSource(librarySource, 'refreshLocalLibraryResults'),
    /showLocalLibraryEmpty\(\)/);
});

test('a forget control appears on library rows only, and never deletes the file', () => {
  assert.match(namedFunctionSource(searchSource, 'searchSongResultHtml'),
    /forgetLocalLibraryResult\(/);
  // Remote results must not grow a control that does nothing for them.
  const guard = searchSource.slice(
    searchSource.indexOf('function isLocalLibrarySong'),
    searchSource.indexOf('function isLocalLibrarySong') + 400
  );
  assert.match(guard, /provider === 'local' \|\| song\.source === 'local' \|\| song\.localKey \|\| song\.localFileId/);
  assert.match(namedFunctionSource(searchSource, 'searchSongResultHtml'),
    /searchLastResultQuery === 'local-library'/);

  const forget = namedFunctionSource(librarySource, 'forgetLocalLibraryResult');
  assert.match(forget, /removeLocalMusicTracks/);
  // Removal re-renders from the main process answer, so the panel and the
  // on-disk index can never disagree about what is left.
  assert.match(forget, /persistentLocalLibraryTracks = tracks\.map\(cloneSong\)/);
  assert.match(forget, /still on disk/, 'the user has to be told the file was not deleted');
});

test('the old guard against a remove channel is now the opposite assertion', () => {
  const persistence = read('tests/local-music-library-persistence.test.js');
  // The original release asserted this channel could not exist. Now it must,
  // and the assertion has to say so — a silently flipped guard is worse than
  // either version of it.
  assert.match(persistence, /assert\.match\(preload, \/removeLocalMusicTracks\/\)/);
  assert.doesNotMatch(persistence, /assert\.doesNotMatch\(preload, \/mineradio-local-library-remove\/\)/);
});

function localIdFor(tracks, name) {
  const track = tracks.find((candidate) => candidate.name === name);
  assert.ok(track, `no imported track named ${name}`);
  return track.localFileId;
}
