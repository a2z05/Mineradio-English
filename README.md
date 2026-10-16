<div align="center">

<img src="./docs/assets/readme/cinema-beat-smoke.png" alt="Mineradio English — dark launch screen" width="100%">

# Mineradio English

**Immersive Windows music player — lyrics stage, particle visuals, 3D playlist shelf. Now fully in English.**

[![Platform](https://img.shields.io/badge/platform-Windows-blue)](https://github.com/a2z05/Mineradio-English/releases)
[![Upstream](https://img.shields.io/badge/upstream-XxHuberrr%2FMineradio-8A2BE2)](https://github.com/XxHuberrr/Mineradio)
[![Maintainer](https://img.shields.io/badge/maintained%20by-a2z-green)](https://github.com/a2z05)

[Download](#-download) · [Phone remote](#-phone-remote-setup) · [Spotify setup](#-spotify-setup) · [Credits](#-credits)

</div>

## ✨ What this fork adds

| Feature | Description |
| --- | --- |
| 🇬🇧 **Full English UI** | Every screen translated: player, home, settings, login flows, dialogs, installer |
| 🎮 **In-game overlay** | Steam-style Ctrl+Alt+M deck over any game — transport, seek, volume, lyric, queue. No alt-tab |
| 🖥️ **Second screen** | Big now-playing display (art, lyrics, progress) for a second monitor |
| 📊 **Mini overlay bar** | Compact always-on-top now-playing strip (Ctrl+Alt+B) |
| 🎧 **Spotify integration** | PKCE OAuth sign-in with search, playlists and likes — ⚠️ **untested, see the notice above** |
| ▶️ **yt-dlp routes** | A bundled yt-dlp powers a third download route *and* a player source: full tracks where the built-in YouTube path only offers a preview, plus its own search tab. No account required |
| 🔀 **Per-app proxy** | Route Spotify / YouTube Music / Deezer / SoundCloud / yt-dlp / Apple Music / Internet Archive through one HTTP proxy where geo-blocked — titlebar toggle + per-service checkboxes. (HTTP and HTTPS only; SOCKS5 is not implemented.) A proxy that stops answering is detected and reported instead of silently swallowing every request |
| 🎤 **Word-by-word lyrics** | Apple-Music-style karaoke (AMLL/TTML), Japanese/Korean romanization, decoded QQ QRC, instant lyric cache |
| 📱 **Phone remote** | Scan once → control playback from your phone browser. Pairing survives PC restarts and auto-reconnects to your last PC. Restyled to match the desktop app, PWA-installable via built-in install prompt |
| 🔊 **Play anywhere** | Spotify-style output switcher — one button casts the PC's current track to your phone speaker (or back), local files included |
| 🔄 **Music transfer** | Upload songs/folders phone→PC, download PC→phone (folder = ZIP). Inbox and library folders fully configurable in the phone panel |
| 📂 **Folder & default player** | Batch-import a folder of tracks; audio files open straight into Mineradio from Explorer |
| ⌨️ **Rebindable hotkeys** | Every action (incl. overlays) configurable in the built-in Hotkeys settings |
| ⚡ **Fast startup** | Cached module loading — cold start only pays full cost once |
| ⬆️ **Auto-updating releases** | Tag-push CI builds installers automatically; in-app updater points at this repo |

## ⚠️ Online providers are not tested — expect them not to work

**Read this before reporting a bug.**

This fork's **local library, playback, lyrics, overlays, phone remote and downloads are the maintained, tested surface.** The **online music providers are not.**

| Area | Status |
| --- | --- |
| Local files, folders, tags, artwork, queue | ✅ Maintained and tested |
| Overlays, second screen, phone remote, transfer | ✅ Maintained and tested |
| Downloads (direct URL + bundled yt-dlp) | ✅ Maintained and tested |
| **Spotify** | ⚠️ **Untested — likely not working** |
| **YouTube Music, Deezer, SoundCloud** | ⚠️ **Untested — likely not working** |
| **NetEase, QQ, Kugou, Soda** | ⚠️ Legacy, hidden from the UI, unsupported |

Every provider integration here was written against an unofficial or undocumented endpoint, and they all break whenever the service on the other end changes something. Nothing in this fork is verified against a live account right now — the maintainer's network blocks most of these services outright, and no account is connected. A "Spotify connected" or "Deezer ready" state means the *client* believes it, not that a stream will play.

**Please don't open issues asking for these to be fixed.** They are known-unfinished. If this project gets popular enough to justify the upkeep, they'll be revisited properly. Until then, treat every online provider as experimental.

What *does* work without any online provider: your own music. Point it at a folder.

## 📦 Download

Get the latest installer from the [Releases page](https://github.com/a2z05/Mineradio-English/releases). Only `Mineradio-x.y.z-Setup.exe` is the installer.

SmartScreen may warn about unsigned installers — *More info → Run anyway*.

## 🚀 Quick start

```bash
npm install
npm start            # run from source
npm run build:win    # build installer into dist/
```

### Phone remote setup

1. Start the app on your PC and click the **phone icon** in the titlebar
2. Scan the QR with your phone camera — the paired remote opens
3. Optional: tap **Install** when prompted (or *Add to Home Screen*) to get a full-screen, offline-ready app

Pairing is remembered: after the first scan your phone reconnects to the same PC automatically — no re-scanning after restarts (as long as both devices are on the same network). If the PC's IP ever changes, the remote probes the last known address and jumps there on its own.

Allow Node/Electron through Windows Firewall (**Private networks**) if it won't connect.

- **Output toggle** (speaker icon): switch audio between **PC** and **Phone** — like Spotify Connect, but for your own music. Works with inbox/local files; DRM streams stay PC-only.
- **Transfer tab**: upload songs or whole folders phone→PC into the inbox folder
- **Library tab**: browse PC music and download tracks or folders as ZIP
- **Folders & devices** (in the phone panel on PC): change the inbox directory, add up to 5 library folders (any drive), unpair phones

### Spotify setup

1. Create a free app at [developer.spotify.com/dashboard](https://developer.spotify.com/dashboard)
2. Add redirect URI: `http://127.0.0.1:3000/api/spotify/callback`
3. Paste your **Client ID** into Mineradio → Spotify panel → Connect

Behind a firewall? Open **Proxy…**, enter your proxy, hit **Test**, toggle on/off anytime.

### Downloading a track

The download button in the player bar asks **which route** to use:

- **Direct URL** — saves the exact stream the player is already using.
- **yt-dlp** — resolves the track through the bundled extractor, so it can save a full track where the built-in path only had a 30-second preview.
- **yt-dlp via proxy** — the same, routed through the proxy.

`yt-dlp` is bundled (`bin/yt-dlp.exe`, [Unlicense](https://github.com/yt-dlp/yt-dlp)) and works offline of any account. Download only what you have the right to download.

### Overlays & hotkeys

- **In-game overlay**: `Ctrl+Alt+M` (rebindable) — glass control deck over any game; `Esc` closes
- **Mini bar**: `Ctrl+Alt+B` — compact now-playing strip; position/opacity/content in overlay settings
- **Second screen**: right-click the titlebar **phone icon** → *Overlay & second screen* → open it and drag to your other display
- All hotkeys are viewable and rebindable in **Hotkeys** settings

## 🔃 Upstream updates

`main` mirrors upstream; all fork work lives on `english`. Updates arrive as reviewed PRs — never silent overwrites. Manual sync: `bash scripts/sync-upstream.sh`, playbook in [CONFLICTS.md](./CONFLICTS.md).

## 🙏 Credits

- Original Mineradio by **[XxHuberrr](https://github.com/XxHuberrr)**
- Spotify & lyric design adapted from [QingYaoSheep/Mineradio-for-Spotify](https://github.com/QingYaoSheep/Mineradio-for-Spotify)
- English edition maintained by **[a2z](https://github.com/a2z05)**

Licensed under GPL-3.0 ([LICENSE](./LICENSE), [NOTICE.md](./NOTICE.md)).
