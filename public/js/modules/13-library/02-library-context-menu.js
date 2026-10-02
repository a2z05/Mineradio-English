// ============================================================
//  Context menus and the playlist picker for the Library page.
//
//  Right-click is where the real work lives: everything a row can do is here,
//  and the same menu drives a single track, a multi-selection, or a whole
//  album — because the actions are the same, only the target list differs.
// ============================================================

var libraryMenuState = { songs: [], group: null, x: 0, y: 0 };

function libraryEnsureMenuDom() {
  var menu = document.getElementById('library-context-menu');
  if (menu) return menu;
  menu = document.createElement('div');
  menu.id = 'library-context-menu';
  menu.className = 'library-context-menu';
  menu.setAttribute('role', 'menu');
  document.body.appendChild(menu);
  document.addEventListener('mousedown', function (event) {
    if (menu.contains(event.target)) return;
    libraryCloseContextMenu();
  });
  window.addEventListener('blur', libraryCloseContextMenu);
  window.addEventListener('resize', libraryCloseContextMenu);
  return menu;
}

function libraryCloseContextMenu() {
  var menu = document.getElementById('library-context-menu');
  if (menu) {
    menu.classList.remove('show');
    menu.hidden = true;
  }
}

function libraryOpenContextMenu(event, songs, group) {
  if (event && event.preventDefault) event.preventDefault();
  var menu = libraryEnsureMenuDom();
  libraryMenuState.songs = Array.isArray(songs) ? songs.slice() : [];
  libraryMenuState.group = group || null;

  var items = [];
  var count = libraryMenuState.songs.length;

  if (group) {
    items.push(['Play', 'libraryMenuPlay(false)']);
    items.push(['Play next', 'libraryMenuQueueNext()']);
    items.push(['Add to queue', 'libraryMenuQueueAll()']);
    items.push(['Shuffle', 'libraryMenuPlay(true)']);
    items.push(['Add to playlist', 'libraryMenuAddToPlaylist()']);
    items.push(['Open folder', 'libraryMenuRevealFirst()']);
    return libraryPaintMenu(menu, event, items, group.name + ' · ' + group.count + ' tracks');
  }

  if (!count) return;

  items.push(count > 1 ? 'Play ' + count + ' tracks|libraryMenuPlay(false)' : 'Play|libraryMenuPlay(false)');
  items.push('Play next|libraryMenuQueueNext()');
  items.push('Add to queue|libraryMenuQueueAll()');
  items.push('Add to playlist|libraryMenuAddToPlaylist()');
  if (count === 1) {
    var song = libraryMenuState.songs[0];
    var favorite = localLibraryIsFavorite(song);
    items.push(favorite ? 'Remove from favorites|libraryMenuFavorite(false)' : 'Add to favorites|libraryMenuFavorite(true)');
    items.push('Set rating|libraryMenuRating()');
    items.push('Edit metadata|libraryMenuEditMetadata()');
    items.push('Open file location|libraryMenuRevealFirst()');
    items.push('Rescan library|libraryMenuRescan()');
  } else {
    items.push('Add ' + count + ' to favorites|libraryMenuFavorite(true)');
    items.push('Edit metadata|libraryMenuEditMetadata()');
  }
  items.push('Remove from library|libraryMenuRemove()');

  var parsed = items.map(function (entry) {
    var parts = Array.isArray(entry) ? entry : String(entry).split('|');
    return { label: parts[0], run: parts[1] };
  });
  return libraryPaintMenu(menu, event, parsed, null);
}

function libraryPaintMenu(menu, event, items, title) {
  var normalized = items.map(function (entry) {
    if (Array.isArray(entry)) return { label: entry[0], run: entry[1] };
    if (typeof entry === 'string') {
      var at = entry.indexOf('|');
      return { label: entry.slice(0, at), run: entry.slice(at + 1) };
    }
    return entry;
  });
  var html = title ? '<div class="library-menu-title">' + escHtml(title) + '</div>' : '';
  html += normalized.map(function (item, index) {
    return '<button type="button" role="menuitem" data-library-menu="' + index + '">' +
      escHtml(item.label) + '</button>';
  }).join('');
  menu.innerHTML = html;
  menu.hidden = false;
  menu.classList.add('show');

  var x = Math.max(8, Math.min(window.innerWidth - 240, (event && event.clientX) || 24));
  var y = Math.max(8, Math.min(window.innerHeight - 40 - normalized.length * 30, (event && event.clientY) || 24));
  menu.style.left = x + 'px';
  menu.style.top = y + 'px';

  menu.onclick = function (clickEvent) {
    var btn = clickEvent.target.closest ? clickEvent.target.closest('[data-library-menu]') : null;
    if (!btn) return;
    var item = normalized[Number(btn.getAttribute('data-library-menu'))];
    libraryCloseContextMenu();
    if (item && item.run) {
      // The handler names are literals from this module, never user input —
      // but they are still dispatched by name, so the call is bounded to the
      // functions this file defines.
      libraryMenuDispatch(item.run);
    }
  };
}

function libraryMenuDispatch(name) {
  // Every key here is the literal the menu paints, verbatim. The items are
  // written as calls — `libraryMenuQueueNext()` — so a key without the `()`
  // looked up nothing and the item closed the menu without doing anything.
  // tests/local-library-page.test.js fails if the two ever drift apart again.
  var table = {
    'libraryMenuPlay(false)': function () { libraryMenuPlay(false); },
    'libraryMenuPlay(true)': function () { libraryMenuPlay(true); },
    'libraryMenuQueueNext()': function () { libraryMenuQueueNext(); },
    'libraryMenuQueueAll()': function () { libraryMenuQueueAll(); },
    'libraryMenuAddToPlaylist()': function () { libraryMenuAddToPlaylist(); },
    'libraryMenuFavorite(true)': function () { libraryMenuFavorite(true); },
    'libraryMenuFavorite(false)': function () { libraryMenuFavorite(false); },
    'libraryMenuRating()': function () { libraryMenuRating(); },
    'libraryMenuEditMetadata()': function () { libraryMenuEditMetadata(); },
    'libraryMenuRevealFirst()': function () { libraryMenuRevealFirst(); },
    'libraryMenuRescan()': function () { libraryMenuRescan(); },
    'libraryMenuRemove()': function () { libraryMenuRemove(); }
  };
  var fn = table[name];
  if (fn) fn();
}

function libraryMenuTargetSongs() {
  if (libraryMenuState.songs.length) return libraryMenuState.songs;
  if (libraryMenuState.group) return libraryMenuState.group.songs.slice();
  return [];
}

function libraryMenuPlay(shuffle) {
  libraryPlaySongs(libraryMenuTargetSongs(), shuffle);
}

function libraryMenuQueueAll() {
  var songs = libraryMenuTargetSongs();
  for (var i = 0; i < songs.length; i += 1) queueSong(songs[i]);
  showToast('Added ' + songs.length + ' to the queue');
}

function libraryMenuQueueNext() {
  var songs = libraryMenuTargetSongs();
  // Insert them in order so the next-up block keeps the order they were
  // selected in rather than arriving reversed.
  for (var i = songs.length - 1; i >= 0; i -= 1) queueSongNext(songs[i]);
  showToast(songs.length === 1
    ? 'Set as next up: ' + (songs[0].name || '')
    : 'Next up: ' + songs.length + ' tracks');
}

function libraryMenuAddToPlaylist() {
  libraryOpenPlaylistPicker(libraryMenuTargetSongs());
}

function libraryMenuFavorite(value) {
  var songs = libraryMenuTargetSongs();
  for (var i = 0; i < songs.length; i += 1) librarySetFavorite(songs[i], value);
  showToast(value ? 'Added to favorites' : 'Removed from favorites');
  setTimeout(function () {
    libraryPaintNav();
    libraryRebuildRows(false);
  }, 240);
}

function libraryMenuRating() {
  var songs = libraryMenuTargetSongs();
  if (songs.length !== 1) return;
  libraryOpenRating(songs[0]);
}

function libraryMenuEditMetadata() {
  var songs = libraryMenuTargetSongs();
  if (!songs.length) return;
  libraryOpenMetadataEditor(songs);
}

function libraryMenuRevealFirst() {
  var songs = libraryMenuTargetSongs();
  if (!songs.length) return;
  var id = localFileIdOf(songs[0]);
  if (!id || !window.desktopWindow || typeof window.desktopWindow.revealLocalMusicTrack !== 'function') {
    showToast('Opening the file location needs the desktop app');
    return;
  }
  window.desktopWindow.revealLocalMusicTrack(id).then(function (result) {
    if (!result || result.ok !== true) {
      showToast(result && result.error === 'LOCAL_FILE_MISSING'
        ? 'That file is no longer on disk — refresh the library'
        : 'Could not open the file location');
    }
  }).catch(function () {
    showToast('Could not open the file location');
  });
}

function libraryMenuRescan() {
  libraryRescan();
}

function libraryMenuRemove() {
  libraryRemoveSongs(libraryMenuTargetSongs());
}

// Right-click anywhere on a row of the page.
function libraryOnRowContextMenu(event) {
  var target = event.target.closest ? event.target.closest('[data-library-index]') : null;
  if (!target) return;
  var index = Number(target.getAttribute('data-library-index'));
  var row = libraryRowAt(index);
  if (!row) return;

  if (row.kind === 'group') {
    libraryOpenContextMenu(event, null, row.group);
    return;
  }

  var id = localLibrarySongKey(row.song);
  if (!id) return;
  // Right-clicking inside a selection operates on the whole selection, the
  // way every file manager does — otherwise multi-select is useless.
  if (!libraryPage.selection[id]) {
    libraryPage.selection = {};
    libraryPage.selectedOrder = [id];
    libraryPage.selection[id] = true;
    libraryPage.anchor = index;
    libraryPaintBulk();
    libraryRenderWindow(true);
  }
  libraryOpenContextMenu(event, librarySelectedSongs(), null);
}

function libraryShowGroupMenu(event, group) {
  libraryOpenContextMenu(event, null, group);
}

// ---------------------------------------------------------------- rating

function libraryOpenRating(song) {
  var menu = libraryEnsureMenuDom();
  libraryMenuState.songs = [song];
  var current = localLibraryUserState(song).rating;
  var items = [];
  for (var stars = 5; stars >= 1; stars -= 1) {
    items.push({
      label: '★★★★★'.slice(0, stars) + '☆☆☆☆☆'.slice(0, 5 - stars) + (current === stars ? '  ✓' : ''),
      run: 'rating:' + stars
    });
  }
  items.push({ label: 'Clear rating', run: 'rating:0' });
  var html = '<div class="library-menu-title">' + escHtml(song.name || 'Track') + '</div>' +
    items.map(function (item, index) {
      return '<button type="button" role="menuitem" data-library-menu="' + index + '">' + escHtml(item.label) + '</button>';
    }).join('');
  menu.innerHTML = html;
  menu.hidden = false;
  menu.classList.add('show');
  menu.style.left = Math.max(8, Math.min(window.innerWidth - 240, window.innerWidth / 2 - 90)) + 'px';
  menu.style.top = Math.max(8, Math.min(window.innerHeight - 240, window.innerHeight / 2 - 80)) + 'px';
  menu.onclick = function (event) {
    var btn = event.target.closest ? event.target.closest('[data-library-menu]') : null;
    if (!btn) return;
    var item = items[Number(btn.getAttribute('data-library-menu'))];
    libraryCloseContextMenu();
    if (!item) return;
    var value = Number(String(item.run).split(':')[1]) || 0;
    librarySetRating(song, value);
    showToast(value ? 'Rated ' + value + ' star' + (value === 1 ? '' : 's') : 'Rating cleared');
    setTimeout(function () { libraryRebuildRows(false); }, 240);
  };
}

// ---------------------------------------------------------------- picker

var libraryPickerSongs = [];

function libraryOpenPlaylistPicker(songs) {
  libraryPickerSongs = Array.isArray(songs) ? songs.slice() : [];
  if (!libraryPickerSongs.length) return;
  var existing = document.getElementById('library-playlist-picker');
  if (!existing) {
    var mask = document.createElement('div');
    mask.id = 'library-playlist-picker';
    mask.className = 'modal-mask';
    mask.innerHTML = '<div class="modal collect-modal library-picker">' +
      '<h2>Add to playlist</h2>' +
      '<div id="library-picker-current" class="collect-current"></div>' +
      '<div class="collect-create">' +
        '<input id="library-picker-new-name" type="text" placeholder="New playlist name" autocomplete="off" maxlength="60">' +
        '<button class="modal-btn primary" onclick="libraryPickerCreate()">Create</button>' +
      '</div>' +
      '<div id="library-picker-list" class="collect-list"></div>' +
      '<div class="btn-row"><button class="modal-btn" onclick="libraryClosePlaylistPicker()">Close</button></div>' +
      '</div>';
    document.body.appendChild(mask);
    mask.addEventListener('mousedown', function (event) {
      if (event.target === mask) libraryClosePlaylistPicker();
    });
    document.getElementById('library-picker-new-name').addEventListener('keydown', function (event) {
      if (event.key === 'Enter') libraryPickerCreate();
    });
  }
  var current = document.getElementById('library-picker-current');
  if (current) {
    current.textContent = libraryPickerSongs.length === 1
      ? (libraryPickerSongs[0].name || 'Track')
      : libraryPickerSongs.length + ' tracks selected';
  }
  var input = document.getElementById('library-picker-new-name');
  if (input) input.value = '';
  libraryRenderPlaylistPicker();
  openGsapModal(document.getElementById('library-playlist-picker'));
  if (input) setTimeout(function () { input.focus(); }, 120);
}

function libraryClosePlaylistPicker() {
  var mask = document.getElementById('library-playlist-picker');
  libraryPickerSongs = [];
  if (mask) closeGsapModal(mask);
}

function libraryRenderPlaylistPicker() {
  var list = document.getElementById('library-picker-list');
  if (!list) return;
  var playlists = localLibraryStore.userData.playlists || [];
  if (!playlists.length) {
    list.innerHTML = '<div class="search-empty">No playlists yet — name one above.</div>';
    return;
  }
  list.innerHTML = playlists.map(function (playlist) {
    return '<button class="collect-item" type="button" onclick="libraryPickerAdd(\'' +
      escHtml(playlist.id) + '\')">' +
      '<span><strong>' + escHtml(playlist.name) + '</strong>' +
      '<small>' + playlist.trackIds.length + ' track' + (playlist.trackIds.length === 1 ? '' : 's') + '</small></span>' +
      '<em>Add</em></button>';
  }).join('');
}

async function libraryPickerCreate() {
  var input = document.getElementById('library-picker-new-name');
  var name = input ? String(input.value || '').trim() : '';
  if (!name) {
    showToast('Give the playlist a name');
    return;
  }
  var result = await libraryPlaylistCreate(name);
  if (!result || result.ok !== true) {
    showToast('Could not create that playlist');
    return;
  }
  await libraryPickerAdd(result.playlist.id, true);
}

async function libraryPickerAdd(playlistId, skipClose) {
  var ids = libraryPickerSongs.map(localFileIdOf).filter(Boolean);
  if (!ids.length) return;
  var result = await libraryPlaylistAddTracks(playlistId, ids);
  if (!result || result.ok !== true) {
    showToast('Could not add to that playlist');
    return;
  }
  var playlist = (localLibraryStore.userData.playlists || []).filter(function (entry) {
    return entry.id === playlistId;
  })[0];
  showToast('Added to ' + (playlist ? playlist.name : 'playlist'));
  if (typeof libraryPaintPlaylistPane === 'function') libraryPaintPlaylistPane();
  if (!skipClose) libraryClosePlaylistPicker();
  else {
    var input = document.getElementById('library-picker-new-name');
    if (input) input.value = '';
    libraryRenderPlaylistPicker();
  }
}
