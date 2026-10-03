'use strict';
// Tag writing for the two containers people actually keep a local library in.
//
// Everything here is deliberately boring and explicit: read the existing tag,
// keep the frames we do not manage (album art above all), replace only the ones
// the user edited, write to a temporary file beside the original, and only then
// swap it in. A half-written MP3 is worse than an editor that refuses, so a
// container we cannot rewrite safely is reported as such instead of being
// quietly left alone.

const fs = require('node:fs');
const path = require('node:path');

const MAX_TAG_BYTES = 64 * 1024 * 1024;
const UTF8 = 'utf8';

function syncsafeAt(buffer, offset) {
  return ((buffer[offset] & 0x7f) << 21)
    | ((buffer[offset + 1] & 0x7f) << 14)
    | ((buffer[offset + 2] & 0x7f) << 7)
    | (buffer[offset + 3] & 0x7f);
}

function toSyncsafe(value) {
  const out = Buffer.alloc(4);
  out[0] = (value >>> 21) & 0x7f;
  out[1] = (value >>> 14) & 0x7f;
  out[2] = (value >>> 7) & 0x7f;
  out[3] = value & 0x7f;
  return out;
}

function removeUnsync(buffer) {
  const out = Buffer.alloc(buffer.length);
  let written = 0;
  for (let i = 0; i < buffer.length; i += 1) {
    out[written] = buffer[i];
    written += 1;
    if (buffer[i] === 0xff && buffer[i + 1] === 0x00) i += 1;
  }
  return out.slice(0, written);
}

function containerFor(filePath) {
  const ext = path.extname(filePath || '').toLowerCase();
  if (ext === '.mp3') return 'mp3';
  if (ext === '.flac') return 'flac';
  return '';
}

function canWriteTags(filePath) {
  return containerFor(filePath);
}

// ---------------------------------------------------------------- ID3v2

// Fields we manage, mapped to their ID3v2.4 frames. Anything not in here
// (APIC, SYLT, and whatever a tagger sprayed over the file) is carried across
// untouched, which is why album art survives an edit.
const ID3_TEXT_FRAMES = {
  name: 'TIT2',
  title: 'TIT2',
  artist: 'TPE1',
  album: 'TALB',
  albumArtist: 'TPE2',
  genre: 'TCON',
  year: 'TDRC',
  track: 'TRCK',
  disc: 'TPOS',
  composer: 'TCOM'
};

function parseId3Frames(header, body, major, tagFlags) {
  let data = body;
  if (tagFlags & 0x80) data = removeUnsync(body);
  let offset = 0;
  if (tagFlags & 0x40) {
    // Extended headers are advisory metadata about the tag itself; we do not
    // write one, so we skip the old one and never carry it forward.
    if (major >= 4) offset = syncsafeAt(data, 0) + 4;
    else offset = data.readUInt32BE(0) + 4;
    if (offset < 0 || offset > data.length) offset = 0;
  }
  const frames = [];
  const headerSize = 10;
  while (offset + headerSize <= data.length) {
    const id = data.toString('latin1', offset, offset + 4);
    if (!/^[A-Z0-9]{4}$/.test(id)) break;
    const size = major >= 4
      ? syncsafeAt(data, offset + 4)
      : data.readUInt32BE(offset + 4);
    const start = offset + headerSize;
    if (size < 0 || start + size > data.length) break;
    frames.push({ id, body: Buffer.from(data.slice(start, start + size)) });
    offset = start + size;
  }
  return frames;
}

function encodeTextFrame(frameId, text) {
  const payload = Buffer.concat([Buffer.from([0x03]), Buffer.from(String(text), UTF8)]);
  const out = Buffer.alloc(10);
  out.write(frameId, 0, 'latin1');
  Buffer.concat([toSyncsafe(payload.length)]).copy(out, 4);
  out[8] = 0;
  out[9] = 0;
  return Buffer.concat([out, payload]);
}

function encodeCommentFrame(text) {
  const payload = Buffer.concat([
    Buffer.from([0x03]),
    Buffer.from('eng', 'latin1'),
    Buffer.from([0x00, 0x00]),
    Buffer.from(String(text), UTF8)
  ]);
  const out = Buffer.alloc(10);
  out.write('COMM', 0, 'latin1');
  toSyncsafe(payload.length).copy(out, 4);
  return Buffer.concat([out, payload]);
}

function buildId3Tag(frames) {
  const parts = [];
  for (const frame of frames) parts.push(frame);
  const size = parts.reduce((total, part) => total + part.length, 0);
  const header = Buffer.alloc(10);
  header.write('ID3', 0, 'latin1');
  header[3] = 4; // v2.4 — the version that encodes frame sizes as syncsafe
  header[4] = 0;
  header[5] = 0; // no unsynchronisation, no extended header, no footer
  toSyncsafe(size).copy(header, 6);
  return Buffer.concat([header, ...parts]);
}

function id3FramesFor(fields) {
  const frames = [];
  const seen = new Set();
  for (const [key, frameId] of Object.entries(ID3_TEXT_FRAMES)) {
    if (fields[key] === undefined) continue;
    if (seen.has(frameId)) continue;
    seen.add(frameId);
    const value = String(fields[key] || '').trim();
    if (value) frames.push(encodeTextFrame(frameId, value));
  }
  if (fields.comment !== undefined) {
    const value = String(fields.comment || '').trim();
    if (value) frames.push(encodeCommentFrame(value));
  }
  return { frames, replaced: seen };
}

// ---------------------------------------------------------------- FLAC

function readFlacBlocks(handle) {
  return (async () => {
    const head = Buffer.alloc(4);
    await handle.read(head, 0, 4, 0);
    if (head.toString('latin1') !== 'fLaC') throw new Error('NOT_FLAC');
    const blocks = [];
    let offset = 4;
    let last = false;
    while (!last) {
      const descriptor = Buffer.alloc(4);
      const { bytesRead } = await handle.read(descriptor, 0, 4, offset);
      if (bytesRead < 4) throw new Error('TRUNCATED_FLAC_TAG');
      last = (descriptor[0] & 0x80) !== 0;
      const type = descriptor[0] & 0x7f;
      const length = (descriptor[1] << 16) | (descriptor[2] << 8) | descriptor[3];
      if (length < 0 || length > MAX_TAG_BYTES) throw new Error('FLAC_BLOCK_TOO_LARGE');
      const data = Buffer.alloc(length);
      if (length) {
        const read = await handle.read(data, 0, length, offset + 4);
        if (read.bytesRead !== length) throw new Error('TRUNCATED_FLAC_TAG');
      }
      blocks.push({ type, data });
      offset += 4 + length;
    }
    return { blocks, audioStart: offset };
  })();
}

function encodeFlacBlock(type, data, isLast) {
  const descriptor = Buffer.alloc(4);
  descriptor[0] = (isLast ? 0x80 : 0) | (type & 0x7f);
  descriptor[1] = (data.length >>> 16) & 0xff;
  descriptor[2] = (data.length >>> 8) & 0xff;
  descriptor[3] = data.length & 0xff;
  return Buffer.concat([descriptor, data]);
}

// A Vorbis comment is ONE block holding every field the file has, so building
// it from the edited fields alone would silently drop everything the user did
// not touch — TITLE, ARTIST, DATE, and whatever custom keys a tagger wrote.
// The ID3 path carries untouched frames across; this is the same promise for
// FLAC. Edited fields are overlaid on what was already there, and an emptied
// field removes its key, matching "clearing a frame" on the MP3 side.
//
// `disc` maps to DISCNUMBER. It used to map to TRACKTOTAL, which meant setting
// the disc number on a FLAC overwrote how many discs the album has.
const VORBIS_KEYS = {
  name: 'TITLE',
  title: 'TITLE',
  artist: 'ARTIST',
  album: 'ALBUM',
  albumArtist: 'ALBUMARTIST',
  genre: 'GENRE',
  year: 'DATE',
  track: 'TRACKNUMBER',
  disc: 'DISCNUMBER',
  composer: 'COMPOSER',
  comment: 'COMMENT'
};

function parseVorbisComment(block) {
  const fallback = Buffer.from('Mineradio', UTF8);
  if (!Buffer.isBuffer(block) || block.length < 8) return { vendor: fallback, entries: [] };
  const vendorLength = block.readUInt32LE(0);
  if (vendorLength + 8 > block.length) return { vendor: fallback, entries: [] };
  const vendor = Buffer.from(block.slice(4, 4 + vendorLength));
  let offset = 4 + vendorLength;
  const count = block.readUInt32LE(offset);
  offset += 4;
  const entries = [];
  const seen = new Set();
  for (let i = 0; i < count && offset + 4 <= block.length; i += 1) {
    const length = block.readUInt32LE(offset);
    offset += 4;
    if (length < 0 || offset + length > block.length) break;
    const entry = block.toString(UTF8, offset, offset + length);
    offset += length;
    // Duplicate keys are legal and readers take the first, so keeping the first
    // here is what stops a rewrite from reordering somebody's tagger output.
    const eq = entry.indexOf('=');
    if (eq <= 0) continue;
    const key = entry.slice(0, eq).toUpperCase();
    if (seen.has(key)) continue;
    seen.add(key);
    entries.push({ key, value: entry.slice(eq + 1) });
  }
  return { vendor, entries };
}

function buildVorbisComment(fields, existingBlock) {
  const { vendor, entries } = parseVorbisComment(existingBlock);
  const merged = new Map();
  for (const entry of entries) merged.set(entry.key, entry.value);
  for (const [field, key] of Object.entries(VORBIS_KEYS)) {
    if (fields[field] === undefined) continue;
    const value = String(fields[field] || '').trim();
    if (value) merged.set(key, value);
    else merged.delete(key);
  }
  const encoded = [];
  for (const [key, value] of merged) encoded.push(Buffer.from(`${key}=${value}`, UTF8));
  const parts = [Buffer.alloc(4), vendor, Buffer.alloc(4)];
  parts[0].writeUInt32LE(vendor.length, 0);
  parts[2].writeUInt32LE(encoded.length, 0);
  for (const entry of encoded) {
    const len = Buffer.alloc(4);
    len.writeUInt32LE(entry.length, 0);
    parts.push(len, entry);
  }
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------- write

async function copyRange(sourceHandle, targetHandle, start, end, targetOffset) {
  const chunkSize = 1024 * 1024;
  const buffer = Buffer.alloc(chunkSize);
  let position = start;
  let out = targetOffset;
  while (position < end) {
    const want = Math.min(chunkSize, end - position);
    const { bytesRead } = await sourceHandle.read(buffer, 0, want, position);
    if (bytesRead <= 0) break;
    await targetHandle.write(buffer, 0, bytesRead, out);
    position += bytesRead;
    out += bytesRead;
  }
  return out;
}

// Never edits in place. The original is only replaced once a complete new file
// has been written beside it, so an interrupted write leaves the old tags —
// and the music — exactly as they were.
async function swapInTemp(filePath, build) {
  const temporary = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.mineradio-tags.tmp`
  );
  await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
  let source = null;
  let target = null;
  try {
    source = await fs.promises.open(filePath, 'r');
    target = await fs.promises.open(temporary, 'w');
    const stat = await source.stat();
    const bytesWritten = await build(source, target, stat.size);
    await target.close();
    target = null;
    if (!bytesWritten) throw new Error('EMPTY_TAG_WRITE');
    // Close the reader BEFORE the swap, not in the finally below. On Windows a
    // rename cannot replace a file that any handle still has open, and the
    // source handle we are reading from is exactly such a handle — so the swap
    // failed with EPERM, the catch deleted the new tags, and the finally then
    // closed a handle whose only remaining job had already been rejected. Every
    // save on Windows hit this: the editor reported "Could not write those tags"
    // and the file was left untouched, which is why the writer looked correct
    // and did nothing.
    await source.close();
    source = null;
    await fs.promises.rename(temporary, filePath);
    return true;
  } catch (error) {
    if (target) await target.close().catch(() => {});
    await fs.promises.unlink(temporary).catch(() => {});
    throw error;
  } finally {
    if (source) await source.close().catch(() => {});
  }
}

async function writeId3(filePath, fields) {
  await swapInTemp(filePath, async (source, target) => {
    const header = Buffer.alloc(10);
    const read = await source.read(header, 0, 10, 0);
    let existing = [];
    let audioStart = 0;
    if (read.bytesRead === 10 && header.toString('latin1', 0, 3) === 'ID3') {
      const size = syncsafeAt(header, 6);
      const footer = (header[5] & 0x10) ? 10 : 0;
      if (size + 10 + footer > MAX_TAG_BYTES) throw new Error('ID3_TAG_TOO_LARGE');
      const body = Buffer.alloc(size);
      if (size) {
        const got = await source.read(body, 0, size, 10);
        if (got.bytesRead !== size) throw new Error('TRUNCATED_ID3_TAG');
      }
      existing = parseId3Frames(header, body, header[3], header[5]);
      audioStart = 10 + size + footer;
    }

    const { frames: edited, replaced } = id3FramesFor(fields);
    const carried = existing
      .filter((frame) => !replaced.has(frame.id) && frame.id !== 'COMM')
      .map((frame) => {
        const out = Buffer.alloc(10);
        out.write(frame.id, 0, 'latin1');
        toSyncsafe(frame.body.length).copy(out, 4);
        return Buffer.concat([out, frame.body]);
      });
    const keptComm = fields.comment !== undefined
      ? []
      : existing.filter((frame) => frame.id === 'COMM').map((frame) => {
        const out = Buffer.alloc(10);
        out.write('COMM', 0, 'latin1');
        toSyncsafe(frame.body.length).copy(out, 4);
        return Buffer.concat([out, frame.body]);
      });

    const tag = buildId3Tag(carried.concat(edited, keptComm));
    await target.write(tag, 0, tag.length, 0);
    const end = await copyRange(source, target, audioStart, Infinity, tag.length);
    return end;
  });
}

async function writeFlac(filePath, fields) {
  await swapInTemp(filePath, async (source, target, fileSize) => {
    const { blocks, audioStart } = await readFlacBlocks(source);
    if (audioStart >= fileSize) throw new Error('FLAC_HAS_NO_AUDIO');
    const streamInfo = blocks.filter((block) => block.type === 0);
    if (!streamInfo.length) throw new Error('FLAC_MISSING_STREAMINFO');
    const existingComment = blocks.find((block) => block.type === 4);
    const comment = buildVorbisComment(fields, existingComment && existingComment.data);
    // Rebuild the block list: STREAMINFO first (the spec requires it), then
    // everything else in its original order with our comment where the old one
    // was, or appended when there was not one.
    const others = blocks.filter((block) => block.type !== 0 && block.type !== 4);
    const hadComment = blocks.some((block) => block.type === 4);
    const commentAt = hadComment
      ? blocks.findIndex((block) => block.type === 4)
      : blocks.length;
    const rebuilt = [];
    let commentPlaced = false;
    if (commentAt <= 1) {
      rebuilt.push({ type: 4, data: comment });
      commentPlaced = true;
    }
    rebuilt.push({ type: 0, data: streamInfo[0].data });
    for (let i = 1; i < blocks.length; i += 1) {
      const block = blocks[i];
      if (block.type === 0 || block.type === 4) continue;
      if (!commentPlaced && i >= commentAt) {
        rebuilt.push({ type: 4, data: comment });
        commentPlaced = true;
      }
      rebuilt.push(block);
    }
    if (!commentPlaced) rebuilt.push({ type: 4, data: comment });

    const encoded = rebuilt.map((block, index) => encodeFlacBlock(
      block.type,
      block.data,
      index === rebuilt.length - 1
    ));
    const header = Buffer.from('fLaC', 'latin1');
    const prefix = Buffer.concat([header, ...encoded]);
    await target.write(prefix, 0, prefix.length, 0);
    const end = await copyRange(source, target, audioStart, fileSize, prefix.length);
    return end;
  });
}

// fields: { name, artist, album, albumArtist, genre, year, track, disc, composer, comment }.
// Only the keys present are written; a key present with an empty value clears
// its frame, so "remove the album" is an action and not a no-op.
async function writeAudioTags(filePath, fields) {
  const container = containerFor(filePath);
  if (!container) {
    const error = new Error('TAG_WRITE_UNSUPPORTED_CONTAINER');
    error.code = 'TAG_WRITE_UNSUPPORTED_CONTAINER';
    throw error;
  }
  const stat = await fs.promises.stat(filePath);
  if (!stat.isFile()) {
    const error = new Error('TAG_WRITE_NOT_A_FILE');
    error.code = 'TAG_WRITE_NOT_A_FILE';
    throw error;
  }
  const payload = {};
  for (const [key, value] of Object.entries(fields || {})) {
    if (value === undefined) continue;
    payload[key] = value === null ? '' : String(value);
  }
  if (container === 'mp3') await writeId3(filePath, payload);
  else await writeFlac(filePath, payload);
  return { ok: true, container };
}

module.exports = { writeAudioTags, canWriteTags, containerFor };