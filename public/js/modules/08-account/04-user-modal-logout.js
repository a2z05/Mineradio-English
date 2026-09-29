function loggedProviderCount() {
  return ['spotify', 'ytmusic', 'deezer', 'soundcloud'].filter(function (key) { return hasPlatformLogin(key); }).length;
}
function updateUserModalUi() {
  activeAccountProvider = firstLoggedProvider();
  var st = platformStatus(activeAccountProvider);
  var meta = platformMeta(activeAccountProvider);
  var chip = document.getElementById('account-provider-chip');
  var avatar = document.getElementById('user-modal-avatar');
  var name = document.getElementById('user-modal-name');
  var vipEl = document.getElementById('user-modal-vip');
  var hint = document.getElementById('account-hint');
  var logoutBtn = document.getElementById('account-logout-btn');
  var addSpotify = document.getElementById('account-add-spotify');
  var addYtmusic = document.getElementById('account-add-ytmusic');
  var addDeezer = document.getElementById('account-add-deezer');
  var addSoundcloud = document.getElementById('account-add-soundcloud');
  if (chip) {
    chip.className = 'account-provider-chip ' + activeAccountProvider;
    chip.innerHTML = '<span class="account-source-dot ' + meta.dot + '"></span><span>' + meta.label + '</span>';
  }
  if (avatar) avatar.src = providerAvatarSrc(activeAccountProvider, st);
  if (name) name.textContent = (st && st.nickname) || meta.label;
  if (vipEl) {
    if (activeAccountProvider === 'spotify') {
      var spProduct = st && st.product === 'premium' ? 'Spotify Premium' : (st && st.product ? ('Spotify ' + String(st.product).toUpperCase()) : 'Spotify plan unknown');
      vipEl.textContent = 'ID: ' + ((st && st.userId) || '-') + '  /  ' + spProduct + '  /  Syncs playlists and Liked Songs';
      vipEl.style.color = hasProviderVip('spotify', st) ? 'rgba(30,215,96,0.86)' : 'rgba(30,215,96,0.60)';
    } else if (activeAccountProvider === 'ytmusic') {
      vipEl.textContent = providerReachabilityStatus('ytmusic').reachable
        ? 'YT Music — ready to play · No sign-in needed'
        : 'YT Music — not reachable on this network · No sign-in needed';
      vipEl.style.color = 'rgba(255,60,60,0.78)';
    } else if (activeAccountProvider === 'deezer') {
      vipEl.textContent = providerReachabilityStatus('deezer').reachable
        ? 'Deezer — ready to play · Previews + auto fallback'
        : 'Deezer — not reachable on this network · No sign-in needed';
      vipEl.style.color = 'rgba(254,223,0,0.86)';
    } else if (activeAccountProvider === 'soundcloud') {
      vipEl.textContent = providerReachabilityStatus('soundcloud').reachable
        ? 'SoundCloud — ready to play · Direct streams'
        : 'SoundCloud — not reachable on this network · No sign-in needed';
      vipEl.style.color = 'rgba(255,110,0,0.86)';
    } else {
      var spProduct2 = st && st.product === 'premium' ? 'Spotify Premium' : (st && st.product ? ('Spotify ' + String(st.product).toUpperCase()) : 'Spotify plan unknown');
      vipEl.textContent = 'ID: ' + ((st && st.userId) || '-') + '  /  ' + spProduct2;
      vipEl.style.color = 'rgba(30,215,96,0.60)';
    }
  }
  ['spotify', 'ytmusic', 'deezer', 'soundcloud', 'both'].forEach(function (key) {
    var btn = document.getElementById('user-provider-' + key);
    if (btn) btn.classList.toggle('active', key === 'both' ? dualAccountMode : (!dualAccountMode && activeAccountProvider === key));
  });
  if (addSpotify) addSpotify.textContent = hasPlatformLogin('spotify') ? 'View Spotify' : 'Connect Spotify';
  // EN-FORK: these three are keyless, so "ready" was always printed. Where the
  // network blocks them that promise is what a click then fails to keep, so the
  // row says whether it can actually be reached.
  if (addYtmusic) addYtmusic.textContent = 'YT Music — ' + (providerReachabilityStatus('ytmusic').reachable ? 'ready' : 'unreachable here');
  if (addDeezer) addDeezer.textContent = 'Deezer — ' + (providerReachabilityStatus('deezer').reachable ? 'ready' : 'unreachable here');
  if (addSoundcloud) addSoundcloud.textContent = 'SoundCloud — ' + (providerReachabilityStatus('soundcloud').reachable ? 'ready' : 'unreachable here');
  if (logoutBtn) logoutBtn.textContent =
    activeAccountProvider === 'spotify' ? 'Log out of Spotify' :
    (activeAccountProvider === 'ytmusic' ? 'YT Music — no sign-out needed' :
    (activeAccountProvider === 'deezer' ? 'Deezer — no sign-out needed' :
    (activeAccountProvider === 'soundcloud' ? 'SoundCloud — no sign-out needed' : 'Log out')));
  if (hint) hint.textContent = dualAccountMode
    ? 'The top-right corner now shows multiple platforms side by side.'
    : 'Choose which platforms show in the top-right; "I want both" shows all signed-in platforms side by side.';
}
function showUserModal() {
  if (!hasAnyPlatformLogin()) return showLoginModal();
  updateUserModalUi();
  // EN-FORK: keep the "Playback sources" order in step with account state,
  // since readiness decides which rows can actually serve as a fallback.
  if (typeof renderPlaybackProviderOrderList === 'function') renderPlaybackProviderOrderList();
  openGsapModal(document.getElementById('user-modal'));
}
function closeUserModal() { closeGsapModal(document.getElementById('user-modal')); }
function setActiveAccountProvider(provider) {
  provider = provider === 'ytmusic' ? 'ytmusic' : (provider === 'deezer' ? 'deezer' : (provider === 'soundcloud' ? 'soundcloud' : 'spotify'));
  if (!hasPlatformLogin(provider)) {
    openProviderLogin(provider);
    return;
  }
  activeAccountProvider = provider;
  dualAccountMode = false;
  renderUserBtn();
  updateUserModalUi();
}
function enableDualAccountView() {
  if (loggedProviderCount() < 2) {
    openProviderLogin(firstLoggedProvider() === 'spotify' ? 'ytmusic' : 'spotify');
    return;
  }
  dualAccountMode = true;
  renderUserBtn();
  updateUserModalUi();
  showToast('Multi-platform account view enabled');
}
function requestDualLoginMode() {
  enableDualAccountView();
}
function openProviderLogin(provider) {
  // EN-FORK: only the four global providers have a sign-in window. Anything
  // else used to be silently coerced to Spotify, which opened a sign-in that
  // could never satisfy the original request.
  var supported = provider === 'ytmusic' || provider === 'deezer'
    || provider === 'soundcloud' || provider === 'spotify';
  if (!supported) {
    if (typeof showToast === 'function') {
      showToast((provider || 'This platform') + ' sign-in was removed in this build — it is only used for saved tracks');
    }
    return;
  }
  closeUserModal();
  loginProvider = provider;
  showLoginModal({ provider: provider });
}

var logoutAllAccountsResetBusy = false;
var logoutAllAccountsResetConfirmUntil = 0;
var logoutAllAccountsResetConfirmTimer = null;

function clearLogoutAllAccountsResetConfirmation() {
  logoutAllAccountsResetConfirmUntil = 0;
  if (logoutAllAccountsResetConfirmTimer) {
    window.clearTimeout(logoutAllAccountsResetConfirmTimer);
    logoutAllAccountsResetConfirmTimer = null;
  }
  var button = document.getElementById('login-reset-all-btn');
  if (button) {
    button.classList.remove('confirming');
    if (!logoutAllAccountsResetBusy) button.textContent = 'Log out';
  }
}

function armLogoutAllAccountsResetConfirmation() {
  logoutAllAccountsResetConfirmUntil = Date.now() + 5000;
  var button = document.getElementById('login-reset-all-btn');
  if (button) {
    button.classList.add('confirming');
    button.textContent = 'Click again to confirm';
  }
  if (typeof showToast === 'function') showToast('Click "Log out" again to clear cookies for all platforms');
  if (logoutAllAccountsResetConfirmTimer) window.clearTimeout(logoutAllAccountsResetConfirmTimer);
  logoutAllAccountsResetConfirmTimer = window.setTimeout(clearLogoutAllAccountsResetConfirmation, 5000);
}

// EN-FORK: global-only providers — Chinese login states removed from UI reset.
function resetAllProviderRendererLoginState() {
  loginStatus = { loggedIn: false, vipType: 0, vipLevel: 'none', isVip: false, isSvip: false, vipLabel: 'No VIP' };
  spotifyLoginStatus = { provider: 'spotify', loggedIn: false, configured: false, oauthConfigured: false, oauthMissing: [], preview: false, nickname: 'Spotify', userId: '', avatar: '', product: '', vipType: 0, vipLevel: 'none', isVip: false, isSvip: false, playbackKeyReady: false, playbackMode: 'recommend-match', tokenConfigured: false, tokenFileExists: false, credentialsFileExists: false, localConfigMissing: false };
  loginStatusChecked = true;
  loginStatusCheckFailed = false;
  neteasePlaylists = [];
  qqPlaylists = [];
  kugouPlaylists = [];
  qishuiPlaylists = [];
  spotifyPlaylists = [];
  userPlaylists = [];
  myPodcastCollections = [];
  myPodcastItems = {};
  likedSongMap = {};
  dualAccountMode = false;
  activeAccountProvider = 'spotify';
  playlistCatalogRevision += 1;
  if (typeof clearQQPlaybackVipEvidence === 'function') clearQQPlaybackVipEvidence();
  if (typeof homeDiscoverState !== 'undefined' && homeDiscoverState) {
    homeDiscoverState.loading = false;
    homeDiscoverState.loaded = true;
    homeDiscoverState.loggedIn = false;
    homeDiscoverState.mode = 'starter';
    homeDiscoverState.songs = [];
    homeDiscoverState.playlists = [];
    homeDiscoverState.podcasts = [];
  }
}

// EN-FORK: global-only logout — Chinese endpoints removed from UI bulk logout.
async function logoutAllAccountsAndResetEasterEgg() {
  if (logoutAllAccountsResetBusy) return;
  if (Date.now() > logoutAllAccountsResetConfirmUntil) {
    armLogoutAllAccountsResetConfirmation();
    return;
  }
  logoutAllAccountsResetBusy = true;
  var button = document.getElementById('login-reset-all-btn');
  clearLogoutAllAccountsResetConfirmation();
  if (button) {
    button.disabled = true;
    button.textContent = 'Clearing…';
  }
  try {
    await Promise.allSettled([
      apiJson('/api/logout'),
      apiJson('/api/spotify/logout')
    ]);
    var result = await requestLoginEasterEggReplayReset();
    if (!result || !result.ok || result.unlocked || result.resetComplete === false) {
      throw new Error(result && (result.error || result.message) || 'LOGIN_EASTER_EGG_REPLAY_RESET_FAILED');
    }
    resetAllProviderRendererLoginState();
    resetLoginEasterEggUiForReplay();
    closeCollectModal();
    closeUserModal();
    closeLoginModal();
    updateLikeButtons();
    safeRenderQueuePanel('logout-all-reset', { scrollCurrent: miniQueueOpen });
    renderUserBtn();
    safeShelfRebuild('logout-all-reset');
    homeSuppressed = false;
    homeForcedOpen = true;
    if (typeof setHomeControlsLocked === 'function') setHomeControlsLocked(true);
    if (typeof updateEmptyHomeVisibility === 'function') updateEmptyHomeVisibility({ forceLoad: false });
    if (typeof renderHomeDashboard === 'function') renderHomeDashboard();
    showToast('All accounts signed out; the login easter egg has reset');
  } catch (error) {
    console.warn('Logout all accounts and reset easter egg failed:', error);
    showToast('Cleanup incomplete. Restart and try again');
  } finally {
    logoutAllAccountsResetBusy = false;
    if (button) {
      button.disabled = false;
      button.classList.remove('confirming');
      button.textContent = 'Log out';
    }
  }
}

// EN-FORK: global-only — ytmusic/deezer/soundcloud need no sign-out; Chinese branches removed.
async function logoutActiveAccount() {
  if (activeAccountProvider === 'spotify') {
    try { await apiJson('/api/spotify/logout'); } catch (e) { }
    try {
      if (window.desktopWindow && typeof window.desktopWindow.clearSpotifyMusicLogin === 'function') {
        await window.desktopWindow.clearSpotifyMusicLogin();
      }
    } catch (e) { }
    spotifyLoginStatus = { provider: 'spotify', loggedIn: false, configured: false, oauthConfigured: false, oauthMissing: [], preview: false, nickname: 'Spotify', userId: '', avatar: '', product: '', vipType: 0, vipLevel: 'none', isVip: false, isSvip: false, playbackKeyReady: false, playbackMode: 'recommend-match', tokenConfigured: false, tokenFileExists: false, credentialsFileExists: false, localConfigMissing: false };
    spotifyPlaylists = [];
    userPlaylists = userPlaylists.filter(function (pl) { return pl.provider !== 'spotify'; });
    playlistCatalogRevision += 1;
    dualAccountMode = false;
    activeAccountProvider = firstLoggedProvider();
    renderUserBtn();
    safeShelfRebuild('spotify-logout');
    if (hasAnyPlatformLogin()) updateUserModalUi();
    else closeUserModal();
    showToast('Signed out of Spotify');
    return;
  }
  if (activeAccountProvider === 'ytmusic' || activeAccountProvider === 'deezer' || activeAccountProvider === 'soundcloud') {
    var m2 = platformMeta(activeAccountProvider);
    showToast((m2.label || activeAccountProvider) + ' needs no sign-out');
    return;
  }
  doLogout();
}
async function doLogout() {
  await apiJson('/api/logout');
  try {
    if (window.desktopWindow && typeof window.desktopWindow.clearNeteaseMusicLogin === 'function') {
      await window.desktopWindow.clearNeteaseMusicLogin();
    }
  } catch (e) { }
  loginStatus = { loggedIn: false };
  neteasePlaylists = [];
  if (!hasPlatformLogin('netease') || loggedProviderCount() < 2) dualAccountMode = false;
  activeAccountProvider = firstLoggedProvider();
  userPlaylists = qqPlaylists.concat(kugouPlaylists || [], qishuiPlaylists || [], spotifyPlaylists || []);
  playlistCatalogRevision += 1;
  myPodcastCollections = [];
  myPodcastItems = {};
  likedSongMap = {};
  closeCollectModal();
  updateLikeButtons();
  safeRenderQueuePanel('logout', { scrollCurrent: miniQueueOpen });
  renderUserBtn();
  safeShelfRebuild('logout');
  closeUserModal();
  showToast('Signed out');
}
