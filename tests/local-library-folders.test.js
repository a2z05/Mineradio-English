'use strict';
// A library that could only be filled by re-picking files is a pile, not a
// library. These are the two halves that make it one: a folder the user chose
// becomes a scan root that keeps finding new music on its own, and a layer of
// the user's own — favourites, ratings, counters, playlists — that survives a
// re-tag, a restart and a restore.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { LocalMusicLibrary } = require('../desktop/local-music-library');
const { LocalLibraryUserData } = require('../desktop/local-library-user-data');

function fakeMetadata(library) {
  library.parseMetadata = async (filePath) => ({
    common: {
      title: path.basename(filePath, path.extname(filePath)),
      artist: 'Local Artist',
      album: 'Local Album',
      albumartist: 'Local Artist',
      genre: ['Electronic'],
      year: 2024,
      track: { no: 1, of: 10 },
      disk: { no: 1, of: 2 },
      composer: ['Composer'],
    },
    format: { duration: 1, bitrate: 320000, sampleRate: 44100, codec: 'flac' },
  });
}

function withLibrary(t, run) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mineradio-local-folders-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const library = new LocalMusicLibrary({ userDataPath: path.join(root, 'profile') });
  fakeMetadata(library);
  return run(library, root);
}

test('a registered folder is scanned recursively and keeps finding new subfolders', async (t) => {
  await withLibrary(t, async (library, root) => {
    const music = path.join(root, 'music');
    fs.mkdirSync(path.join(music, 'Album One'), { recursive: true });
    fs.writeFileSync(path.join(music, 'Album One', 'First.flac'), Buffer.from('one'));

    const added = await library.addFolder(music);
    assert.equal(added.ok !== false, true);
    assert.equal(added.folders.length, 1);
    assert.equal(added.count, 0, 'adding a folder records the root; the scan is its own step');

    const scanned = await library.scanFolders();
    assert.equal(scanned.added, 1);
    assert.equal(scanned.tracks[0].localPath, 'Album One/First.flac');
    // The relative path is relative to the ROOT the user chose, not to wherever
    // the file happened to sit — that is what makes grouping stable.
    assert.equal(scanned.folders[0], music);

    // A brand new subdirectory below the root must be found without the user
    // re-picking anything. The old rescan only read the directories its index
    // already knew, so this file would never have appeared.
    fs.mkdirSync(path.join(music, 'Album Two'), { recursive: true });
    fs.writeFileSync(path.join(music, 'Album Two', 'Second.flac'), Buffer.from('two'));
    const again = await library.scanFolders();
    assert.equal(again.added, 1);
    assert.equal(again.count, 2);
    assert.deepEqual(
      again.tracks.map((track) => track.localPath).sort(),
      ['Album One/First.flac', 'Album Two/Second.flac']
    );
  });
});

test('the same folder is never registered twice, and a full drive is not a root', async (t) => {
  await withLibrary(t, async (library, root) => {
    const music = path.join(root, 'music');
    fs.mkdirSync(music, { recursive: true });
    await library.addFolder(music);
    const second = await library.addFolder(music);
    assert.equal(second.folders.length, 1, 'a duplicate root would scan every file twice');

    const missing = await library.addFolder(path.join(root, 'no-such-folder'));
    assert.equal(missing.ok, false);
    assert.equal(missing.error, 'LOCAL_FOLDER_UNREADABLE');
    assert.equal(missing.folders.length, 1);

    // A path is not a folder: importing a directory check happens here, so a
    // renderer bug cannot register an audio file as a scan root.
    const file = path.join(music, 'Song.flac');
    fs.writeFileSync(file, Buffer.from('x'));
    const notADir = await library.addFolder(file);
    assert.equal(notADir.ok, false);
    assert.equal(notADir.error, 'LOCAL_FOLDER_INVALID');
  });
});

test('removing a folder forgets its rows and leaves every file on disk', async (t) => {
  await withLibrary(t, async (library, root) => {
    const music = path.join(root, 'music');
    fs.mkdirSync(music, { recursive: true });
    const audioPath = path.join(music, 'Song.flac');
    fs.writeFileSync(audioPath, Buffer.from('audio'));
    await library.addFolder(music);
    await library.scanFolders();
    assert.equal((await library.listTracksSync()).count, 1);

    const removed = await library.removeFolder(music);
    assert.equal(removed.folders.length, 0);
    assert.equal(removed.count, 0, 'the rows came from that root, so they go with it');
    assert.equal(fs.existsSync(audioPath), true, 'forgetting a folder must never delete music');
    assert.deepEqual((await library.listFoldersSync()).folders, []);

    // The folder is gone from the roots, so a rescan cannot resurrect it.
    const rescan = await library.rescan();
    assert.equal(rescan.count, 0);
  });
});

test('a rescan still reaches files that were imported by hand, with their prefix', async (t) => {
  await withLibrary(t, async (library, root) => {
    const album = path.join(root, 'music', 'Album');
    fs.mkdirSync(album, { recursive: true });
    fs.writeFileSync(path.join(album, 'One.flac'), Buffer.from('one'));
    await library.importFiles([{ path: path.join(album, 'One.flac'), relativePath: 'Album/One.flac' }]);

    // No folders registered at all: the library came from a file picker. The
    // rescan must still find new files beside the old ones AND keep the prefix
    // the first import gave them, or every grouping downstream collapses.
    fs.writeFileSync(path.join(album, 'Two.flac'), Buffer.from('two'));
    const result = await library.rescan();
    assert.equal(result.added, 1);
    assert.deepEqual(
      result.tracks.map((track) => track.localPath),
      ['Album/One.flac', 'Album/Two.flac']
    );
  });
});

// The scanner was taught to reach a library with no registered folder; the
// watcher was not, which meant the same library got a rescan that found new
// files and an fs.watch on nothing at all — automatic sync then meant the
// two-minute safety sweep and nothing else.
test('the watcher is given the same directories the scanner walks', async (t) => {
  await withLibrary(t, async (library, root) => {
    const music = path.join(root, 'music');
    const album = path.join(music, 'Album');
    fs.mkdirSync(album, { recursive: true });
    fs.writeFileSync(path.join(album, 'One.flac'), Buffer.from('one'));
    await library.importFiles([{ path: path.join(album, 'One.flac'), relativePath: 'Album/One.flac' }]);

    assert.deepEqual(library.folders, [], 'this library has no registered folder');
    const roots = library.watchDirectories();
    assert.equal(roots.includes(album), true,
      'the directory the index points at has to be watched, or a file dropped '
      + 'beside it is only noticed by the sweep: ' + JSON.stringify(roots));

    // Registering the parent folds the orphan into the folder it sits under, so
    // one recursive watch covers it rather than two overlapping ones.
    const added = await library.addFolder(music);
    assert.equal(added.ok !== false, true);
    assert.deepEqual(library.watchDirectories(), [music],
      'a directory inside a registered folder is covered by that folder');
  });
});

test('watch roots collapse to one entry per distinct directory', async (t) => {
  await withLibrary(t, async (library, root) => {
    const music = path.join(root, 'music');
    for (const album of ['A', 'B', 'C']) {
      const dir = path.join(music, album);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, `${album}.flac`), Buffer.from(album));
      await library.importFiles([{ path: path.join(dir, `${album}.flac`), relativePath: `${album}/${album}.flac` }]);
    }
    // One folder of three albums is three watch handles, not nine files' worth.
    assert.equal(library.watchDirectories().length, 3);
  });
});

test('the new tag fields ride along into the serialized track', async (t) => {
  await withLibrary(t, async (library, root) => {
    const music = path.join(root, 'music');
    fs.mkdirSync(music, { recursive: true });
    fs.writeFileSync(path.join(music, 'Song.flac'), Buffer.from('x'));
    await library.addFolder(music);
    await library.scanFolders();
    const [track] = (await library.listTracksSync()).tracks;
    assert.equal(track.album, 'Local Album');
    assert.equal(track.albumArtist, 'Local Artist');
    assert.equal(track.genre, 'Electronic');
    assert.equal(track.year, 2024);
    assert.equal(track.track, 1);
    assert.equal(track.disc, 1);
    assert.equal(track.composer, 'Composer');
    assert.ok(track.bitrate > 0, 'a row that cannot show its bitrate cannot explain its size');
    assert.ok(track.sampleRate > 0);
    assert.equal(track.codec, 'flac');
    assert.ok(track.addedAt > 0, 'Recently added needs a first-seen time');

    // Re-tagging must not move the track to the top of Recently added.
    const addedAt = track.addedAt;
    fs.writeFileSync(path.join(music, 'Song.flac'), Buffer.from('different bytes'));
    const again = await library.scanFolders();
    assert.equal(again.changed, 1);
    assert.equal(again.tracks[0].addedAt, addedAt);
  });
});

// A record whose first parse failed used to be frozen there forever. The scan
// skips files whose mtime and size have not moved — correct for a library this
// size — so a single bad read (a locked handle, an interrupted first scan) left
// year 0, bitrate 0 and an empty codec on rows the tag reader reads perfectly
// on the next attempt, and no later scan ever offered it a second chance. In a
// real library that was 923 of 984 tracks.
test('a record that never parsed is retried even when the file has not changed', async (t) => {
  await withLibrary(t, async (library, root) => {
    const music = path.join(root, 'music');
    fs.mkdirSync(music, { recursive: true });
    fs.writeFileSync(path.join(music, 'Song.flac'), Buffer.from('x'));

    // The first pass fails to read the tag. The file itself is fine.
    library.parseMetadata = async () => { throw new Error('reader had a bad day'); };
    await library.addFolder(music);
    const first = await library.scanFolders();
    const broken = first.tracks[0];
    assert.equal(broken.codec, '');
    assert.equal(broken.year, 0);
    assert.ok(broken.localPath, 'the row exists; only its metadata is missing');

    // The reader recovers, and nothing on disk moves. The row has to heal —
    // if it does not, the empty values are permanent, because the file will
    // never look edited to a scan that only compares mtime and size.
    fakeMetadata(library);
    const second = await library.scanFolders();
    const healed = second.tracks.find((track) => track.localPath === broken.localPath);
    assert.ok(healed, 'the track must still be there after the retry');
    assert.equal(healed.codec, 'flac');
    assert.equal(healed.year, 2024);
    assert.equal(healed.track, 1);
    assert.ok(healed.bitrate > 0, 'a row with no bitrate cannot show how big the file is');

    // And once it has parsed, an untouched file goes back to being skipped:
    // otherwise every rescan would re-read the whole library.
    let parses = 0;
    const counting = library.parseMetadata;
    library.parseMetadata = async (filePath) => { parses += 1; return counting(filePath); };
    await library.scanFolders();
    assert.equal(parses, 0, 'a healthy, unchanged file is not re-read on every scan');
  });
});

// The flag only helps libraries written after it existed. An index from an
// older build has no flag at all, and those are exactly the indexes full of
// rows that never got parsed — so the load has to work out which of them to
// retry, once, rather than leaving them empty for the life of the install.
test('an index written before the retry flag existed is healed on the next scan', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mineradio-local-legacy-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const profile = path.join(root, 'profile');
  const music = path.join(root, 'music');
  fs.mkdirSync(music, { recursive: true });
  fs.writeFileSync(path.join(music, 'Song.flac'), Buffer.from('x'));

  const first = new LocalMusicLibrary({ userDataPath: profile });
  fakeMetadata(first);
  await first.addFolder(music);
  await first.scanFolders();

  // Rewrite the index the way an older build would have left it: no flag, and
  // the tag fields a failed parse produces.
  const indexPath = path.join(profile, 'local-music-library.json');
  const raw = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
  for (const record of raw.records) {
    delete record.parseFailed;
    record.codec = '';
    record.year = 0;
    record.bitrate = 0;
  }
  fs.writeFileSync(indexPath, JSON.stringify(raw));

  const reopened = new LocalMusicLibrary({ userDataPath: profile });
  fakeMetadata(reopened);
  let parsed = 0;
  const counting = reopened.parseMetadata;
  reopened.parseMetadata = async (filePath) => { parsed += 1; return counting(filePath); };

  const healed = await reopened.rescan();
  assert.equal(parsed, 1, 'the legacy row is read again even though the file never changed');
  const track = healed.tracks.filter((row) => row.localPath.indexOf('Song') >= 0)[0];
  assert.ok(track, 'the track is still in the library');
  assert.equal(track.codec, 'flac');
  assert.equal(track.year, 2024);
  assert.ok(track.bitrate > 0);

  parsed = 0;
  await reopened.rescan();
  assert.equal(parsed, 0, 'once healed it is skipped like any other unchanged file');
});

test('favourites, ratings and counters survive a reload and never go out of range', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mineradio-local-user-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = path.join(root, 'profile');
  const userData = new LocalLibraryUserData({ userDataPath: store });
  const id = 'a'.repeat(24);

  await userData.setFavorite(id, true);
  await userData.setRating(id, 4);
  // One listen sends one event: 'complete' when it reached the end, 'play'
  // when the listener stopped short, 'skip' when they bailed. A listen that
  // finishes must still count as a play — otherwise the tracks you actually
  // finish never appear in Most played.
  await userData.recordEvent(id, 'complete');

  // Out-of-range ratings collapse to "no rating" rather than storing 9 or -1
  // and rendering a star row nobody can clear.
  assert.equal((await userData.setRating(id, 9)).rating, 0);
  assert.equal((await userData.setRating(id, 4)).rating, 4);
  assert.equal((await userData.setRating('not-an-id', 5)).changed, false);

  const reopened = new LocalLibraryUserData({ userDataPath: store });
  const state = reopened.stateFor(id);
  assert.equal(state.favorite, true, 'a favourite is the user\'s, not the file\'s');
  assert.equal(state.rating, 4);
  assert.equal(state.plays, 1, 'a finished listen counts once, not zero and not twice');
  assert.equal(state.completed, 1);
  assert.equal(state.skips, 0);
  assert.ok(state.lastPlayedAt > 0);

  // A skip is not a listen: it is the signal that the track was rejected.
  await reopened.recordEvent(id, 'skip');
  const afterSkip = reopened.stateFor(id);
  assert.equal(afterSkip.skips, 1);
  assert.equal(afterSkip.plays, 1, 'giving up on a track must not make it "most played"');
});

test('toggling a favourite twice lands back where it started', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mineradio-local-fav-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const userData = new LocalLibraryUserData({ userDataPath: path.join(root, 'profile') });
  const id = 'b'.repeat(24);
  assert.equal((await userData.toggleFavorite(id)).favorite, true);
  assert.equal((await userData.toggleFavorite(id)).favorite, false);
});

test('playlists are created, reordered, renamed and persist across reloads', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mineradio-local-pl-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = path.join(root, 'profile');
  const userData = new LocalLibraryUserData({ userDataPath: store });

  const created = await userData.createPlaylist('Road trip');
  assert.equal(created.ok, true);
  const playlistId = created.playlist.id;

  await userData.addToPlaylist(playlistId, ['c'.repeat(24), 'd'.repeat(24), 'c'.repeat(24)]);
  let playlist = userData.getPlaylist(playlistId);
  assert.deepEqual(playlist.trackIds, ['c'.repeat(24), 'd'.repeat(24)], 'a duplicate add is a no-op');

  const reordered = await userData.reorderPlaylist(playlistId, 1, 0);
  assert.equal(reordered.ok, true);
  assert.deepEqual(userData.getPlaylist(playlistId).trackIds, ['d'.repeat(24), 'c'.repeat(24)]);
  assert.equal((await userData.reorderPlaylist(playlistId, 0, 99)).error, 'BAD_INDEX');

  await userData.updatePlaylist(playlistId, { name: 'Long drives' });
  await userData.removeFromPlaylist(playlistId, ['d'.repeat(24)]);

  const reopened = new LocalLibraryUserData({ userDataPath: store });
  const loaded = reopened.getPlaylist(playlistId);
  assert.equal(loaded.name, 'Long drives');
  assert.deepEqual(loaded.trackIds, ['c'.repeat(24)], 'the list must be as it was left');

  const copy = await reopened.duplicatePlaylist(playlistId);
  assert.equal(copy.ok, true);
  assert.notEqual(copy.playlist.id, playlistId);
  assert.equal(copy.playlist.name, 'Long drives copy');
  assert.deepEqual(copy.playlist.trackIds, loaded.trackIds);

  const deleted = await reopened.deletePlaylist(playlistId);
  assert.equal(deleted.removed, 1);
  assert.equal(reopened.getPlaylist(playlistId), null);
  assert.equal(reopened.listPlaylists().length, 1, 'the copy is untouched by deleting its source');
});

test('an unknown playlist op is refused instead of mutating the wrong thing', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mineradio-local-badpl-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const userData = new LocalLibraryUserData({ userDataPath: path.join(root, 'profile') });
  const missing = await userData.addToPlaylist('nope', ['a'.repeat(24)]);
  assert.equal(missing.ok, false);
  assert.equal(missing.error, 'PLAYLIST_NOT_FOUND');
});

test('a backup restores a favourite and merges instead of wiping new playlists', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mineradio-local-bk-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = path.join(root, 'profile');
  const userData = new LocalLibraryUserData({ userDataPath: store });
  const id = 'e'.repeat(24);
  await userData.setFavorite(id, true);
  await userData.setRating(id, 5);
  await userData.recordEvent(id, 'play');
  const backup = userData.backupPayload();
  assert.equal(backup.kind, 'mineradio-local-library');

  // Made AFTER the backup was taken. A restore that replaces wholesale would
  // quietly delete it, which is the classic way a backup destroys data.
  const later = await userData.createPlaylist('After backup');

  const fresh = new LocalLibraryUserData({ userDataPath: path.join(root, 'profile2') });
  const restored = await fresh.restorePayload(backup);
  assert.equal(restored.ok, true);
  assert.equal(fresh.stateFor(id).favorite, true);
  assert.equal(fresh.stateFor(id).rating, 5);
  assert.equal(fresh.stateFor(id).plays, 1);
  assert.equal(fresh.listPlaylists().length, 0);

  const merge = await userData.restorePayload(backup);
  assert.equal(merge.ok, true);
  assert.ok(
    userData.listPlaylists().some((playlist) => playlist.id === later.playlist.id),
    'restoring an older backup must not delete a playlist made since'
  );

  assert.equal((await userData.restorePayload({ nonsense: true })).ok, false);
  assert.equal((await userData.restorePayload(null)).ok, false);
});

test('clearing history zeros the counters without touching a favourite', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mineradio-local-hist-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const userData = new LocalLibraryUserData({ userDataPath: path.join(root, 'profile') });
  const id = 'f'.repeat(24);
  await userData.setFavorite(id, true);
  await userData.recordEvent(id, 'play');
  const cleared = await userData.clearHistory();
  assert.equal(cleared.cleared, 1);
  const state = userData.stateFor(id);
  assert.equal(state.favorite, true, 'clearing plays is not unfavouriting everything');
  assert.equal(state.plays, 0);
  assert.equal(state.lastPlayedAt, 0);
});
