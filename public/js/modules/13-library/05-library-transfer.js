// ============================================================
//  Moving the library in and out of the app: M3U playlists, and a backup of
//  everything that is yours rather than the file's — favourites, ratings,
//  counters, playlists, and the settings that go with them.
//
//  Three rules run through all of it. A restore never overwrites what it
//  cannot read: a truncated backup fails loudly and leaves the current data
//  alone. A playlist import never deletes anything — it adds, then the rescan
//  decides what is really there. And settings only ever merge: a backup taken
//  on another machine must not be able to switch off something the user has
//  since turned on here, because the file never mentions that key at all.
// ============================================================

function libraryCurrentM3uIds() {
  if (libraryPage.drill) return libraryPage.drill.songs.map(localFileIdOf).filter(Boolean);
  if (libraryPage.selectedOrder.length) return libraryPage.selectedOrder.slice();
  if (libraryPage.songs.length) return libraryPage.songs.map(localFileIdOf).filter(Boolean);
  return [];
}

async function libraryExportM3u() {
  if (!window.desktopWindow || typeof window.desktopWindow.exportLocalLibraryM3u !== 'function') {
    showToast('Export needs the desktop app');
    return;
  }
  var ids = libraryCurrentM3uIds();
  var result = await window.desktopWindow.exportLocalLibraryM3u(ids);
  if (!result || result.ok !== true) {
    showToast(result && result.error === 'NO_TRACKS_TO_EXPORT' ? 'Nothing here to export' : 'Could not build that playlist');
    return;
  }
  var label = libraryPage.drill
    ? libraryPage.drill.name
    : (libraryPage.query ? 'search results' : libraryViewMeta(libraryPage.view).label);
  var saved = await window.desktopWindow.exportTextFile({
    text: result.text,
    defaultName: 'Mineradio ' + label,
    extension: 'm3u8',
    filterName: 'M3U playlist',
    title: 'Export playlist'
  });
  if (saved && saved.ok) showToast('Exported ' + result.count + ' tracks');
}

async function libraryExportPlaylistM3u(playlist) {
  if (!playlist) return;
  if (!window.desktopWindow || typeof window.desktopWindow.exportLocalLibraryM3u !== 'function') {
    showToast('Export needs the desktop app');
    return;
  }
  var ids = libraryPlaylistSongs(playlist).map(localFileIdOf).filter(Boolean);
  var result = await window.desktopWindow.exportLocalLibraryM3u(ids);
  if (!result || result.ok !== true) {
    showToast('Nothing to export from that playlist');
    return;
  }
  var saved = await window.desktopWindow.exportTextFile({
    text: result.text,
    defaultName: playlist.name || 'Mineradio playlist',
    extension: 'm3u8',
    filterName: 'M3U playlist',
    title: 'Export playlist'
  });
  if (saved && saved.ok) showToast('Exported “' + playlist.name + '”');
}

async function libraryImportM3u() {
  if (!window.desktopWindow || typeof window.desktopWindow.importLocalLibraryM3u !== 'function') {
    showToast('Import needs the desktop app');
    return;
  }
  showToast('Reading that playlist…');
  var result = await window.desktopWindow.importLocalLibraryM3u();
  if (!result || result.canceled) return;
  if (!result.ok) {
    showToast(result.error === 'PLAYLIST_HAD_NO_AUDIO'
      ? 'That file had no audio paths Mineradio can open'
      : 'Could not import that playlist');
    return;
  }
  setLocalLibraryStoreTracks(result.tracks);
  libraryPaintNav();
  if (libraryPage.open) libraryRebuildRows(false);
  showToast('Imported ' + result.count + ' track' + (result.count === 1 ? '' : 's') + ' from that playlist');
}

// ---- settings --------------------------------------------------------------

// Every preference the app keeps in localStorage under its own name, minus the
// keys that must not leave the machine. Login cookies and linked accounts are
// credentials; the entitlement evidence and the LAN id are per-device; the
// normalisation cache and the queue snapshot describe this machine's files and
// are rebuilt on the next play anyway. Everything else is a choice the user
// made and would expect back after a reinstall.
var LIBRARY_SETTINGS_PREFIX = 'mineradio-';
// A preference that predates the namespaced keys and is still ours to carry:
// the output volume the player writes on every change.
var LIBRARY_SETTINGS_EXTRA_KEYS = ['apex-player-volume'];
var LIBRARY_SETTINGS_EXCLUDE = {
  'mineradio-login-cookie-export-v1': 'a login session',
  'mineradio-login-workflow-connections-v1': 'linked accounts',
  'mineradio-qq-playback-vip-evidence-v1': 'per-device entitlement evidence',
  'mineradio-provider-vip-audit-v1': 'per-device entitlement evidence',
  'mineradio-playback-norm-v1': 'per-track measurement cache',
  'mineradio-last-playback-v1': 'the queue left open on this machine'
};
// A preference can hold an archive of images or a pile of lyric files, and the
// save dialog writes exactly one JSON file. The snapshot is capped; what does
// not fit is named to the user rather than dropped in silence.
var LIBRARY_SETTINGS_MAX_BYTES = 4 * 1024 * 1024;

function librarySettingsIsOurs(key) {
  if (typeof key !== 'string' || !key) return false;
  if (key.indexOf(LIBRARY_SETTINGS_PREFIX) === 0) return true;
  return LIBRARY_SETTINGS_EXTRA_KEYS.indexOf(key) >= 0;
}

function librarySettingsSnapshot() {
  var store = null;
  try { store = window.localStorage; } catch (e) { store = null; }
  if (!store) return { settings: {}, skipped: [] };
  var keys = [];
  for (var i = 0; i < store.length; i += 1) {
    var key = store.key(i);
    if (librarySettingsIsOurs(key)) keys.push(key);
  }
  keys.sort();
  var settings = {};
  var skipped = [];
  var bytes = 0;
  for (var k = 0; k < keys.length; k += 1) {
    var name = keys[k];
    if (Object.prototype.hasOwnProperty.call(LIBRARY_SETTINGS_EXCLUDE, name)) continue;
    var value = null;
    try { value = store.getItem(name); } catch (e) { continue; }
    if (value == null) continue;
    var cost = name.length + value.length + 4;
    if (bytes + cost > LIBRARY_SETTINGS_MAX_BYTES) { skipped.push(name); continue; }
    bytes += cost;
    settings[name] = value;
  }
  return { settings: settings, skipped: skipped };
}

function librarySettingsApply(settings) {
  if (!settings || typeof settings !== 'object') return 0;
  var store = null;
  try { store = window.localStorage; } catch (e) { store = null; }
  if (!store) return 0;
  var applied = 0;
  var keys = Object.keys(settings);
  for (var i = 0; i < keys.length; i += 1) {
    var name = keys[i];
    // Only our own keys, and never an excluded one: a backup file is still
    // just a file, and the keys that are off-limits stay off-limits no matter
    // what the file claims to be.
    if (!librarySettingsIsOurs(name)) continue;
    if (Object.prototype.hasOwnProperty.call(LIBRARY_SETTINGS_EXCLUDE, name)) continue;
    var value = settings[name];
    if (typeof value !== 'string') continue;
    try { store.setItem(name, value); applied += 1; } catch (e) { /* out of quota: keep going */ }
  }
  return applied;
}

async function libraryBackupUserData() {
  if (!window.desktopWindow || typeof window.desktopWindow.backupLocalLibraryUserData !== 'function') {
    showToast('Backup needs the desktop app');
    return;
  }
  var result = await window.desktopWindow.backupLocalLibraryUserData();
  if (!result || result.ok !== true) {
    showToast('Could not build a backup');
    return;
  }
  var snapshot = librarySettingsSnapshot();
  result.payload.settings = snapshot.settings;
  var saved = await window.desktopWindow.exportJsonFile({
    data: result.payload,
    defaultName: 'Mineradio library backup'
  });
  if (!(saved && saved.ok)) return;
  showToast(snapshot.skipped.length
    ? 'Backup saved — ' + snapshot.skipped.length + ' large setting' +
      (snapshot.skipped.length === 1 ? '' : 's') + ' left out'
    : 'Backup saved');
}

async function libraryRestoreUserData(replace) {
  if (!window.desktopWindow || typeof window.desktopWindow.importJsonFile !== 'function') {
    showToast('Restore needs the desktop app');
    return;
  }
  var picked = await window.desktopWindow.importJsonFile();
  if (!picked || picked.canceled || !picked.text) return;
  var payload = null;
  try {
    payload = JSON.parse(picked.text);
  } catch (_) {
    showToast('That file is not a Mineradio backup');
    return;
  }
  if (payload && payload.kind && payload.kind !== 'mineradio-local-library') {
    showToast('That file is not a Mineradio backup');
    return;
  }
  var result = await window.desktopWindow.restoreLocalLibraryUserData(payload, replace === true);
  if (!result || result.ok !== true) {
    showToast(result && result.error === 'BAD_BACKUP'
      ? 'That backup is unreadable — nothing was changed'
      : 'Could not restore that backup');
    return;
  }
  localLibrarySetUserData({ songs: result.songs || {}, playlists: result.playlists || [] });
  if (Array.isArray(result.tracks)) setLocalLibraryStoreTracks(result.tracks);
  libraryPaintPlaylistPane();
  libraryPaintNav();
  if (libraryPage.open) libraryRebuildRows(false);
  // Settings ride along in the same file but are written only now, after the
  // library half has been accepted — a backup the main process refuses must
  // not have touched a single preference either. They are read at boot, so the
  // window reloads once they are in: a restore that left half the app on the
  // old values would look like it had not worked at all.
  var applied = librarySettingsApply(payload && payload.settings);
  showToast(applied
    ? 'Backup restored — ' + applied + ' setting' + (applied === 1 ? '' : 's') +
      ' applied, reloading'
    : 'Backup restored');
  if (applied > 0) {
    setTimeout(function () {
      try { if (typeof location !== 'undefined' && location.reload) location.reload(); } catch (e) { }
    }, 900);
  }
}

async function libraryClearHistory() {
  if (!window.desktopWindow || typeof window.desktopWindow.setLocalLibraryUser !== 'function') return;
  if (window.confirm && !window.confirm('Clear play counts and history? Favorites and playlists are kept.')) return;
  // The main process clears every counter in one pass; there is no per-track
  // round trip because that would be one IPC per row for a 50k library.
  var result = await window.desktopWindow.setLocalLibraryUser({ id: '', action: 'clear-history' });
  if (!result || result.ok !== true) {
    showToast('Could not clear the history');
    return;
  }
  for (var id in localLibraryStore.userData.songs) {
    if (!Object.prototype.hasOwnProperty.call(localLibraryStore.userData.songs, id)) continue;
    var entry = localLibraryStore.userData.songs[id];
    entry.plays = 0;
    entry.skips = 0;
    entry.completed = 0;
    entry.lastPlayedAt = 0;
  }
  invalidateLocalLibraryIndex();
  libraryPaintNav();
  if (libraryPage.open) libraryRebuildRows(false);
  showToast('Play history cleared');
}
