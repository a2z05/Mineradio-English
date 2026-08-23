function loggedProviderCount() {
  return ['netease', 'qq', 'kugou', 'qishui', 'spotify'].filter(function (key) { return hasPlatformLogin(key); }).length;
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
  var addNetease = document.getElementById('account-add-netease');
  var addQQ = document.getElementById('account-add-qq');
  var addKugou = document.getElementById('account-add-kugou');
  var addQishui = document.getElementById('account-add-qishui');
  var addSpotify = document.getElementById('account-add-spotify');
  if (chip) {
    chip.className = 'account-provider-chip ' + activeAccountProvider;
    chip.innerHTML = '<span class="account-source-dot ' + meta.dot + '"></span><span>' + meta.label + '</span>';
  }
  if (avatar) avatar.src = providerAvatarSrc(activeAccountProvider, st);
  if (name) name.textContent = (st && st.nickname) || meta.label;
  if (vipEl) {
    if (activeAccountProvider === 'netease') {
      var neVipLevel = providerVipLevel('netease', st);
      var vipLabel = neVipLevel === 'svip' ? 'NetEase SVIP' : (neVipLevel === 'vip' ? 'NetEase VIP' : 'Free user');
      vipEl.textContent = 'UID: ' + ((st && st.userId) || '-') + '  /  ' + vipLabel;
      vipEl.style.color = hasProviderVip('netease', st) ? 'rgba(244,210,138,0.86)' : 'rgba(255,255,255,0.5)';
    } else if (activeAccountProvider === 'kugou') {
      var kgVipLevel = providerVipLevel('kugou', st);
      var kgVipLabel = kgVipLevel === 'svip' ? 'Kugou SVIP member' : (kgVipLevel === 'vip' ? 'Kugou VIP member' : 'Kugou session');
      vipEl.textContent = 'UID: ' + ((st && st.userId) || '-') + '  /  ' + kgVipLabel;
      vipEl.style.color = hasProviderVip('kugou', st) ? 'rgba(86,224,255,0.86)' : 'rgba(86,224,255,0.58)';
    } else if (activeAccountProvider === 'qishui') {
      var qishuiMode = st && st.webSession ? 'Soda Music signed in via QR' : 'Soda Music not signed in';
      var qishuiSync = st && st.webSession ? 'Likes and playlists sync; playback uses account perks' : 'Scan with the Douyin app to sign in';
      vipEl.textContent = qishuiMode + '  /  ' + qishuiSync;
      vipEl.style.color = 'rgba(69,214,143,0.78)';
    } else if (activeAccountProvider === 'spotify') {
      var spProduct = st && st.product === 'premium' ? 'Spotify Premium' : (st && st.product ? ('Spotify ' + String(st.product).toUpperCase()) : 'Spotify plan unknown');
      vipEl.textContent = 'ID: ' + ((st && st.userId) || '-') + '  /  ' + spProduct + '  /  Syncs playlists and Liked Songs';
      vipEl.style.color = hasProviderVip('spotify', st) ? 'rgba(30,215,96,0.86)' : 'rgba(30,215,96,0.60)';
    } else {
      var qqVipLevel = providerVipLevel('qq', st);
      var qqVipPending = qqLoginNeedsAuthorizationRefresh(st) || (typeof qqMembershipNeedsSync === 'function' && qqMembershipNeedsSync(st));
      var qqVipLabel = qqVipPending ? 'QQ membership syncing' : (qqVipLevel === 'svip' ? 'QQ SVIP member' : (qqVipLevel === 'vip' ? 'QQ VIP member' : 'QQ Music session'));
      vipEl.textContent = 'UID: ' + ((st && st.userId) || '-') + '  /  ' + qqVipLabel;
      vipEl.style.color = qqVipPending ? 'rgba(255,232,174,0.86)' : (hasProviderVip('qq', st) ? 'rgba(0,245,212,0.82)' : 'rgba(0,245,212,0.58)');
    }
  }
  ['netease', 'qq', 'kugou', 'qishui', 'spotify', 'both'].forEach(function (key) {
    var btn = document.getElementById('user-provider-' + key);
    if (btn) btn.classList.toggle('active', key === 'both' ? dualAccountMode : (!dualAccountMode && activeAccountProvider === key));
  });
  if (addNetease) addNetease.style.display = hasPlatformLogin('netease') ? 'none' : '';
  if (addQQ) addQQ.textContent = hasPlatformLogin('qq') ? 'View QQ Music' : 'Add QQ Music';
  if (addKugou) addKugou.textContent = hasPlatformLogin('kugou') ? 'View Kugou Music' : 'Add Kugou Music';
  if (addQishui) addQishui.textContent = hasPlatformLogin('qishui') ? 'Sign in to Soda again' : 'Sign in to Soda Music';
  if (addSpotify) addSpotify.textContent = hasPlatformLogin('spotify') ? 'View Spotify' : 'Connect Spotify';
  if (logoutBtn) logoutBtn.textContent =
    activeAccountProvider === 'qq' ? 'Log out of QQ Music' :
    (activeAccountProvider === 'kugou' ? 'Log out of Kugou Music' :
    (activeAccountProvider === 'qishui' ? 'Clear Soda sign-in' :
    (activeAccountProvider === 'spotify' ? 'Log out of Spotify' : 'Log out of NetEase Cloud Music')));
  if (hint) hint.textContent = dualAccountMode
    ? 'The top-right corner now shows multiple platforms side by side.'
    : 'Choose which platforms show in the top-right; "I want both" shows all signed-in platforms side by side.';
}
function showUserModal() {
  if (!hasAnyPlatformLogin()) return showLoginModal();
  updateUserModalUi();
  openGsapModal(document.getElementById('user-modal'));
  if (qqLoginStatus && qqLoginStatus.loggedIn && typeof refreshQQVipStatusNow === 'function') {
    refreshQQVipStatusNow('account-modal')
      .then(updateUserModalUi)
      .catch(function (e) { console.warn('QQ VIP modal refresh failed:', e); });
  }
}
function closeUserModal() { closeGsapModal(document.getElementById('user-modal')); }
function setActiveAccountProvider(provider) {
  provider = provider === 'qq' ? 'qq' : (provider === 'kugou' ? 'kugou' : (provider === 'qishui' ? 'qishui' : (provider === 'spotify' ? 'spotify' : 'netease')));
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
    openProviderLogin(firstLoggedProvider() === 'netease' ? 'qq' : 'netease');
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
  provider = provider === 'qq' ? 'qq' : (provider === 'kugou' ? 'kugou' : (provider === 'qishui' ? 'qishui' : (provider === 'spotify' ? 'spotify' : 'netease')));
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

function resetAllProviderRendererLoginState() {
  loginStatus = { loggedIn: false, vipType: 0, vipLevel: 'none', isVip: false, isSvip: false, vipLabel: 'No VIP' };
  qqLoginStatus = { provider: 'qq', loggedIn: false, preview: false, nickname: 'QQ Music', userId: '', avatar: '', vipType: 0, vipLevel: 'none', isVip: false, isSvip: false };
  kugouLoginStatus = { provider: 'kugou', loggedIn: false, preview: false, nickname: 'Kugou Music', userId: '', avatar: '', vipType: 0, vipLevel: 'none', isVip: false, isSvip: false, playbackKeyReady: false };
  qishuiLoginStatus = { provider: 'qishui', loggedIn: false, configured: false, oauthConfigured: false, oauthMissing: [], preview: false, nickname: 'Soda Music', userId: '', avatar: '', vipType: 0, vipLevel: 'none', isVip: false, isSvip: false, playbackKeyReady: false, playbackMode: 'recommend-match' };
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
  activeAccountProvider = 'netease';
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
      apiJson('/api/qq/logout'),
      apiJson('/api/kugou/logout'),
      apiJson('/api/qishui/logout'),
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
  if (activeAccountProvider === 'qishui') {
    try { await apiJson('/api/qishui/logout'); } catch (e) { }
    try {
      if (window.desktopWindow && typeof window.desktopWindow.clearQishuiMusicLogin === 'function') {
        await window.desktopWindow.clearQishuiMusicLogin();
      }
    } catch (e) { }
    qishuiLoginStatus = { provider: 'qishui', loggedIn: false, configured: false, oauthConfigured: false, oauthMissing: [], preview: false, nickname: 'Soda Music', userId: '', avatar: '', vipType: 0, vipLevel: 'none', isVip: false, isSvip: false, playbackKeyReady: false, playbackMode: 'recommend-match' };
    qishuiPlaylists = [];
    userPlaylists = userPlaylists.filter(function (pl) { return pl.provider !== 'qishui'; });
    playlistCatalogRevision += 1;
    dualAccountMode = false;
    activeAccountProvider = firstLoggedProvider();
    renderUserBtn();
    safeShelfRebuild('qishui-logout');
    if (hasAnyPlatformLogin()) updateUserModalUi();
    else closeUserModal();
    showToast('Soda Music authorization cleared');
    return;
  }
  if (activeAccountProvider === 'kugou') {
    try { await apiJson('/api/kugou/logout'); } catch (e) { }
    try {
      if (window.desktopWindow && typeof window.desktopWindow.clearKugouMusicLogin === 'function') {
        await window.desktopWindow.clearKugouMusicLogin();
      }
    } catch (e) { }
    kugouLoginStatus = { provider: 'kugou', loggedIn: false, preview: false, nickname: 'Kugou Music', userId: '', avatar: '', vipType: 0, vipLevel: 'none', isVip: false, isSvip: false, playbackKeyReady: false };
    kugouPlaylists = [];
    userPlaylists = userPlaylists.filter(function (pl) { return pl.provider !== 'kugou'; });
    playlistCatalogRevision += 1;
    dualAccountMode = false;
    activeAccountProvider = firstLoggedProvider();
    renderUserBtn();
    if (hasAnyPlatformLogin()) updateUserModalUi();
    else closeUserModal();
    showToast('Signed out of Kugou Music');
    return;
  }
  if (activeAccountProvider === 'qq') {
    try { await apiJson('/api/qq/logout'); } catch (e) { }
    try {
      if (window.desktopWindow && typeof window.desktopWindow.clearQQMusicLogin === 'function') {
        await window.desktopWindow.clearQQMusicLogin();
      }
    } catch (e) { }
    if (typeof clearQQPlaybackVipEvidence === 'function') clearQQPlaybackVipEvidence();
    qqLoginStatus = { provider: 'qq', loggedIn: false, preview: false, nickname: 'QQ Music', userId: '', avatar: '', vipType: 0, vipLevel: 'none', isVip: false, isSvip: false };
    qqPlaylists = [];
    userPlaylists = userPlaylists.filter(function (pl) { return pl.provider !== 'qq'; });
    playlistCatalogRevision += 1;
    dualAccountMode = false;
    activeAccountProvider = firstLoggedProvider();
    renderUserBtn();
    if (hasAnyPlatformLogin()) updateUserModalUi();
    else closeUserModal();
    showToast('Signed out of QQ Music');
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
