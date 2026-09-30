// ============================================================
//  Local library — the tracks already saved on this device.
//
//  Everything behind it already existed: files are tag-read on import, kept
//  on disk, and restored into persistentLocalLibraryTracks at startup. What
//  did not exist was any way to LOOK at them. The only two things the app
//  could do were "load the whole pile into the queue" (home card) and "import
//  more", so a library of two hundred tracks played only from the top and
//  could never be browsed. This surfaces it in the results panel through the
//  same rows search renders, so a click on one track plays that track.
var LOCAL_LIBRARY_RESULT_KEY = 'local-library';

function localLibraryTracksNow() {
  return Array.isArray(persistentLocalLibraryTracks) ? persistentLocalLibraryTracks : [];
}

async function fetchLocalLibraryTracks() {
  // The startup restore normally fills the cache, so opening the panel is
  // instant. Only go to the main process when it is empty — after a failed
  // restore, or on a build without the desktop bridge.
  var cached = localLibraryTracksNow();
  if (cached.length) return cached;
  if (!window.desktopWindow || typeof window.desktopWindow.listLocalMusicLibrary !== 'function') return [];
  var result;
  try {
    result = await window.desktopWindow.listLocalMusicLibrary();
  } catch (err) {
    console.warn('[LocalLibrary] list failed', err);
    return [];
  }
  if (!result || result.ok !== true || !Array.isArray(result.tracks)) return [];
  var tracks = result.tracks
    .map(function (song) {
      var copy = hydrateCustomCover(Object.assign({}, song));
      copy.localMissing = false;
      return copy;
    })
    .filter(function (song) { return song && song.localUrl && song.localKey; });
  if (tracks.length) persistentLocalLibraryTracks = tracks.map(cloneSong);
  return localLibraryTracksNow();
}

function updateLocalLibraryChoiceLabel(count) {
  var sub = document.getElementById('local-library-choice-sub');
  if (!sub) return;
  if (count > 0) sub.textContent = count + ' track' + (count === 1 ? '' : 's') + ' saved on this device';
  else sub.textContent = 'Nothing saved yet — import a file or folder';
}

function localLibraryHeadHtml(count) {
  return '<div class="search-empty search-local-head" data-local-library-head="1">' +
    '<span><strong>Local library</strong> · ' + count + ' track' + (count === 1 ? '' : 's') + ' on this device</span>' +
    '<button type="button" onclick="playAllLocalLibraryTracks()">Play all</button>' +
    '</div>';
}

function localLibraryEmptyHtml() {
  return '<div class="search-empty" data-local-library-empty="1">' +
    'No local tracks yet.<br>Import a file or a folder and they will be saved here.' +
    '<div class="search-local-actions">' +
    '<button type="button" onclick="triggerUploadInput(\'audio\')">Import files</button>' +
    '<button type="button" onclick="triggerUploadInput(\'folder\')">Import folder</button>' +
    '</div></div>';
}

// Render the library into the results panel. The load-more sentinel still
// works: remoteHasMore is false, so scrolling grows the list locally in
// batches instead of asking the search API for page two of a local folder.
function renderLocalLibraryResults(tracks) {
  pendingSearchProviderPages = {
    key: LOCAL_LIBRARY_RESULT_KEY,
    query: '',
    mode: searchMode,
    providerPages: {},
    hasMore: false
  };
  searchLastResultQuery = LOCAL_LIBRARY_RESULT_KEY;
  renderSongSearchResults(tracks, { animate: true });
  $results.insertAdjacentHTML('afterbegin', localLibraryHeadHtml(tracks.length));
  updateLocalLibraryChoiceLabel(tracks.length);
}

function showLocalLibraryEmpty() {
  pendingSearchProviderPages = { key: LOCAL_LIBRARY_RESULT_KEY, query: '', mode: searchMode, providerPages: {}, hasMore: false };
  searchLastResultQuery = LOCAL_LIBRARY_RESULT_KEY;
  resetSearchMusicRenderState();
  playlist = [];
  $results.innerHTML = localLibraryEmptyHtml();
  $results.classList.add('show');
  updateLocalLibraryChoiceLabel(0);
}

async function openLocalLibraryResults() {
  homeForcedOpen = false;
  homeSuppressed = false;
  if (typeof setHomeControlsLocked === 'function') setHomeControlsLocked(false);
  if (typeof updateEmptyHomeVisibility === 'function') updateEmptyHomeVisibility();
  if (typeof closeUploadPanel === 'function') closeUploadPanel();
  var tracks = await fetchLocalLibraryTracks();
  if (!tracks.length) { showLocalLibraryEmpty(); return; }
  renderLocalLibraryResults(tracks);
}

// "Play all" replaces the queue with the library and starts at the top — the
// same thing the home card did, but reachable from where you just browsed it.
function playAllLocalLibraryTracks() {
  var tracks = localLibraryTracksNow();
  if (!tracks.length) {
    showToast('No local tracks saved yet');
    return false;
  }
  if (typeof importLocalAudioSongs !== 'function') return false;
  return importLocalAudioSongs(tracks.map(cloneSong), { mode: 'persistent-library' });
}
