# Upstream Merge Playbook

How to resolve conflicts when merging `upstream/main` into `english`.
Read this before resolving anything. Golden rule: **ours = feature intent, theirs = newer upstream**. Usually the correct resolution is *both*.

## File-by-file map

| Upstream file | What we changed there | Conflict policy |
| --- | --- | --- |
| `public/index.html` | All visible text translated to English | Take upstream's structural changes, re-translate new/changed Chinese strings. Never accept a hunk wholesale. |
| `public/desktop-lyrics.html`, `desktop/startup.html` | Same as above | Same as above |
| `public/js/modules/**` (~86 files) | Chinese string literals translated in place | Take upstream code, translate its changed/new strings again |
| `server.js` | English user-facing messages + appended route blocks: Spotify PKCE (`/api/spotify/login|callback|auth/status|session|web-api/*`), lyric cache wrap, `/api/qq/lyric/decoded`, `/api/remote/*`, `/remote/*` static, `/remote/qr.svg` | Keep upstream fixes inside existing handlers; keep ALL our added route blocks verbatim (they're additive and marked `// EN-FORK:`). Re-apply translation to any new user-facing message fields |
| `desktop/main.js` | Translated dialogs/menus/tray + SpotifySecureAuthStore wiring (global.__mineradioSpotifyAuthStore) | Keep upstream logic changes; keep our store wiring near the top requires; re-translate new dialog strings |
| `package.json` | version `x.y.z-en.N`, productName "Mineradio English", appId suffix `-English`, kuromoji/wanakana deps | Take upstream dep/version bumps where they don't collide; always restore our name/appId identity keys; bump `-en.N` after each merge |
| `public/js/index-loader.js` | 3 extra module registrations: `00-state/12-i18n.js`, `12-remote/00-remote-server-bridge.js`, `07-fx/10-remote-settings.js` | Trivial: take upstream list, re-add our three lines (i18n must stay before first consumer) |
| `spotify-auth-session.js`, `spotify-secure-auth-store.js`, `spotify-web-api-policy.js`, `apple-music-*.js`, `lyric-cache.js`, `qq-lyric-codec.js`, `romanization-engine.js` | Ours only — no upstream counterpart | Never conflicts |
| `public/js/modules/12-remote/**`, `public/js/modules/00-state/12-i18n.js`, `public/js/modules/07-fx/10-remote-settings.js` | Ours only | Never conflicts |
| `public/remote/**` | Ours only | Never conflicts |
| `scripts/sync-upstream.sh`, `.github/workflows/upstream-watch.yml`, `CONFLICTS.md`, `README.md` | Ours only (README intentionally diverges) | Never conflicts |
| `build/installer.nsh` | Installer text translated | Take upstream changes, re-translate text |

## Markers

All intentional edits to files that upstream also actively edits are wrapped or preceded by:

```
// EN-FORK: <why>
```

Searching `EN-FORK` in a conflicted file shows every spot that needs preserving.

## Procedure

1. `bash scripts/sync-upstream.sh` (stops on conflict).
2. For each conflicted file, consult the table above.
3. After resolving: run the verify suite:
   - `node --check` every touched `.js`
   - Han census: `rg -c '[一-鿿]' public desktop server.js -g '!public/vendor'` should only show allowlisted data archives
4. Commit the merge, bump version `-en.N+1`, push both branches.

## Version scheme

Upstream `2.1.0` → fork `2.1.0-en.1`. After each upstream merge or feature change, increment the trailing number. The `-en.` suffix guarantees fork builds never cross-update from upstream release feeds (and vice versa).
