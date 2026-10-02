// ============================================================
//  Local library store — the renderer's read-only projection of the
//  main-process index, plus the user's own layer on top of it.
//
//  The main process owns the files, the tags and the favourites: this module
//  caches what it hands back and derives the groupings every view needs from
//  it once, rather than re-walking 50k records on every keystroke. Nothing here
//  writes to disk — every mutation goes straight back over IPC and the answer
//  is what updates the cache, so the panel and the index can never drift apart.
// ============================================================

var localLibraryStore = {
  tracks: [],
  byId: {},
  userData: { songs: {}, playlists: [] },
  folders: [],
  loaded: false,
  loading: false,
  index: null,
  indexAt: 0,
  // Why the last read came back with nothing, when it was not simply empty. The
  // main process records this because loadIndex runs in the constructor and has
  // no way to fail out loud; a zero count is all that reaches the page without
  // it, and an unreadable index reads exactly like an empty library.
  warning: ''
};

// Groupings are derived once and thrown away whenever the track list or the
// counters change. Building them on every render is what turns a 50k library
// into a frozen window.
function invalidateLocalLibraryIndex() {
  localLibraryStore.index = null;
}

function localFileIdOf(song) {
  return String((song && (song.localFileId || song.localKey || song.id)) || '').replace(/^local:/, '');
}

function localLibrarySongKey(song) {
  return localFileIdOf(song);
}

function localLibraryUserState(song) {
  var id = localLibrarySongKey(song);
  var stored = id ? localLibraryStore.userData.songs[id] : null;
  if (!stored) return { favorite: false, rating: 0, plays: 0, skips: 0, completed: 0, lastPlayedAt: 0 };
  return stored;
}

function localLibraryIsFavorite(song) {
  return localLibraryUserState(song).favorite === true;
}

function localLibraryNormalizeTracks(list) {
  return (Array.isArray(list) ? list : [])
    .filter(function (song) { return song && song.localUrl && song.localKey; })
    .map(function (song) {
      var copy = hydrateCustomCover(Object.assign({}, song));
      copy.localMissing = false;
      return copy;
    });
}

// One place that owns "where do the tracks come from". Startup normally fills
// the cache already, so opening the page is instant; the await only happens
// the first time in a session, or after a scan replaced the list.
async function hydrateLocalLibraryStore(options) {
  options = options || {};
  if (localLibraryStore.loading && !options.force) return localLibraryStore.tracks;
  localLibraryStore.loading = true;
  try {
    var haveBridge = !!(window.desktopWindow
      && typeof window.desktopWindow.listLocalMusicLibrary === 'function');
    var requests = [];
    if (haveBridge && (options.force || !localLibraryStore.tracks.length)) {
      requests.push(window.desktopWindow.listLocalMusicLibrary());
    } else {
      requests.push(Promise.resolve({ ok: true, tracks: localLibraryStore.tracks }));
    }
    if (haveBridge && (options.force || !localLibraryStore.loaded)) {
      requests.push(window.desktopWindow.getLocalLibraryUserData
        ? window.desktopWindow.getLocalLibraryUserData()
        : Promise.resolve(null));
      requests.push(window.desktopWindow.listLocalMusicFolders
        ? window.desktopWindow.listLocalMusicFolders()
        : Promise.resolve(null));
    } else {
      requests.push(Promise.resolve(null));
      requests.push(Promise.resolve(null));
    }

    var results = await Promise.all(requests);

    var listResult = results[0];
    if (listResult && listResult.ok !== false && Array.isArray(listResult.tracks)) {
      localLibraryStore.warning = String(listResult.warning || '');
      localLibraryStore.tracks = localLibraryNormalizeTracks(listResult.tracks);
      // The startup restore keeps its own copy in sync so the search panel and
      // this page agree about what a local row is.
      if (typeof persistentLocalLibraryTracks !== 'undefined') {
        persistentLocalLibraryTracks = localLibraryStore.tracks.map(cloneSong);
      }
    }

    var userDataResult = results[1];
    if (userDataResult && userDataResult.ok === true) {
      localLibraryStore.userData = {
        songs: userDataResult.songs || {},
        playlists: Array.isArray(userDataResult.playlists) ? userDataResult.playlists : []
      };
    }

    var foldersResult = results[2];
    if (foldersResult && foldersResult.ok === true && Array.isArray(foldersResult.folders)) {
      localLibraryStore.folders = foldersResult.folders;
    }

    localLibraryStore.loaded = true;
    rebuildLocalLibraryById();
    invalidateLocalLibraryIndex();
    if (typeof updateLocalLibraryChoiceLabel === 'function') {
      updateLocalLibraryChoiceLabel(localLibraryStore.tracks.length);
    }
    return localLibraryStore.tracks;
  } finally {
    localLibraryStore.loading = false;
  }
}

function rebuildLocalLibraryById() {
  var map = {};
  for (var i = 0; i < localLibraryStore.tracks.length; i += 1) {
    var song = localLibraryStore.tracks[i];
    var id = localLibrarySongKey(song);
    if (id) map[id] = song;
  }
  localLibraryStore.byId = map;
}

// Replace the cache from a scan answer. The scan result is authoritative —
// it already pruned what disappeared — so there is no merge to do here.
function setLocalLibraryStoreTracks(tracks) {
  localLibraryStore.tracks = localLibraryNormalizeTracks(tracks);
  // Every caller reaches this only after the main process answered with a list
  // it had just read or written, which is an index it was willing to open — so
  // whatever the boot reported about an older file no longer describes what is
  // on disk. The read path is what sets it; this is what lets it go.
  localLibraryStore.warning = '';
  rebuildLocalLibraryById();
  invalidateLocalLibraryIndex();
  if (typeof persistentLocalLibraryTracks !== 'undefined') {
    persistentLocalLibraryTracks = localLibraryStore.tracks.map(cloneSong);
  }
  if (typeof updateLocalLibraryChoiceLabel === 'function') {
    updateLocalLibraryChoiceLabel(localLibraryStore.tracks.length);
  }
  return localLibraryStore.tracks;
}

function localLibrarySetUserData(userData) {
  if (!userData) return;
  localLibraryStore.userData = {
    songs: userData.songs || {},
    playlists: Array.isArray(userData.playlists) ? userData.playlists : []
  };
}

function localLibrarySetFolders(folders) {
  if (Array.isArray(folders)) localLibraryStore.folders = folders.slice();
}

// ---------------------------------------------------------------- grouping

function localLibraryFolderOf(song) {
  var relative = String(song.localPath || '');
  if (!relative) return '';
  var slash = relative.lastIndexOf('/');
  return slash > 0 ? relative.slice(0, slash) : '';
}

function localLibraryKeyFor(song, field) {
  if (field === 'album') return String(song.album || '').trim() || 'Unknown album';
  if (field === 'artist') return String(song.artist || '').trim() || 'Unknown artist';
  if (field === 'albumArtist') return String(song.albumArtist || '').trim() || String(song.artist || '').trim() || 'Unknown artist';
  if (field === 'genre') return String(song.genre || '').trim() || 'Unknown genre';
  if (field === 'folder') return localLibraryFolderOf(song) || 'Root';
  if (field === 'year') {
    var year = Number(song.year) || 0;
    return year > 0 ? String(year) : 'Unknown year';
  }
  return '';
}

function localLibraryBuildGroups(field) {
  var groups = {};
  var order = [];
  var tracks = localLibraryStore.tracks;
  for (var i = 0; i < tracks.length; i += 1) {
    var song = tracks[i];
    var key = localLibraryKeyFor(song, field);
    var bucket = groups[key];
    if (!bucket) {
      bucket = { key: key, name: key, count: 0, songs: [], cover: '', artist: '', sub: '' };
      groups[key] = bucket;
      order.push(key);
    }
    bucket.songs.push(song);
    bucket.count += 1;
    if (!bucket.cover) bucket.cover = songCoverSrc(song, 64) || '';
    if (!bucket.artist && field !== 'artist') bucket.artist = String(song.artist || '');
    if (!bucket.sub && field === 'folder') bucket.sub = bucket.count + ' track' + (bucket.count === 1 ? '' : 's');
  }
  var list = order.map(function (key) { return groups[key]; });
  for (var g = 0; g < list.length; g += 1) {
    var group = list[g];
    if (group.songs.length > 1 && group.songs[0] && typeof group.songs[0].track === 'number') {
      group.songs.sort(function (a, b) {
        var disc = (Number(a.disc) || 1) - (Number(b.disc) || 1);
        if (disc) return disc;
        return (Number(a.track) || 0) - (Number(b.track) || 0);
      });
    }
  }
  list.sort(function (a, b) { return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }); });
  return list;
}

function localLibraryBuildIndex() {
  if (localLibraryStore.index) return localLibraryStore.index;
  var index = {
    albums: localLibraryBuildGroups('album'),
    artists: localLibraryBuildGroups('artist'),
    genres: localLibraryBuildGroups('genre'),
    folders: localLibraryBuildGroups('folder'),
    years: localLibraryBuildGroups('year')
  };
  localLibraryStore.index = index;
  localLibraryStore.indexAt = Date.now();
  return index;
}

// ---------------------------------------------------------------- views

var LIBRARY_VIEWS = [
  { id: 'songs', label: 'Songs', kind: 'songs' },
  { id: 'albums', label: 'Albums', kind: 'groups' },
  { id: 'artists', label: 'Artists', kind: 'groups' },
  { id: 'genres', label: 'Genres', kind: 'groups' },
  { id: 'folders', label: 'Folders', kind: 'groups' },
  { id: 'playlists', label: 'Playlists', kind: 'playlists' },
  { id: 'recent-added', label: 'Recently added', kind: 'songs' },
  { id: 'recent-played', label: 'Recently played', kind: 'songs' },
  { id: 'favorites', label: 'Favorites', kind: 'songs' },
  { id: 'top-rated', label: 'Top rated', kind: 'songs' },
  { id: 'most-played', label: 'Most played', kind: 'songs' }
];

function libraryViewMeta(viewId) {
  for (var i = 0; i < LIBRARY_VIEWS.length; i += 1) {
    if (LIBRARY_VIEWS[i].id === viewId) return LIBRARY_VIEWS[i];
  }
  return LIBRARY_VIEWS[0];
}

function localLibrarySortedCopy(tracks) {
  return tracks.slice().sort(function (a, b) {
    return String(a.name || '').localeCompare(String(b.name || ''), undefined, { numeric: true, sensitivity: 'base' });
  });
}

// Returns the rows for one view: either songs or groups. Sorting happens here
// so the page never has to know which counters exist.
function libraryViewRows(viewId) {
  var tracks = localLibraryStore.tracks;
  switch (viewId) {
    case 'albums':
      return localLibraryBuildIndex().albums;
    case 'artists':
      return localLibraryBuildIndex().artists;
    case 'genres':
      return localLibraryBuildIndex().genres;
    case 'folders':
      return localLibraryBuildIndex().folders;
    case 'recent-added':
      return tracks.slice().sort(function (a, b) {
        var delta = (Number(b.addedAt) || 0) - (Number(a.addedAt) || 0);
        if (delta) return delta;
        return String(a.name || '').localeCompare(String(b.name || ''));
      });
    case 'recent-played':
      return tracks.filter(function (song) { return localLibraryUserState(song).lastPlayedAt > 0; })
        .sort(function (a, b) {
          var delta = (Number(localLibraryUserState(b).lastPlayedAt) || 0)
            - (Number(localLibraryUserState(a).lastPlayedAt) || 0);
          if (delta) return delta;
          return String(a.name || '').localeCompare(String(b.name || ''));
        });
    case 'favorites':
      return localLibrarySortedCopy(tracks.filter(function (song) { return localLibraryIsFavorite(song); }));
    case 'top-rated':
      return tracks.filter(function (song) { return localLibraryUserState(song).rating > 0; })
        .sort(function (a, b) {
          var delta = (Number(localLibraryUserState(b).rating) || 0)
            - (Number(localLibraryUserState(a).rating) || 0);
          if (delta) return delta;
          return String(a.name || '').localeCompare(String(b.name || ''));
        });
    case 'most-played':
      return tracks.filter(function (song) { return localLibraryUserState(song).plays > 0; })
        .sort(function (a, b) {
          var delta = (Number(localLibraryUserState(b).plays) || 0)
            - (Number(localLibraryUserState(a).plays) || 0);
          if (delta) return delta;
          return String(a.name || '').localeCompare(String(b.name || ''));
        });
    default:
      return localLibrarySortedCopy(tracks);
  }
}

// ---------------------------------------------------------------- search

// A subsequence match ranked by how tightly the query hugs the text. "gt" finds
// "Greatest Hits" but so does "great hit", and a consecutive run scores above a
// scattered one — which is the difference between a useful top row and a list
// ordered by nothing.
function localLibraryScoreMatch(haystack, needle) {
  if (!needle) return 1;
  var text = String(haystack || '').toLowerCase();
  var query = String(needle).toLowerCase();
  var exact = text.indexOf(query);
  if (exact === 0) return 1000;
  if (exact > 0) return 700 - Math.min(300, exact);
  var score = 0;
  var run = 0;
  var at = 0;
  for (var i = 0; i < query.length; i += 1) {
    var found = text.indexOf(query[i], at);
    if (found < 0) return 0;
    run = found === at && i > 0 ? run + 1 : 0;
    score += 10 + run * 6 - Math.min(6, found - at);
    at = found + 1;
  }
  return score;
}

function librarySearchTracks(query) {
  var trimmed = String(query || '').trim();
  if (!trimmed) return localLibrarySortedCopy(localLibraryStore.tracks);
  var terms = trimmed.toLowerCase().split(/\s+/).filter(Boolean);
  var tracks = localLibraryStore.tracks;
  var hits = [];
  for (var i = 0; i < tracks.length; i += 1) {
    var song = tracks[i];
    var best = 0;
    var fields = [
      song.name,
      song.artist,
      song.album,
      song.albumArtist,
      song.genre,
      song.composer,
      song.localPath,
      String(song.year || '')
    ];
    var total = 0;
    for (var t = 0; t < terms.length; t += 1) {
      var termScore = 0;
      for (var f = 0; f < fields.length; f += 1) {
        termScore = Math.max(termScore, localLibraryScoreMatch(fields[f], terms[t]));
      }
      if (!termScore) { total = 0; break; }
      total += termScore;
    }
    if (!total) continue;
    best = total;
    hits.push({ song: song, score: best });
  }
  hits.sort(function (a, b) {
    if (b.score !== a.score) return b.score - a.score;
    return String(a.song.name || '').localeCompare(String(b.song.name || ''));
  });
  return hits.map(function (hit) { return hit.song; });
}

function libraryGroupTracks(query) {
  var trimmed = String(query || '').trim();
  if (!trimmed) return null;
  var groups = localLibraryBuildIndex().albums
    .concat(localLibraryBuildIndex().artists)
    .concat(localLibraryBuildIndex().genres)
    .concat(localLibraryBuildIndex().folders);
  var hits = [];
  for (var i = 0; i < groups.length; i += 1) {
    var score = localLibraryScoreMatch(groups[i].name, trimmed);
    if (score > 0) hits.push({ group: groups[i], score: score });
  }
  hits.sort(function (a, b) { return b.score - a.score; });
  return hits.slice(0, 40).map(function (hit) { return hit.group; });
}

// ---------------------------------------------------------------- mutations

// Every write goes to the main process and adopts its answer. Optimistic UI
// would be faster by a frame, and wrong the first time the disk is busy.
async function librarySetFavorite(song, favorite) {
  var id = localLibrarySongKey(song);
  if (!id || !window.desktopWindow || typeof window.desktopWindow.setLocalLibraryUser !== 'function') return null;
  var result = await window.desktopWindow.setLocalLibraryUser({ id: id, action: 'favorite', value: favorite !== false });
  if (result && result.changed) {
    var entry = localLibraryStore.userData.songs[id] || {};
    entry.favorite = !!result.favorite;
    entry.rating = result.rating || entry.rating || 0;
    localLibraryStore.userData.songs[id] = entry;
    invalidateLocalLibraryIndex();
  }
  return result;
}

async function libraryToggleFavorite(song) {
  var id = localLibrarySongKey(song);
  if (!id || !window.desktopWindow || typeof window.desktopWindow.setLocalLibraryUser !== 'function') return null;
  var result = await window.desktopWindow.setLocalLibraryUser({ id: id, action: 'favorite-toggle' });
  if (result && result.changed) {
    var entry = localLibraryStore.userData.songs[id] || {};
    entry.favorite = !!result.favorite;
    localLibraryStore.userData.songs[id] = entry;
    invalidateLocalLibraryIndex();
  }
  return result;
}

async function librarySetRating(song, rating) {
  var id = localLibrarySongKey(song);
  if (!id || !window.desktopWindow || typeof window.desktopWindow.setLocalLibraryUser !== 'function') return null;
  var result = await window.desktopWindow.setLocalLibraryUser({ id: id, action: 'rating', value: rating });
  if (result && result.changed) {
    var entry = localLibraryStore.userData.songs[id] || {};
    entry.rating = result.rating || 0;
    localLibraryStore.userData.songs[id] = entry;
    invalidateLocalLibraryIndex();
  }
  return result;
}

// Play counters are recorded from the playback start path so "Most played"
// means the same thing here as in the home dashboard's listen stats.
async function libraryRecordPlaybackEvent(song, event) {
  var id = localLibrarySongKey(song);
  if (!id || !window.desktopWindow || typeof window.desktopWindow.setLocalLibraryUser !== 'function') return null;
  try {
    var result = await window.desktopWindow.setLocalLibraryUser({ id: id, action: 'event', event: event });
    if (result && result.changed) {
      var entry = localLibraryStore.userData.songs[id] || {};
      entry.plays = result.plays || 0;
      entry.skips = result.skips || 0;
      entry.completed = result.completed || 0;
      entry.lastPlayedAt = result.lastPlayedAt || 0;
      localLibraryStore.userData.songs[id] = entry;
      invalidateLocalLibraryIndex();
    }
    return result;
  } catch (err) {
    return null;
  }
}
