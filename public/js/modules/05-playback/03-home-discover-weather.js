function fallbackHomeTiles() {
  return [
    { kind: 'login', title: 'Sign in to sync playlists', sub: 'NetEase / QQ / Kugou / Soda' },
    { kind: 'search', title: 'Search a song', sub: 'Original artists first', query: '' },
    { kind: 'local', title: 'Import local music', sub: 'Visualize local files too' },
    { kind: 'podcastSearch', title: 'Search podcasts', sub: 'Long-form / Radio' },
    { kind: 'guide', title: 'Explore the visual stage', sub: 'Particles / Lyrics / Covers' },
  ];
}
function homeTileCover(item) {
  if (!item) return '';
  if (item.kind === 'song') return songCoverSrc(item.song, 220);
  return item.cover ? coverUrlWithSize(item.cover, 220) : '';
}
function homeToneForItem(item, index) {
  if (!item) return 'daily';
  if (item.kind === 'recent') return 'search';
  if (item.kind === 'profile') return 'local';
  if (item.tone) return item.tone;
  if (item.kind === 'song') return index % 2 ? 'search' : 'daily';
  if (item.kind === 'playlist') return 'playlist';
  if (item.kind === 'podcast' || item.kind === 'podcastSearch') return 'podcast';
  if (item.kind === 'local') return 'local';
  if (item.kind === 'guide') return 'guide';
  if (item.kind === 'login') return 'library';
  if (item.kind === 'search') return 'search';
  return ['daily', 'playlist', 'local', 'guide', 'search'][index % 5];
}
function renderHomeMosaic(items) {
  var cells = document.querySelectorAll('#home-mosaic .home-mosaic-cell');
  if (!cells.length) return;
  var covers = [];
  (items || []).forEach(function (item) {
    var cover = homeTileCover(item);
    if (cover) covers.push(cover);
  });
  for (var i = 0; i < cells.length; i++) {
    var src = covers[i] || covers[(i + 1) % Math.max(1, covers.length)] || '';
    cells[i].style.backgroundImage = src ? 'url("' + cssImageUrl(src) + '")' : '';
    cells[i].classList.toggle('has-cover', !!src);
    cells[i].classList.toggle('home-skeleton', !src && homeDiscoverState.loading);
  }
}
function renderHomeTiles() {
  var row = document.getElementById('home-tile-row');
  var title = document.getElementById('home-rail-title');
  var note = document.getElementById('home-rail-note');
  if (!row) return;
  var tiles = [];
  var loggedOutHome = !homeDiscoverState.loggedIn && !hasAnyPlatformLogin();
  var summary = homeListenSummary();
  if (summary.recent && tiles.length < 5) {
    tiles.push({ kind: 'recent', title: summary.recent.name || 'Keep Listening', sub: summary.recent.artist || summary.recent.source || '', cover: summary.recent.cover, record: summary.recent });
  }
  if (summary.topArtist && tiles.length < 5) {
    tiles.push({ kind: 'profile', title: summary.topArtist.name, sub: 'Top artist · ' + summary.topArtist.plays + ' plays', query: summary.topArtist.name });
  }
  if (!loggedOutHome) {
    homeDiscoverState.songs.slice(0, Math.max(0, 4 - tiles.length)).forEach(function (song, i) {
      tiles.push({ kind: 'song', index: i, song: song, title: song.name || "Today's Song", sub: song.artist || songSourceLabel(song) });
    });
    homeDiscoverState.playlists.slice(0, Math.max(0, 5 - tiles.length)).forEach(function (pl, i) {
      tiles.push({ kind: 'playlist', index: i, title: pl.name || 'Recommended Playlists', sub: (pl.trackCount ? pl.trackCount + ' tracks' : 'Playlist') + (pl.playCount ? ' · ' + compactHomeCount(pl.playCount) + ' plays' : ''), cover: pl.cover });
    });
    if (tiles.length < 5) {
      homeDiscoverState.podcasts.slice(0, 5 - tiles.length).forEach(function (p, i) {
        tiles.push({ kind: 'podcast', index: i, title: p.name || 'Popular Podcasts', sub: p.djName || p.category || 'Podcast', cover: p.cover });
      });
    }
  }
  if (!tiles.length) tiles = fallbackHomeTiles();
  tiles = tiles.slice(0, 5);
  if (title) title.textContent = summary.recent ? 'Pick Up Where You Left Off' : (loggedOutHome ? 'Start Here' : 'Your Playlists & Recommendations');
  if (note) {
    var liveNote = homeDiscoverState.updatedAt ? 'Just updated · Click to play' : 'Click to play';
    note.textContent = homeDiscoverState.loading ? 'Preparing recommendations' : (loggedOutHome ? 'Sign in to see personal picks' : (homeDiscoverState.error ? 'Offline picks' : liveNote));
  }
  row.innerHTML = tiles.map(function (item, i) {
    var cover = homeTileCover(item);
    var tone = homeToneForItem(item, i);
    var coverClass = 'home-tile-cover' + (cover ? ' has-cover' : '');
    return '<button class="home-tile' + (!cover && homeDiscoverState.loading ? ' home-skeleton' : '') + '" data-home-tone="' + escHtml(tone) + '" type="button" onclick="handleHomeTileClick(' + i + ')">' +
      '<div class="' + coverClass + '" style="' + (cover ? 'background-image:url(&quot;' + escHtml(cssImageUrl(cover)) + '&quot;)' : '') + '"></div>' +
      '<div class="home-tile-title">' + escHtml(item.title || '') + '</div>' +
      '<div class="home-tile-sub">' + escHtml(item.sub || '') + '</div>' +
      '</button>';
  }).join('');
  row._homeTiles = tiles;
  renderHomeMosaic(tiles);
}
function renderHomeDiscover() {
  var sub = document.getElementById('home-subtitle');
  var loggedOutHome = !homeDiscoverState.loggedIn && !hasAnyPlatformLogin();
  var weatherTitle = document.getElementById('home-weather-title');
  var weatherKicker = document.getElementById('home-weather-kicker');
  var weatherMeta = document.getElementById('home-weather-meta');
  if (weatherTitle) weatherTitle.textContent = 'My Music Library';
  if (weatherKicker) weatherKicker.textContent = 'Mineradio · Your Library';
  if (sub) {
    if (loggedOutHome) sub.textContent = 'Sign in to see your playlists, top artists, and recent plays here; you can also search or import local music.';
    else sub.textContent = 'Start from your playlists, recent plays, platform recommendations, and top artists.';
  }
  if (weatherMeta) {
    var meta = loggedOutHome ? ['Cross-platform search', 'Local music', 'Popular radio'] : ['Personal picks', 'Platform playlists', 'Popular radio'];
    weatherMeta.innerHTML = meta.map(function (text) { return '<span class="home-weather-pill">' + escHtml(text) + '</span>'; }).join('');
  }
  var daily = homeDiscoverState.songs[0] || null;
  var cardSongB = homeDiscoverState.songs[1] || null;
  var cardSongC = homeDiscoverState.songs[2] || null;
  var playlistItem = homeDiscoverState.playlists[0] || null;
  var podcastItem = homeDiscoverState.podcasts[0] || null;
  var summary = homeListenSummary();
  var weatherCardTitle = document.getElementById('home-weather-card-title');
  var weatherCardSub = document.getElementById('home-weather-card-sub');
  var dailyTitle = document.getElementById('home-daily-title');
  var dailySub = document.getElementById('home-daily-sub');
  var privateTitle = document.getElementById('home-private-title');
  var privateSub = document.getElementById('home-private-sub');
  var continueTitle = document.getElementById('home-continue-title');
  var continueSub = document.getElementById('home-continue-sub');
  var profileTitle = document.getElementById('home-profile-title');
  var profileSub = document.getElementById('home-profile-sub');
  var libTitle = document.getElementById('home-library-title');
  var libSub = document.getElementById('home-library-sub');
  if (weatherCardTitle) weatherCardTitle.textContent = 'My Playlists';
  if (weatherCardSub) {
    weatherCardSub.textContent = playlistItem ? (((playlistItem.trackCount || 0) ? playlistItem.trackCount + ' tracks · ' : '') + (playlistItem.creator || 'Open the playlist library on the left')) : 'Open the playlist library on the left';
  }
  if (continueTitle) continueTitle.textContent = summary.recent ? summary.recent.name : 'Keep Listening';
  if (continueSub) continueSub.textContent = summary.recent ? (summary.recent.artist || summary.recent.source || 'Recent plays') : 'Recent plays will appear here';
  if (profileTitle) profileTitle.textContent = summary.topArtist ? summary.topArtist.name : (summary.topSong ? summary.topSong.name : 'Listening Profile');
  if (profileSub) profileSub.textContent = summary.topArtist ? ('Top artist · ' + summary.topArtist.plays + ' plays') : (summary.totalPlays ? summary.totalPlays + ' total plays' : 'Play a few songs to build your profile');
  if (loggedOutHome) {
    if (dailyTitle) dailyTitle.textContent = 'Daily Mix';
    if (dailySub) dailySub.textContent = 'Sign in to sync your daily songs';
    if (privateTitle) privateTitle.textContent = 'Recommended Songs';
    if (privateSub) privateSub.textContent = 'Sign in to sync more songs';
    if (libTitle) libTitle.textContent = 'More Songs';
    if (libSub) libSub.textContent = 'Recommendations improve as you play';
    setHomeArt('home-weather-art', '', 280);
    setHomeArt('home-daily-art', '', 280);
    setHomeArt('home-private-art', '', 280);
    setHomeArt('home-continue-art', summary.recent && summary.recent.cover, 280);
    setHomeArt('home-profile-art', summary.topSong && summary.topSong.cover || summary.recent && summary.recent.cover, 280);
    setHomeArt('home-library-art', '', 280);
  } else {
    if (dailyTitle) dailyTitle.textContent = daily ? daily.name : 'Daily Mix';
    if (dailySub) dailySub.textContent = daily ? ((daily.artist || songSourceLabel(daily) || "Today's Song") + ' · Click to play today's queue') : 'Sync your daily songs';
    if (privateTitle) privateTitle.textContent = cardSongB ? cardSongB.name : 'Private Radar';
    if (privateSub) privateSub.textContent = cardSongB ? (cardSongB.artist || songSourceLabel(cardSongB) || 'Recommended songs') : (homeDiscoverState.songs.length + ' tracks · Based on today's picks and listening habits');
    if (libTitle) libTitle.textContent = cardSongC ? cardSongC.name : (summary.topArtist ? summary.topArtist.name : 'More Songs');
    if (libSub) libSub.textContent = cardSongC ? (cardSongC.artist || songSourceLabel(cardSongC) || 'Recommended songs') : (summary.topArtist ? ('Artist affinity · ' + summary.topArtist.plays + ' plays') : 'Play a few songs to build your taste profile');
    setHomeArt('home-weather-art', (userPlaylists[0] && userPlaylists[0].cover) || (playlistItem && playlistItem.cover) || daily && daily.cover, 280);
    setHomeArt('home-daily-art', daily && daily.cover, 280);
    setHomeArt('home-private-art', cardSongB && cardSongB.cover || daily && daily.cover || summary.recent && summary.recent.cover || playlistItem && playlistItem.cover, 280);
    setHomeArt('home-continue-art', summary.recent && summary.recent.cover || playlistItem && playlistItem.cover, 280);
    setHomeArt('home-profile-art', summary.topSong && summary.topSong.cover || podcastItem && podcastItem.cover, 280);
    setHomeArt('home-library-art', cardSongC && cardSongC.cover || summary.topSong && summary.topSong.cover || summary.recent && summary.recent.cover || podcastItem && podcastItem.cover, 280);
  }
  renderHomeTiles();
}
async function loadHomeDiscover(force) {
  if (homeDiscoverState.loading) return;
  if (homeDiscoverState.loaded && !force) return;
  var token = ++homeDiscoverToken;
  homeDiscoverState.loading = true;
  homeDiscoverState.error = '';
  renderHomeDiscover();
  try {
    var data = await apiJson('/api/discover/home?t=' + Date.now());
    if (token !== homeDiscoverToken) return;
    homeDiscoverState.loggedIn = !!(data && data.loggedIn) || hasAnyPlatformLogin();
    homeDiscoverState.mode = data && data.mode || (homeDiscoverState.loggedIn ? 'member' : 'starter');
    homeDiscoverState.songs = homeDiscoverState.loggedIn ? (data && data.dailySongs || []).map(cloneSong) : [];
    homeDiscoverState.playlists = homeDiscoverState.loggedIn ? ((data && data.playlists && data.playlists.length) ? data.playlists : userPlaylists.slice(0, 10)) : [];
    homeDiscoverState.podcasts = homeDiscoverState.loggedIn ? (data && data.podcasts || []) : [];
    homeDiscoverState.updatedAt = Number(data && data.updatedAt) || Date.now();
    homeDiscoverState.loaded = true;
  } catch (e) {
    console.warn('home discover failed:', e);
    if (token === homeDiscoverToken) homeDiscoverState.error = 'DISCOVER_FAILED';
  } finally {
    if (token === homeDiscoverToken) {
      homeDiscoverState.loading = false;
      renderHomeDiscover();
    }
  }
}
