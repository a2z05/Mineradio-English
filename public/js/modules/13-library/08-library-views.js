// ============================================================
//  Sort, filter and view switching for the library table.
//
//  Ported from Sonora (GPL-3.0-or-later, github.com/sonorahq/sonora):
//  crates/views/src/shared/tracks/{columns,sieve,sort}.rs and
//  crates/router/src/lib.rs. Their UI is Rust/GPUI; the model underneath it
//  is a ranked column spec, a multi-axis sieve and a grouping header, and that
//  part is plain data, so it survives the move into this renderer.
//
//  Two rules this file keeps, because they are the whole point of the port:
//
//   1. Sorting and filtering run over the whole library, not over what is on
//      screen. The visible rows are a window onto an ordered, sieved list, so
//      turning a column around cannot scroll the user off the end of their own
//      library at 50,000 tracks.
//   2. No view ever sorts the array the table renders from in place. Every
//      route builds a fresh array; the store's own order is left alone so the
//      next route starts from the same place.
// ============================================================

var LIBRARY_VIEW_ROWS_MAX = 0; // every route is unbounded on purpose

// Sonora ranks a column so a narrow window can drop the least useful ones
// first. Rank drives which columns the table shows at the current width.
var LIBRARY_COLUMN_RANK = {
  essential: 4,
  handy: 3,
  nice: 2,
  spare: 1,
  useful: 1
};

// The columns, in Sonora's order, with the widths they give them. `fill`
// columns share what is left after the fixed ones; the fractions are relative
// to each other, exactly as columns.rs expresses them.
var LIBRARY_COLUMNS = [
  { field: 'index', key: 'index', label: '#', width: 'fixed:52px', rank: 'essential', align: 'right' },
  { field: 'cover', key: 'cover', label: '', width: 'fixed:44px', rank: 'essential' },
  { field: 'title', key: 'title', label: 'Title', fill: 0.515, rank: 'essential' },
  { field: 'artist', key: 'artist', label: 'Artist', fill: 0.212, rank: 'handy' },
  { field: 'album', key: 'album', label: 'Album', fill: 0.273, rank: 'spare' },
  { field: 'addedAt', key: 'added-at', label: 'Date added', width: 'fixed:112px', rank: 'nice' },
  { field: 'duration', key: 'duration', label: 'Length', width: 'fixed:84px', rank: 'useful', align: 'right' }
];

// Views whose rows are groups (an album, an artist) do not repeat the album
// name on every track, so they widen the title and drop the column. The last
// column counts tracks rather than timing them, because a group has no single
// length worth printing.
var LIBRARY_GROUP_COLUMNS = [
  { field: 'index', key: 'index', label: '#', width: 'fixed:52px', rank: 'essential', align: 'right' },
  { field: 'cover', key: 'cover', label: '', width: 'fixed:44px', rank: 'essential' },
  { field: 'title', key: 'title', label: 'Title', fill: 0.665, rank: 'essential' },
  { field: 'artist', key: 'artist', label: 'Artist', fill: 0.335, rank: 'handy' },
  { field: 'count', key: 'count', label: 'Tracks', width: 'fixed:84px', rank: 'useful', align: 'right' }
];

function libraryColumnsForView(viewId) {
  var meta = libraryViewMeta(viewId);
  return meta && meta.kind === 'groups' ? LIBRARY_GROUP_COLUMNS : LIBRARY_COLUMNS;
}

// Which columns a table of this width can carry without squeezing the title
// into three words a row. Sonora hides by rank (columns.rs, `rank:` on each
// ColumnSpec): the essentials stay and the nice-to-haves go first. The budget
// is measured against the title alone, because that is the column the user is
// actually reading and it is the one that suffers when everything else is kept.
var LIBRARY_TITLE_MIN_W = 260;

function libraryVisibleColumns(viewId, width) {
  var columns = libraryColumnsForView(viewId);
  var w = Number(width) || 0;
  if (!w) return columns;

  var kept = null;
  // Start at the threshold that keeps everything and raise it only as far as it
  // has to go. Trying from the other end — dropping first, adding back — answers
  // a different question and is how a wide window ends up short of columns.
  for (var threshold = 1; threshold <= 4; threshold += 1) {
    var candidate = columns.filter(function (column) {
      return LIBRARY_COLUMN_RANK[column.rank] >= threshold;
    });
    if (!candidate.length) break;
    kept = candidate;

    var titleColumn = null;
    var fill = 0;
    var fixed = 0;
    for (var i = 0; i < candidate.length; i += 1) {
      if (candidate[i].field === 'title') titleColumn = candidate[i];
      if (candidate[i].fill) fill += candidate[i].fill;
      else fixed += parseFloat(candidate[i].width.replace('fixed:', '')) || 0;
    }
    // Nothing is fighting the title, so there is no reason to drop anything.
    if (!titleColumn) break;

    var room = w - fixed - 20;
    var titleWidth = room > 0 && fill ? room * (titleColumn.fill / fill) : 0;
    if (titleWidth >= LIBRARY_TITLE_MIN_W) break;
  }
  return kept && kept.length ? kept : columns;
}

// ---------------------------------------------------------------- the sieve

// Sonora's TrackSieve: every axis that is switched on must pass. Duration
// bounds are inclusive to the second, and the favourite axis is applied by the
// caller because the sieve cannot see the user state store.
function libraryNewSieve() {
  return { duration: null, favorites: false, rated: false, unplayed: false };
}

function librarySieveActive(sieve) {
  return !!(sieve && (sieve.duration || sieve.favorites || sieve.rated || sieve.unplayed));
}

function librarySieveKeeps(sieve, song) {
  if (!sieve) return true;
  var state = localLibraryUserState(song);
  if (sieve.favorites && state.favorite !== true) return false;
  if (sieve.rated && !(state.rating > 0)) return false;
  if (sieve.unplayed && (state.plays || 0) > 0) return false;
  if (sieve.duration) {
    var seconds = Number(song && song.duration);
    if (!isFinite(seconds)) return false;
    // The half second either way is Sonora's tolerance, so a track listed as
    // 3:59 is still inside a 0-4:00 filter.
    if (seconds < sieve.duration[0] - 0.5 || seconds > sieve.duration[1] + 0.5) return false;
  }
  return true;
}

function libraryApplySieve(songs, sieve) {
  if (!librarySieveActive(sieve)) return songs.slice();
  var out = [];
  for (var i = 0; i < songs.length; i += 1) {
    if (librarySieveKeeps(sieve, songs[i])) out.push(songs[i]);
  }
  return out;
}

// ---------------------------------------------------------------- sorting

// Sonora folds case before comparing so "abba" and "Abba" sort together.
function libraryFoldText(value) {
  var text = String(value == null ? '' : value);
  try {
    return text.toLocaleLowerCase();
  } catch (e) {
    return text.toLowerCase();
  }
}

// The tracks call their title `name`, but the groups call it `name` too — the
// one field name both shapes agree on. Group counts ride on `count`.
function librarySortName(row) {
  return row && row.name != null ? row.name : row && row.title;
}

function librarySortValue(row, field) {
  if (field === 'title') return libraryFoldText(librarySortName(row));
  if (field === 'artist') return libraryFoldText(row.artist || row.albumArtist);
  if (field === 'album') return libraryFoldText(row.album);
  if (field === 'addedAt') return Number(row.addedAt) || 0;
  if (field === 'duration') return Number(row.duration) || 0;
  if (field === 'count') return Number(row.count) || 0;
  // The user state covers tracks only; a group lands on 0 and stays put,
  // which is honest — sorting albums by plays would mean ranking sums of
  // other sums.
  if (field === 'plays') {
    return (localLibraryUserState(row).plays || 0);
  }
  if (field === 'rating') {
    return (localLibraryUserState(row).rating || 0);
  }
  if (field === 'lastPlayedAt') {
    return (localLibraryUserState(row).lastPlayedAt || 0);
  }
  return '';
}

// Returns a copy, always. The caller may hold on to it.
function librarySortSongs(songs, field, direction) {
  var out = songs.slice();
  var sign = direction === 'desc' ? -1 : 1;
  out.sort(function (a, b) {
    var left = librarySortValue(a, field);
    var right = librarySortValue(b, field);
    if (typeof left === 'number' || typeof right === 'number') {
      var d = (Number(left) || 0) - (Number(right) || 0);
      if (d) return d * sign;
    } else {
      if (left < right) return -1 * sign;
      if (left > right) return 1 * sign;
    }
    // A stable tiebreak keeps a re-sort from reshuffling equal rows under the
    // user's feet, and gives numeric fields a name to fall back on.
    var aName = libraryFoldText(librarySortName(a));
    var bName = libraryFoldText(librarySortName(b));
    if (aName !== bName) return aName < bName ? -1 : 1;
    return 0;
  });
  return out;
}

// Sonora's group header: the first letter, uppercased, or "#" for anything that
// does not start with a letter. Multi-character case folds are kept whole, so
// "ßeta" files under SS.
function libraryGroupInitial(text) {
  var first = String(text == null ? '' : text).charAt(0);
  if (!first || !first.toUpperCase || !first.toUpperCase().match(/\p{L}/u)) return '#';
  return first.toUpperCase();
}

function libraryGroupHeaderFor(field, song) {
  if (field === 'title') return libraryGroupInitial(librarySortName(song));
  if (field === 'artist') return libraryGroupInitial(song.artist || song.albumArtist);
  if (field === 'album') return libraryGroupInitial(song.album);
  return null;
}

// ---------------------------------------------------------------- the route

function libraryRouteId(viewId, field, direction, sieve) {
  return [
    viewId || 'songs',
    field || 'title',
    direction === 'desc' ? 'desc' : 'asc',
    sieve && sieve.duration ? sieve.duration.join('-') : '',
    sieve && sieve.favorites ? 'fav' : '',
    sieve && sieve.rated ? 'rated' : '',
    sieve && sieve.unplayed ? 'fresh' : ''
  ].join('|');
}

function librarySortKeyForRoute(routeId) {
  var parts = String(routeId || '').split('|');
  return { field: parts[1] || 'title', direction: parts[2] === 'desc' ? 'desc' : 'asc' };
}

// The ordered, sieved list a view shows. Built once per route and cached, so
// flipping back to a route the user has already visited does not re-sort the
// library again.
var libraryRouteCache = Object.create(null);
var libraryRouteCacheOrder = [];
var LIBRARY_ROUTE_CACHE_MAX = 24;

function libraryParseSieve(parts) {
  // The positions match libraryRouteId. Kept in one place so the writer and
  // the reader cannot disagree about which index holds what: a favourites
  // filter landing on the rated flag would show as applied and do nothing.
  var duration = null;
  if (parts[3]) {
    var bounds = parts[3].split('-').map(Number);
    if (isFinite(bounds[0]) && isFinite(bounds[1]) && bounds[1] > bounds[0]) {
      duration = [bounds[0], bounds[1]];
    }
  }
  return {
    duration: duration,
    favorites: parts[4] === 'fav',
    rated: parts[5] === 'rated',
    unplayed: parts[6] === 'fresh'
  };
}

function libraryRouteSongs(routeId) {
  var cached = libraryRouteCache[routeId];
  if (cached) return cached;
  var parts = String(routeId || '').split('|');
  var viewId = parts[0] || 'songs';
  var field = parts[1] || 'title';
  var direction = parts[2] === 'desc' ? 'desc' : 'asc';
  var sieve = libraryParseSieve(parts);
  var base = libraryViewRows(viewId);
  var meta = libraryViewMeta(viewId);
  var isGroups = !!(meta && meta.kind === 'groups');
  // The sieve is defined per track — favourite, rated, length. A group has
  // none of those, so applying it would quietly empty every album view.
  var rows = isGroups
    ? librarySortSongs(base, field === 'duration' ? 'count' : field, direction)
    : librarySortSongs(libraryApplySieve(base, sieve), field, direction);
  libraryRouteCache[routeId] = rows;
  libraryRouteCacheOrder.push(routeId);
  while (libraryRouteCacheOrder.length > LIBRARY_ROUTE_CACHE_MAX) {
    var oldest = libraryRouteCacheOrder.shift();
    delete libraryRouteCache[oldest];
  }
  return rows;
}

// Clears the cache. Every write to the library that changes membership, a
// rating, a play count or an added date has to call this, or the user sorts by
// plays and sees the count they had before they just played something.
function libraryInvalidateRouteCache() {
  libraryRouteCache = Object.create(null);
  libraryRouteCacheOrder = [];
}

function libraryToggleSort(routeId, field) {
  var parts = String(routeId || '').split('|');
  var currentField = parts[1] || 'title';
  var currentDirection = parts[2] === 'desc' ? 'desc' : 'asc';
  var direction = currentField === field && currentDirection === 'asc' ? 'desc' : 'asc';
  parts[1] = field;
  parts[2] = direction;
  return parts.join('|');
}

// Sonora splits a sorted list into letter runs and shows a divider between
// them. Returns rows the table already knows how to draw: {kind:'group'} for
// the divider, {kind:'song'} for the track.
function libraryRowsWithDividers(songs, field) {
  var rows = [];
  var last = null;
  for (var i = 0; i < songs.length; i += 1) {
    var header = libraryGroupHeaderFor(field, songs[i]);
    if (field === 'title' && header && header !== last) {
      rows.push({ kind: 'divider', initial: header, count: 0 });
      last = header;
    }
    rows.push({ kind: 'song', song: songs[i], index: i });
  }
  return rows;
}