<div align="center">

<img src="./docs/assets/readme/cinema-beat-smoke.png" alt="Mineradio English" width="100%">

# Mineradio English

**An immersive music player, fully in English — with Spotify, phone remote & music sync**

[![Platform](https://img.shields.io/badge/platform-Windows-blue)](https://github.com/a2z05/Mineradio-English/releases)
[![Upstream](https://img.shields.io/badge/upstream-XxHuberrr%2FMineradio-8A2BE2)](https://github.com/XxHuberrr/Mineradio)
[![Maintainer](https://img.shields.io/badge/maintained%20by-a2z-green)](https://github.com/a2z05)

| ![Lyrics stage](./docs/assets/readme/preview-spotify-lyrics.png) | ![Phone remote](./docs/assets/readme/preview-phone-remote.png) |
|:---:|:---:|
| *Word-by-word synced lyrics* | *Control your PC from your phone* |

</div>

---

Mineradio English is a community fork of [Mineradio](https://github.com/XxHuberrr/Mineradio) — a Windows desktop player built around cinematic camera work, particle visuals, a lyrics stage, and a 3D playlist shelf. This fork keeps everything upstream has, then adds:

## ✨ What this fork adds

| Feature | Description |
| --- | --- |
| 🇬🇧 **Full English UI** | Every screen translated: player, settings, login flows, dialogs, installer |
| 🎧 **Spotify integration** | Sign in with PKCE OAuth (no client secret stored). Search, playlists, likes alongside NetEase / QQ / Kugou / Soda Music |
| 🔀 **Spotify-only proxy** | Route just Spotify through an HTTP/SOCKS proxy where it's geo-blocked — one-click toggle |
| 🎤 **Apple-Music-style lyrics** | Word-by-word synced lyrics (AMLL/TTML), Japanese/Korean romanization, decoded QQ QRC karaoke |
| 💾 **Lyric cache** | Songs load instantly on repeat plays |
| 📱 **Phone remote** | Scan a QR → control playback from any phone browser. PWA-installable, live progress over SSE |
| 🔄 **Two-way music transfer** | Upload songs/folders phone→PC, browse & download PC→phone (whole folder = ZIP) |
| ⬆️ **Update-safe** | Daily auto-PRs merge upstream updates; your customizations never vanish |
| 🩹 **Stock-install patcher** | One command converts an existing Mineradio install to the English edition (revertible) |

## 📦 Download

Grab the latest installer from [Releases](https://github.com/a2z05/Mineradio-English/releases).

> SmartScreen may warn about unsigned installers — click *More info → Run anyway*. Only download from this repo's Releases page.

## 🚀 Quick start

```bash
npm install
npm start            # run the desktop app
npm run build:win    # build the NSIS installer into dist/
```

### Phone remote setup

1. Start the app on your PC
2. Click the **phone icon** in the titlebar
3. Scan the QR code with your phone camera — the paired remote opens automatically
4. Optional: *"Add to Home Screen"* installs it as an app

Both devices must share a network. If it won't connect, allow Node/Electron through Windows Firewall (private networks).

### Moving music between phone & PC

- **Transfer tab** (on phone): upload single songs or entire folders → they land in the PC's `data/music-inbox/`
- **Library tab** (on phone): browse the PC's music, download tracks or whole folders as ZIP

### Spotify setup

1. Create a free app at [developer.spotify.com/dashboard](https://developer.spotify.com/dashboard)
2. Add redirect URI: `http://127.0.0.1:3000/api/spotify/callback`
3. Paste your **Client ID** into Mineradio → Spotify panel → Connect

Behind a firewall? Open **Proxy…** in the same panel, enter your HTTP/SOCKS proxy, hit **Test**, then toggle it on/off anytime.

## 🩹 Patching an existing install

Already have stock Mineradio installed? You don't need to reinstall:

```bash
node scripts/build-patch.js        # builds dist/patch/
cd dist/patch
apply-patch.cmd "D:\Path\To\Mineradio"
```

Every replaced file is kept next to the original as `*.stock-backup`, so you can always revert by deleting the patched copy and removing the suffix.

## 🔃 Staying current with upstream

```
main      ← pristine mirror of XxHuberrr/Mineradio (never commit here)
english   ← all fork work lives here (default branch)
```

Upstream merges arrive as pull requests you review — nothing is ever overwritten silently. Manual sync:

```bash
bash scripts/sync-upstream.sh
```

See [CONFLICTS.md](./CONFLICTS.md) for the full merge playbook.

## 🙏 Credits

- **English edition maintained by [a2z](https://github.com/a2z05)**
- Original Mineradio & all core features: **[XxHuberrr](https://github.com/XxHuberrr)** — thank you for an amazing player
- Spotify/lyrics design adapted from [QingYaoSheep/Mineradio-for-Spotify](https://github.com/QingYaoSheep/Mineradio-for-Spotify)

## 📄 License

Follows upstream licensing (see [LICENSE](./LICENSE) / [NOTICE.md](./NOTICE.md)).
