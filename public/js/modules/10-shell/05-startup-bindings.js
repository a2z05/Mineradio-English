applyDiyMode(diyPlayerMode, { save: false });
bindFxPanel();
applySavedLyricPaletteState();
bindQualityControl();
bindAudioOutputControls();
bindVolumeControls();
initControlGlassSurface();
bindPlayerControlAnimations();
scheduleUiWarmTask(function () {
  updateControlGlassDisplacementMap();
  updateSearchBoxGlassDisplacementMap();
  updateSearchPillGlassDisplacementMap();
  try {
    if (renderer && renderer.compile && scene && camera) renderer.compile(scene, camera);
  } catch (e) { }
}, 900);
applyUserCapsuleAutoHideState();
applyFxFabAutoHideState();
initializeDesktopCloseBehavior();
applyStartupAutoplayUi();
applyControlsAutoHidePreference();
applyDesktopLyricsState(false);
applyWallpaperModeState(false);
setShelfMode(fx.shelf);
if (fx.shelf === 'side') setShelfPinnedOpen(!!fx.shelfPinnedOpen, true, false);
var restoredPlaybackAtStartup = restoreLastPlaybackSnapshot();
var persistedLocalLibraryRestorePromise = Promise.resolve(restorePersistedLocalLibrary()).then(function (restored) {
  if (restored) restoredPlaybackAtStartup = true;
  else if (!restoredLastPlaybackSnapshot) restoredPlaybackAtStartup = false;
  // The import hub's "My library" entry states how many tracks are saved; that
  // count is only known once the restore above has run.
  if (typeof updateLocalLibraryChoiceLabel === 'function') updateLocalLibraryChoiceLabel(localLibraryTracksNow().length);
  return restored;
}, function () { return false; });
// The Library page reads its own cache rather than the search panel's copy, so
// warm it here: the first open is then instant instead of waiting on three IPC
// round-trips while the modal is already on screen.
if (typeof hydrateLocalLibraryStore === 'function') {
  persistedLocalLibraryRestorePromise.then(function () {
    return hydrateLocalLibraryStore();
  }, function () { return null; }).then(function () {
    if (typeof libraryPaintPlaylistPane === 'function') libraryPaintPlaylistPane();
    // Subscribed after the first restore so a scan that lands during startup is
    // not answered by a refresh that has not finished yet.
    if (typeof libraryWatchLibraryChanges === 'function') libraryWatchLibraryChanges();
  }, function () { /* a cold library must never block startup */ });
}
applyStartupStarfieldPreset();
switchPlaylistTab(queueViewTab, { save: false, animate: false, refresh: false });
applyPlaylistPanelPinState(false);
if (fx.floatLayer) createFloatLayer();
if (fx.particleLyrics) createLyricsParticles();
if (fx.backCover) createBackCoverLayer();
initIdleGuideCanvas();
var startupLoginStatusPromise = Promise.all([refreshLoginStatus(), refreshQQLoginStatus({ forceVip: true, reason: 'startup' }), refreshKugouLoginStatus(), refreshQishuiLoginStatus(), refreshSpotifyLoginStatus(), persistedLocalLibraryRestorePromise]);
startQQLoginStatusAutoRefresh();
startKugouLoginStatusAutoRefresh();
startQishuiLoginStatusAutoRefresh();
startSpotifyLoginStatusAutoRefresh();
if (startupLoginStatusPromise && startupLoginStatusPromise.then) {
  startupLoginStatusPromise.then(function () {
    // EN-FORK: the feed is loaded whenever a source exists — the keyless
    // catalogs need no account, so requiring a login here is what produced a
    // blank home for a user who never signs in to anything.
    if (hasPlayableSource()) {
      refreshUserPlaylists(true);
      loadHomeDiscover(true);
    }
    if (restoredPlaybackAtStartup) queueStartupAutoplayAfterHomeReveal('login-status');
    if (document.body.classList.contains('splash-active')) return;
    var homeShown = updateEmptyHomeVisibility({ forceLoad: hasPlayableSource() });
    if (!hasPlayableSource()) maybeRunStartupLoginGuide('status');
    else if (!hasHomeFeedContent() && !homeShown) maybeRunStartupLoginGuide('status');
  }, function () {
    if (restoredPlaybackAtStartup) queueStartupAutoplayAfterHomeReveal('login-status');
  });
} else if (restoredPlaybackAtStartup) {
  queueStartupAutoplayAfterHomeReveal('startup');
}
var collectNameInput = document.getElementById('collect-new-name');
if (collectNameInput) {
  collectNameInput.addEventListener('keydown', function (e) {
    if (e.key === 'Enter') {
      e.preventDefault();
      createPlaylistFromCollect();
    }
  });
}
var customLyricInput = document.getElementById('custom-lyric-input');
if (customLyricInput) {
  customLyricInput.addEventListener('keydown', function (e) {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
      e.preventDefault();
      saveCustomLyricForCurrent();
    }
  });
}
safeRenderQueuePanel('startup');
if (!restoredPlaybackAtStartup) {
  restoredPlaybackAtStartup = restoreLastPlaybackSnapshot();
  if (restoredPlaybackAtStartup) queueStartupAutoplayAfterHomeReveal('startup-restore');
}
safeRenderQueuePanel('startup-restore');
updateCustomCoverButton();
updateCustomLyricControls();
updateLikeButtons();
setTimeout(initUpdatePreview, 9000);
// EN-FORK: the download buttons open a route menu (Direct URL / yt-dlp) instead
// of firing the direct downloader straight away.
if (typeof bindDownloadRouteButtons === 'function') bindDownloadRouteButtons();
window.addEventListener('beforeunload', function () {
  saveLastPlaybackSnapshot(true, 'beforeunload');
});

// ============================================================
//  主循环
