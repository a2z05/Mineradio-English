'use strict';
// Steps 12 and 13 for files on this device: where a cover comes from, and
// where lyrics come from, in the order each is asked for.
//
// The artwork chain used to have a hole in the middle — embedded, then
// cached, with no such thing as the cover sitting in the folder — so an album
// of files with no picture tag showed a placeholder while folder.jpg sat right
// there. And a plain-text lyric file was never looked at at all. Both are read
// from disk here, against real files, because the interesting part is the
// ORDER and what survives a reload.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  LocalMusicLibrary,
  FOLDER_ARTWORK_BASENAMES,
  looksLikeLyricText,
} = require('../desktop/local-music-library');

const ONE_PIXEL_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC1lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64'
);

// A pixel that differs from the first, so a test can say which of two images
// actually won rather than only that something did.
function otherPng() {
  const bytes = Buffer.from(ONE_PIXEL_PNG);
  bytes[bytes.length - 1] ^= 1;
  return bytes;
}

const LYRIC_SHAPE = 'First line of the song\nSecond line of the song\nThird line of the song';

function bareMetadata(common) {
  return async () => ({ common: common || {}, format: { duration: 1 } });
}

async function coverBytes(library, track) {
  const response = await library.mediaResponse(new Request(track.cover));
  assert.equal(response.status, 200, 'the cover URL answers: ' + track.cover);
  return Buffer.from(await response.arrayBuffer());
}

function albumFixture(root, names) {
  const album = path.join(root, 'Album');
  fs.mkdirSync(album, { recursive: true });
  for (const name of names) fs.writeFileSync(path.join(album, name), 'audio');
  return album;
}

function openLibrary(profile, common) {
  return new LocalMusicLibrary({
    userDataPath: profile,
    parseMetadata: bareMetadata(common),
  });
}

// ---------------------------------------------------------------- artwork

test('a cover in the folder is used when the file itself carries none', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mr-artwork-folder-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const album = albumFixture(root, ['One.flac', 'Two.flac']);
  fs.writeFileSync(path.join(album, 'cover.png'), ONE_PIXEL_PNG);

  const library = openLibrary(path.join(root, 'profile'));
  const imported = await library.importFiles([
    { path: path.join(album, 'One.flac') },
    { path: path.join(album, 'Two.flac') },
  ]);
  assert.equal(imported.count, 2);
  for (const track of imported.tracks) {
    assert.match(track.cover, /^mineradio-local:\/\/cover\//,
      'both tracks get a cover from the folder, not a placeholder');
  }
  assert.deepEqual(await coverBytes(library, imported.tracks[0]), ONE_PIXEL_PNG,
    'what is served is the file that was in the folder');
  assert.deepEqual(await coverBytes(library, imported.tracks[1]), ONE_PIXEL_PNG);
});

test('a folder cover is copied once for the album, not once per track', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mr-artwork-shared-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const album = albumFixture(root, ['01.flac', '02.flac', '03.flac', '04.flac']);
  fs.writeFileSync(path.join(album, 'cover.png'), ONE_PIXEL_PNG);

  const library = openLibrary(path.join(root, 'profile'));
  const imported = await library.importFiles(
    ['01.flac', '02.flac', '03.flac', '04.flac'].map((name) => ({ path: path.join(album, name) }))
  );
  const onDisk = new Set(imported.tracks.map((track) => library.records.get(track.localFileId).coverPath));
  assert.equal(onDisk.size, 1, 'four tracks, one file — not four copies of the same image');
  assert.ok(fs.existsSync([...onDisk][0]));
  // Every track still gets its own URL, because the URL names the track.
  assert.equal(new Set(imported.tracks.map((track) => track.cover)).size, 4);
});

test('an embedded picture beats one sitting in the folder', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mr-artwork-embedded-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const album = albumFixture(root, ['Tagged.flac', 'Untagged.flac']);
  const folderArt = otherPng();
  fs.writeFileSync(path.join(album, 'cover.png'), folderArt);

  const library = openLibrary(path.join(root, 'profile'));
  library.parseMetadata = async (filePath) => ({
    common: {
      title: path.basename(filePath, '.flac'),
      picture: path.basename(filePath) === 'Tagged.flac'
        ? [{ format: 'image/png', data: ONE_PIXEL_PNG }]
        : [],
    },
    format: { duration: 1 },
  });
  const imported = await library.importFiles([
    { path: path.join(album, 'Tagged.flac') },
    { path: path.join(album, 'Untagged.flac') },
  ]);
  const tagged = imported.tracks.find((track) => track.name === 'Tagged');
  const untagged = imported.tracks.find((track) => track.name === 'Untagged');
  assert.deepEqual(await coverBytes(library, tagged), ONE_PIXEL_PNG, 'the tag wins');
  assert.deepEqual(await coverBytes(library, untagged), folderArt, 'the folder is the fallback');
});

test('cover.jpg is preferred over folder.jpg when a folder has both', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mr-artwork-names-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const album = albumFixture(root, ['Song.flac']);
  const preferred = ONE_PIXEL_PNG;
  const other = otherPng();
  // Written in the order that would lose if readdir order decided the answer,
  // so the ranking in the code is what the test actually measures.
  fs.writeFileSync(path.join(album, 'folder.png'), other);
  fs.writeFileSync(path.join(album, 'cover.png'), preferred);

  const library = openLibrary(path.join(root, 'profile'));
  const imported = await library.importFiles([{ path: path.join(album, 'Song.flac') }]);
  assert.deepEqual(await coverBytes(library, imported.tracks[0]), preferred,
    'cover beats folder, whatever order the directory listing came back in');
  assert.ok(FOLDER_ARTWORK_BASENAMES.indexOf('cover') < FOLDER_ARTWORK_BASENAMES.indexOf('folder'));
});

test('artwork dropped in later is picked up by a rescan, and keeps working once the file is gone', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mr-artwork-cached-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const album = albumFixture(root, ['Song.flac']);
  const coverPath = path.join(album, 'cover.png');
  const profile = path.join(root, 'profile');

  const library = openLibrary(profile);
  const first = await library.importFiles([{ path: path.join(album, 'Song.flac') }]);
  assert.equal(first.tracks[0].cover, '', 'nothing to show yet, and that is the placeholder rung');

  // The rung between embedded and cached: the user drops a cover in the folder
  // after the album was imported.
  fs.writeFileSync(coverPath, ONE_PIXEL_PNG);
  const second = await library.importFiles([{ path: path.join(album, 'Song.flac') }]);
  assert.match(second.tracks[0].cover, /^mineradio-local:\/\/cover\//);
  assert.deepEqual(await coverBytes(library, second.tracks[0]), ONE_PIXEL_PNG);

  // Now the cached rung: the folder file disappears, the album keeps its art.
  fs.unlinkSync(coverPath);
  const third = await library.importFiles([{ path: path.join(album, 'Song.flac') }]);
  assert.equal(third.tracks[0].cover, second.tracks[0].cover,
    'the copy already in the cache is still there');
  assert.deepEqual(await coverBytes(library, third.tracks[0]), ONE_PIXEL_PNG);

  // And when the folder image comes back as a different one, the folder is
  // asked again rather than the stale copy winning for ever.
  const replacement = otherPng();
  fs.writeFileSync(coverPath, replacement);
  const fourth = await library.importFiles([{ path: path.join(album, 'Song.flac') }]);
  assert.deepEqual(await coverBytes(library, fourth.tracks[0]), replacement,
    'what is in the folder now beats what was cached from before');
});

test('taking one track out does not take the album cover with it', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mr-artwork-remove-one-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const album = albumFixture(root, ['One.flac', 'Two.flac', 'Three.flac']);
  fs.writeFileSync(path.join(album, 'cover.png'), ONE_PIXEL_PNG);

  const library = openLibrary(path.join(root, 'profile'));
  const imported = await library.importFiles(['One.flac', 'Two.flac', 'Three.flac']
    .map((name) => ({ path: path.join(album, name) })));
  const sharedCoverPath = library.records.get(
    imported.tracks.find((track) => track.name === 'One').localFileId
  ).coverPath;

  const doomed = imported.tracks.find((track) => track.name === 'One').localFileId;
  await library.removeTracks([doomed]);
  assert.equal(library.records.has(doomed), false, 'the track is gone');

  const survivors = library.listTracksSync().tracks;
  assert.equal(survivors.length, 2);
  for (const track of survivors) {
    assert.deepEqual(await coverBytes(library, track), ONE_PIXEL_PNG,
      'the cover belongs to the folder, and the folder is still there');
  }

  // And when the last two go with it, the file goes too.
  await library.removeTracks(survivors.map((track) => track.localFileId));
  assert.equal(fs.existsSync(sharedCoverPath), false,
    'nothing points at it any more, so it is not left behind');
});

test('retagging one track does not blank the rest of the album', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mr-artwork-shared-remove-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const album = albumFixture(root, ['One.flac', 'Two.flac', 'Three.flac']);
  const folderImage = path.join(album, 'cover.png');
  fs.writeFileSync(folderImage, ONE_PIXEL_PNG);

  const library = openLibrary(path.join(root, 'profile'));
  await library.importFiles(['One.flac', 'Two.flac', 'Three.flac']
    .map((name) => ({ path: path.join(album, name) })));
  // The source goes away too, so nothing can quietly rebuild the copy: from
  // here the cached rung is the only thing keeping the album's art alive.
  fs.unlinkSync(folderImage);

  // One of them grows a tag of its own and moves off the shared file.
  library.parseMetadata = async (filePath) => ({
    common: {
      title: path.basename(filePath, '.flac'),
      picture: path.basename(filePath) === 'One.flac'
        ? [{ format: 'image/png', data: otherPng() }]
        : [],
    },
    format: { duration: 1 },
  });
  const retagged = await library.importFiles([{ path: path.join(album, 'One.flac') }]);
  const one = retagged.tracks.find((track) => track.name === 'One');
  assert.deepEqual(await coverBytes(library, one), otherPng(), 'the tag took over its own track');

  library.parseMetadata = bareMetadata();
  const reimported = await library.importFiles([
    { path: path.join(album, 'Two.flac') },
    { path: path.join(album, 'Three.flac') },
  ]);
  // importFiles answers with the whole library, not just what was handed to it.
  const others = reimported.tracks.filter((track) => track.name !== 'One');
  assert.equal(others.length, 2);
  for (const track of others) {
    assert.deepEqual(await coverBytes(library, track), ONE_PIXEL_PNG,
      'the other two keep the folder cover the retag must not have deleted');
  }

  // Taking the last two out is what finally lets the shared file go.
  const sharedCoverPath = library.records.get(
    others.find((track) => track.name === 'Two').localFileId
  ).coverPath;
  await library.removeTracks(others.map((track) => track.localFileId));
  assert.equal(fs.existsSync(sharedCoverPath), false,
    'the folder copy goes once no track points at it any more');
  assert.ok(fs.existsSync(library.records.get(one.localFileId).coverPath),
    'the track that brought its own art keeps it');
});

// ---------------------------------------------------------------- lyrics

test('a plain-text lyric file beside the track is used, and survives a reload', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mr-lyrics-plain-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const album = albumFixture(root, ['Song.flac']);
  fs.writeFileSync(path.join(album, 'Song.txt'), String.fromCharCode(0xfeff) + LYRIC_SHAPE, 'utf8');
  const profile = path.join(root, 'profile');

  const library = openLibrary(profile);
  const imported = await library.importFiles([{ path: path.join(album, 'Song.flac') }]);
  assert.equal(imported.tracks[0].hasLyric, true, 'a .txt counts as an offline source');
  assert.equal(imported.tracks[0].lyricSource, 'sidecar');
  assert.equal(Object.hasOwn(imported.tracks[0], 'lyric'), false,
    'the text rides in the manifest, not in every row of every list');
  assert.equal(library.lyricForTrack(imported.tracks[0].localFileId).lyric, LYRIC_SHAPE,
    'the byte-order mark is not part of the first line');

  // The allowlist in loadIndex is what would silently drop this on reload.
  const reopened = new LocalMusicLibrary({
    userDataPath: profile,
    parseMetadata: async () => { throw new Error('reload must use the manifest'); },
  });
  const reloaded = reopened.listTracksSync();
  assert.equal(reloaded.tracks[0].hasLyric, true);
  assert.equal(reloaded.tracks[0].lyricSource, 'sidecar');
  assert.equal(reopened.lyricForTrack(reloaded.tracks[0].localFileId).lyric, LYRIC_SHAPE);
});

test('a text file that is not a lyric is ignored rather than shown as one', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mr-lyrics-notes-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const album = albumFixture(root, ['Song.flac']);
  for (const note of ['see booklet for credits', 'ripped from my own CD\n2003', '[ar:Someone]\n[ti:Something]']) {
    fs.writeFileSync(path.join(album, 'Song.txt'), note, 'utf8');
    const library = openLibrary(path.join(root, 'profile-' + note.length));
    const imported = await library.importFiles([{ path: path.join(album, 'Song.flac') }]);
    assert.equal(imported.tracks[0].hasLyric, false,
      'not a lyric: ' + JSON.stringify(note));
    assert.equal(imported.tracks[0].lyricSource, '');
  }
});

test('the tag is asked before a text file, and an .lrc before either', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mr-lyrics-priority-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const album = albumFixture(root, ['Tagged.flac', 'Plain.flac']);
  fs.writeFileSync(path.join(album, 'Tagged.txt'), LYRIC_SHAPE, 'utf8');
  fs.writeFileSync(path.join(album, 'Plain.txt'), LYRIC_SHAPE, 'utf8');
  fs.writeFileSync(path.join(album, 'Plain.lrc'), '[00:01.000]From the sidecar', 'utf8');

  const library = openLibrary(path.join(root, 'profile'));
  library.parseMetadata = async (filePath) => ({
    common: {
      title: path.basename(filePath, '.flac'),
      lyrics: [{ text: 'From the tag' }],
    },
    format: { duration: 1 },
  });
  const imported = await library.importFiles([
    { path: path.join(album, 'Tagged.flac') },
    { path: path.join(album, 'Plain.flac') },
  ]);
  const tagged = imported.tracks.find((track) => track.name === 'Tagged');
  const plain = imported.tracks.find((track) => track.name === 'Plain');
  assert.equal(library.lyricForTrack(tagged.localFileId).lyric, 'From the tag',
    'an official tag beats a text file that happens to share the name');
  assert.equal(tagged.lyricSource, 'embedded');
  assert.equal(library.lyricForTrack(plain.localFileId).lyric, '[00:01.000]From the sidecar',
    'a synchronized file the user placed there beats everything');
  assert.equal(plain.lyricSource, 'sidecar');
});

test('a text file with timestamps in it is taken even on its own', () => {
  assert.equal(looksLikeLyricText('[00:12.50]One line and nothing else'), true);
  assert.equal(looksLikeLyricText(LYRIC_SHAPE), true);
  assert.equal(looksLikeLyricText('[ar:Band]\n[ti:Song]\n' + LYRIC_SHAPE), true,
    'the metadata header is not counted against it');
  assert.equal(looksLikeLyricText(''), false);
  assert.equal(looksLikeLyricText('   \n\n  '), false);
  assert.equal(looksLikeLyricText('see booklet for credits'), false);
  assert.equal(looksLikeLyricText('[ar:Band]\n[ti:Song]'), false, 'a header on its own is not a lyric');
  assert.equal(looksLikeLyricText('one\ntwo'), false, 'two words is a note, not a song');
});
