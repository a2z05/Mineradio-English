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
| 🎧 **Spotify integration** | Sign in with PKCE OAuth. Search, playlists and likes alongside NetEase / QQ / Kugou / Soda Music |
| 🔀 **Spotify-only proxy** | Route just Spotify through an HTTP/SOCKS proxy where it's geo-blocked — easy on/off toggle + Test button |
| 🎤 **Word-by-word lyrics** | Apple-Music-style karaoke (AMLL/TTML), Japanese/Korean romanization, decoded QQ QRC, instant lyric cache |
| 📱 **Phone remote** | Scan a QR → control playback from your phone browser. PWA-installable, live progress |
| 🔄 **Music transfer** | Upload songs/folders phone→PC, download PC→phone (folder = ZIP) |
| ⬆️ **Update-safe** | Daily auto-PRs merge upstream updates; nothing gets overwritten silently |

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
3. Optional: *Add to Home Screen* installs it as an app

Both devices need to share a network; allow Node/Electron through Windows Firewall (private) if it won't connect.

- **Transfer tab**: upload songs or whole folders phone→PC (they land in `data/music-inbox/`)
- **Library tab**: browse PC music and download tracks or folders as ZIP

### Spotify setup

1. Create a free app at [developer.spotify.com/dashboard](https://developer.spotify.com/dashboard)
2. Add redirect URI: `http://127.0.0.1:3000/api/spotify/callback`
3. Paste your **Client ID** into Mineradio → Spotify panel → Connect

Behind a firewall? Open **Proxy…**, enter your proxy, hit **Test**, toggle on/off anytime.

## 🔃 Upstream updates

`main` mirrors upstream; all fork work lives on `english`. Updates arrive as reviewed PRs — never silent overwrites. Manual sync: `bash scripts/sync-upstream.sh`, playbook in [CONFLICTS.md](./CONFLICTS.md).

## 🙏 Credits

- Original Mineradio by **[XxHuberrr](https://github.com/XxHuberrr)**
- Spotify & lyric design adapted from [QingYaoSheep/Mineradio-for-Spotify](https://github.com/QingYaoSheep/Mineradio-for-Spotify)
- English edition maintained by **[a2z](https://github.com/a2z05)**

Licensed under GPL-3.0 ([LICENSE](./LICENSE), [NOTICE.md](./NOTICE.md)).
