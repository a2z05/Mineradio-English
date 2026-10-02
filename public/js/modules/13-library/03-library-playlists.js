// ============================================================
//  Local playlists — owned by the main process, shown in two places: as a
//  view inside the Library page, and as a block above the signed-in playlists
//  in the panel's "My playlists" tab. Both read the same cache, and every
//  mutation adopts the answer the main process sends back, so the two views
//  can never disagree about what a playlist contains.
// ============================================================

function libraryPlaylists() {
  return Array.isArray(localLibraryStore.userData.playlists)
    ? localLibraryStore.userData.playlists
    : [];
}

function libraryFindPlaylist(id) {
  var wanted = String(id || '');
  return libraryPlaylists().filter(function (playlist) { return playlist.id === wanted; })[0] || null;
}

function libraryAdoptPlaylistResult(result) {
  if (!result) return null;
  if (Array.isArray(result.playlists)) localLibraryStore.userData.playlists = result.playlists;
  if (result.playlist && !libraryFindPlaylist(result.playlist.id)) {
    localLibraryStore.userData.playlists.push(result.playlist);
  }
  if (typeof libraryPaintPlaylistPane === 'function') libraryPaintPlaylistPane();
  return result;
}

async function libraryPlaylistCreate(name) {
  if (!window.desktopWindow || typeof window.desktopWindow.localPlaylistOp !== 'function') {
    showToast('Playlists need the desktop app');
    return null;
  }
  var result = await window.desktopWindow.localPlaylistOp({ op: 'create', name: name });
  libraryAdoptPlaylistResult(result);
  libraryPaintPlaylistPane();
  return result;
}

// A row that failed to resolve to an id is dropped here rather than handed to
// the main process: it cannot be a track, and an empty id in a playlist is a
// row that plays as silence.
function libraryCleanTrackIds(trackIds) {
  return (Array.isArray(trackIds) ? trackIds : [])
    .map(function (id) { return String(id || '').trim(); })
    .filter(Boolean);
}

async function libraryPlaylistAddTracks(playlistId, trackIds) {
  if (!window.desktopWindow || typeof window.desktopWindow.localPlaylistOp !== 'function') return null;
  var result = await window.desktopWindow.localPlaylistOp({ op: 'add', id: playlistId, trackIds: libraryCleanTrackIds(trackIds) });
  libraryAdoptPlaylistResult(result);
  return result;
}

async function libraryPlaylistRemoveTracks(playlistId, trackIds) {
  if (!window.desktopWindow || typeof window.desktopWindow.localPlaylistOp !== 'function') return null;
  var result = await window.desktopWindow.localPlaylistOp({ op: 'remove', id: playlistId, trackIds: libraryCleanTrackIds(trackIds) });
  libraryAdoptPlaylistResult(result);
  return result;
}

async function libraryPlaylistRename(playlistId, name) {
  if (!window.desktopWindow || typeof window.desktopWindow.localPlaylistOp !== 'function') return null;
  var result = await window.desktopWindow.localPlaylistOp({ op: 'rename', id: playlistId, name: name });
  libraryAdoptPlaylistResult(result);
  return result;
}

async function libraryPlaylistDelete(playlistId) {
  if (!window.desktopWindow || typeof window.desktopWindow.localPlaylistOp !== 'function') return null;
  var result = await window.desktopWindow.localPlaylistOp({ op: 'delete', id: playlistId });
  libraryAdoptPlaylistResult(result);
  if (result && result.ok) showToast('Playlist deleted');
  return result;
}

async function libraryPlaylistDuplicate(playlistId) {
  if (!window.desktopWindow || typeof window.desktopWindow.localPlaylistOp !== 'function') return null;
  var result = await window.desktopWindow.localPlaylistOp({ op: 'duplicate', id: playlistId });
  libraryAdoptPlaylistResult(result);
  if (result && result.ok) showToast('Playlist duplicated');
  return result;
}

async function libraryPlaylistReorder(playlistId, from, to) {
  if (!window.desktopWindow || typeof window.desktopWindow.localPlaylistOp !== 'function') return null;
  var result = await window.desktopWindow.localPlaylistOp({ op: 'reorder', id: playlistId, from: from, to: to });
  libraryAdoptPlaylistResult(result);
  return result;
}

// Resolve a playlist's ids against the index. A playlist outlives a rescan, so
// an id with no track behind it is expected — it is just skipped, not an error.
function libraryPlaylistSongs(playlist) {
  if (!playlist) return [];
  var out = [];
  for (var i = 0; i < playlist.trackIds.length; i += 1) {
    var song = localLibraryStore.byId[playlist.trackIds[i]];
    if (song) out.push(song);
  }
  return out;
}

function libraryPlaylistMissingCount(playlist) {
  if (!playlist) return 0;
  var missing = 0;
  for (var i = 0; i < playlist.trackIds.length; i += 1) {
    if (!localLibraryStore.byId[playlist.trackIds[i]]) missing += 1;
  }
  return missing;
}

function libraryPlayPlaylist(playlist, shuffle) {
  var songs = libraryPlaylistSongs(playlist);
  if (!songs.length) {
    var missing = libraryPlaylistMissingCount(playlist);
    showToast(missing
      ? 'Those files are no longer in your library — refresh it'
      : 'That playlist is empty');
    return false;
  }
  return libraryPlaySongs(songs, shuffle);
}

function libraryQueuePlaylist(playlist) {
  var songs = libraryPlaylistSongs(playlist);
  if (!songs.length) { showToast('Nothing to add'); return; }
  for (var i = 0; i < songs.length; i += 1) queueSong(songs[i]);
  showToast('Added ' + songs.length + ' to the queue');
}

// ---------------------------------------------------------------- panel block

// Sits above the signed-in list in the same pane. The remote renderer owns
// #pl-list and rewrites it on every refresh, so local playlists live in their
// own element beside it and neither can clobber the other.
var LOCAL_PLAYLIST_PANE_ID = 'local-pl-list';

function libraryEnsurePlaylistPane() {
  var pane = document.getElementById('pl-pane');
  if (!pane) return null;
  var block = document.getElementById(LOCAL_PLAYLIST_PANE_ID);
  if (block) return block;
  block = document.createElement('div');
  block.id = LOCAL_PLAYLIST_PANE_ID;
  block.className = 'local-playlist-block';
  var list = document.getElementById('pl-list');
  pane.insertBefore(block, list || null);
  return block;
}

function libraryPaintPlaylistPane() {
  var block = libraryEnsurePlaylistPane();
  if (!block) return;
  var playlists = libraryPlaylists();
  var head = '<div class="local-playlist-head">' +
    '<span>On this device</span>' +
    '<button class="fx-mini-btn ghost" type="button" onclick="libraryCreatePlaylistPrompt()" ' +
      'title="New playlist">＋ New</button>' +
    '</div>';
  if (!playlists.length) {
    block.innerHTML = head + '<div class="local-playlist-empty">' +
      'Playlists you make here are saved on this device and survive a restart.' +
      '</div>';
    return;
  }
  block.innerHTML = head + playlists.map(function (playlist) {
    var missing = libraryPlaylistMissingCount(playlist);
    return '<div class="local-playlist-card" data-local-playlist="' + escHtml(playlist.id) + '" ' +
      'oncontextmenu="libraryPlaylistContextMenu(event,\'' + escHtml(playlist.id) + '\')">' +
      '<div class="local-playlist-card-main" onclick="libraryOpenPlaylistView(\'' + escHtml(playlist.id) + '\')">' +
        '<strong>' + escHtml(playlist.name) + '</strong>' +
        '<small>' + playlist.trackIds.length + ' track' + (playlist.trackIds.length === 1 ? '' : 's') +
          (missing ? ' · ' + missing + ' missing' : '') + '</small>' +
      '</div>' +
      '<div class="local-playlist-card-acts">' +
        '<button class="library-row-btn" type="button" title="Play" onclick="event.stopPropagation();libraryPlayPlaylistById(\'' +
          escHtml(playlist.id) + '\', false)">▶</button>' +
        '<button class="library-row-btn" type="button" title="Shuffle" onclick="event.stopPropagation();libraryPlayPlaylistById(\'' +
          escHtml(playlist.id) + '\', true)">⤨</button>' +
        '<button class="library-row-btn" type="button" title="More" onclick="event.stopPropagation();libraryPlaylistContextMenu(event,\'' +
          escHtml(playlist.id) + '\')">⋯</button>' +
      '</div>' +
      '</div>';
  }).join('');
}

async function libraryCreatePlaylistPrompt() {
  var name = window.prompt ? window.prompt('New playlist name', '') : '';
  if (name === null) return;
  name = String(name || '').trim();
  if (!name) { showToast('Give the playlist a name'); return; }
  var result = await libraryPlaylistCreate(name);
  if (!result || result.ok !== true) { showToast('Could not create that playlist'); return; }
  showToast('Created “' + name + '”');
  if (libraryPage.open) libraryRebuildRows(false);
}

function libraryPlayPlaylistById(id, shuffle) {
  var playlist = libraryFindPlaylist(id);
  if (!playlist) return false;
  return libraryPlayPlaylist(playlist, shuffle);
}

function libraryQueuePlaylistById(id) {
  var playlist = libraryFindPlaylist(id);
  if (playlist) libraryQueuePlaylist(playlist);
}

function libraryOpenPlaylistView(id) {
  var playlist = libraryFindPlaylist(id);
  if (!playlist) return;
  if (!libraryPage.open) { openLibraryPage('playlists'); }
  libraryPage.view = 'playlists';
  libraryPaintNav();
  libraryDrillInto({
    key: playlist.id,
    name: playlist.name,
    songs: libraryPlaylistSongs(playlist)
  });
  // Remember which playlist is drilled so the back button returns to the list.
  libraryPage.drill.playlistId = playlist.id;
  libraryRebuildRows(true);
}

// ---------------------------------------------------------------- context menu

function libraryPlaylistRowHtml(playlist, index) {
  var missing = libraryPlaylistMissingCount(playlist);
  var cover = '';
  for (var i = 0; i < playlist.trackIds.length && !cover; i += 1) {
    var song = localLibraryStore.byId[playlist.trackIds[i]];
    if (song) cover = songCoverSrc(song, 64) || '';
  }
  var coverHtml = cover
    ? '<img src="' + cover + '" alt="" loading="lazy" onerror="this.style.opacity=0.2">'
    : '<span class="library-row-cover-ph" aria-hidden="true"></span>';
  var sub = playlist.trackIds.length + ' track' + (playlist.trackIds.length === 1 ? '' : 's')
    + (missing ? ' · ' + missing + ' missing' : '');
  return '<div class="library-row library-group-row library-playlist-row" data-library-index="' + index + '" role="row">' +
    '<span class="library-row-num">♫</span>' +
    '<span class="library-row-cover">' + coverHtml + '</span>' +
    '<span class="library-row-main">' +
      '<span class="library-row-title">' + escHtml(playlist.name) + '</span>' +
      '<span class="library-row-meta">' + escHtml(sub) + '</span>' +
    '</span>' +
    '<span class="library-row-actions">' +
      '<button class="library-row-btn" type="button" title="Play" data-library-act="play-playlist">▶</button>' +
      '<button class="library-row-btn" type="button" title="Shuffle" data-library-act="shuffle-playlist">⤨</button>' +
      '<button class="library-row-btn" type="button" title="Add to queue" data-library-act="queue-playlist">＋</button>' +
      '<button class="library-row-btn" type="button" title="More" data-library-act="playlist-menu">⋯</button>' +
    '</span>' +
    '</div>';
}

function libraryShowPlaylistMenu(event, playlist) {
  libraryPlaylistContextMenu(event, playlist && playlist.id);
}

function libraryPlaylistContextMenu(event, playlistId) {
  if (event && event.preventDefault) event.preventDefault();
  var playlist = libraryFindPlaylist(playlistId);
  if (!playlist) return;
  var menu = libraryEnsureMenuDom();
  libraryMenuState.songs = [];
  libraryMenuState.group = null;
  libraryMenuState.playlist = playlist;
  var items = [
    { label: 'Play', run: 'playlist:play' },
    { label: 'Shuffle', run: 'playlist:shuffle' },
    { label: 'Add to queue', run: 'playlist:queue' },
    { label: 'Rename', run: 'playlist:rename' },
    { label: 'Duplicate', run: 'playlist:duplicate' },
    { label: 'Export as M3U', run: 'playlist:export' },
    { label: 'Delete', run: 'playlist:delete' }
  ];
  var html = '<div class="library-menu-title">' + escHtml(playlist.name) + '</div>' +
    items.map(function (item, index) {
      return '<button type="button" role="menuitem" data-library-menu="' + index + '">' +
        escHtml(item.label) + '</button>';
    }).join('');
  menu.innerHTML = html;
  menu.hidden = false;
  menu.classList.add('show');
  menu.style.left = Math.max(8, Math.min(window.innerWidth - 240, event.clientX || 40)) + 'px';
  menu.style.top = Math.max(8, Math.min(window.innerHeight - 280, event.clientY || 40)) + 'px';
  menu.onclick = function (clickEvent) {
    var btn = clickEvent.target.closest ? clickEvent.target.closest('[data-library-menu]') : null;
    if (!btn) return;
    var item = items[Number(btn.getAttribute('data-library-menu'))];
    libraryCloseContextMenu();
    if (item) libraryPlaylistRun(item.run, playlist);
  };
}

function libraryPlaylistRun(run, playlist) {
  if (run === 'playlist:play') return libraryPlayPlaylist(playlist, false);
  if (run === 'playlist:shuffle') return libraryPlayPlaylist(playlist, true);
  if (run === 'playlist:queue') return libraryQueuePlaylist(playlist);
  if (run === 'playlist:export') return libraryExportPlaylistM3u(playlist);
  if (run === 'playlist:duplicate') return libraryPlaylistDuplicate(playlist.id);
  if (run === 'playlist:delete') {
    var ok = window.confirm
      ? window.confirm('Delete “' + playlist.name + '”? The music files stay on disk.')
      : true;
    if (!ok) return null;
    return libraryPlaylistDelete(playlist.id).then(function (result) {
      if (libraryPage.open && libraryPage.view === 'playlists') libraryRebuildRows(false);
      if (libraryPage.drill && libraryPage.drill.playlistId === playlist.id) libraryDrillBack();
      return result;
    });
  }
  if (run === 'playlist:rename') {
    var name = window.prompt ? window.prompt('Rename playlist', playlist.name) : null;
    if (name === null) return null;
    var trimmed = String(name || '').trim();
    if (!trimmed) return null;
    return libraryPlaylistRename(playlist.id, trimmed).then(function () {
      if (libraryPage.open && libraryPage.view === 'playlists') libraryRebuildRows(false);
      if (libraryPage.drill && libraryPage.drill.playlistId === playlist.id) {
        libraryPage.drill.name = trimmed;
        libraryPaintHeader();
      }
      return null;
    });
  }
  return null;
}
