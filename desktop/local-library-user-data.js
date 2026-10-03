'use strict';
// Everything about a track that is the USER'S, rather than the file's: the
// star, the rating, the play counters, and the playlists they made. Tags live
// in the library index because they are read back off disk; none of this is,
// and re-tagging a file must never reset a favourite or a play count.
//
// Keys are the library id (the same 24-char id the index uses) rather than a
// path, so a moved file keeps its rating. A key that no longer resolves to a
// track is kept, not swept: the file may come back on the next scan, and a
// restored backup should not need re-favouriting.

const fs = require('node:fs');
const path = require('node:path');

const STORE_VERSION = 1;
const MAX_PLAYLISTS = 500;
const MAX_PLAYLIST_TRACKS = 20000;
const MAX_HISTORY = 2000;
const MAX_TEXT = 400;

function cleanText(value, fallback = '', max = MAX_TEXT) {
  if (typeof value !== 'string') return fallback;
  const trimmed = value.replace(/\s+/g, ' ').trim();
  if (!trimmed) return fallback;
  return trimmed.slice(0, max);
}

function cleanId(value) {
  const id = cleanText(value, '', 64).replace(/^local:/, '').toLowerCase();
  return /^[a-f0-9]{24}$/.test(id) ? id : '';
}

function cleanIdList(value, max) {
  const seen = new Set();
  const out = [];
  for (const entry of Array.isArray(value) ? value : []) {
    const id = cleanId(entry);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
    if (out.length >= max) break;
  }
  return out;
}

function cleanCount(value) {
  const count = Number(value);
  return Number.isFinite(count) && count > 0 ? Math.floor(count) : 0;
}

function cleanStamp(value) {
  const stamp = Number(value);
  return Number.isFinite(stamp) && stamp > 0 ? Math.floor(stamp) : 0;
}

// Ratings are stars, deliberately: a 0-10 scale invites people to write 7.5 and
// then argue about whether that is the same as 8.
function cleanRating(value) {
  const rating = Math.round(Number(value));
  return Number.isFinite(rating) && rating >= 1 && rating <= 5 ? rating : 0;
}

function sanitizePlaylist(playlist, index) {
  const source = playlist && typeof playlist === 'object' ? playlist : {};
  return {
    id: cleanText(source.id, `pl-${index + 1}-${cleanText(source.name, 'Playlist').toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 24)}`, 80),
    name: cleanText(source.name, `Playlist ${index + 1}`),
    trackIds: cleanIdList(source.trackIds, MAX_PLAYLIST_TRACKS),
    createdAt: cleanStamp(source.createdAt) || Date.now(),
    updatedAt: cleanStamp(source.updatedAt) || cleanStamp(source.createdAt) || Date.now(),
  };
}

class LocalLibraryUserData {
  constructor(options = {}) {
    const userDataPath = String(options.userDataPath || '');
    this.userDataPath = userDataPath;
    this.storePath = userDataPath ? path.join(userDataPath, 'local-library-user-data.json') : '';
    this.songs = new Map();
    this.playlists = [];
    this.mutation = Promise.resolve();
    this.load();
  }

  load() {
    this.songs = new Map();
    this.playlists = [];
    if (!this.storePath) return;
    let parsed = null;
    try {
      parsed = JSON.parse(fs.readFileSync(this.storePath, 'utf8'));
    } catch (_) {
      return;
    }
    if (!parsed || typeof parsed !== 'object') return;
    const songs = parsed.songs && typeof parsed.songs === 'object' ? parsed.songs : {};
    for (const [key, value] of Object.entries(songs)) {
      const id = cleanId(key);
      if (!id || !value || typeof value !== 'object') continue;
      this.songs.set(id, {
        favorite: value.favorite === true,
        rating: cleanRating(value.rating),
        plays: cleanCount(value.plays),
        skips: cleanCount(value.skips),
        completed: cleanCount(value.completed),
        lastPlayedAt: cleanStamp(value.lastPlayedAt),
        addedAt: cleanStamp(value.addedAt),
      });
    }
    this.playlists = (Array.isArray(parsed.playlists) ? parsed.playlists : [])
      .slice(0, MAX_PLAYLISTS)
      .map(sanitizePlaylist);
  }

  snapshot() {
    return {
      ok: true,
      songs: Object.fromEntries(this.songs),
      playlists: this.playlists.map((playlist) => ({ ...playlist, trackIds: playlist.trackIds.slice() })),
    };
  }

  serialize() {
    return {
      version: STORE_VERSION,
      savedAt: Date.now(),
      songs: Object.fromEntries(this.songs),
      playlists: this.playlists.map((playlist) => ({ ...playlist, trackIds: playlist.trackIds.slice() })),
    };
  }

  async persist() {
    if (!this.storePath) return;
    const payload = JSON.stringify(this.serialize());
    const temporary = `${this.storePath}.tmp`;
    await fs.promises.mkdir(path.dirname(this.storePath), { recursive: true });
    await fs.promises.writeFile(temporary, payload, 'utf8');
    await fs.promises.rename(temporary, this.storePath);
  }

  // Every write goes through one chain so two rapid clicks cannot interleave a
  // read-modify-write and lose the second change.
  enqueue(operation) {
    const pending = this.mutation.then(operation, operation);
    this.mutation = pending.catch(() => {});
    return pending;
  }

  entry(id) {
    const key = cleanId(id);
    if (!key) return null;
    if (!this.songs.has(key)) {
      this.songs.set(key, {
        favorite: false, rating: 0, plays: 0, skips: 0, completed: 0, lastPlayedAt: 0, addedAt: Date.now(),
      });
    }
    return this.songs.get(key);
  }

  stateFor(id) {
    const existing = this.songs.get(cleanId(id));
    if (!existing) return { favorite: false, rating: 0, plays: 0, skips: 0, completed: 0, lastPlayedAt: 0 };
    return { ...existing };
  }

  setFavorite(id, favorite) {
    return this.enqueue(async () => {
      const entry = this.entry(id);
      if (!entry) return { ...this.stateFor(id), changed: false };
      entry.favorite = favorite !== false;
      await this.persist();
      return { ...entry, changed: true };
    });
  }

  toggleFavorite(id) {
    return this.enqueue(async () => {
      const entry = this.entry(id);
      if (!entry) return { ...this.stateFor(id), changed: false };
      entry.favorite = !entry.favorite;
      await this.persist();
      return { ...entry, changed: true };
    });
  }

  setRating(id, rating) {
    return this.enqueue(async () => {
      const entry = this.entry(id);
      if (!entry) return { ...this.stateFor(id), changed: false };
      entry.rating = cleanRating(rating);
      await this.persist();
      return { ...entry, changed: true };
    });
  }

  // One call per playback event, from one place, so "played" means the same
  // thing in the counters, in Recently Played and in Most Played. The two
  // counters are independent on purpose: a track that starts and is then
  // skipped is a play AND a skip, and a track that finishes is a play AND a
  // completion — counting the completion as a second play would double every
  // song that actually reaches the end.
  recordEvent(id, event) {
    const kind = event === 'skip' ? 'skip' : (event === 'complete' ? 'complete' : 'play');
    return this.enqueue(async () => {
      const entry = this.entry(id);
      if (!entry) return { ...this.stateFor(id), changed: false };
      if (kind === 'skip') {
        // A skip is not a listen. Counting it would make "Most played" a list
        // of the tracks you give up on fastest.
        entry.skips += 1;
      } else {
        // Every listen counts once, whether or not it reached the end — the
        // renderer sends exactly one event per listen, 'complete' or 'play'.
        entry.plays += 1;
        if (kind === 'complete') entry.completed += 1;
      }
      entry.lastPlayedAt = Date.now();
      await this.persist();
      return { ...entry, changed: true };
    });
  }

  // Counters for tracks whose tags were re-read: the file identity is the id,
  // so nothing here needs migrating when a file moves.
  stateMap(ids) {
    const out = {};
    for (const id of Array.isArray(ids) ? ids : []) {
      const key = cleanId(id);
      if (key && this.songs.has(key)) out[key] = { ...this.songs.get(key) };
    }
    return out;
  }

  listPlaylists() {
    return this.playlists.map((playlist) => ({ ...playlist, trackIds: playlist.trackIds.slice() }));
  }

  getPlaylist(id) {
    const wanted = cleanText(id, '', 80);
    const found = this.playlists.find((playlist) => playlist.id === wanted);
    return found ? { ...found, trackIds: found.trackIds.slice() } : null;
  }

  createPlaylist(name, id) {
    return this.enqueue(async () => {
      if (this.playlists.length >= MAX_PLAYLISTS) {
        return { ok: false, error: 'TOO_MANY_PLAYLISTS', playlists: this.listPlaylists() };
      }
      const playlist = sanitizePlaylist({
        id: id || `pl-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
        name: name || 'New playlist',
        trackIds: [],
        createdAt: Date.now(),
        updatedAt: Date.now(),
      }, this.playlists.length);
      this.playlists = this.playlists.concat([playlist]);
      await this.persist();
      return { ok: true, playlist: { ...playlist, trackIds: [] }, playlists: this.listPlaylists() };
    });
  }

  updatePlaylist(id, patch) {
    return this.enqueue(async () => {
      const wanted = cleanText(id, '', 80);
      const index = this.playlists.findIndex((playlist) => playlist.id === wanted);
      if (index < 0) return { ok: false, error: 'PLAYLIST_NOT_FOUND', playlists: this.listPlaylists() };
      const current = this.playlists[index];
      if (patch && Array.isArray(patch.trackIds)) {
        this.playlists[index] = sanitizePlaylist({
          ...current,
          name: patch.name === undefined ? current.name : patch.name,
          trackIds: patch.trackIds,
          updatedAt: Date.now(),
        }, index);
      } else if (patch && patch.name !== undefined) {
        this.playlists[index] = sanitizePlaylist({ ...current, name: patch.name, updatedAt: Date.now() }, index);
      }
      await this.persist();
      return { ok: true, playlist: this.getPlaylist(wanted), playlists: this.listPlaylists() };
    });
  }

  deletePlaylist(id) {
    return this.enqueue(async () => {
      const wanted = cleanText(id, '', 80);
      const before = this.playlists.length;
      this.playlists = this.playlists.filter((playlist) => playlist.id !== wanted);
      const removed = before - this.playlists.length;
      if (removed) await this.persist();
      return { ok: true, removed, playlists: this.listPlaylists() };
    });
  }

  duplicatePlaylist(id) {
    return this.enqueue(async () => {
      const source = this.getPlaylist(id);
      if (!source) return { ok: false, error: 'PLAYLIST_NOT_FOUND', playlists: this.listPlaylists() };
      if (this.playlists.length >= MAX_PLAYLISTS) {
        return { ok: false, error: 'TOO_MANY_PLAYLISTS', playlists: this.listPlaylists() };
      }
      const copy = sanitizePlaylist({
        ...source,
        id: `pl-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
        name: `${source.name} copy`,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      }, this.playlists.length);
      this.playlists = this.playlists.concat([copy]);
      await this.persist();
      return { ok: true, playlist: copy, playlists: this.listPlaylists() };
    });
  }

  addToPlaylist(id, trackIds) {
    return this.enqueue(async () => {
      const wanted = cleanText(id, '', 80);
      const index = this.playlists.findIndex((playlist) => playlist.id === wanted);
      if (index < 0) return { ok: false, error: 'PLAYLIST_NOT_FOUND', playlists: this.listPlaylists() };
      const additions = cleanIdList(trackIds, MAX_PLAYLIST_TRACKS);
      if (!additions.length) return { ok: true, playlist: this.getPlaylist(wanted), playlists: this.listPlaylists(), added: 0 };
      const current = this.playlists[index];
      const merged = current.trackIds.slice();
      const present = new Set(merged);
      let added = 0;
      for (const trackId of additions) {
        if (present.has(trackId)) continue;
        if (merged.length >= MAX_PLAYLIST_TRACKS) break;
        present.add(trackId);
        merged.push(trackId);
        added += 1;
      }
      this.playlists[index] = sanitizePlaylist({ ...current, trackIds: merged, updatedAt: Date.now() }, index);
      await this.persist();
      return { ok: true, playlist: this.getPlaylist(wanted), playlists: this.listPlaylists(), added };
    });
  }

  removeFromPlaylist(id, trackIds) {
    return this.enqueue(async () => {
      const wanted = cleanText(id, '', 80);
      const index = this.playlists.findIndex((playlist) => playlist.id === wanted);
      if (index < 0) return { ok: false, error: 'PLAYLIST_NOT_FOUND', playlists: this.listPlaylists() };
      const removals = new Set(cleanIdList(trackIds, MAX_PLAYLIST_TRACKS));
      if (!removals.size) return { ok: true, playlist: this.getPlaylist(wanted), playlists: this.listPlaylists(), removed: 0 };
      const current = this.playlists[index];
      const kept = current.trackIds.filter((trackId) => !removals.has(trackId));
      const removed = current.trackIds.length - kept.length;
      this.playlists[index] = sanitizePlaylist({ ...current, trackIds: kept, updatedAt: Date.now() }, index);
      await this.persist();
      return { ok: true, playlist: this.getPlaylist(wanted), playlists: this.listPlaylists(), removed };
    });
  }

  reorderPlaylist(id, fromIndex, toIndex) {
    return this.enqueue(async () => {
      const wanted = cleanText(id, '', 80);
      const index = this.playlists.findIndex((playlist) => playlist.id === wanted);
      if (index < 0) return { ok: false, error: 'PLAYLIST_NOT_FOUND', playlists: this.listPlaylists() };
      const current = this.playlists[index];
      const from = Math.trunc(Number(fromIndex));
      const to = Math.trunc(Number(toIndex));
      if (!Number.isInteger(from) || !Number.isInteger(to)) {
        return { ok: false, error: 'BAD_INDEX', playlist: this.getPlaylist(wanted), playlists: this.listPlaylists() };
      }
      if (from < 0 || from >= current.trackIds.length || to < 0 || to >= current.trackIds.length) {
        return { ok: false, error: 'BAD_INDEX', playlist: this.getPlaylist(wanted), playlists: this.listPlaylists() };
      }
      const next = current.trackIds.slice();
      const [moved] = next.splice(from, 1);
      next.splice(to, 0, moved);
      this.playlists[index] = sanitizePlaylist({ ...current, trackIds: next, updatedAt: Date.now() }, index);
      await this.persist();
      return { ok: true, playlist: this.getPlaylist(wanted), playlists: this.listPlaylists() };
    });
  }

  // A backup is the whole file verbatim: restoring it must be able to put back
  // a rating or a play count, not just the library rows.
  backupPayload() {
    return {
      kind: 'mineradio-local-library',
      version: STORE_VERSION,
      exportedAt: Date.now(),
      userData: this.serialize(),
    };
  }

  // Restore merges rather than replaces unless asked: a backup taken before the
  // user made two new playlists should not silently delete them.
  restorePayload(payload, options = {}) {
    return this.enqueue(async () => {
      const incoming = payload && payload.userData ? payload.userData : payload;
      if (!incoming || typeof incoming !== 'object') {
        return { ok: false, error: 'BAD_BACKUP', playlists: this.listPlaylists() };
      }
      // Anything that does not actually look like a backup is refused rather
      // than "merged". An empty merge would look like success and leave the
      // user believing their favourite came back when nothing was written.
      // The shape decides, not the label: a truncated download still carries
      // `kind`, and key names alone prove nothing about the content behind
      // them. The two halves are read below with a fallback to {} and [], and
      // under replace those fallbacks are deletions — so a payload missing a
      // half is refused when it would be destructive, and accepted when it
      // would only add. An empty but well-formed backup is content and still
      // replaces; a missing one is not.
      const usableSongs = !!incoming.songs && typeof incoming.songs === 'object'
        && !Array.isArray(incoming.songs);
      const usablePlaylists = Array.isArray(incoming.playlists);
      const looksLikeBackup = options.replace
        ? (usableSongs && usablePlaylists)
        : (usableSongs || usablePlaylists);
      if (!looksLikeBackup) {
        return { ok: false, error: 'BAD_BACKUP', playlists: this.listPlaylists() };
      }
      if (options.replace) {
        this.songs = new Map();
        this.playlists = [];
      }
      const songs = usableSongs ? incoming.songs : {};
      for (const [key, value] of Object.entries(songs)) {
        const id = cleanId(key);
        if (!id || !value || typeof value !== 'object') continue;
        this.songs.set(id, {
          favorite: value.favorite === true,
          rating: cleanRating(value.rating),
          plays: cleanCount(value.plays),
          skips: cleanCount(value.skips),
          completed: cleanCount(value.completed),
          lastPlayedAt: cleanStamp(value.lastPlayedAt),
          addedAt: cleanStamp(value.addedAt) || Date.now(),
        });
      }
      const playlists = Array.isArray(incoming.playlists) ? incoming.playlists : [];
      for (let i = 0; i < playlists.length && this.playlists.length < MAX_PLAYLISTS; i += 1) {
        const sanitized = sanitizePlaylist(playlists[i], this.playlists.length);
        const at = this.playlists.findIndex((playlist) => playlist.id === sanitized.id);
        if (at >= 0) this.playlists[at] = sanitized;
        else this.playlists.push(sanitized);
      }
      await this.persist();
      return { ok: true, songs: Object.fromEntries(this.songs), playlists: this.listPlaylists() };
    });
  }

  clearHistory() {
    return this.enqueue(async () => {
      let changed = 0;
      for (const entry of this.songs.values()) {
        if (entry.plays || entry.skips || entry.lastPlayedAt) changed += 1;
        entry.plays = 0;
        entry.skips = 0;
        entry.completed = 0;
        entry.lastPlayedAt = 0;
      }
      await this.persist();
      return { ok: true, cleared: changed };
    });
  }
}

module.exports = { LocalLibraryUserData, STORE_VERSION, MAX_PLAYLISTS, MAX_PLAYLIST_TRACKS, MAX_HISTORY };