// ============================================================
//  Moving the library in and out of the app: M3U playlists, and a backup of
//  everything that is yours rather than the file's — favourites, ratings,
//  counters, playlists.
//
//  Two rules run through all of it. A restore never overwrites what it cannot
//  read: a truncated backup fails loudly and leaves the current data alone.
//  And a playlist import never deletes anything — it adds, then the rescan
//  decides what is really there.
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
  var saved = await window.desktopWindow.exportJsonFile({
    data: result.payload,
    defaultName: 'Mineradio library backup'
  });
  if (saved && saved.ok) showToast('Backup saved');
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
  showToast('Backup restored');
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
