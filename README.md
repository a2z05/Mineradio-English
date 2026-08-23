# Mineradio English

An English-language community fork of [Mineradio](https://github.com/XxHuberrr/Mineradio) — an immersive Windows music player built around cinematic camera work, particle visuals, a lyrics stage, and a 3D playlist shelf.

> **Maintained by [a2z05](https://github.com/a2z05).** Original Mineradio and all its core features by **[XxHuberrr](https://github.com/XxHuberrr)**. Spotify/lyrics feature design adapted from [QingYaoSheep/Mineradio-for-Spotify](https://github.com/QingYaoSheep/Mineradio-for-Spotify).

## What this fork changes

- **Full English interface** — every screen translated: player, settings, login flows, dialogs, installer.
- **Spotify integration** — sign in with your own Spotify account via secure PKCE OAuth (no client secret stored), search, playlists, likes, and playback metadata alongside NetEase / QQ / Kugou / Soda Music.
- **Apple-Music-style lyrics** — word-by-word synced lyrics (AMLL/TTML), romanization for Japanese/Korean tracks, decoded QQ QRC karaoke lyrics, and an aggressive lyric cache so songs load instantly on repeat.
- **Phone remote & music sync** — control PC playback from any phone browser on the same Wi-Fi (auto-detected LAN address + QR pairing, PWA-installable, live progress via SSE):
  - transport control, seek, volume, queue management, search-and-enqueue from your phone;
  - a phone UI that mirrors the PC app's dark glass design;
  - **two-way music transfer**: upload songs or whole folders from your phone to the PC's library inbox, browse the PC library on your phone, and download individual tracks or entire folders as ZIP back to your phone.


## Staying up to date with upstream

Upstream moves fast. This fork is structured so its changes are never lost:

```
main      <- pristine mirror of XxHuberrr/Mineradio (never commit here)
english   <- all fork work lives here; upstream merges land here
```

To pull in upstream updates manually:

```bash
bash scripts/sync-upstream.sh
```

A GitHub Action (`upstream-watch.yml`) also checks daily and opens a PR when upstream publishes new commits — review and merge like any PR.

## Development

```bash
npm install
npm start            # run the desktop app
npm run build:win    # build the NSIS installer into dist/
```

### Phone remote

1. Start the app on your PC.
2. Click the **phone icon** in the titlebar (or open Settings → Phone Remote).
3. Scan the QR code with your phone camera — the paired remote opens in your browser automatically.
4. Install it as an app from your phone's browser menu ("Add to Home Screen").

Both devices must be on the same network. If it doesn't connect, allow Node/Electron through Windows Firewall for private networks.

**Moving music:** open the **Transfer** tab on your phone to upload songs or entire folders to the PC (they land in `data/music-inbox/`), and the **Library** tab to browse and download the PC's music — single tracks or whole folders zipped on the fly.

### Spotify setup

Spotify login uses OAuth PKCE — you need a free Spotify developer app:

1. Create an app at https://developer.spotify.com/dashboard
2. Add redirect URI: `http://127.0.0.1:3000/api/spotify/callback`
3. Copy the **Client ID** into Mineradio → Spotify login panel and click Connect.

## Credits

- **English edition maintained by [a2z05](https://github.com/a2z05)**
- Upstream project and all original features: **[XxHuberrr/Mineradio](https://github.com/XxHuberrr/Mineradio)** — thank you for the amazing player
- Spotify/AMLL feature design adapted from **[QingYaoSheep/Mineradio-for-Spotify](https://github.com/QingYaoSheep/Mineradio-for-Spotify)**

## License

Follows upstream licensing (see LICENSE / NOTICE.md).
