'use strict';
// Tag writing. The editor's whole promise is that what it shows is what lands
// on disk and nothing else moves — so these tests read the file back from disk
// rather than trusting a return value, and every one of them would have caught
// the bug where the write never happened at all.
//
// The bug: swapInTemp closed its read handle in a `finally` that ran after the
// rename. On Windows a rename cannot replace a file any handle still has open,
// so every save failed with EPERM, the catch deleted the new tags, and the
// editor reported "Could not write those tags" while the file sat untouched.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { writeAudioTags, canWriteTags, containerFor } = require('../desktop/local-tag-writer');

const AUDIO = Buffer.alloc(8192, 0x11);

// ------------------------------------------------------------- fixtures

function syncsafe(value) {
  return Buffer.from([
    (value >>> 21) & 0x7f,
    (value >>> 14) & 0x7f,
    (value >>> 7) & 0x7f,
    value & 0x7f,
  ]);
}

// A v2.3 frame carries a plain 32-bit size; v2.4 carries a syncsafe one. Real
// libraries hold both, and reading one as the other silently truncates the tag.
function frame(id, payload, major) {
  const head = Buffer.alloc(10);
  head.write(id, 0, 'latin1');
  if (major >= 4) syncsafe(payload.length).copy(head, 4);
  else head.writeUInt32BE(payload.length, 4);
  return Buffer.concat([head, payload]);
}

function text(value) {
  return Buffer.concat([Buffer.from([0x00]), Buffer.from(value, 'utf8')]);
}

function buildMp3(major, frames) {
  const body = Buffer.concat(frames);
  const header = Buffer.alloc(10);
  header.write('ID3', 0, 'latin1');
  header[3] = major;
  header[4] = 0;
  header[5] = 0;
  syncsafe(body.length).copy(header, 6);
  return Buffer.concat([header, body, AUDIO]);
}

// APIC: encoding, mime type, NUL, picture type, description, then the image.
function apic(magic) {
  return Buffer.concat([
    Buffer.from([0x00]),
    Buffer.from('image/jpeg', 'latin1'),
    Buffer.from([0x00, 0x03]),
    Buffer.from('cover', 'latin1'),
    Buffer.from([0x00]),
    Buffer.from(magic, 'latin1'),
  ]);
}

// USLT: encoding, language, description NUL, then the lyrics.
function uslt(magic) {
  return Buffer.concat([
    Buffer.from([0x00]),
    Buffer.from('eng', 'latin1'),
    Buffer.from([0x00]),
    Buffer.from('desc', 'latin1'),
    Buffer.from([0x00]),
    Buffer.from(magic, 'latin1'),
  ]);
}

function flacBlock(type, data, last) {
  const descriptor = Buffer.alloc(4);
  descriptor[0] = (last ? 0x80 : 0) | (type & 0x7f);
  descriptor[1] = (data.length >>> 16) & 0xff;
  descriptor[2] = (data.length >>> 8) & 0xff;
  descriptor[3] = data.length & 0xff;
  return Buffer.concat([descriptor, data]);
}

function buildFlac(withComment) {
  const blocks = [];
  blocks.push(flacBlock(0, Buffer.alloc(34), false)); // STREAMINFO, required
  if (withComment) {
    // vendor "Test", plus one standard and one custom key — the custom one is
    // the case a rebuild from the edited fields alone would silently delete.
    const vendor = Buffer.from('Test', 'utf8');
    const entries = ['ARTIST=Someone', 'MOOD=late night']
      .map((s) => Buffer.from(s, 'utf8'));
    const u32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32LE(n, 0); return b; };
    const parts = [u32(vendor.length), vendor, u32(entries.length)];
    for (const entry of entries) parts.push(u32(entry.length), entry);
    blocks.push(flacBlock(4, Buffer.concat(parts), false));
  }
  blocks.push(flacBlock(1, Buffer.alloc(64), true)); // PADDING, last
  return Buffer.concat([Buffer.from('fLaC', 'latin1'), ...blocks, AUDIO]);
}

function withTemp(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mineradio-tags-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function readTags(filePath) {
  const b = fs.readFileSync(filePath);
  assert.equal(b.toString('latin1', 0, 3), 'ID3', 'still an ID3 file');
  const major = b[3];
  const size = ((b[6] & 0x7f) << 21) | ((b[7] & 0x7f) << 14) | ((b[8] & 0x7f) << 7) | (b[9] & 0x7f);
  const frames = new Map();
  let off = 10;
  const end = 10 + size;
  while (off + 10 <= end) {
    const id = b.toString('latin1', off, off + 4);
    if (!/^[A-Z0-9]{4}$/.test(id)) break;
    const len = major >= 4
      ? ((b[off + 4] & 0x7f) << 21) | ((b[off + 5] & 0x7f) << 14) | ((b[off + 6] & 0x7f) << 7) | (b[off + 7] & 0x7f)
      : b.readUInt32BE(off + 4);
    frames.set(id, b.slice(off + 10, off + 10 + len));
    off += 10 + len;
  }
  return { major, frames, audio: b.slice(10 + size) };
}

// ------------------------------------------------------------------ the write

// This is the one. Before the fix it failed with EPERM on Windows because the
// read handle was still open when the rename ran.
test('a save replaces the file on disk instead of refusing to touch it', async (t) => {
  const dir = withTemp(t);
  const file = path.join(dir, 'song.mp3');
  fs.writeFileSync(file, buildMp3(3, [
    frame('TIT2', text('Original Title'), 3),
    frame('TPE1', text('Original Artist'), 3),
    frame('TALB', text('Original Album'), 3),
    frame('APIC', apic('APIC-MAGIC-BYTES'), 3),
    frame('USLT', uslt('LYRICS-MAGIC-BYTES'), 3),
  ]));
  const before = fs.readFileSync(file);

  const result = await writeAudioTags(file, { composer: 'New Composer' });
  assert.equal(result.ok, true);
  assert.equal(result.container, 'mp3');

  const after = fs.readFileSync(file);
  assert.ok(after.includes(Buffer.from('New Composer')),
    'the new tag must be readable straight off the disk, not just in the answer');
  assert.ok(!before.equals(after), 'the file has to have actually changed');

  const parsed = readTags(file);
  assert.ok(parsed.audio.equals(AUDIO), 'audio bytes are byte-for-byte untouched');
  assert.equal(parsed.frames.get('TIT2').includes(Buffer.from('Original Title')), true,
    'a tag you did not edit must survive the rewrite');
  assert.equal(parsed.frames.get('TPE1').includes(Buffer.from('Original Artist')), true);
  assert.equal(parsed.frames.get('APIC').includes(Buffer.from('APIC-MAGIC-BYTES')), true,
    'album art is carried across, which is the frame people lose first');
  assert.equal(parsed.frames.get('USLT').includes(Buffer.from('LYRICS-MAGIC-BYTES')), true,
    'embedded lyrics are carried across too');

  // The temporary file beside the original is gone — no half-written leftovers
  // sitting in the user's music folder.
  assert.deepEqual(fs.readdirSync(dir), ['song.mp3']);
});

test('a v2.4 input is read as v2.4, not as the v2.3 size layout', async (t) => {
  const dir = withTemp(t);
  const file = path.join(dir, 'modern.mp3');
  // A frame whose syncsafe size differs from its plain 32-bit reading, so a
  // container mix-up would corrupt the parse rather than merely miscount.
  const payload = Buffer.concat([text('A'.repeat(300))]);
  fs.writeFileSync(file, buildMp3(4, [
    frame('TIT2', text('Kept Title'), 4),
    frame('TXXX', payload, 4),
  ]));

  const result = await writeAudioTags(file, { album: 'Fresh Album' });
  assert.equal(result.ok, true);
  const parsed = readTags(file);
  assert.ok(parsed.audio.equals(AUDIO), 'audio untouched');
  assert.equal(parsed.frames.get('TIT2').includes(Buffer.from('Kept Title')), true,
    'the second frame was after the edited one — misparsing its size would drop it');
  assert.ok(parsed.frames.has('TXXX'), 'frames after the edit must still be found');
  assert.equal(parsed.frames.get('TALB').includes(Buffer.from('Fresh Album')), true);
});

test('the rewrite reads back as ID3v2.4', async (t) => {
  const dir = withTemp(t);
  const file = path.join(dir, 'old.mp3');
  fs.writeFileSync(file, buildMp3(3, [frame('TIT2', text('T'), 3)]));
  await writeAudioTags(file, { composer: 'C' });
  assert.equal(readTags(file).major, 4, 'the editor says it writes ID3v2.4');
});

// ------------------------------------------------------------------ clearing

test('an emptied field clears its frame rather than leaving the old value', async (t) => {
  const dir = withTemp(t);
  const file = path.join(dir, 'song.mp3');
  fs.writeFileSync(file, buildMp3(3, [
    frame('TALB', text('Album To Remove'), 3),
    frame('TIT2', text('Title'), 3),
  ]));

  await writeAudioTags(file, { album: '' });
  const parsed = readTags(file);
  assert.equal(parsed.frames.has('TALB'), false,
    '"remove the album" has to be an action, not a no-op that keeps writing the old value');
  assert.equal(parsed.frames.get('TIT2').includes(Buffer.from('Title')), true,
    'clearing one field must not disturb the others');
});

// ------------------------------------------------------------------ refusal

test('a container this build cannot rewrite is refused, not silently kept', async (t) => {
  const dir = withTemp(t);
  for (const name of ['song.ogg', 'song.wav', 'song.m4a', 'song.opus', 'song.flac.txt']) {
    const file = path.join(dir, name);
    fs.writeFileSync(file, Buffer.from('not really'));
    const before = fs.readFileSync(file);
    await assert.rejects(() => writeAudioTags(file, { name: 'X' }),
      (error) => error.code === 'TAG_WRITE_UNSUPPORTED_CONTAINER',
      name + ' must be refused');
    assert.ok(fs.readFileSync(file).equals(before), name + ' must be untouched');
    assert.equal(canWriteTags(file), '');
    assert.equal(containerFor(file), '');
  }
  assert.equal(canWriteTags('a/b/c.MP3'), 'mp3', 'case does not change the container');
});

test('a path that is not a regular file is refused', async (t) => {
  const dir = withTemp(t);
  // Named like a track on purpose: an extension-less directory is caught by the
  // container check first, and this is the case that has to reach the stat.
  const folder = path.join(dir, 'folder.mp3');
  fs.mkdirSync(folder);
  await assert.rejects(() => writeAudioTags(folder, { name: 'X' }),
    (error) => error.code === 'TAG_WRITE_NOT_A_FILE');
  await assert.rejects(() => writeAudioTags(path.join(dir, 'absent.mp3'), { name: 'X' }),
    (error) => error.code === 'ENOENT');
});

// ------------------------------------------------------- failure leaves no mess

test('a write that fails part way leaves the original exactly as it was', async (t) => {
  const dir = withTemp(t);
  const file = path.join(dir, 'song.mp3');
  // A tag header claiming to be over the 64MB ceiling, so the parse refuses
  // after the temporary file has already been created beside the original.
  const header = Buffer.alloc(10);
  header.write('ID3', 0, 'latin1');
  header[3] = 3;
  syncsafe(64 * 1024 * 1024).copy(header, 6);
  const original = Buffer.concat([header, AUDIO]);
  fs.writeFileSync(file, original);

  await assert.rejects(() => writeAudioTags(file, { composer: 'X' }),
    (error) => error.message === 'ID3_TAG_TOO_LARGE');
  assert.ok(fs.readFileSync(file).equals(original),
    'an interrupted write must leave the old tags and the music exactly as they were');
  assert.deepEqual(fs.readdirSync(dir), ['song.mp3'],
    'the temporary file is cleaned up rather than left beside the user\'s music');
});

// --------------------------------------------------------------------- FLAC

test('a FLAC write lands, keeps STREAMINFO first, and keeps its audio', async (t) => {
  const dir = withTemp(t);
  const file = path.join(dir, 'song.flac');
  fs.writeFileSync(file, buildFlac(false));
  assert.equal(containerFor(file), 'flac');

  const result = await writeAudioTags(file, { composer: 'Flac Composer', album: 'Flac Album' });
  assert.equal(result.ok, true);
  assert.equal(result.container, 'flac');

  const after = fs.readFileSync(file);
  assert.equal(after.toString('latin1', 0, 4), 'fLaC');
  assert.ok(after.includes(Buffer.from('COMPOSER=Flac Composer')));
  assert.ok(after.includes(Buffer.from('ALBUM=Flac Album')));
  assert.ok(after.subarray(after.length - AUDIO.length).equals(AUDIO), 'audio untouched');
  // STREAMINFO has to stay the first block or the file is unreadable.
  assert.equal(after[4] & 0x7f, 0, 'the first block is still STREAMINFO');
  assert.deepEqual(fs.readdirSync(dir), ['song.flac']);
});

test('a FLAC write carries an existing vorbis comment through', async (t) => {
  const dir = withTemp(t);
  const file = path.join(dir, 'song.flac');
  fs.writeFileSync(file, buildFlac(true));

  await writeAudioTags(file, { composer: 'Added Later' });
  const after = fs.readFileSync(file);
  assert.ok(after.includes(Buffer.from('ARTIST=Someone')),
    'fields the user did not edit keep their value — a FLAC holds every field in '
    + 'one block, so rebuilding it from the edit alone erases them');
  assert.ok(after.includes(Buffer.from('MOOD=late night')),
    'a key this app does not even know about is somebody else\'s tag and survives');
  assert.ok(after.includes(Buffer.from('COMPOSER=Added Later')));
  assert.ok(after.subarray(after.length - AUDIO.length).equals(AUDIO));
});

test('clearing a FLAC field removes just that key', async (t) => {
  const dir = withTemp(t);
  const file = path.join(dir, 'song.flac');
  fs.writeFileSync(file, buildFlac(true));

  await writeAudioTags(file, { artist: '' });
  const after = fs.readFileSync(file);
  assert.ok(!after.includes(Buffer.from('ARTIST=Someone')),
    'the emptied key is gone — substring-safe, since ALBUMARTIST= contains ARTIST=');
  assert.ok(after.includes(Buffer.from('MOOD=late night')),
    'and the keys beside it are not swept away with it');
});

test('a FLAC with no audio is refused instead of producing an empty file', async (t) => {
  const dir = withTemp(t);
  const file = path.join(dir, 'broken.flac');
  fs.writeFileSync(file, Buffer.concat([
    Buffer.from('fLaC', 'latin1'),
    flacBlock(0, Buffer.alloc(34), true),
  ]));
  const before = fs.readFileSync(file);
  // FLAC refuses by message; the ID3 path uses error.code. The main process
  // reports whichever is set, so both reach the user the same way.
  await assert.rejects(() => writeAudioTags(file, { composer: 'X' }),
    (error) => error.message === 'FLAC_HAS_NO_AUDIO');
  assert.ok(fs.readFileSync(file).equals(before));
});

test('the disc number does not overwrite the disc total on a FLAC', async (t) => {
  const dir = withTemp(t);
  const file = path.join(dir, 'song.flac');
  fs.writeFileSync(file, buildFlac(false));

  await writeAudioTags(file, { disc: '2', track: '3' });
  const after = fs.readFileSync(file);
  assert.ok(after.includes(Buffer.from('DISCNUMBER=2')),
    'disc goes to DISCNUMBER — it used to land on TRACKTOTAL and erase how many discs the set has');
  assert.ok(!after.includes(Buffer.from('TRACKTOTAL=2')));
  assert.ok(after.includes(Buffer.from('TRACKNUMBER=3')));
});

// ------------------------------------------------------------------- comment

test('a comment is written as its own frame and the other frames survive', async (t) => {
  const dir = withTemp(t);
  const file = path.join(dir, 'song.mp3');
  fs.writeFileSync(file, buildMp3(3, [
    frame('TIT2', text('Title'), 3),
    frame('TXXX', Buffer.from('unrelated', 'latin1'), 3),
  ]));

  await writeAudioTags(file, { comment: 'hello comment' });
  const parsed = readTags(file);
  assert.equal(parsed.frames.has('COMM'), true, 'the comment has its own frame');
  assert.ok(parsed.frames.get('COMM').includes(Buffer.from('hello comment')));
  assert.equal(parsed.frames.get('TXXX').includes(Buffer.from('unrelated')), true);
  assert.equal(parsed.frames.get('TIT2').includes(Buffer.from('Title')), true);
});

test('the declared tag size matches the frames actually written', async (t) => {
  const dir = withTemp(t);
  const file = path.join(dir, 'song.mp3');
  fs.writeFileSync(file, buildMp3(3, [
    frame('TIT2', text('Padding padding padding padding padding'), 3),
  ]));
  await writeAudioTags(file, { composer: 'X' });

  const b = fs.readFileSync(file);
  const declared = ((b[6] & 0x7f) << 21) | ((b[7] & 0x7f) << 14) | ((b[8] & 0x7f) << 7) | (b[9] & 0x7f);
  // Walk the frames and confirm they fill the declared size exactly, so no
  // reader walks off the end into the audio looking for a frame that is not
  // there.
  let off = 10;
  const end = 10 + declared;
  let count = 0;
  while (off + 10 <= end) {
    const id = b.toString('latin1', off, off + 4);
    if (!/^[A-Z0-9]{4}$/.test(id)) break;
    const len = ((b[off + 4] & 0x7f) << 21) | ((b[off + 5] & 0x7f) << 14)
      | ((b[off + 6] & 0x7f) << 7) | (b[off + 7] & 0x7f);
    off += 10 + len;
    count += 1;
  }
  assert.ok(count >= 2, 'both the kept and the edited frame are present');
  assert.equal(off, end, 'the frames fill the tag exactly — no padding gap, no overrun');
  assert.ok(b.slice(end).equals(AUDIO), 'what follows the tag is the audio, untouched');
});
