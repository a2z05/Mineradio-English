const { contextBridge, ipcRenderer, clipboard, webUtils } = require('electron');

contextBridge.exposeInMainWorld('desktopWindow', {
  isDesktop: true,
  minimize: () => ipcRenderer.invoke('desktop-window-minimize'),
  restore: () => ipcRenderer.invoke('desktop-window-restore'),
  toggleMaximize: () => ipcRenderer.invoke('desktop-window-toggle-maximize'),
  toggleFullscreen: () => ipcRenderer.invoke('desktop-window-toggle-fullscreen'),
  exitFullscreenWindowed: () => ipcRenderer.invoke('desktop-window-exit-fullscreen-windowed'),
  getState: () => ipcRenderer.invoke('desktop-window-get-state'),
  getGpuDiagnostics: () => ipcRenderer.invoke('mineradio-get-gpu-diagnostics'),
  getMemorySnapshot: () => ipcRenderer.invoke('mineradio-memory-get-snapshot'),
  configureMemoryReduct: (payload) => ipcRenderer.invoke('mineradio-memory-configure-auto', payload || {}),
  trimAppMemory: (payload) => ipcRenderer.invoke('mineradio-memory-trim-app', payload || {}),
  purgeSystemMemory: (payload) => ipcRenderer.invoke('mineradio-memory-purge-system', payload || {}),
  getCacheSettings: () => ipcRenderer.invoke('mineradio-cache-get-settings'),
  chooseCacheDirectory: () => ipcRenderer.invoke('mineradio-cache-choose-directory'),
  setCacheSettings: (payload) => ipcRenderer.invoke('mineradio-cache-set-settings', payload || {}),
  clearHttpCache: () => ipcRenderer.invoke('mineradio-cache-clear-http'),
  listWallpaperEngineProjects: (payload) => ipcRenderer.invoke('mineradio-wallpaper-engine-list', payload || {}),
  getWallpaperEngineProjectDetails: (id) => ipcRenderer.invoke('mineradio-wallpaper-engine-project-details', String(id || '')),
  openWallpaperEngineProjectDetails: (id, target) => ipcRenderer.invoke('mineradio-wallpaper-engine-open-project-details', {
    id: String(id || ''),
    target: target === 'workshop' ? 'workshop' : 'we',
  }),
  chooseWallpaperEngineDirectory: () => ipcRenderer.invoke('mineradio-wallpaper-engine-choose-directory'),
  chooseWallpaperEngineProjectFile: () => ipcRenderer.invoke('mineradio-wallpaper-engine-choose-project-file'),
  removeWallpaperEngineDirectory: (rootId) => ipcRenderer.invoke('mineradio-wallpaper-engine-remove-directory', String(rootId || '')),
  getWallpaperEngineRuntimeStatus: (payload) => ipcRenderer.invoke('mineradio-wallpaper-engine-runtime-status', payload || {}),
  startWallpaperEngineScene: (payload) => ipcRenderer.invoke('mineradio-wallpaper-engine-start-scene', payload || {}),
  reportWallpaperEngineCaptureResult: (payload) => ipcRenderer.invoke('mineradio-wallpaper-engine-capture-result', payload || {}),
  prepareWallpaperEngineGlassCapture: (payload) => ipcRenderer.invoke('mineradio-wallpaper-engine-prepare-glass-capture', payload || {}),
  activateWallpaperEngineDwmSurface: (payload) => ipcRenderer.invoke('mineradio-wallpaper-engine-activate-dwm-surface', payload || {}),
  updateWallpaperEngineGlassSurface: (payload) => ipcRenderer.send('mineradio-wallpaper-engine-glass-surface', payload || {}),
  reportWallpaperEnginePointerActivity: (payload) => ipcRenderer.send('mineradio-wallpaper-engine-pointer-activity', payload || {}),
  stopWallpaperEngineScene: (payload) => ipcRenderer.invoke('mineradio-wallpaper-engine-stop-scene', payload || {}),
  onWallpaperEngineHostBoundsChanged: (callback) => {
    if (typeof callback !== 'function') return () => {};
    const listener = (_event, payload) => callback(payload || {});
    ipcRenderer.on('mineradio-wallpaper-engine-host-bounds-changed', listener);
    return () => ipcRenderer.removeListener('mineradio-wallpaper-engine-host-bounds-changed', listener);
  },
  listLocalMusicLibrary: () => ipcRenderer.invoke('mineradio-local-library-list'),
  readLocalMusicLyric: (localFileId) => ipcRenderer.invoke('mineradio-local-library-lyric', String(localFileId || '')),
  // EN-FORK: forgetting a track is how a saved library stops being a pile you
  // can never shrink. The main process has had removeTracks() since the
  // original release, but nothing could reach it — no channel, no button. This
  // is that channel. It drops the index entry and the cached cover; the audio
  // file on disk is never touched.
  removeLocalMusicTracks: (localFileIds) => ipcRenderer.invoke(
    'mineradio-local-library-remove',
    (Array.isArray(localFileIds) ? localFileIds : [localFileIds])
      .map((id) => String(id || ''))
      .filter(Boolean)
  ),
  // EN-FORK: re-read the folders the library already came from. No paths are
  // sent — rescan() only walks directories its own index points at — so this
  // cannot be aimed anywhere else.
  rescanLocalMusicLibrary: () => ipcRenderer.invoke('mineradio-local-library-rescan'),
  // EN-FORK: folders are the library's roots. Adding one is the same request a
  // file import makes — an absolute, user-chosen directory — and removing one
  // only drops the rows it supplied; the files stay on disk.
  listLocalMusicFolders: () => ipcRenderer.invoke('mineradio-local-library-folders'),
  addLocalMusicFolder: (root) => ipcRenderer.invoke('mineradio-local-library-folder-add', String(root || '')),
  removeLocalMusicFolder: (root) => ipcRenderer.invoke('mineradio-local-library-folder-remove', String(root || '')),
  chooseLocalMusicFolder: () => ipcRenderer.invoke('mineradio-remote-pick-folder', 'library'),
  scanLocalMusicLibrary: () => ipcRenderer.invoke('mineradio-local-library-scan'),
  onLocalMusicScanProgress: (callback) => {
    if (typeof callback !== 'function') return () => {};
    const listener = (_event, payload) => callback(payload || {});
    ipcRenderer.on('mineradio-local-library-scan-progress', listener);
    return () => ipcRenderer.removeListener('mineradio-local-library-scan-progress', listener);
  },
  // EN-FORK: the folder tree, and the real directory behind a node. Ids only —
  // the renderer never holds or sends a path, exactly like reveal and M3U.
  getLocalMusicTree: () => ipcRenderer.invoke('mineradio-local-library-tree'),
  browseLocalMusicFolder: (nodeId) => ipcRenderer.invoke('mineradio-local-library-folder-browse', String(nodeId || '')),
  revealLocalMusicFolder: (nodeId) => ipcRenderer.invoke('mineradio-local-library-reveal-folder', String(nodeId || '')),
  rescanLocalMusicFolder: (localFileIds) => ipcRenderer.invoke(
    'mineradio-local-library-folder-rescan',
    (Array.isArray(localFileIds) ? localFileIds : [localFileIds]).map((id) => String(id || '')).filter(Boolean)
  ),
  // EN-FORK: background sync. status() reports what is being watched; now=true
  // forces a scan instead of waiting for the debounce window to close.
  syncLocalMusicLibrary: (now) => ipcRenderer.invoke('mineradio-local-library-sync', { now: now === true }),
  onLocalLibraryChanged: (callback) => {
    if (typeof callback !== 'function') return () => {};
    const listener = (_event, payload) => callback(payload || {});
    ipcRenderer.on('mineradio-local-library-changed', listener);
    return () => ipcRenderer.removeListener('mineradio-local-library-changed', listener);
  },
  // EN-FORK: OS integration. The renderer reports what is playing; the main
  // process answers media keys, the taskbar thumbnail and the tray menu. The
  // return value is an unsubscribe so binding it once stays bound once.
  publishMediaState: (payload) => ipcRenderer.invoke('mineradio-media-publish', payload || {}),
  mediaKeys: (request) => ipcRenderer.invoke('mineradio-media-keys', request || {}),
  mediaKeysStatus: () => ipcRenderer.invoke('mineradio-media-keys-status'),
  notifyNowPlaying: (payload) => ipcRenderer.invoke('mineradio-now-playing-notify', payload || {}),
  onMediaCommand: (callback) => {
    if (typeof callback !== 'function') return () => {};
    const listener = (_event, payload) => callback(payload || {});
    ipcRenderer.on('mineradio-media-command', listener);
    return () => ipcRenderer.removeListener('mineradio-media-command', listener);
  },
  // EN-FORK: favourites, ratings, play counters and playlists live in the main
  // process so they survive a restart and cannot be lost to a renderer reload.
  getLocalLibraryUserData: () => ipcRenderer.invoke('mineradio-local-library-user-data'),
  setLocalLibraryUser: (request) => ipcRenderer.invoke('mineradio-local-library-user-set', request || {}),
  getLocalPlaylists: () => ipcRenderer.invoke('mineradio-local-library-playlists'),
  localPlaylistOp: (request) => ipcRenderer.invoke('mineradio-local-library-playlist-op', request || {}),
  backupLocalLibraryUserData: () => ipcRenderer.invoke('mineradio-local-library-backup'),
  restoreLocalLibraryUserData: (payload, replace) => ipcRenderer.invoke('mineradio-local-library-restore', {
    payload: payload || null,
    replace: replace === true,
  }),
  // Absolute paths never cross the bridge: the main process builds the playlist
  // from ids, and resolves an imported one back to files on this disk.
  exportLocalLibraryM3u: (ids) => ipcRenderer.invoke('mineradio-local-library-export-m3u', {
    ids: Array.isArray(ids) ? ids.map((id) => String(id || '')).filter(Boolean) : [],
  }),
  importLocalLibraryM3u: () => ipcRenderer.invoke('mineradio-local-library-import-m3u'),
  revealLocalMusicTrack: (localFileId) => ipcRenderer.invoke('mineradio-local-library-reveal', String(localFileId || '')),
  // EN-FORK: the caller must pass optIn:true, and only after showing the user
  // exactly which fields are about to change. There is no code path that edits
  // a tag without it — that flag is the whole consent mechanism.
  writeLocalMusicTags: (id, fields, optIn) => ipcRenderer.invoke('mineradio-local-library-write-tags', {
    id: String(id || ''),
    fields: fields || {},
    optIn: optIn === true,
  }),
  importLocalMusicFiles: async (files) => {
    const entries = [];
    for (const file of Array.from(files || [])) {
      let filePath = '';
      try {
        filePath = webUtils && typeof webUtils.getPathForFile === 'function' ? webUtils.getPathForFile(file) : '';
      } catch (_) {}
      if (!filePath) continue;
      entries.push({
        path: filePath,
        relativePath: String(file && (file.webkitRelativePath || file.name) || ''),
      });
    }
    if (!entries.length) return { ok: false, count: 0, tracks: [], error: 'NO_AUTHORIZED_LOCAL_AUDIO' };
    const authorization = await ipcRenderer.invoke('mineradio-local-library-authorize', { files: entries });
    if (!authorization || authorization.ok !== true || !authorization.token) return authorization;
    return ipcRenderer.invoke('mineradio-local-library-import', { token: authorization.token });
  },
  importInboxMusicFiles: () => ipcRenderer.invoke('mineradio-local-library-import-inbox'),
  // Default-player flow: import absolute file paths opened from Explorer.
  importLocalMusicPaths: async (paths) => {
    const entries = (Array.isArray(paths) ? paths : [])
      .map((p) => ({ path: String(p || ''), relativePath: '' }))
      .filter((entry) => entry.path);
    if (!entries.length) return { ok: false, count: 0, tracks: [], error: 'NO_AUTHORIZED_LOCAL_AUDIO' };
    const authorization = await ipcRenderer.invoke('mineradio-local-library-authorize', { files: entries });
    if (!authorization || authorization.ok !== true || !authorization.token) return authorization;
    return ipcRenderer.invoke('mineradio-local-library-import', { token: authorization.token });
  },
  onOpenAudioFiles: (callback) => {
    if (typeof callback !== 'function') return () => {};
    const listener = (_event, files) => callback(Array.isArray(files) ? files : []);
    ipcRenderer.on('mineradio-open-audio-files', listener);
    return () => ipcRenderer.removeListener('mineradio-open-audio-files', listener);
  },
  toggleNowPlayingOverlay: (which) => ipcRenderer.invoke('mineradio-overlay-toggle', which === 'game' ? 'game' : 'bar'),
  openNowPlayingOverlay: (which) => ipcRenderer.invoke('mineradio-overlay-open', String(which || 'bar')),
  closeNowPlayingOverlay: (which) => ipcRenderer.invoke('mineradio-overlay-close', String(which || 'bar')),
  getOverlayConfig: () => ipcRenderer.invoke('mineradio-overlay-get-config'),
  setOverlayConfig: (patch) => ipcRenderer.invoke('mineradio-overlay-set-config', patch || {}),
  onOverlayCommand: (callback) => {
    if (typeof callback !== 'function') return () => {};
    const listener = (_event, cmd, payload) => callback(String(cmd || ''), payload || {});
    ipcRenderer.on('mineradio-overlay-remote-command', listener);
    return () => ipcRenderer.removeListener('mineradio-overlay-remote-command', listener);
  },
  publishOverlayState: (snapshot) => ipcRenderer.send('mineradio-overlay-publish-state', snapshot || {}),
  readLyricCache: (key) => ipcRenderer.invoke('mineradio-cache-read-lyric', key || ''),
  writeLyricCache: (key, payload) => ipcRenderer.invoke('mineradio-cache-write-lyric', key || '', payload || {}),
  close: (behavior) => ipcRenderer.invoke('desktop-window-close', behavior),
  getCloseBehavior: () => ipcRenderer.invoke('desktop-window-get-close-behavior'),
  setCloseBehavior: (behavior) => ipcRenderer.invoke('desktop-window-set-close-behavior', behavior),
  getLoginEasterEggStatus: () => ipcRenderer.invoke('mineradio-login-easter-egg-status'),
  unlockLoginEasterEgg: (value) => ipcRenderer.invoke('mineradio-login-easter-egg-unlock', String(value || '')),
  resetLoginEasterEgg: () => ipcRenderer.invoke('mineradio-login-easter-egg-reset'),
  openNeteaseMusicLogin: () => ipcRenderer.invoke('netease-music-open-login'),
  clearNeteaseMusicLogin: () => ipcRenderer.invoke('netease-music-clear-login'),
  openQQMusicLogin: (options) => ipcRenderer.invoke('qq-music-open-login', options || {}),
  clearQQMusicLogin: () => ipcRenderer.invoke('qq-music-clear-login'),
  openKugouMusicLogin: () => ipcRenderer.invoke('kugou-music-open-login'),
  clearKugouMusicLogin: () => ipcRenderer.invoke('kugou-music-clear-login'),
  clearQishuiMusicLogin: () => ipcRenderer.invoke('qishui-music-clear-login'),
  openSpotifyMusicLogin: () => ipcRenderer.invoke('spotify-music-open-login'),
  clearSpotifyMusicLogin: () => ipcRenderer.invoke('spotify-music-clear-login'),
  openUpdatePage: (url) => ipcRenderer.invoke('mineradio-open-update-page', String(url || '')),
  restartApp: () => ipcRenderer.invoke('mineradio-restart-app'),
  configureGlobalHotkeys: (bindings) => ipcRenderer.invoke('mineradio-hotkeys-configure-global', bindings || []),
  copyText: (text) => {
    clipboard.writeText(String(text || ''));
    return { ok: true };
  },
  readText: () => ({ ok: true, text: clipboard.readText() || '' }),
  exportJsonFile: (payload) => ipcRenderer.invoke('mineradio-export-json-file', payload || {}),
  exportLoginCookie: (provider) => ipcRenderer.invoke('mineradio-export-login-cookie', provider || ''),
  importJsonFile: () => ipcRenderer.invoke('mineradio-import-json-file'),
  exportTextFile: (payload) => ipcRenderer.invoke('mineradio-export-text-file', payload || {}),
  importTextFile: (payload) => ipcRenderer.invoke('mineradio-import-text-file', payload || {}),
  readCurrentFxAutosaveSync: () => ipcRenderer.sendSync('mineradio-current-fx-autosave-read-sync'),
  saveCurrentFxAutosaveSync: (payload) => ipcRenderer.sendSync('mineradio-current-fx-autosave-save-sync', payload || {}),
  saveCurrentFxAutosave: (payload) => ipcRenderer.invoke('mineradio-current-fx-autosave-save', payload || {}),
  onGlobalHotkey: (callback) => {
    if (typeof callback !== 'function') return () => {};
    const listener = (_event, payload) => callback(payload || {});
    ipcRenderer.on('mineradio-global-hotkey', listener);
    return () => ipcRenderer.removeListener('mineradio-global-hotkey', listener);
  },
  setDesktopLyricsEnabled: (enabled, payload) => ipcRenderer.invoke('mineradio-desktop-lyrics-set-enabled', !!enabled, payload || {}),
  updateDesktopLyrics: (payload) => ipcRenderer.invoke('mineradio-desktop-lyrics-update', payload || {}),
  onDesktopLyricsLockState: (callback) => {
    if (typeof callback !== 'function') return () => {};
    const listener = (_event, payload) => callback(payload || {});
    ipcRenderer.on('mineradio-desktop-lyrics-lock-state', listener);
    return () => ipcRenderer.removeListener('mineradio-desktop-lyrics-lock-state', listener);
  },
  onDesktopLyricsEnabledState: (callback) => {
    if (typeof callback !== 'function') return () => {};
    const listener = (_event, payload) => callback(payload || {});
    ipcRenderer.on('mineradio-desktop-lyrics-enabled-state', listener);
    return () => ipcRenderer.removeListener('mineradio-desktop-lyrics-enabled-state', listener);
  },
  setWallpaperMode: (enabled, payload) => ipcRenderer.invoke('mineradio-wallpaper-set-enabled', !!enabled, payload || {}),
  updateWallpaperMode: (payload) => ipcRenderer.invoke('mineradio-wallpaper-update', payload || {}),
  getWallpaperModeStatus: () => ipcRenderer.invoke('mineradio-wallpaper-get-status'),
  updateDesktopIconShields: (payload) => ipcRenderer.send('mineradio-full-desktop-icon-shields', payload || {}),
  setDesktopSoftwareLocked: (locked) => ipcRenderer.invoke('mineradio-full-desktop-set-software-lock', locked === true),
  setDesktopIconsVisible: (visible) => ipcRenderer.invoke('mineradio-full-desktop-set-icons-visible', visible !== false),
  requestDesktopKeyboardFocus: (reason) => ipcRenderer.invoke(
    'mineradio-full-desktop-request-keyboard-focus',
    String(reason || 'renderer-pointerdown').slice(0, 80)
  ),
  updateDesktopPointerRoute: (payload) => ipcRenderer.send('mineradio-full-desktop-pointer-route', {
    overSoftwareUi: payload && payload.overSoftwareUi === true,
    overDesktopControls: payload && payload.overDesktopControls === true,
  }),
  onWallpaperModeState: (callback) => {
    if (typeof callback !== 'function') return () => {};
    const listener = (_event, payload) => callback(payload || {});
    ipcRenderer.on('mineradio-wallpaper-runtime-state', listener);
    return () => ipcRenderer.removeListener('mineradio-wallpaper-runtime-state', listener);
  },
  onStateChange: (callback) => {
    const listener = (_event, state) => callback(state);
    ipcRenderer.on('desktop-window-state', listener);
    return () => ipcRenderer.removeListener('desktop-window-state', listener);
  },
});

window.addEventListener('DOMContentLoaded', () => {
  document.documentElement.classList.add('desktop-shell-root');
  document.body.classList.add('desktop-shell');
});
