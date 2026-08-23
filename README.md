<div align="center">

<img src="./docs/assets/readme/cinema-beat-smoke.png" alt="Mineradio English — dark launch screen" width="100%">

# Mineradio English

**A Windows desktop immersive music player — search & play, a lyrics stage, particle visuals,
a 3D playlist shelf and full desktop mode, all fully in English.**

[![Platform](https://img.shields.io/badge/platform-Windows-blue)](https://github.com/a2z05/Mineradio-English/releases)
[![Upstream](https://img.shields.io/badge/upstream-XxHuberrr%2FMineradio-8A2BE2)](https://github.com/XxHuberrr/Mineradio)
[![Maintainer](https://img.shields.io/badge/maintained%20by-a2z-green)](https://github.com/a2z05)

| ![Word-by-word synced lyrics](./docs/assets/readme/preview-spotify-lyrics.png) | ![Phone remote](./docs/assets/readme/preview-phone-remote.png) |
|:---:|:---:|
| *Word-by-word synced lyrics* | *Control your PC from your phone* |

</div>

---

## ✨ What this fork adds

| Feature | Description |
| --- | --- |
| 🇬🇧 **Full English UI** | Every screen translated: player, home, settings, login flows, dialogs, even the installer |
| 🎧 **Spotify integration** | Sign in with PKCE OAuth (no client secret stored). Search, playlists and likes alongside NetEase / QQ / Kugou / Soda Music |
| 🔀 **Spotify-only proxy** | Route *just* Spotify through an HTTP/SOCKS proxy where it's geo-blocked — with an easy on/off toggle and Test button |
| 🎤 **Apple-Music-style lyrics** | Word-by-word synced lyrics (AMLL/TTML), Japanese/Korean romanization, decoded QQ QRC karaoke |
| 💾 **Lyric cache** | Songs load instantly on repeat plays |
| 📱 **Phone remote** | Scan a QR code → control playback from any phone browser. PWA-installable, live progress over SSE |
| 🔄 **Two-way music transfer** | Upload songs/folders phone→PC, browse & download PC→phone (whole folder arrives as a ZIP) |
| 🩹 **Stock-install patcher** | Convert an existing Mineradio install into the English edition with one command — fully revertible |
| ⬆️ **Update-safe** | Daily auto-PRs merge upstream updates; your customizations never vanish |

## 📦 Download

Grab the latest installer from the [Releases page](https://github.com/a2z05/Mineradio-English/releases).

> Only the file named `Mineradio-x.y.z-Setup.exe` is the installer. Don't treat `.blockmap`, `latest.yml` or `win-unpacked` files as the installer.

### If the download or install gets blocked

Unsigned Electron installers are sometimes flagged by browsers, Windows Defender or SmartScreen. First confirm the file really came from this repo's Releases page and is named `…Setup.exe`.

1. **Browser warns about the download** — open the downloads list, click the `⋯` next to the entry, choose *Keep* / *Keep anyway* / *Show more*, then keep the file.
2. **Windows SmartScreen shows a blue warning** — click *More info*, then *Run anyway*.
3. **Antivirus reports an actual trojan or quarantines the file** — don't force-run it; delete it and re-download from this page. If it still misbehaves, open an issue with a screenshot.

Prefer the original author's channels? The Chinese original offers [Quark](https://pan.quark.cn/s/df00d9520835), [Baidu Netdisk (code `SJHP`)](https://pan.baidu.com/s/1UAAyvXHNJjxVXAHIPtl4Ow?pwd=SJHP), [Lanzou](https://xxhuber.lanzout.com/s/Mineradio) and [GitHub Release](https://github.com/XxHuberrr/Mineradio/releases/tag/v2.1.0) downloads too.

## 🚀 Quick start (from source)

```bash
npm install
npm start            # run the desktop app
npm run build:win    # build the NSIS installer into dist/
```

The desktop entry loads a local server via the Electron main process. `npm run build:win` produces the Windows NSIS installer in `dist/`.

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

## 🩹 Patching an existing stock install

Already have stock (Chinese) Mineradio installed? No reinstall needed:

```bash
node scripts/build-patch.js        # builds dist/patch/
cd dist/patch
apply-patch.cmd "D:\Path\To\Mineradio"
```

Every replaced file is kept next to the original as `*.stock-backup`, so you can always revert by deleting the patched copy and removing the suffix.

## ⚙️ How updates work

This fork's in-app update check reads **this repo's** GitHub Releases (`a2z05/Mineradio-English`). When a newer version is published here, the in-app update entry shows the release notes and opens the download page in your browser — the client never silently replaces itself. For testing you can point `MINERADIO_UPDATE_MANIFEST` at a local manifest JSON or HTTP URL to simulate a release.

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

---

Mineradio English is a community fork of [Mineradio by XxHuberrr](https://github.com/XxHuberrr/Mineradio) — a Windows desktop player that combines cinematic camera work, particle visuals, a lyrics stage and a 3D playlist shelf into a private music space that feels live. **Everything upstream has is here**, fully translated to English.

## 🛡️ Third-party music platforms

Mineradio is **not** an official client of NetEase Cloud Music, QQ Music or Tencent Music Entertainment Group, and is not affiliated with any music platform.

Third-party platform integration exists only for personal study, local client experience and playback assistance with the user's own account. Please respect each platform's user agreement, copyright rules and membership terms. The project does not provide ways to bypass payments, bypass memberships, crack audio quality, or redistribute music content.

## 🔒 User data & privacy

Login cookies, search history, custom covers, custom lyrics, beat-analysis caches and similar data belong only in the local user-data directory or browser local storage — never committed to a repository. See [PRIVACY.md](./PRIVACY.md).

## 🙏 Credits

- Original Mineradio designed & built by **[XxHuberrr](https://github.com/XxHuberrr)** — thank you for an amazing player
- Spotify & word-by-word lyric design adapted from [QingYaoSheep/Mineradio-for-Spotify](https://github.com/QingYaoSheep/Mineradio-for-Spotify)
- **English edition maintained by [a2z](https://github.com/a2z05)**

## 📄 License

Copyright (C) 2026 XxHuberrr. Licensed under GPL-3.0 — see [LICENSE](./LICENSE). The MR Logo, the Mineradio name, interface visual design and original visual expression remain the property of the original author; third-party dependencies and services follow their own licenses and terms. English-edition changes are contributed under the same GPL-3.0 license. See also [NOTICE.md](./NOTICE.md).
