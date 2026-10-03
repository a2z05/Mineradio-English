// ============================================================
//  EN-FORK — let the OS drive the player.
//
//  Everything a desktop music player is expected to answer to lives outside
//  the window: the media keys on the keyboard, the row in the volume mixer, the
//  little thumbnail on the taskbar button, the tray menu. A renderer cannot
//  reach any of it, so this is the main process's job — but the renderer is the
//  only thing that knows what is playing.
//
//  So the split is: the renderer *reports* the track (title, artist, cover as a
//  data URL, duration) and the main process *publishes* it through the three
//  Windows-backed channels it owns. Nothing here reaches back into the renderer
//  for anything but a title.
// ============================================================

// Accelerator, then the action to send. The left column is what Electron parses
// and the OS binds, so these have to be keyboard key names — 'playPause' and
// friends are action names, and Electron rejects them with a conversion failure,
// which left all four keys unregistered and the binding map empty. Measured on
// this build: MediaPrevTrack is not accepted either; the previous key is spelled
// MediaPreviousTrack.
const MEDIA_KEY_ACTIONS = [
  ['MediaPlayPause', 'togglePlay'],
  ['MediaNextTrack', 'nextTrack'],
  ['MediaPreviousTrack', 'prevTrack'],
  ['MediaStop', 'stopPlayback'],
];

function clipText(value, limit) {
  const text = String(value == null ? '' : value)
    .replace(/\s+/g, ' ')
    .trim();
  if (!text) return '';
  return text.length > limit ? text.slice(0, limit - 1) + '…' : text;
}

class MediaSessionBridge {
  constructor(options = {}) {
    this.windowProvider = typeof options.getWindow === 'function' ? options.getWindow : () => null;
    this.appName = String(options.appName || 'Mineradio');
    this.iconPath = options.iconPath || '';
    this.registeredKeys = new Map();
    this.lastState = { playing: false, hasTrack: false };
    this.overlay = null;
    this.hasThumbnails = false;
  }

  // ---------------------------------------------------------- renderer reports

  // Called on every track switch and every play/pause. Everything here is
  // best-effort: a missing API must never be able to break playback.
  async publish(payload) {
    const win = this.windowProvider();
    if (!win || win.isDestroyed()) return { ok: false, error: 'NO_WINDOW' };
    if (payload && payload.reason === 'dispose') return this.dispose();
    const state = {
      title: clipText(payload && payload.title, 120),
      artist: clipText(payload && payload.artist, 120),
      album: clipText(payload && payload.album, 120),
      duration: Math.max(0, Number(payload && payload.duration) || 0),
      artwork: typeof (payload && payload.artwork) === 'string' && payload.artwork.indexOf('data:image/') === 0
        ? payload.artwork
        : '',
      playing: !!(payload && payload.playing),
      hasTrack: !!(payload && (payload.title || payload.artist)),
    };
    // Cover art is megabytes for a 1000x1000 embedded image and there is only
    // one such texture in Windows. If the artist replaced the album on the same
    // track, the old thumbnail is exactly right and re-encoding it is wasted work.
    const previous = this.lastState;
    if (previous.hasTrack && state.hasTrack
      && previous.title === state.title && previous.artist === state.artist && previous.album === state.album) {
      state.artwork = previous.artwork;
    }
    this.lastState = state;
    this.applyThumbnails(win, state);
    this.applyTray(win, state);
    return { ok: true, hasArtwork: !!state.artwork };
  }

  // Called when playback ends for good — no window, no taskbar row.
  async dispose() {
    this.lastState = { playing: false, hasTrack: false };
    const win = this.windowProvider();
    if (win && !win.isDestroyed()) {
      try { win.setRepresentedFilename(''); } catch (_) { }
      try { win.setDocumentEdited(false); } catch (_) { }
      this.setThumbnailButtons(win, null);
    }
    this.applyTray(win, { playing: false, hasTrack: false });
    return { ok: true };
  }

  // ---------------------------------------------------------- Windows channels

  applyThumbnails(win, state) {
    if (!win || win.isDestroyed()) return;
    try {
      win.setRepresentedFilename(state.title || '');
      win.setDocumentEdited(state.playing === true);
    } catch (_) {
      // setRepresentedFilename is Windows-only and throws elsewhere; that is
      // fine, the thumbnail is decoration.
    }
    if (state.hasTrack) {
      const label = state.playing ? 'Pause' : 'Play';
      this.setThumbnailButtons(win, [
        { type: 'playback', iconName: state.playing ? 'pause' : 'play', tooltip: label, click: () => this.send('togglePlay') },
        { type: 'playback', iconName: 'skip_previous', tooltip: 'Previous track', click: () => this.send('prevTrack') },
        { type: 'playback', iconName: 'skip_next', tooltip: 'Next track', click: () => this.send('nextTrack') },
      ]);
    } else {
      this.setThumbnailButtons(win, null);
    }
  }

  setThumbnailButtons(win, buttons) {
    if (!win || win.isDestroyed() || typeof win.setThumbarButtons !== 'function') return;
    try {
      win.setThumbarButtons(buttons || []);
      this.hasThumbnails = Array.isArray(buttons) && buttons.length > 0;
    } catch (_) {
      this.hasThumbnails = false;
    }
  }

  applyTray(win, state) {
    if (!this.overlay || this.overlay.isDestroyed()) return;
    try {
      this.overlay.setThumbarButtons(state.hasTrack
        ? [
          { type: 'playback', iconName: state.playing ? 'pause' : 'play', tooltip: state.playing ? 'Pause' : 'Play', click: () => this.send('togglePlay') },
          { type: 'playback', iconName: 'skip_previous', tooltip: 'Previous track', click: () => this.send('prevTrack') },
          { type: 'playback', iconName: 'skip_next', tooltip: 'Next track', click: () => this.send('nextTrack') },
        ]
        : []);
    } catch (_) { }
  }

  // ---------------------------------------------------------- media keys

  // The hardware keys. globalShortcut is the only route on Windows, and a
  // registration can silently fail because another app took it — so the result
  // is reported rather than assumed, and the renderer only claims the keys that
  // really registered.
  registerMediaKeys() {
    const { globalShortcut } = require('electron');
    const results = [];
    const taken = new Set();
    for (const [accelerator, action] of MEDIA_KEY_ACTIONS) {
      try { globalShortcut.unregister(accelerator); } catch (_) { }
      let ok = false;
      try {
        ok = globalShortcut.register(accelerator, () => this.send(action)) === true;
      } catch (_) {
        ok = false;
      }
      if (ok) {
        this.registeredKeys.set(accelerator, action);
        taken.add(accelerator);
      }
      results.push({ accelerator, action, ok });
    }
    const binding = {};
    for (const [accelerator, action] of MEDIA_KEY_ACTIONS) {
      if (taken.has(accelerator)) binding[action] = accelerator;
    }
    return { ok: true, results, binding };
  }

  unregisterMediaKeys() {
    const { globalShortcut } = require('electron');
    for (const accelerator of this.registeredKeys.keys()) {
      try { globalShortcut.unregister(accelerator); } catch (_) { }
    }
    this.registeredKeys.clear();
  }

  // ---------------------------------------------------------- notifications

  // Track change as a notification. Deliberately not for every track: a
  // notification per song turns the player into spam, so it fires when the
  // window is not in front and the previous track actually had a title.
  async notifyTrackChange(payload) {
    const { Notification } = require('electron');
    if (!Notification || !Notification.isSupported()) return { ok: false, error: 'UNSUPPORTED' };
    const state = this.lastState;
    if (!state.hasTrack) return { ok: false, error: 'NO_TRACK' };
    const win = this.windowProvider();
    const focused = !!(win && !win.isDestroyed() && win.isFocused());
    if (focused || payload === null) return { ok: false, error: focused ? 'FOCUSED' : 'NO_PAYLOAD' };
    const parts = [state.artist, state.title].filter(Boolean);
    if (!parts.length) return { ok: false, error: 'NO_TRACK' };
    try {
      const n = new Notification({
        title: this.appName,
        body: parts.join(' — '),
        silent: true,
        icon: this.iconPath && require('fs').existsSync(this.iconPath) ? this.iconPath : undefined,
      });
      n.on('click', () => {
        try { if (win && !win.isDestroyed()) { if (win.isMinimized()) win.restore(); win.focus(); } } catch (_) { }
      });
      n.show();
      return { ok: true };
    } catch (error) {
      return { ok: false, error: String((error && error.message) || error) };
    }
  }

  // ---------------------------------------------------------- plumbing

  send(action) {
    const win = this.windowProvider();
    if (!win || win.isDestroyed() || !action) return;
    try {
      win.webContents.send('mineradio-media-command', { action });
    } catch (_) { }
  }
}

module.exports = { MEDIA_KEY_ACTIONS, MediaSessionBridge };