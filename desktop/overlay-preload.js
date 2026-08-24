const { contextBridge, ipcRenderer } = require('electron');

function bind(channel, callback) {
  if (typeof callback !== 'function') return () => {};
  const listener = (_event, payload) => callback(payload || {});
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

contextBridge.exposeInMainWorld('desktopOverlay', {
  onLyricsState: (callback) => bind('mineradio-desktop-lyrics-state', callback),
  onWallpaperState: (callback) => bind('mineradio-wallpaper-state', callback),
  setLyricsDrag: (dragging) => ipcRenderer.invoke('mineradio-desktop-lyrics-set-dragging', !!dragging),
  setLyricsPointerCapture: (active) => ipcRenderer.invoke('mineradio-desktop-lyrics-set-pointer-capture', !!active),
  setLyricsHotBounds: (bounds) => ipcRenderer.invoke('mineradio-desktop-lyrics-set-hot-bounds', bounds || {}),
  setLyricsLockState: (locked) => ipcRenderer.invoke('mineradio-desktop-lyrics-set-lock-state', !!locked),
  moveLyricsBy: (dx, dy) => ipcRenderer.invoke('mineradio-desktop-lyrics-move-by', Number(dx) || 0, Number(dy) || 0),
  closeLyrics: () => ipcRenderer.invoke('mineradio-desktop-lyrics-set-enabled', false, {}),
  // EN-FORK: now-playing overlay bar + second-screen window controls.
  onOverlayState: (callback) => bind('mineradio-now-playing-overlay-state', callback),
  togglePlay: () => ipcRenderer.invoke('mineradio-overlay-playback-cmd', 'toggle'),
  prevTrack: () => ipcRenderer.invoke('mineradio-overlay-playback-cmd', 'prev'),
  nextTrack: () => ipcRenderer.invoke('mineradio-overlay-playback-cmd', 'next'),
  sendOverlayCommand: (cmd, payload) => ipcRenderer.invoke('mineradio-overlay-playback-cmd', String(cmd || ''), payload || {}),
  closeOverlay: (which) => ipcRenderer.invoke('mineradio-overlay-close', String(which || 'bar')),
  closeScreen: () => ipcRenderer.invoke('mineradio-overlay-close', 'screen'),
});
