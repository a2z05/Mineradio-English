// ============================================================
//  The folder browser — a real tree of the folders on disk, next to the rows
//  the index already knows about.
//
//  Two lists, because they answer different questions:
//
//    Browse  — what is actually in this directory right now. Includes folders
//              that are empty and files the scan has not picked up yet, which
//              is what makes "my new album is not showing up" answerable
//              instead of mysterious.
//    Indexed — the tracks the index holds for this node and everything under
//              it. These have ids, so Play, Queue and Rescan work on them.
//
//  The main process builds the tree because only it knows which music folder a
//  track's relative path was scanned against. Nothing here holds a filesystem
//  path: nodes are addressed by the opaque ids the tree hands out, and the main
//  process re-checks every one of them against a root it owns.
// ============================================================

var libraryFolderBrowser = {
  tree: [],
  nodeId: '',
  trail: [],
  path: [],
  open: {},
  browse: null,
  browseStamp: 0,
  loading: false,
  status: ''
};

function libraryFolderBrowserHtml() {
  return '<div class="library-folders" id="library-folders">' +
    '<div class="library-folders-head">' +
      '<span>Folders</span>' +
      '<em id="library-folder-count"></em>' +
    '</div>' +
    '<div class="library-folder-path" id="library-folder-path"></div>' +
    '<div class="library-folder-actions" id="library-folder-actions"></div>' +
    '<div class="library-folder-scroll" id="library-folder-scroll"></div>' +
  '</div>';
}

function libraryFolderNodeById(id, list) {
  var wanted = String(id || '');
  var stack = (list || libraryFolderBrowser.tree).slice();
  while (stack.length) {
    var node = stack.pop();
    if (!node) continue;
    if (node.id === wanted) return node;
    if (node.children && node.children.length) stack.push.apply(stack, node.children);
  }
  return null;
}

// Every node from the root down to this one, so the breadcrumb can be built
// without the tree having to carry parent links.
function libraryFolderTrail(nodeId) {
  var trail = [];
  var walk = function (nodes, stack) {
    for (var i = 0; i < nodes.length; i += 1) {
      var node = nodes[i];
      var next = stack.concat([node]);
      if (node.id === nodeId) { trail = next; return true; }
      if (node.children && node.children.length && walk(node.children, next)) return true;
    }
    return false;
  };
  walk(libraryFolderBrowser.tree || [], []);
  return trail;
}

function libraryFolderDescendants(node) {
  var out = [];
  var stack = node && node.children ? node.children.slice() : [];
  while (stack.length) {
    var child = stack.shift();
    if (!child) continue;
    out.push(child);
    if (child.children && child.children.length) stack.push.apply(stack, child.children);
  }
  return out;
}

// Index counts roll up the whole subtree; the node the main process built
// already counted every descendant, so this is a sum over the flattened list
// rather than a second walk per click.
function libraryFolderNodeCount(node) {
  return node ? Number(node.count) || 0 : 0;
}

function libraryFolderIndexedIds(node) {
  var ids = [];
  var nodeIds = [node].concat(libraryFolderDescendants(node)).map(function (entry) { return entry.id; });
  var tracks = localLibraryStore.tracks;
  for (var i = 0; i < tracks.length; i += 1) {
    var song = tracks[i];
    var owner = librarySongFolderNodeId(song, nodeIds);
    if (owner) ids.push(localLibrarySongKey(song));
  }
  return ids;
}

// Which node a song sits under. The main process's node ids are root digests
// with the path appended, and the renderer cannot recompute a digest — so the
// trail is used instead: the deepest trail entry whose label sequence is a
// suffix of the song's folder segments. Correct, and it only walks the visible
// trail rather than the whole tree.
function librarySongFolderNodeId(song, nodeIds) {
  var segments = String((song && song.localPath) || '').replace(/\\/g, '/').split('/');
  segments.pop(); // the file itself
  var trail = libraryFolderTrail(nodeIds && nodeIds[0]);
  var deepest = '';
  for (var i = 0; i < trail.length; i += 1) {
    var fromRoot = trail.slice(i).map(function (entry) { return entry.label; });
    if (fromRoot.length > segments.length) continue;
    var matches = true;
    for (var j = 0; j < fromRoot.length; j += 1) {
      if (String(segments[segments.length - fromRoot.length + j] || '').toLowerCase() !== fromRoot[j].toLowerCase()) {
        matches = false;
        break;
      }
    }
    if (matches) deepest = trail[i].id;
  }
  return deepest;
}

async function libraryLoadFolderTree(force) {
  if (libraryFolderBrowser.loading) return libraryFolderBrowser.tree;
  if (!force && libraryFolderBrowser.tree.length) return libraryFolderBrowser.tree;
  libraryFolderBrowser.loading = true;
  try {
    if (window.desktopWindow && typeof window.desktopWindow.getLocalMusicTree === 'function') {
      var result = await window.desktopWindow.getLocalMusicTree();
      if (result && result.ok === true && Array.isArray(result.tree)) {
        libraryFolderBrowser.tree = result.tree;
        if (libraryFolderBrowser.limited === undefined) libraryFolderBrowser.limited = !!result.tree.limited;
      }
    }
  } catch (err) {
    // A missing bridge is the browser preview, not an error worth a toast.
  } finally {
    libraryFolderBrowser.loading = false;
  }
  return libraryFolderBrowser.tree;
}

// ---------------------------------------------------------------- painting

function libraryPaintFolderCount() {
  var el = document.getElementById('library-folder-count');
  if (!el) return;
  var node = libraryFolderBrowser.nodeId ? libraryFolderNodeById(libraryFolderBrowser.nodeId) : null;
  el.textContent = node ? libraryFolderNodeCount(node) + ' indexed' : libraryFolderStoreCountLabel();
}

function libraryFolderStoreCountLabel() {
  var total = 0;
  var walk = function (nodes) {
    for (var i = 0; i < nodes.length; i += 1) {
      total += Number(nodes[i].count) || 0;
      if (nodes[i].children && nodes[i].children.length) walk(nodes[i].children);
    }
  };
  walk(libraryFolderBrowser.tree || []);
  return total + ' indexed';
}

function libraryPaintFolderPath() {
  var el = document.getElementById('library-folder-path');
  if (!el) return;
  if (!libraryFolderBrowser.nodeId) {
    el.innerHTML = '<span class="muted">Every music folder</span>';
    return;
  }
  var trail = libraryFolderTrail(libraryFolderBrowser.nodeId);
  var html = '';
  for (var i = 0; i < trail.length; i += 1) {
    if (i) html += '<span class="sep">›</span>';
    html += '<button type="button" data-library-folder="' + escHtml(trail[i].id) + '">' +
      escHtml(trail[i].label) + '</button>';
  }
  var node = libraryFolderNodeById(libraryFolderBrowser.nodeId);
  if (node) {
    html += '<span class="sep">›</span><span class="here">' +
      libraryFolderNodeCount(node) + ' indexed</span>';
  }
  el.innerHTML = html;
}

function libraryPaintFolderActions() {
  var el = document.getElementById('library-folder-actions');
  if (!el) return;
  var id = libraryFolderBrowser.nodeId;
  el.innerHTML =
    '<button class="fx-mini-btn ghost" type="button" onclick="libraryFolderPlay(false)"' +
      (id ? '' : ' disabled') + '>Play</button>' +
    '<button class="fx-mini-btn ghost" type="button" onclick="libraryFolderPlay(true)"' +
      (id ? '' : ' disabled') + '>Shuffle</button>' +
    '<button class="fx-mini-btn ghost" type="button" onclick="libraryFolderQueue()"' +
      (id ? '' : ' disabled') + '>Queue</button>' +
    '<button class="fx-mini-btn ghost" type="button" onclick="libraryFolderAddToPlaylist()"' +
      (id ? '' : ' disabled') + '>Playlist</button>' +
    '<button class="fx-mini-btn ghost" type="button" onclick="libraryFolderReveal()"' +
      (id ? '' : ' disabled') + '>Reveal</button>' +
    '<button class="fx-mini-btn ghost" type="button" onclick="libraryFolderRescan()"' +
      (id ? '' : ' disabled') + '>Rescan</button>';
}

function libraryFolderRowHtml(entry, kind, index) {
  var node = kind === 'node' ? entry : null;
  var isOpen = !!libraryFolderBrowser.open[entry.id];
  var hasChildren = node ? node.childCount > 0 : false;
  var depth = node ? node.depth : 0;
  var count = node ? libraryFolderNodeCount(node) : Number(entry.count) || 0;
  var chevron = kind === 'dir'
    ? (isOpen ? '▾' : '▸')
    : (hasChildren ? (isOpen ? '▾' : '▸') : '·');
  var label = kind === 'dir' ? entry.name : entry.name;
  var sub = kind === 'file'
    ? escHtml(libraryFormatDuration(entry.duration))
    : count + ' indexed';
  return '<div class="library-folder-row" data-library-folder-kind="' + kind +
      '" data-library-folder-index="' + index + '" data-library-folder-id="' + escHtml(entry.id) +
      '" data-library-folder-child="' + (hasChildren ? '1' : '0') + '" style="--folder-depth:' + depth + '">' +
    '<span class="library-folder-chevron">' + chevron + '</span>' +
    '<span class="library-folder-label">' + escHtml(label) + '</span>' +
    '<span class="library-folder-sub">' + sub + '</span>' +
  '</div>';
}

// One flat, indented list: the indexed children of this node and the real
// contents of this directory, side by side. Deeper than one level goes through
// the Browse button rather than by expanding rows — a 50k-file tree is not
// something to render in full.
function libraryBuildFolderRows() {
  var node = libraryFolderBrowser.nodeId ? libraryFolderNodeById(libraryFolderBrowser.nodeId) : null;
  var rows = [];
  if (node) {
    var children = (node.children || []).slice().sort(function (a, b) {
      return String(a.label).localeCompare(String(b.label), undefined, { numeric: true, sensitivity: 'base' });
    });
    for (var i = 0; i < children.length; i += 1) rows.push({ kind: 'node', entry: children[i] });
  }
  var browse = libraryFolderBrowser.browse;
  if (browse) {
    var directoryIds = browse.childIds || {};
    for (var d = 0; d < browse.directories.length; d += 1) {
      var name = browse.directories[d];
      rows.push({ kind: 'dir', entry: { name: name, id: directoryIds[name] || libraryFolderBrowser.nodeId } });
    }
    for (var f = 0; f < browse.files.length; f += 1) {
      rows.push({ kind: 'file', entry: { name: browse.files[f], id: '' } });
    }
  }
  return rows;
}

function libraryPaintFolderScroll() {
  var el = document.getElementById('library-folder-scroll');
  if (!el) return;
  var rows = libraryBuildFolderRows();
  libraryFolderBrowser.rows = rows;
  if (!rows.length) {
    el.innerHTML = libraryFolderBrowser.nodeId
      ? '<div class="library-folder-empty">Nothing in this folder</div>'
      : '<div class="library-folder-empty">Add a music folder to browse it here</div>';
    return;
  }
  var html = '';
  for (var i = 0; i < rows.length; i += 1) html += libraryFolderRowHtml(rows[i].entry, rows[i].kind, i);
  el.innerHTML = html;
}

function libraryPaintFolderBrowser() {
  libraryPaintFolderCount();
  libraryPaintFolderPath();
  libraryPaintFolderActions();
  libraryPaintFolderScroll();
}

// ---------------------------------------------------------------- browsing

async function libraryFolderSelect(nodeId) {
  libraryFolderBrowser.nodeId = String(nodeId || '');
  libraryFolderBrowser.trail = libraryFolderTrail(libraryFolderBrowser.nodeId);
  libraryFolderBrowser.browse = null;
  libraryPaintFolderPath();
  libraryPaintFolderActions();
  libraryPaintFolderCount();
  await libraryFolderBrowseNow();
  libraryPaintFolderCount();
}

async function libraryFolderBrowseNow() {
  var stamp = Date.now();
  libraryFolderBrowser.browseStamp = stamp;
  if (!window.desktopWindow || typeof window.desktopWindow.browseLocalMusicFolder !== 'function') {
    libraryFolderBrowser.browse = { directories: [], files: [], childIds: {} };
    libraryPaintFolderScroll();
    return;
  }
  libraryFolderBrowser.loading = true;
  try {
    var result = await window.desktopWindow.browseLocalMusicFolder(libraryFolderBrowser.nodeId);
    // A slow answer for a node the user has already left must not repaint.
    if (stamp !== libraryFolderBrowser.browseStamp) return;
    if (result && result.ok === true) {
      libraryFolderBrowser.browse = {
        directories: Array.isArray(result.directories) ? result.directories : [],
        files: Array.isArray(result.files) ? result.files : [],
        childIds: result.childIds || {},
      };
    } else if (result && result.error === 'LOCAL_FOLDER_UNKNOWN') {
      // The folder moved or was renamed since the tree was built.
      libraryFolderBrowser.browse = { directories: [], files: [], childIds: {} };
      libraryFolderBrowser.status = 'That folder is no longer there';
    } else {
      libraryFolderBrowser.browse = { directories: [], files: [], childIds: {} };
    }
  } catch (err) {
    if (stamp !== libraryFolderBrowser.browseStamp) return;
    libraryFolderBrowser.browse = { directories: [], files: [], childIds: {} };
  } finally {
    if (stamp === libraryFolderBrowser.browseStamp) libraryFolderBrowser.loading = false;
    libraryPaintFolderScroll();
    libraryPaintFolderCount();
  }
}

function libraryFolderToggle(nodeId) {
  var id = String(nodeId || '');
  libraryFolderBrowser.open[id] = !libraryFolderBrowser.open[id];
  libraryPaintFolderScroll();
}

// ---------------------------------------------------------------- actions

function libraryFolderSelectedSongs() {
  var node = libraryFolderBrowser.nodeId ? libraryFolderNodeById(libraryFolderBrowser.nodeId) : null;
  if (!node) return [];
  var wanted = {};
  var ids = libraryFolderIndexedIds(node);
  for (var i = 0; i < ids.length; i += 1) wanted[ids[i]] = true;
  var out = [];
  var tracks = localLibraryStore.tracks;
  for (var t = 0; t < tracks.length; t += 1) {
    var id = localLibrarySongKey(tracks[t]);
    if (wanted[id]) out.push(tracks[t]);
  }
  return out;
}

function libraryFolderPlay(shuffle) {
  var songs = libraryFolderSelectedSongs();
  if (!songs.length) {
    showToast('Nothing indexed in that folder yet');
    return false;
  }
  return libraryPlaySongs(songs, shuffle);
}

function libraryFolderQueue() {
  var songs = libraryFolderSelectedSongs();
  if (!songs.length) {
    showToast('Nothing indexed in that folder yet');
    return;
  }
  for (var i = 0; i < songs.length; i += 1) queueSong(songs[i]);
  showToast('Added ' + songs.length + ' to the queue');
}

function libraryFolderAddToPlaylist() {
  var songs = libraryFolderSelectedSongs();
  if (!songs.length) {
    showToast('Nothing indexed in that folder yet');
    return;
  }
  libraryOpenPlaylistPicker(songs);
}

async function libraryFolderReveal() {
  var nodeId = libraryFolderBrowser.nodeId;
  if (!nodeId) return;
  if (!window.desktopWindow || typeof window.desktopWindow.revealLocalMusicFolder !== 'function') {
    showToast('Opening a folder needs the desktop app');
    return;
  }
  var result = await window.desktopWindow.revealLocalMusicFolder(nodeId);
  if (!result || result.ok !== true) {
    showToast(result && result.error === 'LOCAL_FILE_MISSING'
      ? 'That folder is no longer on disk'
      : 'Could not open that folder');
  }
}

async function libraryFolderRescan() {
  var node = libraryFolderBrowser.nodeId ? libraryFolderNodeById(libraryFolderBrowser.nodeId) : null;
  if (!node) return;
  var ids = libraryFolderIndexedIds(node);
  if (!ids.length) {
    showToast('Nothing indexed in that folder yet');
    return;
  }
  if (!window.desktopWindow || typeof window.desktopWindow.rescanLocalMusicFolder !== 'function') {
    libraryRunScan(false);
    return;
  }
  var result = await window.desktopWindow.rescanLocalMusicFolder(ids);
  if (!result || result.ok !== true) {
    showToast(result && result.error === 'LOCAL_TRACK_NOT_FOUND'
      ? 'Those tracks are no longer in the library'
      : 'Could not rescan that folder');
    return;
  }
  setLocalLibraryStoreTracks(result.tracks);
  if (Array.isArray(result.folders)) localLibrarySetFolders(result.folders);
  await libraryLoadFolderTree(true);
  libraryPaintFolderBrowser();
  showToast('Folder rescanned');
}

// ---------------------------------------------------------------- wiring

function libraryInstallFolderBrowser() {
  var host = document.getElementById('library-folders-host');
  if (host && !document.getElementById('library-folders')) host.innerHTML = libraryFolderBrowserHtml();
  var scroll = document.getElementById('library-folder-scroll');
  if (scroll && !scroll.dataset.bound) {
    scroll.dataset.bound = '1';
    scroll.addEventListener('click', function (event) {
      var row = event.target.closest ? event.target.closest('[data-library-folder-index]') : null;
      if (!row) return;
      var index = Number(row.getAttribute('data-library-folder-index'));
      var entry = (libraryFolderBrowser.rows || [])[index];
      if (!entry) return;
      var id = row.getAttribute('data-library-folder-id');
      var kind = row.getAttribute('data-library-folder-kind');
      // The chevron half of a row walks into it; the name half opens it in the
      // tree. A row with no children has neither affordance and just re-reads.
      var chevronHit = !!(event.target.closest && event.target.closest('.library-folder-chevron'));
      if (kind === 'file') {
        var songs = libraryFolderSelectedSongs();
        var name = entry.entry.name.toLowerCase();
        var match = songs.filter(function (song) {
          return String(song.localPath || '').toLowerCase().split('/').pop() === name;
        })[0];
        if (match) libraryPlaySongs([match], false);
        else showToast('That file is not in the index yet — rescan the folder');
        return;
      }
      if (kind === 'node' && row.getAttribute('data-library-folder-child') === '1') {
        if (chevronHit) libraryFolderToggle(id);
        else libraryFolderSelect(id);
        return;
      }
      if (kind === 'dir') { libraryFolderSelect(id); return; }
      if (row.getAttribute('data-library-folder-child') === '1') libraryFolderToggle(id);
      else libraryFolderSelect(id);
    });
  }
  var pathBar = document.getElementById('library-folder-path');
  if (pathBar && !pathBar.dataset.bound) {
    pathBar.dataset.bound = '1';
    pathBar.addEventListener('click', function (event) {
      var button = event.target.closest ? event.target.closest('[data-library-folder]') : null;
      if (button) libraryFolderSelect(button.getAttribute('data-library-folder'));
    });
  }
}

function libraryFolderBrowserVisible() {
  return !!(document.getElementById('library-folders') && libraryPage.open);
}

// A change anywhere in the library — a background scan, an import, a restore —
// invalidates the tree. Rebuilt on next open rather than mid-paint.
function libraryInvalidateFolderTree() {
  libraryFolderBrowser.tree = [];
  libraryFolderBrowser.browse = null;
  libraryFolderBrowser.status = '';
  if (libraryFolderBrowserVisible()) libraryLoadFolderTree(true).then(libraryPaintFolderBrowser);
}

// ---------------------------------------------------------------- live sync

var librarySyncUnwatch = null;

// The main process announces every scan. This is what makes "automatic sync"
// real: the page updates itself when the disk changes, without a refresh.
function libraryWatchLibraryChanges() {
  if (librarySyncUnwatch) return;
  if (!window.desktopWindow || typeof window.desktopWindow.onLocalLibraryChanged !== 'function') return;
  librarySyncUnwatch = window.desktopWindow.onLocalLibraryChanged(function (payload) {
    if (!payload) return;
    if (Array.isArray(payload.folders)) localLibrarySetFolders(payload.folders);
    libraryInvalidateFolderTree();
    var changed = Number(payload.added) || 0;
    var removed = Number(payload.removed) || 0;
    var reTagged = Number(payload.changed) || 0;
    if (!changed && !removed && !reTagged) {
      if (libraryPage.open) libraryPaintFolderBrowser();
      return;
    }
    var parts = [];
    if (changed) parts.push(changed + ' added');
    if (reTagged) parts.push(reTagged + ' updated');
    if (removed) parts.push(removed + ' removed');
    // A background scan that actually changed something is worth one line;
    // one that found nothing is not, or a periodic sweep would talk every
    // twenty seconds.
    libraryPage.status = 'Library updated · ' + parts.join(', ');
    // The store is shared with the search panel and the queue, so the refresh
    // happens whether or not this page is open — a closed page would otherwise
    // come back to rows the index has already moved on from.
    hydrateLocalLibraryStore({ force: true }).then(function () {
      if (typeof libraryPaintPlaylistPane === 'function') libraryPaintPlaylistPane();
      if (!libraryPage.open) return;
      libraryPaintNav();
      libraryPaintHeader();
      libraryRebuildRows(false);
      libraryPaintFolderBrowser();
      var status = document.getElementById('library-status');
      if (status && !libraryPage.scanning) {
        status.hidden = false;
        status.textContent = libraryPage.status;
      }
    }).catch(function () { /* a failed refresh leaves the previous rows in place */ });
  });
}

async function librarySyncNow() {
  if (!window.desktopWindow || typeof window.desktopWindow.syncLocalMusicLibrary !== 'function') {
    return libraryRunScan(false);
  }
  var status = await window.desktopWindow.syncLocalMusicLibrary(true);
  if (status && status.ok === false) {
    showToast('Could not sync the library');
    return null;
  }
  // The change event carries the answer; if the bridge is old, fall back.
  await hydrateLocalLibraryStore({ force: true });
  libraryInvalidateFolderTree();
  libraryPaintNav();
  libraryRebuildRows(false);
  return status;
}
