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
  // The route cache sorts and filters on rating, plays and last played, which
  // live in the user state rather than in the track. A favourite toggle or a
  // play count therefore has to drop it too, or the table keeps the order it
  // had before the change.
  if (typeof libraryInvalidateRouteCache === 'function') libraryInvalidateRouteCache();
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
  // Every module is bundled into one classic script, so this declaration is
  // hoisted above the statement below that fills the store in — and the player
  // calls updateLikeButtons() from an earlier module's top level. Reading an
  // object that does not exist yet would throw there, and an uncaught throw
  // stops the bundle for good: nothing after that line ever runs.
  if (!localLibraryStore || !localLibraryStore.userData) return false;
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
  // The sorted/filtered table is cached per route, and a route's contents are
  // a function of the tracks — so a rescan has to drop it or the user keeps
  // looking at the library as it was before the scan.
  if (typeof libraryInvalidateRouteCache === 'function') libraryInvalidateRouteCache();
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

// One lowercase string per track holding every field search looks at, joined
// with newlines. The eight-field scan below costs a function call per field per
// track — 400k calls across a 50k library, measured at 378 ms for a two
// character query — where one scan of one string per track measures 31 ms.
//
// The blob is a superset of the fields, so it is only ever used to throw tracks
// away: a term whose characters do not appear in order in the blob cannot
// appear in order in any field of it either, which makes the filter free of
// false negatives and leaves the scoring below — and therefore every result and
// its order — exactly as it was.
//
// The cache hangs off the store and is keyed on the array it was built from, so
// it invalidates itself the moment the track list is replaced and does not move
// at all when a favourite or a rating changes. No caller has to remember to
// clear it.
function localLibrarySearchBlobs(tracks) {
  var cache = localLibraryStore.searchBlobCache;
  if (cache && cache.source === tracks) return cache.blobs;
  var blobs = new Array(tracks.length);
  for (var i = 0; i < tracks.length; i += 1) blobs[i] = localLibrarySearchBlob(tracks[i]);
  localLibraryStore.searchBlobCache = { source: tracks, blobs: blobs };
  return blobs;
}

function localLibrarySearchBlob(song) {
  song = song || {};
  return (String(song.name || '') + '\n' +
    String(song.artist || '') + '\n' +
    String(song.album || '') + '\n' +
    String(song.albumArtist || '') + '\n' +
    String(song.genre || '') + '\n' +
    String(song.composer || '') + '\n' +
    String(song.localPath || '') + '\n' +
    String(song.year || '')).toLowerCase();
}

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

// The most localLibraryScoreMatch can ever return for a query of n characters.
// The two substring paths top out at 1000 (a prefix hit) and 699 (a hit further
// in); the subsequence path adds 10 + 6·run per character, and run can never
// exceed the character's own index, so the sum is 10n + 3n(n-1) with every gap
// zero — any real gap only subtracts from it.
//
// This is what lets localLibraryMatchScore stop early. At 50k tracks the eight
// field scores cost ~400 ms when a query is broad enough to reach the last
// field, which is most two-character queries; once a field has hit the ceiling
// no remaining field can beat it, so the other six calls are provably wasted.
// For every query under about seventeen characters the ceiling is 1000 — an
// exact prefix — which is the common case by a wide margin.
function localLibraryScoreCeiling(termLength) {
  var n = Number(termLength) > 0 ? Number(termLength) : 0;
  var seq = 10 * n + 3 * n * (n - 1);
  return seq > 1000 ? seq : 1000;
}

// What a query *is*, in one place: whitespace-separated, lowercased terms.
// Every entry point splits this way so the library page and the global panel
// cannot disagree about how many words were typed.
function localLibraryQueryTerms(query) {
  var trimmed = String(query || '').trim().toLowerCase();
  return trimmed ? trimmed.split(/\s+/).filter(Boolean) : [];
}

// The single decision about whether a track matches: every term has to hit at
// least one field, and the track's score is the sum of that term's best field.
//
// Deliberately shared. It used to be inlined twice, and the second copy was
// written against the memoised blob — whose subsequence walk can step over a
// newline into the next field. "northern aurora" therefore matched a track
// whose fields held "Northern" and "Borealis", and the global panel offered a
// row the library page would reject. Two matchers on one query is two answers.
//
// The fields are scored inline rather than collected into an array first:
// building the array costs ~148 ms of the 378 ms scan at 50k tracks, and
// nothing here needs to iterate them any other way.
function localLibraryMatchScore(song, terms) {
  if (!song || !terms.length) return 0;
  var year = String(song.year || '');
  var total = 0;
  for (var t = 0; t < terms.length; t += 1) {
    var term = terms[t];
    var ceiling = localLibraryScoreCeiling(term.length);
    // Stop only at the ceiling — never at "good enough" — so the result is
    // bit-for-bit what a full walk over all eight fields would have found.
    // For any query shorter than about seventeen characters the ceiling is a
    // plain prefix hit, which is what most two-character queries become on the
    // artist or title field: six of the eight calls then never happen.
    var termScore = localLibraryScoreMatch(song.name, term);
    var scored;
    if (termScore < ceiling) {
      scored = localLibraryScoreMatch(song.artist, term);
      if (scored > termScore) termScore = scored;
    }
    if (termScore < ceiling) {
      scored = localLibraryScoreMatch(song.album, term);
      if (scored > termScore) termScore = scored;
    }
    if (termScore < ceiling) {
      scored = localLibraryScoreMatch(song.albumArtist, term);
      if (scored > termScore) termScore = scored;
    }
    if (termScore < ceiling) {
      scored = localLibraryScoreMatch(song.genre, term);
      if (scored > termScore) termScore = scored;
    }
    if (termScore < ceiling) {
      scored = localLibraryScoreMatch(song.composer, term);
      if (scored > termScore) termScore = scored;
    }
    if (termScore < ceiling) {
      scored = localLibraryScoreMatch(song.localPath, term);
      if (scored > termScore) termScore = scored;
    }
    if (termScore < ceiling) {
      scored = localLibraryScoreMatch(year, term);
      if (scored > termScore) termScore = scored;
    }
    if (!termScore) return 0;
    total += termScore;
  }
  return total;
}

// The blob is a superset of the fields, so it is only ever used to throw tracks
// away: a term whose characters do not appear in order in the blob cannot
// appear in order in any field of it either, which makes the filter free of
// false negatives.
//
// It is not a *decision*. A subsequence found in the joined string may have
// stepped across a newline into a different field, so this says yes to a few
// tracks localLibraryMatchScore then rejects — one wasted score per track,
// where the other direction would silently drop a real hit.
function localLibraryBlobCouldMatch(blob, terms) {
  for (var t = 0; t < terms.length; t += 1) {
    if (!localLibraryScoreMatch(blob, terms[t])) return false;
  }
  return true;
}

// Order two search hits the same way everywhere: score first, then title, so
// tracks that tie always come back in the same order whichever surface asked.
function localLibraryHitBetter(a, b) {
  if (a.score !== b.score) return a.score > b.score;
  return String(a.song.name || '').localeCompare(String(b.song.name || '')) < 0;
}

// The same order, as a sort comparator, so the two callers below can never
// drift into disagreeing about which of two tied tracks comes first.
function localLibraryCompareHits(a, b) {
  if (localLibraryHitBetter(a, b)) return -1;
  if (localLibraryHitBetter(b, a)) return 1;
  return 0;
}

// The one scan. Every track is blob-prefiltered, scored by
// localLibraryMatchScore, and ordered by localLibraryCompareHits; `limit` then
// cuts the tail, 0 meaning "keep everything".
//
// Both surfaces call this — the library page unbounded, the global panel to
// forty — which is the whole reason it exists as a function rather than as a
// loop in each. Two copies of a matcher diverge, and the first divergence this
// had was a track whose blob matched across a field boundary that its fields
// did not: the panel offered a row the page would reject.
//
// The prefilter is one call per track before the eight: on a 50k library it
// costs 31 ms where the full scan costs 378 ms, and a query that matches
// nothing — which is most of what is typed — never reaches the inner loop.
function localLibrarySearchSongs(tracks, query, limit) {
  var trimmed = String(query || '').trim();
  if (!trimmed) return localLibrarySortedCopy(tracks);
  if (!tracks.length) return [];
  var terms = localLibraryQueryTerms(trimmed);
  var blobs = localLibrarySearchBlobs(tracks);
  var cap = Number(limit) > 0 ? Number(limit) : 0;
  var hits = [];
  for (var i = 0; i < tracks.length; i += 1) {
    if (!localLibraryBlobCouldMatch(blobs[i], terms)) continue;
    var song = tracks[i];
    var score = localLibraryMatchScore(song, terms);
    if (!score) continue;
    if (!cap) { hits.push({ song: song, score: score }); continue; }

    // Bounded: keep only the best `cap` while walking, instead of collecting
    // every hit and sorting it. "rock" matches all fifty thousand tracks, and
    // sorting that list costs ~100 ms in tie-breaking alone — ties go to
    // localeCompare, of all things, because two tracks that score the same have
    // to come back in the same order on both surfaces.
    var last = hits.length >= cap ? hits[hits.length - 1] : null;
    if (last && score < last.score) continue;
    if (last && score === last.score &&
      String(song.name || '').localeCompare(String(last.song.name || '')) >= 0) continue;
    var hit = { song: song, score: score };
    // Binary insertion into an already-ordered list. It asks "is this strictly
    // better than what is at p", which is exactly what sort-then-slice does, so
    // the answer is the same rows in the same order — ties included.
    var at = 0;
    var hi = hits.length;
    while (at < hi) {
      var mid = (at + hi) >> 1;
      if (localLibraryHitBetter(hit, hits[mid])) hi = mid;
      else at = mid + 1;
    }
    hits.splice(at, 0, hit);
    if (hits.length > cap) hits.length = cap;
  }
  if (!cap) hits.sort(localLibraryCompareHits);
  return hits.map(function (hit) { return hit.song; });
}

function librarySearchTracks(query) {
  return localLibrarySearchSongs(localLibraryStore.tracks, query, 0);
}

// What the global search box has to offer from this device: the same tracks
// librarySearchTracks would return, cut to a bounded candidate list.
//
// The panel shows 180 rows across every source it has, and a library of fifty
// thousand tracks answers a query like "the" with tens of thousands of rows —
// handing those to mergeSongSearchResults would crowd every online source out
// of the list, so only the top `limit` survive.
//
// Empty is not the same answer here as on the library page. The page shows the
// whole library with nothing typed; the panel has nothing to add to the online
// results it is already showing, and offering all fifty thousand tracks would
// be worse than offering none.
//
// The store is what the Library page hydrates at startup; the restore copy is
// the fallback for the window before that finishes, so a search typed in the
// first second of the session still finds something.
function localLibrarySearchCandidates(query, limit) {
  if (!String(query || '').trim()) return [];
  var tracks = (localLibraryStore && localLibraryStore.tracks.length)
    ? localLibraryStore.tracks
    : (typeof localLibraryTracksNow === 'function' ? localLibraryTracksNow() : []);
  if (!tracks.length) return [];
  return localLibrarySearchSongs(tracks, query, limit);
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
// The hearts in the player read this store rather than keeping a second copy
// of the flag, so a favourite set from a row or a context menu has to reach
// them instead of waiting for the next track change. Guarded because the
// startup bindings call updateLikeButtons() before this module is parsed.
function notifyLikeButtonsChanged() {
  if (typeof updateLikeButtons === 'function') updateLikeButtons();
}

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
    notifyLikeButtonsChanged();
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
    notifyLikeButtonsChanged();
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
