// ============================================================
//  The Library page — browse the local collection the way a music player
//  is supposed to let you: by song, album, artist, genre, folder, by when
//  it arrived, by how often it gets played.
//
//  The rows are windowed. Only the slice under the thumb is in the DOM, so a
//  50,000-track library costs the same as an 18-track one — which is the whole
//  reason this is a scroller and not a giant innerHTML.
// ============================================================

var libraryPage = {
  open: false,
  view: 'songs',
  query: '',
  rows: [],
  songs: [],
  rowHeight: 54,
  scrollTop: 0,
  loading: false,
  scanning: false,
  scanAt: 0,
  selection: {},
  selectedOrder: [],
  anchor: -1,
  drill: null,
  drillStamp: 0,
  status: ''
};

var LIBRARY_ROW_H_SONG = 54;
var LIBRARY_ROW_H_GROUP = 64;
var LIBRARY_OVERSCAN = 6;
var LIBRARY_PAGE_STORAGE_KEY = 'mineradio-library-view';

function libraryEnsureDom() {
  var existing = document.getElementById('library-page');
  if (existing) return existing;
  var mask = document.createElement('div');
  mask.id = 'library-page';
  mask.className = 'modal-mask library-page-mask';
  mask.setAttribute('aria-hidden', 'true');
  mask.innerHTML =
    '<div class="modal library-page" role="dialog" aria-modal="true" aria-label="Library">' +
      '<div class="library-head">' +
        '<div class="library-head-title">' +
          '<div class="fx-title">Library</div>' +
          '<div class="fx-sub" id="library-count">0 tracks</div>' +
        '</div>' +
        '<div class="library-search">' +
          '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" ' +
            'stroke-linecap="round"><circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/></svg>' +
          '<input id="library-search-input" type="text" autocomplete="off" spellcheck="false" ' +
            'placeholder="Search titles, artists, albums, folders…">' +
          '<button id="library-search-clear" type="button" title="Clear search" aria-label="Clear search">×</button>' +
        '</div>' +
        '<div class="library-head-actions">' +
          '<button class="fx-mini-btn ghost" id="library-add-folder-btn" type="button" onclick="libraryAddMusicFolder()">Add folder</button>' +
          '<button class="fx-mini-btn ghost" id="library-refresh-btn" type="button" onclick="libraryRescan()">Refresh</button>' +
          '<button class="fx-mini-btn ghost" id="library-more-btn" type="button" onclick="libraryToggleMoreMenu(event)">More</button>' +
          '<button class="library-close" type="button" onclick="closeLibraryPage()" aria-label="Close library">×</button>' +
        '</div>' +
      '</div>' +
      '<div class="library-body">' +
        '<nav class="library-nav" id="library-nav" aria-label="Library views"></nav>' +
        '<div class="library-main">' +
          '<div class="library-toolbar">' +
            '<div class="library-crumb" id="library-crumb"></div>' +
            '<div class="library-toolbar-actions">' +
              '<button class="fx-mini-btn ghost" type="button" onclick="libraryPlayRows(true)">Shuffle</button>' +
              '<button class="fx-mini-btn ghost" type="button" onclick="libraryPlayRows(false)">Play</button>' +
              '<button class="fx-mini-btn ghost" type="button" onclick="librarySelectAll()">Select all</button>' +
            '</div>' +
          '</div>' +
          '<div class="library-bulk" id="library-bulk" hidden></div>' +
          '<div class="library-scroller" id="library-scroller" tabindex="0">' +
            '<div class="library-spacer" id="library-spacer" style="height:0">' +
              '<div class="library-window" id="library-window" style="top:0"></div>' +
            '</div>' +
            '<div class="library-empty" id="library-empty" hidden></div>' +
          '</div>' +
          '<div class="library-status" id="library-status" hidden></div>' +
        '</div>' +
        '<div class="library-side" id="library-folders-host"></div>' +
      '</div>' +
      '<div class="library-more-menu" id="library-more-menu" hidden></div>' +
    '</div>';
  document.body.appendChild(mask);
  mask.addEventListener('mousedown', function (event) {
    if (event.target === mask) closeLibraryPage();
  });
  var scroller = document.getElementById('library-scroller');
  scroller.addEventListener('scroll', libraryOnScroll, { passive: true });
  var input = document.getElementById('library-search-input');
  var timer = null;
  input.addEventListener('input', function () {
    clearTimeout(timer);
    timer = setTimeout(function () {
      libraryPage.query = input.value;
      document.getElementById('library-search-clear').hidden = !libraryPage.query;
      libraryRebuildRows(true);
    }, 90);
  });
  document.getElementById('library-search-clear').addEventListener('click', function () {
    input.value = '';
    libraryPage.query = '';
    this.hidden = true;
    libraryRebuildRows(true);
    input.focus();
  });
  scroller.addEventListener('keydown', libraryOnKeyDown);
  scroller.addEventListener('click', libraryOnRowClick);
  scroller.addEventListener('contextmenu', libraryOnRowContextMenu);
  // Dragging is on the whole page, not the row list: a track has to be droppable
  // on the playlist pane, the queue and the folder tree, none of which are
  // inside the scroller.
  libraryInstallLibraryDropTargets(mask);
  return mask;
}

// ---------------------------------------------------------------- drag & drop

var libraryDragState = { songs: [], over: '' };

function libraryDraggableHtml(song, index) {
  return ' draggable="true" data-library-drag="' + index + '"';
}

function libraryInstallLibraryDropTargets(mask) {
  if (!mask || mask.dataset.dropBound) return;
  mask.dataset.dropBound = '1';
  mask.addEventListener('dragstart', function (event) {
    var handle = event.target.closest ? event.target.closest('[data-library-drag]') : null;
    if (!handle) return;
    var index = Number(handle.getAttribute('data-library-drag'));
    var row = libraryRowAt(index);
    if (!row || row.kind !== 'song') return;
    var id = localLibrarySongKey(row.song);
    // Dragging one row inside an existing selection drags the whole selection,
    // the way every file list behaves.
    var songs = libraryPage.selection[id] ? librarySelectedSongs() : [row.song];
    if (!songs.length) songs = [row.song];
    libraryDragState.songs = songs;
    try {
      event.dataTransfer.effectAllowed = 'copy';
      event.dataTransfer.setData('text/plain', songs.map(localFileIdOf).filter(Boolean).join('\n'));
    } catch (_) { /* a browser that refuses setData still gets the click behaviour */ }
    if (libraryOnRowDragVisual) mask.classList.add('dragging');
  });
  mask.addEventListener('dragend', function () {
    libraryDragState.songs = [];
    libraryDragState.over = '';
    if (libraryOnRowDragVisual) mask.classList.remove('dragging');
    document.querySelectorAll('.library-drop-over').forEach(function (el) {
      el.classList.remove('library-drop-over');
    });
  });

  var targets = [
    { id: 'library-drop-playlist', matches: function (node) { return !!node.closest('#library-playlist-list, .local-playlist-list, #library-picker-list'); } },
    { id: 'library-drop-queue', matches: function (node) { return !!node.closest('#queue-list, .queue-panel, #playlist-panel'); } },
    { id: 'library-drop-folders', matches: function (node) { return !!node.closest('#library-folder-scroll'); } }
  ];
  targets.forEach(function (target) {
    mask.addEventListener('dragover', function (event) {
      if (!libraryDragState.songs.length) return;
      if (!event.target.closest || !target.matches(event.target)) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = 'copy';
      libraryDragState.over = target.id;
      var element = event.target.closest(target.id === 'library-drop-folders'
        ? '#library-folder-scroll'
        : (target.id === 'library-drop-queue' ? '#queue-list, .queue-panel' : '#library-playlist-list, .local-playlist-list'));
      if (element) element.classList.add('library-drop-over');
    });
    mask.addEventListener('dragleave', function (event) {
      if (!event.target.closest || !target.matches(event.target)) return;
      libraryDragState.over = '';
      var element = event.target.closest(target.id === 'library-drop-folders'
        ? '#library-folder-scroll'
        : (target.id === 'library-drop-queue' ? '#queue-list, .queue-panel' : '#library-playlist-list, .local-playlist-list'));
      if (element) element.classList.remove('library-drop-over');
    });
    mask.addEventListener('drop', function (event) {
      if (!libraryDragState.songs.length) return;
      if (!event.target.closest || !target.matches(event.target)) return;
      event.preventDefault();
      var songs = libraryDragState.songs.slice();
      libraryDragState.songs = [];
      libraryDragState.over = '';
      var element = event.target.closest(target.id === 'library-drop-folders'
        ? '#library-folder-scroll'
        : (target.id === 'library-drop-queue' ? '#queue-list, .queue-panel' : '#library-playlist-list, .local-playlist-list'));
      if (element) element.classList.remove('library-drop-over');
      if (target.id === 'library-drop-playlist') libraryDropOnPlaylist(songs, event);
      else if (target.id === 'library-drop-queue') {
        for (var i = 0; i < songs.length; i += 1) queueSong(songs[i]);
        showToast('Added ' + songs.length + ' to the queue');
      } else libraryDropOnFolders(songs);
    });
  });
}

async function libraryDropOnPlaylist(songs, event) {
  var host = event.target.closest('#library-playlist-list, .local-playlist-list, #library-picker-list');
  var card = host && event.target.closest ? event.target.closest('[data-library-playlist]') : null;
  var id = card ? card.getAttribute('data-library-playlist') : '';
  if (!id) {
    // Dropped on the list but not on a playlist: offer to make one, which is
    // what every file manager does rather than silently dropping the tracks.
    libraryOpenPlaylistPicker(songs);
    return;
  }
  var ids = songs.map(localFileIdOf).filter(Boolean);
  var result = await libraryPlaylistAddTracks(id, ids);
  if (!result || result.ok !== true) {
    showToast('Could not add to that playlist');
    return;
  }
  var playlist = (localLibraryStore.userData.playlists || []).filter(function (entry) { return entry.id === id; })[0];
  showToast('Added to ' + (playlist ? playlist.name : 'playlist'));
  if (typeof libraryPaintPlaylistPane === 'function') libraryPaintPlaylistPane();
}

// Dropping tracks onto a folder node queues that folder, which is the one
// action a folder can do that a track cannot do to a track.
function libraryDropOnFolders(songs) {
  var nodeId = libraryFolderBrowser.nodeId;
  if (!nodeId) return;
  for (var i = 0; i < songs.length; i += 1) queueSong(songs[i]);
  showToast('Added ' + songs.length + ' to the queue');
}

function libraryNavHtml() {
  var html = '';
  for (var i = 0; i < LIBRARY_VIEWS.length; i += 1) {
    var view = LIBRARY_VIEWS[i];
    var active = libraryPage.view === view.id && !libraryPage.drill ? ' active' : '';
    html += '<button class="library-nav-item' + active + '" type="button" data-library-view="' + view.id + '">' +
      '<span>' + escHtml(view.label) + '</span>' +
      '<em>' + libraryViewCount(view.id) + '</em>' +
      '</button>';
  }
  return html;
}

function libraryViewCount(viewId) {
  switch (viewId) {
    case 'playlists':
      return String(libraryPlaylists().length);
    case 'favorites':
    case 'recent-played':
    case 'most-played':
    case 'top-rated':
      return String(libraryViewRows(viewId).length);
    default:
      return String(localLibraryStore.tracks.length);
  }
}

function libraryPaintNav() {
  var nav = document.getElementById('library-nav');
  if (nav) nav.innerHTML = libraryNavHtml();
}

function libraryCrumbHtml() {
  if (libraryPage.drill) {
    return '<button type="button" onclick="libraryDrillBack()">‹ All ' +
      escHtml(libraryViewMeta(libraryPage.view).label.toLowerCase()) + '</button>' +
      '<span>' + escHtml(libraryPage.drill.name) + '</span>' +
      '<em>' + libraryPage.songs.length + ' track' + (libraryPage.songs.length === 1 ? '' : 's') + '</em>';
  }
  var label = libraryPage.query ? 'Search results' : libraryViewMeta(libraryPage.view).label;
  var kindWord = libraryViewMeta(libraryPage.view).kind === 'groups' ? 'group'
    : (libraryViewMeta(libraryPage.view).kind === 'playlists' ? 'playlist' : 'track');
  var plural = kindWord === 'group' ? 'groups' : (kindWord === 'playlist' ? 'playlists' : 'tracks');
  return '<span>' + escHtml(label) + '</span><em>' +
    libraryPage.rows.length + ' ' + (libraryPage.rows.length === 1 ? kindWord : plural) + '</em>';
}

function libraryPaintHeader() {
  var count = document.getElementById('library-count');
  if (count) count.textContent = localLibraryStore.tracks.length + ' track' + (localLibraryStore.tracks.length === 1 ? '' : 's');
  var crumb = document.getElementById('library-crumb');
  if (crumb) crumb.innerHTML = libraryCrumbHtml();
}

// ---------------------------------------------------------------- rows

function libraryRebuildRows(resetScroll) {
  if (libraryPage.drill) {
    libraryPage.songs = libraryPage.drill.songs.slice();
    libraryPage.rows = libraryPage.songs;
    libraryPage.rowHeight = LIBRARY_ROW_H_SONG;
  } else if (libraryPage.query) {
    var groups = libraryGroupTracks(libraryPage.query) || [];
    var songs = librarySearchTracks(libraryPage.query);
    libraryPage.songs = songs;
    // Groups first so "find that album" lands above the individual tracks.
    libraryPage.rows = groups.map(function (group) { return { kind: 'group', group: group }; })
      .concat(songs.map(function (song) { return { kind: 'song', song: song }; }));
    libraryPage.rowHeight = groups.length ? LIBRARY_ROW_H_GROUP : LIBRARY_ROW_H_SONG;
  } else {
    var view = libraryViewMeta(libraryPage.view);
    var raw = libraryViewRows(libraryPage.view);
    if (view.kind === 'playlists') {
      libraryPage.rows = libraryPlaylists().map(function (playlist) {
        return { kind: 'playlist', playlist: playlist };
      });
      libraryPage.rowHeight = LIBRARY_ROW_H_GROUP;
      libraryPage.songs = [];
    } else if (view.kind === 'groups') {
      libraryPage.rows = raw.map(function (group) { return { kind: 'group', group: group }; });
      libraryPage.rowHeight = LIBRARY_ROW_H_GROUP;
      libraryPage.songs = [];
    } else {
      libraryPage.rows = raw.map(function (song) { return { kind: 'song', song: song }; });
      libraryPage.rowHeight = LIBRARY_ROW_H_SONG;
      libraryPage.songs = raw;
    }
  }
  if (resetScroll !== false) {
    var scroller = document.getElementById('library-scroller');
    if (scroller) scroller.scrollTop = 0;
    libraryPage.scrollTop = 0;
  }
  libraryPaintHeader();
  libraryRenderWindow(true);
}

function libraryRowAt(index) {
  return libraryPage.rows[index] || null;
}

function librarySongRowHtml(song, index) {
  var id = localLibrarySongKey(song);
  var selected = !!libraryPage.selection[id];
  var state = localLibraryUserState(song);
  var cover = songCoverSrc(song, 64);
  var coverHtml = cover
    ? '<img src="' + cover + '" alt="" loading="lazy" onerror="this.style.opacity=0.2">'
    : '<span class="library-row-cover-ph" aria-hidden="true"></span>';
  var stars = '';
  for (var s = 1; s <= 5; s += 1) {
    stars += '<i class="' + (s <= state.rating ? 'on' : '') + '"></i>';
  }
  var meta = [song.artist || 'Unknown artist', song.album || '', state.plays ? state.plays + ' plays' : '']
    .filter(Boolean).map(escHtml).join(' · ');
  return '<div class="library-row library-song-row' + (selected ? ' selected' : '') +
      (state.favorite ? ' is-favorite' : '') + '" data-library-index="' + index + '"' +
      ' data-library-id="' + escHtml(id) + '"' + libraryDraggableHtml(song, index) + ' role="row">' +
    '<span class="library-row-num">' + (index + 1) + '</span>' +
    '<span class="library-row-cover">' + coverHtml + '</span>' +
    '<span class="library-row-main">' +
      '<span class="library-row-title">' + escHtml(song.name || 'Untitled') +
        (state.favorite ? '<b class="library-row-fav" title="Favorite">♥</b>' : '') + '</span>' +
      '<span class="library-row-meta">' + meta + '</span>' +
    '</span>' +
    '<span class="library-row-folder" title="' + escHtml(song.localPath || '') + '">' +
      escHtml(localLibraryFolderOf(song) || 'Root') + '</span>' +
    '<span class="library-row-stars" aria-label="' + state.rating + ' of 5">' + stars + '</span>' +
    '<span class="library-row-time">' + escHtml(libraryFormatDuration(song.duration)) + '</span>' +
    '<span class="library-row-actions">' +
      '<button class="library-row-btn" type="button" title="Play next" data-library-act="queue">＋</button>' +
      '<button class="library-row-btn" type="button" title="Add to playlist" data-library-act="collect">⋯</button>' +
    '</span>' +
    '</div>';
}

function libraryGroupRowHtml(group, index) {
  var cover = group.cover || '';
  var coverHtml = cover
    ? '<img src="' + cover + '" alt="" loading="lazy" onerror="this.style.opacity=0.2">'
    : '<span class="library-row-cover-ph" aria-hidden="true"></span>';
  var sub = group.artist || group.sub || (group.count + ' track' + (group.count === 1 ? '' : 's'));
  return '<div class="library-row library-group-row" data-library-index="' + index + '" role="row">' +
    '<span class="library-row-num">▸</span>' +
    '<span class="library-row-cover">' + coverHtml + '</span>' +
    '<span class="library-row-main">' +
      '<span class="library-row-title">' + escHtml(group.name) + '</span>' +
      '<span class="library-row-meta">' + escHtml(sub) + '</span>' +
    '</span>' +
    '<span class="library-row-folder">' + group.count + ' track' + (group.count === 1 ? '' : 's') + '</span>' +
    '<span class="library-row-actions">' +
      '<button class="library-row-btn" type="button" title="Play group" data-library-act="play-group">▶</button>' +
      '<button class="library-row-btn" type="button" title="More" data-library-act="group-menu">⋯</button>' +
    '</span>' +
    '</div>';
}

function libraryFormatDuration(seconds) {
  var total = Math.round(Number(seconds) || 0);
  if (!total) return '';
  var mins = Math.floor(total / 60);
  var secs = total % 60;
  return mins + ':' + (secs < 10 ? '0' : '') + secs;
}

function libraryOnScroll() {
  var scroller = document.getElementById('library-scroller');
  if (!scroller) return;
  libraryPage.scrollTop = scroller.scrollTop;
  libraryRenderWindow(false);
}

function libraryRenderWindow(force) {
  var spacer = document.getElementById('library-spacer');
  var win = document.getElementById('library-window');
  var scroller = document.getElementById('library-scroller');
  var empty = document.getElementById('library-empty');
  if (!spacer || !win || !scroller) return;

  var total = libraryPage.rows.length;
  spacer.style.height = (total * libraryPage.rowHeight) + 'px';
  if (empty) {
    empty.hidden = total > 0;
    if (!total) empty.innerHTML = libraryEmptyStateHtml();
  }

  var viewport = scroller.clientHeight || 480;
  var first = Math.max(0, Math.floor(libraryPage.scrollTop / libraryPage.rowHeight) - LIBRARY_OVERSCAN);
  var last = Math.min(total, Math.ceil((libraryPage.scrollTop + viewport) / libraryPage.rowHeight) + LIBRARY_OVERSCAN);
  var key = first + ':' + last + ':' + total + ':' + libraryPage.view + ':' + libraryPage.query + ':' +
    libraryPage.rowHeight + ':' + libraryPage.drillStamp;
  if (!force && win.dataset.key === key) return;
  win.dataset.key = key;

  var html = '';
  for (var i = first; i < last; i += 1) {
    var row = libraryRowAt(i);
    if (!row) continue;
    if (row.kind === 'group') html += libraryGroupRowHtml(row.group, i);
    else if (row.kind === 'playlist') html += libraryPlaylistRowHtml(row.playlist, i);
    else html += librarySongRowHtml(row.song, i);
  }
  win.style.transform = 'translateY(' + (first * libraryPage.rowHeight) + 'px)';
  win.innerHTML = html;
}

function libraryEmptyStateHtml() {
  if (libraryPage.query) {
    return 'No matches for “' + escHtml(libraryPage.query) + '”.';
  }
  if (!localLibraryStore.tracks.length) {
    // An index that would not open and one that was never built both arrive
    // here as zero tracks. Offering to start over when the reason is a file
    // that could not be read sends the user off to re-add folders they still
    // have, so the reason is what is said instead.
    var unread = !!localLibraryStore.warning;
    return '<strong>' + (unread
      ? 'Your library index could not be opened'
      : 'Your library is empty') + '</strong>' +
      '<span>' + (unread
        ? 'Mineradio could not read the file that lists your tracks, so there is nothing to show. Your music on disk was not touched — add a music folder and it will be indexed again.'
        : 'Add a music folder and Mineradio will index every track it finds.') + '</span>' +
      '<div class="library-empty-actions">' +
      '<button class="fx-mini-btn ghost" type="button" onclick="libraryAddMusicFolder()">Add music folder</button>' +
      '<button class="fx-mini-btn ghost" type="button" onclick="triggerUploadInput(\'audio\')">Import files</button>' +
      '</div>';
  }
  if (libraryPage.drill) return 'Nothing here.';
  return 'Nothing in this view yet — play something first.';
}

// ---------------------------------------------------------------- open/close

async function openLibraryPage(viewId) {
  var mask = libraryEnsureDom();
  libraryPage.open = true;
  if (viewId) libraryPage.view = viewId;
  if (window.desktopWindow) libraryPage.drill = null;
  if (typeof closeUploadPanel === 'function') closeUploadPanel();
  if ($results) $results.classList.remove('show');
  libraryPaintNav();
  libraryPaintHeader();
  libraryRenderWindow(true);
  openGsapModal(mask);
  var input = document.getElementById('library-search-input');
  if (input) input.value = libraryPage.query;
  var clear = document.getElementById('library-search-clear');
  if (clear) clear.hidden = !libraryPage.query;
  libraryPaintNav();
  await hydrateLocalLibraryStore();
  libraryPaintNav();
  libraryRebuildRows(true);
  libraryUpdateFolderControls();
  librarySyncFolderPane();
}

function closeLibraryPage() {
  var mask = document.getElementById('library-page');
  libraryPage.open = false;
  closeLibraryMenu();
  if (!mask) return;
  closeGsapModal(mask, function () {
    libraryClearSelection();
  });
}

function librarySetView(viewId) {
  libraryPage.view = viewId;
  libraryPage.drill = null;
  libraryPage.drillStamp = 0;
  try {
    window.localStorage.setItem(LIBRARY_PAGE_STORAGE_KEY, viewId);
  } catch (_) {}
  libraryPaintNav();
  libraryRebuildRows(true);
  librarySyncFolderPane();
}

// The tree is a companion to the Folders view, not furniture for every view:
// shown only where it answers something the rows cannot.
function librarySyncFolderPane() {
  var side = document.getElementById('library-side');
  if (!side) return;
  var wanted = libraryPage.view === 'folders' && !libraryPage.query;
  side.hidden = !wanted;
  if (!wanted) return;
  libraryInstallFolderBrowser();
  libraryPaintFolderBrowser();
  if (!libraryFolderBrowser.tree.length) {
    libraryLoadFolderTree(true).then(function () {
      if (wanted && libraryPage.open) libraryPaintFolderBrowser();
    });
  }
}

function libraryDrillInto(group) {
  if (!group) return;
  libraryPage.drill = { name: group.name, songs: group.songs.slice(), key: group.key };
  libraryPage.drillStamp = Date.now();
  libraryPage.query = '';
  var input = document.getElementById('library-search-input');
  if (input) input.value = '';
  libraryRebuildRows(true);
}

function libraryDrillBack() {
  libraryPage.drill = null;
  libraryPage.drillStamp = 0;
  libraryRebuildRows(true);
}

// ---------------------------------------------------------------- selection

function libraryClearSelection() {
  libraryPage.selection = {};
  libraryPage.selectedOrder = [];
  libraryPage.anchor = -1;
  libraryPaintBulk();
  libraryRenderWindow(true);
}

function librarySelectAll() {
  libraryPage.selection = {};
  libraryPage.selectedOrder = [];
  for (var i = 0; i < libraryPage.rows.length; i += 1) {
    var row = libraryRowAt(i);
    if (row && row.kind === 'song') {
      var id = localLibrarySongKey(row.song);
      if (id) { libraryPage.selection[id] = true; libraryPage.selectedOrder.push(id); }
    }
  }
  libraryPaintBulk();
  libraryRenderWindow(true);
}

function librarySelectedSongs() {
  var out = [];
  for (var i = 0; i < libraryPage.selectedOrder.length; i += 1) {
    var song = localLibraryStore.byId[libraryPage.selectedOrder[i]];
    if (song) out.push(song);
  }
  return out;
}

function libraryPaintBulk() {
  var bar = document.getElementById('library-bulk');
  if (!bar) return;
  var count = libraryPage.selectedOrder.length;
  if (!count) { bar.hidden = true; bar.innerHTML = ''; return; }
  bar.hidden = false;
  bar.innerHTML =
    '<span><strong>' + count + '</strong> selected</span>' +
    '<button class="fx-mini-btn ghost" type="button" onclick="libraryBulkAction(\'play\')">Play</button>' +
    '<button class="fx-mini-btn ghost" type="button" onclick="libraryBulkAction(\'queue\')">Add to queue</button>' +
    '<button class="fx-mini-btn ghost" type="button" onclick="libraryBulkAction(\'playlist\')">Add to playlist</button>' +
    '<button class="fx-mini-btn ghost" type="button" onclick="libraryBulkAction(\'favorite\')">Favorite</button>' +
    '<button class="fx-mini-btn ghost" type="button" onclick="libraryBulkAction(\'remove\')">Remove from library</button>' +
    '<button class="library-bulk-clear" type="button" onclick="libraryClearSelection()">Clear</button>';
}

// ---------------------------------------------------------------- interaction

function libraryOnRowClick(event) {
  var target = event.target.closest ? event.target.closest('[data-library-index]') : null;
  if (!target) return;
  var index = Number(target.getAttribute('data-library-index'));
  var row = libraryRowAt(index);
  if (!row) return;

  var actionBtn = event.target.closest ? event.target.closest('[data-library-act]') : null;
  if (actionBtn) {
    event.stopPropagation();
    var act = actionBtn.getAttribute('data-library-act');
    if (act === 'queue' && row.kind === 'song') {
      queueSongNext(row.song);
      showToast('Set as next up: ' + (row.song.name || ''));
    } else if (act === 'collect' && row.kind === 'song') {
      libraryOpenPlaylistPicker([row.song]);
    } else if (act === 'play-group' && row.kind === 'group') {
      libraryPlayGroup(row.group, false);
    } else if (act === 'group-menu') {
      libraryShowGroupMenu(event, row.group);
    } else if (act === 'play-playlist' && row.kind === 'playlist') {
      libraryPlayPlaylist(row.playlist, false);
    } else if (act === 'shuffle-playlist' && row.kind === 'playlist') {
      libraryPlayPlaylist(row.playlist, true);
    } else if (act === 'queue-playlist' && row.kind === 'playlist') {
      libraryQueuePlaylist(row.playlist);
    } else if (act === 'playlist-menu' && row.kind === 'playlist') {
      libraryShowPlaylistMenu(event, row.playlist);
    }
    return;
  }

  if (row.kind === 'group') {
    libraryDrillInto(row.group);
    return;
  }

  if (row.kind === 'playlist') {
    var plId = row.playlist && row.playlist.id;
    if (plId) libraryOpenPlaylistView(plId);
    return;
  }

  var id = localLibrarySongKey(row.song);
  if (!id) return;

  if (event.shiftKey && libraryPage.anchor >= 0) {
    var from = Math.min(libraryPage.anchor, index);
    var to = Math.max(libraryPage.anchor, index);
    libraryPage.selection = {};
    libraryPage.selectedOrder = [];
    for (var i = from; i <= to; i += 1) {
      var rangeRow = libraryRowAt(i);
      if (!rangeRow || rangeRow.kind !== 'song') continue;
      var rangeId = localLibrarySongKey(rangeRow.song);
      if (rangeId && !libraryPage.selection[rangeId]) {
        libraryPage.selection[rangeId] = true;
        libraryPage.selectedOrder.push(rangeId);
      }
    }
  } else if (event.ctrlKey || event.metaKey || event.detail === 2) {
    if (libraryPage.selection[id]) {
      delete libraryPage.selection[id];
      libraryPage.selectedOrder = libraryPage.selectedOrder.filter(function (key) { return key !== id; });
    } else {
      libraryPage.selection[id] = true;
      libraryPage.selectedOrder.push(id);
    }
    libraryPage.anchor = index;
  } else {
    libraryPage.selection = {};
    libraryPage.selectedOrder = [id];
    libraryPage.selection[id] = true;
    libraryPage.anchor = index;
  }
  libraryPaintBulk();
  libraryRenderWindow(true);
}

function libraryOnKeyDown(event) {
  if (event.key === 'Escape') {
    if (libraryPage.selection && libraryPage.selectedOrder.length) libraryClearSelection();
    else closeLibraryPage();
    return;
  }
  if (event.key === 'Enter') {
    var selected = librarySelectedSongs();
    if (selected.length) {
      event.preventDefault();
      libraryPlaySongs(selected, false);
    }
    return;
  }
  if (event.key === 'a' && (event.ctrlKey || event.metaKey)) {
    event.preventDefault();
    librarySelectAll();
    return;
  }
  if (event.key === 'Delete' || event.key === 'Backspace') {
    var remove = librarySelectedSongs();
    if (remove.length) {
      event.preventDefault();
      libraryRemoveSongs(remove);
    }
  }
}

// ---------------------------------------------------------------- playing

function libraryPlaySongs(songs, shuffle) {
  if (!songs || !songs.length) {
    showToast('Nothing to play');
    return false;
  }
  var ordered = songs.slice();
  if (shuffle) ordered = shuffleArrayInPlace(ordered.slice());
  if (typeof importLocalAudioSongs === 'function') {
    importLocalAudioSongs(ordered.map(cloneSong), { mode: 'persistent-library' });
    return true;
  }
  playQueue = ordered.map(cloneSong);
  currentIdx = 0;
  playQueueAt(0);
  return true;
}

function libraryPlayGroup(group, shuffle) {
  if (!group) return false;
  return libraryPlaySongs(group.songs, shuffle);
}

function libraryPlayRows(shuffle) {
  if (libraryPage.selectedOrder.length) {
    libraryPlaySongs(librarySelectedSongs(), shuffle);
    return;
  }
  if (libraryPage.songs.length) {
    libraryPlaySongs(libraryPage.songs, shuffle);
    return;
  }
  showToast('Nothing to play here');
}

function libraryBulkAction(action) {
  var songs = librarySelectedSongs();
  if (!songs.length) return;
  if (action === 'play') { libraryPlaySongs(songs, false); return; }
  if (action === 'queue') {
    for (var i = 0; i < songs.length; i += 1) queueSong(songs[i]);
    showToast('Added ' + songs.length + ' to the queue');
    return;
  }
  if (action === 'playlist') { libraryOpenPlaylistPicker(songs); return; }
  if (action === 'favorite') {
    for (var f = 0; f < songs.length; f += 1) librarySetFavorite(songs[f], true);
    showToast('Added ' + songs.length + ' to favorites');
    setTimeout(function () { libraryRebuildRows(false); }, 260);
    return;
  }
  if (action === 'remove') libraryRemoveSongs(songs);
}

async function libraryRemoveSongs(songs) {
  if (!songs.length) return;
  if (!window.desktopWindow || typeof window.desktopWindow.removeLocalMusicTracks !== 'function') {
    showToast('Removing tracks needs the desktop app');
    return;
  }
  var ids = songs.map(localFileIdOf).filter(Boolean);
  if (!ids.length) return;
  var result = await window.desktopWindow.removeLocalMusicTracks(ids);
  if (!result || result.ok !== true) {
    showToast('Could not remove those tracks');
    return;
  }
  setLocalLibraryStoreTracks(result.tracks);
  libraryClearSelection();
  libraryPaintNav();
  libraryRebuildRows(false);
  showToast(ids.length === 1
    ? 'Removed from your library — the file is still on disk'
    : 'Removed ' + ids.length + ' tracks — the files are still on disk');
}

// ---------------------------------------------------------------- folders

function libraryUpdateFolderControls() {
  var addBtn = document.getElementById('library-add-folder-btn');
  if (addBtn) addBtn.textContent = localLibraryStore.folders.length ? 'Add folder' : 'Add music folder';
}

async function libraryAddMusicFolder() {
  if (!window.desktopWindow || typeof window.desktopWindow.chooseLocalMusicFolder !== 'function') {
    showToast('Choosing a folder needs the desktop app');
    return;
  }
  var chosen = await window.desktopWindow.chooseLocalMusicFolder();
  if (!chosen) return;
  var added = await window.desktopWindow.addLocalMusicFolder(chosen);
  if (!added || added.ok === false) {
    showToast(added && added.error === 'LOCAL_FOLDER_INVALID'
      ? 'That folder could not be read'
      : 'Could not add that folder');
    return;
  }
  localLibrarySetFolders(added.folders);
  libraryUpdateFolderControls();
  showToast('Folder added — scanning…');
  await libraryRunScan(true);
}

async function libraryRemoveMusicFolder(folder) {
  if (!window.desktopWindow || typeof window.desktopWindow.removeLocalMusicFolder !== 'function') return;
  var result = await window.desktopWindow.removeLocalMusicFolder(folder);
  if (!result || result.ok === false) {
    showToast('Could not remove that folder');
    return;
  }
  localLibrarySetFolders(result.folders);
  if (Array.isArray(result.tracks)) setLocalLibraryStoreTracks(result.tracks);
  libraryUpdateFolderControls();
  libraryPaintNav();
  libraryRebuildRows(false);
  showToast('Folder removed — the music files were left on disk');
}

function librarySetScanning(active, scanned) {
  libraryPage.scanning = active;
  var btn = document.getElementById('library-refresh-btn');
  var status = document.getElementById('library-status');
  if (btn) {
    btn.disabled = active;
    btn.textContent = active ? 'Scanning…' : 'Refresh';
  }
  if (status) {
    status.hidden = !active && !libraryPage.status;
    if (active) status.textContent = 'Scanning your music folders' + (scanned ? ' · ' + scanned + ' files' : '') + '…';
    else if (libraryPage.status) status.textContent = libraryPage.status;
  }
}

async function libraryRunScan(force) {
  if (libraryPage.scanning) return null;
  if (!window.desktopWindow || typeof window.desktopWindow.scanLocalMusicLibrary !== 'function') {
    showToast('Scanning needs the desktop app');
    return null;
  }
  librarySetScanning(true, 0);
  var unsubscribe = window.desktopWindow.onLocalMusicScanProgress
    ? window.desktopWindow.onLocalMusicScanProgress(function (payload) {
      librarySetScanning(true, Number(payload && payload.scanned) || 0);
    })
    : function () {};
  try {
    var result = await window.desktopWindow.scanLocalMusicLibrary();
    if (!result || result.ok === false) throw new Error(result && result.error || 'LOCAL_LIBRARY_SCAN_FAILED');
    setLocalLibraryStoreTracks(result.tracks);
    if (Array.isArray(result.folders)) localLibrarySetFolders(result.folders);
    libraryPaintNav();
    libraryRebuildRows(false);
    libraryUpdateFolderControls();
    var parts = [];
    if (result.added) parts.push(result.added + ' added');
    if (result.changed) parts.push(result.changed + ' updated');
    if (result.removed) parts.push(result.removed + ' removed');
    libraryPage.status = parts.length ? 'Scan complete · ' + parts.join(', ') : 'Library is up to date';
    showToast(libraryPage.status);
    return result;
  } catch (err) {
    console.warn('[Library] scan failed', err);
    libraryPage.status = 'Scan failed';
    showToast('Could not scan your music folders');
    return null;
  } finally {
    unsubscribe();
    librarySetScanning(false, 0);
    setTimeout(function () {
      if (!libraryPage.scanning) libraryPage.status = '';
      var status = document.getElementById('library-status');
      if (status && !libraryPage.scanning) status.hidden = true;
    }, 4000);
  }
}

function libraryRescan() {
  return libraryRunScan(false);
}

// ---------------------------------------------------------------- more menu

function libraryToggleMoreMenu(event) {
  if (event) event.stopPropagation();
  var menu = document.getElementById('library-more-menu');
  if (!menu) return;
  if (!menu.hidden) { closeLibraryMenu(); return; }
  menu.innerHTML = [
    ['Sync now', 'librarySyncNow()'],
    ['Import M3U playlist', 'libraryImportM3u()'],
    ['Export this view as M3U', 'libraryExportM3u()'],
    ['Backup library data', 'libraryBackupUserData()'],
    ['Restore backup', 'libraryRestoreUserData()'],
    ['Clear play history', 'libraryClearHistory()']
  ].map(function (entry) {
    return '<button type="button" onclick="closeLibraryMenu();' + entry[1] + '">' + entry[0] + '</button>';
  }).join('');
  menu.hidden = false;
}

function closeLibraryMenu() {
  var menu = document.getElementById('library-more-menu');
  if (menu) menu.hidden = true;
}
