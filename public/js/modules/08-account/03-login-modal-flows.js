var loginRefreshRequestSeq = 0;
var loginWorkflowDrag = null;
var LOGIN_WORKFLOW_CONNECTION_STORE_KEY = 'mineradio-login-workflow-connections-v1';
var LOGIN_WORKFLOW_PROVIDERS = ['spotify', 'ytmusic', 'deezer', 'soundcloud'];
var loginWorkflowPendingProvider = '';
var loginWorkflowVerifiedSession = {};
var loginProviderPointer = null;
var loginProviderClickSuppressed = false;
var loginWorkflowEdgeRenderFrame = 0;
var loginWorkflowEdgeRenderTimers = [];
var SPOTIFY_DEVELOPER_DASHBOARD_URL = 'https://developer.spotify.com/dashboard';
var SPOTIFY_REDIRECT_URI = 'http://127.0.0.1:43879/callback';

function isLoginRefreshCurrent(provider, seq) {
  return loginProvider === provider && loginRefreshRequestSeq === seq;
}

// EN-FORK: global-only providers — Chinese (netease/qq/kugou/qishui) removed from UI.
function normalizeLoginProviderKey(provider) {
  return (provider === 'ytmusic' || provider === 'deezer' || provider === 'soundcloud') ? provider : 'spotify';
}
// EN-FORK: global-only — cookie mode not needed (Spotify uses OAuth, others are keyless).
function loginProviderSupportsCookieMode(provider) {
  provider = normalizeLoginProviderKey(provider);
  return provider !== 'spotify';
}
// EN-FORK: global-only providers — Chinese providers removed from UI.
function loginProviderOfficialModeText(provider) {
  provider = normalizeLoginProviderKey(provider);
  if (provider === 'spotify') return { title: 'OAuth', sub: 'Opens the Spotify authorization window' };
  return { title: 'Connect', sub: 'Connect to ' + (platformMeta(provider).label || provider) };
}
// EN-FORK: global-only — cookie import not needed for global providers.
function setManualCookieOpenForProvider(provider, open) {
  void provider; void open;
}
function isManualCookieOpenForProvider(provider) {
  void provider;
  return false;
}
function readLoginWorkflowConnections() {
  try { localStorage.removeItem(LOGIN_WORKFLOW_CONNECTION_STORE_KEY); } catch (e) { }
  return [];
}
function saveLoginWorkflowConnections(list) {
  try { localStorage.removeItem(LOGIN_WORKFLOW_CONNECTION_STORE_KEY); } catch (e) { }
}
function providerHasLiveLogin(provider) {
  provider = normalizeLoginProviderKey(provider);
  if (loginWorkflowVerifiedSession && loginWorkflowVerifiedSession[provider]) return true;
  try { return typeof hasPlatformLogin === 'function' && hasPlatformLogin(provider); } catch (e) { return false; }
}
function loginWorkflowConnectedProviders() {
  return loginWorkflowProviderOrder().filter(providerHasLiveLogin);
}
function loginWorkflowProviderOrder() {
  try { return accountProviderOrder(); } catch (e) { return LOGIN_WORKFLOW_PROVIDERS.slice(); }
}
function syncLoginWorkflowConnectionsFromStatus() {
  saveLoginWorkflowConnections([]);
  return loginWorkflowConnectedProviders();
}
function hasLoginWorkflowConnection(provider) {
  provider = normalizeLoginProviderKey(provider);
  return loginWorkflowConnectedProviders().indexOf(provider) >= 0;
}
function markLoginWorkflowConnected(provider) {
  provider = normalizeLoginProviderKey(provider);
  loginWorkflowVerifiedSession[provider] = true;
  if (!isAccountProviderExternallyVisible(provider)) {
    var list = accountProviderVisibleList();
    list.push(provider);
    saveAccountProviderVisibleList(list);
  }
}
function setLoginAuthDrawerOpen(open) {
  var drawer = document.getElementById('login-auth-drawer');
  var modal = document.querySelector('#login-modal .dual-login-modal');
  var panel = document.getElementById('qq-cookie-panel');
  if (modal) modal.classList.toggle('login-details-open', !!open);
  if (drawer) {
    // EN-FORK FIX: the sign-in form (cookie import / Spotify guide with the
    // Client ID box + tutorial + Save button) needs the FULL drawer width.
    // :has() matching proved unreliable in practice, so drive an explicit
    // class from JS whenever the form panel is visible.
    var formOpen = !!(panel && panel.classList.contains('show'));
    drawer.classList.toggle('form-open', formOpen);
    drawer.classList.toggle('show', !!open);
  }
  if (!open) {
    loginWorkflowPendingProvider = '';
    try { stopQrPoll(); } catch (e) { }
  }
}
function markLoginNodeConnecting() {
  var graph = document.getElementById('login-node-graph');
  if (!graph) return;
  graph.classList.remove('connecting');
  void graph.offsetWidth;
  graph.classList.add('connecting');
  setTimeout(function () { graph.classList.remove('connecting'); }, 980);
}
function loginWorkflowActiveMode() {
  return isManualCookieOpenForProvider(loginProvider) ? 'cookie' : 'official';
}
function workflowPointForPort(port, root) {
  if (!port || !root) return null;
  var portRect = port.getBoundingClientRect();
  var rootRect = root.getBoundingClientRect();
  return {
    x: portRect.left + portRect.width / 2 - rootRect.left,
    y: portRect.top + portRect.height / 2 - rootRect.top
  };
}
function workflowPointFromEvent(e, root) {
  if (!e || !root) return null;
  var rootRect = root.getBoundingClientRect();
  return { x: e.clientX - rootRect.left, y: e.clientY - rootRect.top };
}
function workflowPointDistance(a, b) {
  if (!a || !b) return Infinity;
  var dx = a.x - b.x;
  var dy = a.y - b.y;
  return Math.sqrt(dx * dx + dy * dy);
}
function loginWorkflowMrTargetPoint(graph) {
  if (!graph) return null;
  return workflowPointForPort(graph.querySelector('[data-login-mr-target="mr"]'), graph);
}
function loginWorkflowSnapPoint(point, graph) {
  var mr = loginWorkflowMrTargetPoint(graph);
  if (point && mr && workflowPointDistance(point, mr) <= 92) return mr;
  return point;
}
function loginWorkflowNearMr(point, graph) {
  var mr = loginWorkflowMrTargetPoint(graph);
  return !!(point && mr && workflowPointDistance(point, mr) <= 108);
}
function workflowBezierPath(a, b) {
  var gap = Math.abs(b.x - a.x);
  var dx = Math.max(18, Math.min(86, gap * 0.55));
  return 'M ' + a.x.toFixed(1) + ' ' + a.y.toFixed(1) +
    ' C ' + (a.x + dx).toFixed(1) + ' ' + a.y.toFixed(1) +
    ', ' + (b.x - dx).toFixed(1) + ' ' + b.y.toFixed(1) +
    ', ' + b.x.toFixed(1) + ' ' + b.y.toFixed(1);
}
function appendWorkflowPath(svg, from, to, className) {
  if (!svg || !from || !to) return;
  var path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', workflowBezierPath(from, to));
  path.setAttribute('class', className || 'workflow-link');
  svg.appendChild(path);
}
function clearWorkflowSvg(svg) {
  if (!svg) return;
  while (svg.firstChild) svg.removeChild(svg.firstChild);
}
function renderLoginWorkflowEdges(tempPoint) {
  var graph = document.getElementById('login-node-graph');
  var svg = document.getElementById('login-workflow-svg');
  if (!graph || !svg) return;
  var w = Math.max(1, graph.clientWidth || 1);
  var h = Math.max(1, graph.clientHeight || 1);
  svg.setAttribute('viewBox', '0 0 ' + w + ' ' + h);
  clearWorkflowSvg(svg);
  var mrIn = graph.querySelector('[data-login-mr-target="mr"]');
  loginWorkflowConnectedProviders().forEach(function (provider) {
    var providerOut = graph.querySelector('[data-login-provider-output="' + provider + '"]');
    appendWorkflowPath(svg, workflowPointForPort(providerOut, graph), workflowPointForPort(mrIn, graph), 'workflow-link active' + (provider === loginProvider ? ' selected' : ''));
  });
  if (loginWorkflowPendingProvider && !providerHasLiveLogin(loginWorkflowPendingProvider)) {
    var pendingOut = graph.querySelector('[data-login-provider-output="' + loginWorkflowPendingProvider + '"]');
    appendWorkflowPath(svg, workflowPointForPort(pendingOut, graph), workflowPointForPort(mrIn, graph), 'workflow-link pending');
  }
  if (loginWorkflowDrag && tempPoint) {
    appendWorkflowPath(svg, workflowPointForPort(loginWorkflowDrag.port, graph), loginWorkflowSnapPoint(tempPoint, graph), 'workflow-link temp');
  }
}
function scheduleLoginWorkflowEdges(reason) {
  if (loginWorkflowEdgeRenderFrame) cancelAnimationFrame(loginWorkflowEdgeRenderFrame);
  loginWorkflowEdgeRenderFrame = requestAnimationFrame(function () {
    loginWorkflowEdgeRenderFrame = 0;
    renderLoginWorkflowEdges();
  });
  loginWorkflowEdgeRenderTimers.forEach(function (timer) { clearTimeout(timer); });
  loginWorkflowEdgeRenderTimers = [];
  [70, 170, 340, 560].forEach(function (delay) {
    loginWorkflowEdgeRenderTimers.push(setTimeout(function () {
      renderLoginWorkflowEdges();
    }, delay));
  });
}
function selectLoginProviderNode(provider) {
  if (loginProviderClickSuppressed) {
    loginProviderClickSuppressed = false;
    return;
  }
  provider = normalizeLoginProviderKey(provider);
  setLoginProvider(provider, true);
  setLoginAuthDrawerOpen(hasLoginWorkflowConnection(provider) || loginWorkflowPendingProvider === provider);
  updateLoginProviderUi();
}
function connectLoginProviderToMr(provider) {
  provider = normalizeLoginProviderKey(provider);
  if (provider !== loginProvider) setLoginProvider(provider, true);
  loginWorkflowPendingProvider = provider;
  setLoginAuthDrawerOpen(true);
  markLoginNodeConnecting();
  updateLoginProviderUi();
  connectLoginMode(loginWorkflowActiveMode());
}
function finishLoginWorkflowDrag(e) {
  var graph = document.getElementById('login-node-graph');
  if (!graph || !loginWorkflowDrag) return;
  var drag = loginWorkflowDrag;
  var target = document.elementFromPoint(e.clientX, e.clientY);
  var port = target && target.closest ? target.closest('.flow-port.in') : null;
  var mrNode = target && target.closest ? target.closest('[data-login-node="mr"]') : null;
  var eventPoint = workflowPointFromEvent(e, graph);
  var nearMr = loginWorkflowNearMr(eventPoint, graph);
  if ((port && graph.contains(port)) || (mrNode && graph.contains(mrNode)) || nearMr) {
    var mrTarget = port && port.getAttribute('data-login-mr-target');
    if (drag.source === 'provider' && (mrTarget || mrNode || nearMr)) {
      connectLoginProviderToMr(drag.provider);
    }
  }
  loginWorkflowDrag = null;
  graph.classList.remove('dragging-line', 'drop-ready');
  try { graph.releasePointerCapture(e.pointerId); } catch (_) { }
  scheduleLoginWorkflowEdges('wire-finish');
}
function beforeLoginProviderForPointer(y) {
  var parent = document.getElementById('login-platform-tabs');
  if (!parent) return '';
  var nodes = Array.prototype.slice.call(parent.querySelectorAll('[data-login-provider]'));
  for (var i = 0; i < nodes.length; i += 1) {
    var rect = nodes[i].getBoundingClientRect();
    if (y < rect.top + rect.height / 2) return nodes[i].getAttribute('data-login-provider') || '';
  }
  return '';
}
function startLoginWorkflowPointerDrag(graph, state, e) {
  loginWorkflowDrag = {
    port: state.port,
    source: 'provider',
    provider: state.provider
  };
  graph.classList.add('dragging-line');
  renderLoginWorkflowEdges(workflowPointFromEvent(e, graph));
}
function accountProviderOrderAfterMove(provider, beforeProvider) {
  provider = normalizeLoginProviderKey(provider);
  beforeProvider = beforeProvider ? normalizeLoginProviderKey(beforeProvider) : '';
  var order = accountProviderOrder().filter(function (item) { return item !== provider; });
  var index = beforeProvider ? order.indexOf(beforeProvider) : -1;
  if (index < 0) order.push(provider);
  else order.splice(index, 0, provider);
  return order;
}
function shouldMoveLoginProviderBefore(provider, beforeProvider) {
  var current = accountProviderOrder();
  var next = accountProviderOrderAfterMove(provider, beforeProvider);
  return current.join('|') !== next.join('|');
}
function finishLoginProviderPointer(e) {
  var graph = document.getElementById('login-node-graph');
  if (loginWorkflowDrag) {
    finishLoginWorkflowDrag(e);
    loginProviderClickSuppressed = true;
    setTimeout(function () { loginProviderClickSuppressed = false; }, 120);
    return;
  }
  var state = loginProviderPointer;
  loginProviderPointer = null;
  if (graph) graph.classList.remove('sorting-provider');
  if (!state) return;
  if (state.node) state.node.classList.remove('sorting');
  try { if (graph) graph.releasePointerCapture(e.pointerId); } catch (_) { }
  loginProviderClickSuppressed = true;
  setTimeout(function () { loginProviderClickSuppressed = false; }, 120);
  scheduleLoginWorkflowEdges('sort-finish');
}
function loginProviderVipLabel(provider, status) {
  if (!status || !status.loggedIn) return '';
  var level = providerVipLevel(provider, status);
  return level === 'svip' ? 'SVIP' : (level === 'vip' ? 'VIP' : 'Basic');
}
function handleLoginProviderExternalSwitchEvent(e, provider) {
  if (e) {
    e.preventDefault();
    e.stopPropagation();
  }
  provider = normalizeLoginProviderKey(provider);
  toggleAccountProviderExternal(provider);
  updateLoginProviderUi();
  scheduleLoginWorkflowEdges('external-switch');
}
function updateLoginProviderCapsuleStatus(provider, btn) {
  var st = platformStatus(provider) || {};
  var meta = platformMeta(provider);
  var handle = btn.querySelector('.login-provider-sort-handle');
  if (!handle) {
    handle = document.createElement('span');
    handle.className = 'login-provider-sort-handle';
    handle.innerHTML = '<i></i><i></i><i></i>';
    btn.insertBefore(handle, btn.firstChild);
  }
  handle.setAttribute('data-login-provider-sort', provider);
  handle.setAttribute('title', 'Drag to sort');
  handle.setAttribute('aria-label', 'Drag to sort');
  var logo = btn.querySelector('.provider-logo');
  if (logo) {
    if (st.loggedIn) {
      logo.classList.add('has-avatar');
      logo.innerHTML = '<img src="' + providerAvatarSrc(provider, st) + '" alt="">';
    } else {
      logo.classList.remove('has-avatar');
      logo.textContent = meta.short;
    }
  }
  var badge = btn.querySelector('.login-provider-state-badge');
  if (!badge) {
    badge = document.createElement('span');
    badge.className = 'login-provider-state-badge';
    btn.appendChild(badge);
  }
  var externalSwitch = btn.querySelector('.login-provider-external-switch');
  if (!externalSwitch) {
    externalSwitch = document.createElement('span');
    externalSwitch.className = 'login-provider-external-switch';
    btn.appendChild(externalSwitch);
  }
  externalSwitch.removeAttribute('aria-hidden');
  externalSwitch.setAttribute('role', 'switch');
  externalSwitch.setAttribute('tabindex', '0');
  externalSwitch.setAttribute('data-login-provider-external', provider);
  externalSwitch.setAttribute('aria-label', 'Show in top-right account pill');
  externalSwitch.setAttribute('aria-checked', isAccountProviderExternallyVisible(provider) ? 'true' : 'false');
  if (!externalSwitch.querySelector('.login-provider-external-label')) {
    externalSwitch.innerHTML = '<span class="login-provider-external-label">Show</span><i></i>';
  }
  if (!externalSwitch.__loginProviderExternalBound) {
    externalSwitch.__loginProviderExternalBound = true;
    externalSwitch.addEventListener('pointerdown', function (e) {
      e.stopPropagation();
    });
    externalSwitch.addEventListener('click', function (e) {
      handleLoginProviderExternalSwitchEvent(e, externalSwitch.getAttribute('data-login-provider-external') || provider);
    });
    externalSwitch.addEventListener('keydown', function (e) {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      handleLoginProviderExternalSwitchEvent(e, externalSwitch.getAttribute('data-login-provider-external') || provider);
    });
  }
  externalSwitch.title = isAccountProviderExternallyVisible(provider) ? 'Shown in top-right; click to hide' : 'Not shown in top-right; click to show';
  var label = loginProviderVipLabel(provider, st);
  var level = providerVipLevel(provider, st);
  badge.textContent = label;
  badge.className = 'login-provider-state-badge ' + (st.loggedIn ? (level === 'none' ? 'normal' : level) : 'hidden');
}
function bindLoginWorkflowPointerEvents() {
  var graph = document.getElementById('login-node-graph');
  if (!graph || graph._workflowBound) return;
  graph._workflowBound = true;
  graph.addEventListener('pointerdown', function (e) {
    var sortHandle = e.target && e.target.closest ? e.target.closest('[data-login-provider-sort]') : null;
    if (sortHandle && graph.contains(sortHandle)) {
      var sortNode = sortHandle.closest('.login-node-providers [data-login-provider]');
      var sortProvider = sortNode && sortNode.getAttribute('data-login-provider') || sortHandle.getAttribute('data-login-provider-sort') || '';
      if (!sortProvider) return;
      sortProvider = normalizeLoginProviderKey(sortProvider);
      if (sortProvider !== loginProvider) setLoginProvider(sortProvider, true);
      loginProviderPointer = {
        provider: sortProvider,
        node: sortNode,
        startX: e.clientX,
        startY: e.clientY,
        dragging: false
      };
      if (sortNode) sortNode.classList.add('sorting');
      graph.classList.add('sorting-provider');
      loginProviderClickSuppressed = true;
      try { graph.setPointerCapture(e.pointerId); } catch (_) { }
      e.preventDefault();
      e.stopPropagation();
      return;
    }
    var port = e.target && e.target.closest ? e.target.closest('.flow-port.out') : null;
    if (!port || !graph.contains(port)) return;
    var providerNode = port.closest('.login-node-providers [data-login-provider]');
    var provider = port.getAttribute('data-login-provider-output') || (providerNode && providerNode.getAttribute('data-login-provider')) || '';
    if (!provider) return;
    if (provider !== loginProvider) setLoginProvider(provider, true);
    loginProviderClickSuppressed = true;
    startLoginWorkflowPointerDrag(graph, { provider: provider, port: port }, e);
    try { graph.setPointerCapture(e.pointerId); } catch (_) { }
    e.preventDefault();
    e.stopPropagation();
  });
  graph.addEventListener('pointermove', function (e) {
    if (!loginProviderPointer && !loginWorkflowDrag) return;
    e.preventDefault();
    if (loginProviderPointer) {
      var dx = e.clientX - loginProviderPointer.startX;
      var dy = e.clientY - loginProviderPointer.startY;
      var dist = Math.sqrt(dx * dx + dy * dy);
      if (!loginProviderPointer.dragging && dist < 5) return;
      loginProviderPointer.dragging = true;
      if (loginProviderPointer.node) loginProviderPointer.node.classList.add('sorting');
      graph.classList.add('sorting-provider');
      loginProviderClickSuppressed = true;
      var beforeProvider = beforeLoginProviderForPointer(e.clientY);
      if (beforeProvider !== loginProviderPointer.provider && shouldMoveLoginProviderBefore(loginProviderPointer.provider, beforeProvider)) {
        moveAccountProviderBefore(loginProviderPointer.provider, beforeProvider);
        updateLoginProviderUi();
      }
      return;
    }
    if (!loginWorkflowDrag) return;
    var point = workflowPointFromEvent(e, graph);
    graph.classList.toggle('drop-ready', loginWorkflowNearMr(point, graph));
    renderLoginWorkflowEdges(point);
  });
  graph.addEventListener('pointerup', finishLoginProviderPointer);
  graph.addEventListener('pointercancel', function (e) {
    if (loginProviderPointer && loginProviderPointer.node) loginProviderPointer.node.classList.remove('sorting');
    loginProviderPointer = null;
    loginWorkflowDrag = null;
    graph.classList.remove('dragging-line', 'drop-ready', 'sorting-provider');
    try { graph.releasePointerCapture(e.pointerId); } catch (_) { }
    scheduleLoginWorkflowEdges('pointer-cancel');
  });
  if (!bindLoginWorkflowPointerEvents._resizeBound) {
    bindLoginWorkflowPointerEvents._resizeBound = true;
    window.addEventListener('resize', function () { scheduleLoginWorkflowEdges('resize'); });
    window.addEventListener('orientationchange', function () { scheduleLoginWorkflowEdges('orientation'); });
  }
}
function updateLoginNodeGraphUi() {
  var graph = document.getElementById('login-node-graph');
  if (graph) graph.setAttribute('data-provider', loginProvider);
  syncAccountProviderOrderUi();
  var connected = syncLoginWorkflowConnectionsFromStatus();
  loginWorkflowProviderOrder().forEach(function (provider) {
    var btn = document.getElementById('login-provider-' + provider);
    if (!btn) return;
    updateLoginProviderCapsuleStatus(provider, btn);
    btn.classList.toggle('active', provider === loginProvider);
    btn.classList.toggle('external-on', isAccountProviderExternallyVisible(provider));
    btn.classList.toggle('connected', connected.indexOf(provider) >= 0);
    btn.classList.toggle('pending', loginWorkflowPendingProvider === provider && connected.indexOf(provider) < 0);
  });
  var official = document.getElementById('login-mode-official');
  var cookie = document.getElementById('login-mode-cookie');
  var officialText = loginProviderOfficialModeText(loginProvider);
  if (official) {
    var title = official.querySelector('b');
    var sub = official.querySelector('small');
    if (title) title.textContent = officialText.title;
    if (sub) sub.textContent = officialText.sub;
    official.disabled = false;
    official.classList.toggle('active', !isManualCookieOpenForProvider(loginProvider));
  }
  if (cookie) {
    var cookieTitle = cookie.querySelector('b');
    var cookieSub = cookie.querySelector('small');
    if (cookieTitle) cookieTitle.textContent = 'Cookie';
    if (cookieSub) cookieSub.textContent = loginProviderSupportsCookieMode(loginProvider) ? 'Open manual import after connecting' : 'This platform does not support cookie import';
    cookie.disabled = !loginProviderSupportsCookieMode(loginProvider);
    cookie.classList.toggle('active', isManualCookieOpenForProvider(loginProvider));
  }
  var copy = graph && graph.querySelector('.login-node-copy');
  if (copy) {
    var meta = platformMeta(loginProvider);
    var copySub = copy.querySelector('small');
    var connectedCount = connected.length;
    if (copySub) copySub.textContent = hasLoginWorkflowConnection(loginProvider)
      ? ((meta && meta.label || loginProvider) + ' connected / ' + connectedCount + ' total')
      : (loginWorkflowPendingProvider === loginProvider
        ? ((meta && meta.label || loginProvider) + ' awaiting sign-in confirmation')
        : (connectedCount ? (connectedCount + ' connected. Drag an interface in to add more') : 'Drag an interface from the left here'));
  }
  scheduleLoginWorkflowEdges('node-ui');
}
function connectLoginProvider(provider) {
  selectLoginProviderNode(provider);
}
function selectLoginMode(mode) {
  if (mode === 'cookie' && !loginProviderSupportsCookieMode(loginProvider)) {
    showToast('This provider uses official sign-in');
    return;
  }
  // EN-FORK: cookie mode disabled for global providers.
  updateLoginProviderUi();
  setLoginAuthDrawerOpen(hasLoginWorkflowConnection(loginProvider) || loginWorkflowPendingProvider === loginProvider);
}
function startSelectedLoginConnection() {
  if (!hasLoginWorkflowConnection(loginProvider) && loginWorkflowPendingProvider !== loginProvider) {
    showToast('Drag an interface from the left to the MR port first');
    return;
  }
  setLoginAuthDrawerOpen(true);
  connectLoginMode(loginWorkflowActiveMode());
}
function connectLoginMode(mode) {
  setLoginAuthDrawerOpen(true);
  markLoginNodeConnecting();
  // EN-FORK: global providers use official OAuth/connect flow — cookie mode removed.
  setManualCookieOpenForProvider(loginProvider, false);
  updateLoginProviderUi();
  setTimeout(openProviderWebLogin, 120);
}

var pendingCookieExportProvider = '';
function providerCookieExportLabel(provider) {
  provider = normalizeLoginProviderKey(provider);
  var meta = platformMeta(provider);
  return meta && meta.label || (provider === 'spotify' ? 'Spotify' : provider);
}
function offerLoginCookieExport(provider, info) {
  provider = normalizeLoginProviderKey(provider);
  if (!hasPlatformLogin(provider) && !(info && info.loggedIn)) return;
  markLoginWorkflowConnected(provider);
  updateLoginNodeGraphUi();
  pendingCookieExportProvider = provider;
  var label = providerCookieExportLabel(provider);
  var prompt = document.getElementById('cookie-export-prompt');
  var title = document.getElementById('cookie-export-title');
  var desc = document.getElementById('cookie-export-desc');
  if (title) title.textContent = 'Export ' + label + ' login cookie to desktop?';
  if (desc) desc.textContent = 'The file will be saved as "' + label + '_login_cookie.txt" to back up this platform\'s session.';
  if (prompt) prompt.classList.add('show');
}
function dismissCookieExportPrompt() {
  pendingCookieExportProvider = '';
  var prompt = document.getElementById('cookie-export-prompt');
  if (prompt) prompt.classList.remove('show');
}
async function confirmCookieExportPrompt() {
  var provider = pendingCookieExportProvider;
  dismissCookieExportPrompt();
  if (!provider) return;
  var api = window.desktopWindow;
  if (!api || typeof api.exportLoginCookie !== 'function') {
    showToast('Login cookie export requires the desktop app');
    return;
  }
  try {
    var result = await api.exportLoginCookie(provider);
    if (result && result.ok) showToast('Login cookie exported to desktop');
    else showToast((result && (result.message || result.error)) || 'No login cookie to export');
  } catch (e) {
    showToast('Failed to export login cookie');
  }
}

async function showLoginModal(opts) {
  opts = opts || {};
  loginProvider = opts.provider ? normalizeLoginProviderKey(opts.provider) : 'spotify';
  var modal = document.getElementById('login-modal');
  if (typeof setLoginEasterEggMode === 'function' &&
      (!loginEasterEggState || !loginEasterEggState.ready || !loginEasterEggState.unlocked)) {
    setLoginEasterEggMode(true);
  }
  openGsapModal(modal);
  var unlocked = typeof prepareLoginEasterEggGate === 'function'
    ? await prepareLoginEasterEggGate()
    : true;
  if (!unlocked) return;
  resumeLoginModalAfterGate();
}
function resumeLoginModalAfterGate() {
  bindLoginWorkflowPointerEvents();
  setLoginAuthDrawerOpen(false);
  updateLoginProviderUi();
  scheduleLoginWorkflowEdges('open');
}
function closeLoginModal() {
  stopQrPoll();
  setLoginAuthDrawerOpen(false);
  closeGsapModal(document.getElementById('login-modal'));
}
function setLoginProvider(provider, silent) {
  loginProvider = normalizeLoginProviderKey(provider);
  loginRefreshRequestSeq += 1;
  updateLoginProviderUi();
  if (!silent && document.getElementById('login-modal').classList.contains('show')) refreshQr();
}
// What this network can actually reach, refreshable from the modal with one
// request. "Search and play instantly" is what the build wants to say about
// the three global providers, and it is true wherever those providers resolve.
// Where they are DNS-sinkholed it is a lie the user discovers only by typing a
// search that returns nothing, so the modal states the constraint up front: the
// provider needs no account, but this network cannot reach it. The result is
// cached per provider (TTL below) because re-probing on every modal open would
// add three network round-trips to something that changes on router time.
var providerReachabilityCache = {};
var PROVIDER_REACHABILITY_TTL_MS = 5 * 60 * 1000;
function providerReachabilityKey(provider) { return String(provider || ''); }
async function probeProviderReachability(provider) {
  provider = providerReachabilityKey(provider);
  var now = Date.now();
  var hit = providerReachabilityCache[provider];
  if (hit && hit.expiresAt > now) return hit.reachable;
  var reachable = true;
  try {
    var res = await apiJson('/api/' + provider + '/status?t=' + now, { timeoutMs: 8000 });
    // "logged in" is a build-side default; reachability is whether the provider
    // actually answered instead of timing out. A configured:false (soundcloud
    // here) means it answers with no catalogue, which is also usable.
    reachable = !!(res && typeof res === 'object' && !res.error);
  } catch (e) {
    reachable = false;
  }
  providerReachabilityCache[provider] = { reachable: reachable, expiresAt: now + PROVIDER_REACHABILITY_TTL_MS };
  return reachable;
}
function providerReachabilityStatus(provider, overrideReachable) {
  provider = providerReachabilityKey(provider);
  var label = (typeof platformMeta === 'function' && platformMeta(provider).label) || provider;
  var reachable = overrideReachable;
  if (typeof reachable !== 'boolean') {
    var hit = providerReachabilityCache[provider];
    reachable = hit ? hit.reachable : true;
    // A stale "reachable" is worse than a stale "unreachable": re-probe in the
    // background so the next open shows the truth.
    if (!hit) probeProviderReachability(provider).then(function () { try { updateLoginProviderUi(); } catch (e) { } });
  }
  if (reachable) {
    return {
      reachable: true,
      summary: label + ' is ready — no sign-in needed.',
      detail: label + ' — no sign-in needed. Search and play instantly.',
      action: 'No sign-in needed',
    };
  }
  return {
    reachable: false,
    summary: label + ' cannot be reached on this network.',
    detail: label + ' needs no account, but this network cannot reach it — it resolves to a blocked address here. Spotify and Internet Archive work; this provider will answer again on a network where it resolves.',
    action: 'Proxy settings…',
  };
}
function spotifyLoginStatusText(info) {
  info = info || spotifyLoginStatus || {};
  if (info.loggedIn) return 'Spotify connected / ' + (info.product === 'premium' ? 'Premium' : (info.product ? String(info.product).toUpperCase() : 'Plan unknown')) + ' / Syncs playlists and Liked Songs';
  if (info.reauthRequired) return 'Spotify long-term authorization expired. Reconnect official OAuth';
  // The backend reports the concrete reason a valid login still fails —
  // Spotify's own 403 body, for instance. Skipping it here is what made a
  // working login look broken and sent users to reconnect something that
  // already worked.
  if (info.errorMessage) return String(info.errorMessage);
  if (info.stale) return 'Spotify session expired. Reconnect official OAuth';
  if (info.localConfigMissing) return 'Spotify not connected: paste a Client ID, then click "Save & Authorize"';
  if (info.oauthConfigured) return 'Client ID saved. Click "Connect Spotify" to open the official authorization window';
  if (info.configured || info.searchReady) return 'Spotify search available; sign in to sync membership, playlists and Liked Songs';
  var missing = info.oauthMissing && info.oauthMissing.length ? (' Missing: ' + info.oauthMissing.join(', ')) : '';
  return 'Paste a Spotify Client ID and register the callback http://127.0.0.1:43879/callback in Spotify Developer Dashboard' + missing;
}
function parseSpotifyConfigInput(text) {
  text = String(text || '').trim();
  if (!text) return {};
  var parsed = null;
  if (/^\s*\{/.test(text)) {
    try { parsed = JSON.parse(text); } catch (e) { parsed = null; }
  }
  if (parsed && typeof parsed === 'object') {
    var source = parsed.spotify && typeof parsed.spotify === 'object' ? parsed.spotify : parsed;
    return {
      clientId: source.clientId || source.client_id || source.id || '',
      redirectUri: source.redirectUri || source.redirect_uri || source.callbackUrl || source.callback_url || '',
      market: source.market || source.country || '',
      scope: source.scope || source.scopes || ''
    };
  }
  var payload = {};
  var loose = [];
  text.split(/[\r\n;]+/).forEach(function (part) {
    part = String(part || '').trim();
    if (!part) return;
    var pair = part.match(/^([A-Za-z0-9_\-\s]+)\s*[:=]\s*(.+)$/);
    if (!pair) {
      loose.push(part);
      return;
    }
    var key = pair[1].toLowerCase().replace(/[\s_-]+/g, '');
    var value = pair[2].trim();
    if (key === 'clientid' || key === 'spotifyclientid' || key === 'id') payload.clientId = value;
    else if (key === 'redirecturi' || key === 'callbackurl' || key === 'callback') payload.redirectUri = value;
    else if (key === 'market' || key === 'country') payload.market = value;
    else if (key === 'scope' || key === 'scopes') payload.scope = value;
  });
  if (!payload.clientId && loose.length) payload.clientId = loose[0];
  return payload;
}
function openSpotifyDeveloperDashboard() {
  try { window.open(SPOTIFY_DEVELOPER_DASHBOARD_URL, '_blank'); } catch (e) { }
  showToast('Opened the Spotify developer site');
}
async function copySpotifyRedirectUri() {
  var ok = false;
  try {
    var api = window.desktopWindow;
    if (api && typeof api.copyText === 'function') {
      var res = await Promise.resolve(api.copyText(SPOTIFY_REDIRECT_URI));
      ok = !res || res.ok !== false;
    }
  } catch (e) { ok = false; }
  if (!ok && navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
    try {
      await navigator.clipboard.writeText(SPOTIFY_REDIRECT_URI);
      ok = true;
    } catch (e) { ok = false; }
  }
  if (!ok) {
    var helper = document.createElement('textarea');
    helper.value = SPOTIFY_REDIRECT_URI;
    helper.setAttribute('readonly', 'readonly');
    helper.style.position = 'fixed';
    helper.style.left = '-9999px';
    document.body.appendChild(helper);
    helper.select();
    try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
    document.body.removeChild(helper);
  }
  showToast(ok ? 'Spotify callback URL copied' : 'Copy failed. Copy the callback URL manually');
}
// EN-FORK: openQishuiPublicSearch removed — qishui login/search hidden (global providers only).
function updateLoginProviderUi() {
  var isSpotify = loginProvider === 'spotify';
  var title = document.getElementById('login-modal-title');
  var desc = document.getElementById('login-modal-desc');
  var shell = document.getElementById('qr-shell');
  var st = document.getElementById('qr-status');
  var refreshBtn = document.getElementById('refresh-qr-btn');
  var qqPanel = document.getElementById('qq-cookie-panel');
  var qqCookieToggle = document.getElementById('qq-cookie-toggle-btn');
  var qqCookieInput = document.getElementById('qq-cookie-input');
  var qqCookieNote = qqPanel ? qqPanel.querySelector('.qq-cookie-note') : null;
  var qqCard = document.getElementById('qq-web-login-card');
  var qqCookieSaveBtn = document.getElementById('qq-cookie-save-btn');
  var spotifyBtn = document.getElementById('login-provider-spotify');
  var canOpenSpotifyOAuth = !!(window.desktopWindow && typeof window.desktopWindow.openSpotifyMusicLogin === 'function');
  var spotifyBusy = !!(spotifyConfigBusy || spotifyOAuthBusy);
  updateLoginNodeGraphUi();
  if (isSpotify) {
    if (spotifyBtn) spotifyBtn.classList.toggle('active', true);
    if (title) title.textContent = 'Connect Spotify';
    if (desc) desc.innerHTML = canOpenSpotifyOAuth
      ? 'Paste a <b>Spotify Client ID</b>, then save &amp; authorize to sync Premium/Free status, playlists and Liked Songs. Playback still auto-switches to match sources.'
      : 'The desktop authorization bridge is unavailable here; connect Spotify in the Mineradio desktop app.';
    if (shell) { shell.classList.add('web-login-preview'); shell.classList.remove('qq-preview', 'netease-preview'); }
    if (qqPanel) { qqPanel.classList.add('show', 'spotify-guide-panel'); }
    if (qqCookieToggle) qqCookieToggle.classList.remove('show');
    if (qqCookieInput) qqCookieInput.placeholder = spotifyLoginStatus.oauthConfigured
      ? 'Client ID saved; paste a new one to replace it'
      : 'Paste Spotify Client ID';
    if (qqCookieNote) qqCookieNote.innerHTML =
      '<div class="spotify-guide-title">Connect Spotify in 3 steps</div>' +
      '<div class="spotify-guide-steps">' +
        '<span>1. Open the dashboard and create an app</span>' +
        '<span>2. Set the callback to <code>' + SPOTIFY_REDIRECT_URI + '</code></span>' +
        '<span>3. Copy the Client ID and paste it here</span>' +
      '</div>' +
      '<div class="spotify-guide-actions">' +
        '<button type="button" class="spotify-guide-link" onclick="openSpotifyDeveloperDashboard()">Open dashboard</button>' +
        '<button type="button" class="spotify-guide-link" onclick="copySpotifyRedirectUri()">Copy callback</button>' +
        '<button type="button" class="spotify-guide-link" onclick="openAppProxyPanel()">Proxy…</button>' +
        '<span>PKCE needs no Client Secret</span>' +
      '</div>';
    if (qqCookieSaveBtn) {
      qqCookieSaveBtn.disabled = spotifyBusy;
      qqCookieSaveBtn.textContent = spotifyConfigBusy ? 'Saving…' : (spotifyOAuthBusy ? 'Waiting for authorization…' : 'Save & Authorize');
    }
    if (qqCard) {
      qqCard.style.display = '';
      qqCard.disabled = spotifyBusy || !canOpenSpotifyOAuth || !spotifyLoginStatus.oauthConfigured;
      var spCardMark = qqCard.querySelector('b');
      var spCardLabel = qqCard.querySelector('span');
      if (spCardMark) spCardMark.textContent = 'SP';
      if (spCardLabel) spCardLabel.textContent = spotifyOAuthBusy ? 'Waiting for Spotify authorization' : (spotifyLoginStatus.oauthConfigured ? 'Open Spotify authorization' : 'Save Client ID first');
    }
    if (st) { st.className = 'preview'; st.textContent = spotifyLoginStatusText(); }
    if (refreshBtn) {
      refreshBtn.disabled = spotifyBusy || !canOpenSpotifyOAuth;
      refreshBtn.textContent = spotifyConfigBusy ? 'Saving…' : (spotifyOAuthBusy ? 'Waiting for authorization…' : (spotifyLoginStatus.oauthConfigured ? 'Connect Spotify' : 'Save & Authorize'));
      refreshBtn.onclick = spotifyLoginStatus.oauthConfigured ? openSpotifyWebLogin : submitSpotifyConfigLogin;
    }
    updateLoginNodeGraphUi();
    return;
  }
  // EN-FORK: ytmusic/deezer/soundcloud need no sign-in.
  if (loginProvider === 'ytmusic' || loginProvider === 'deezer' || loginProvider === 'soundcloud') {
    if (spotifyBtn) spotifyBtn.classList.toggle('active', false);
    var provMeta = platformMeta(loginProvider);
    // EN-FORK: "no sign-in needed" is true, and it used to be the whole message.
    // That read as "nothing here works" on any network where the provider is
    // unreachable, because the modal never asked whether it could be reached:
    // Deezer, YT Music and SoundCloud report configured:true and loggedIn:true
    // from a hardcoded default and only fail when a search is actually sent.
    // The honest status is the reachability probe — which provider it is, that
    // it needs no account, and whether this network can reach it at all.
    var provStatus = providerReachabilityStatus(loginProvider);
    if (title) title.textContent = provMeta.label || loginProvider;
    if (desc) desc.textContent = provStatus.detail;
    if (shell) { shell.classList.remove('qq-preview', 'netease-preview'); shell.classList.remove('web-login-preview'); }
    if (qqPanel) { qqPanel.classList.remove('show', 'spotify-guide-panel'); }
    if (qqCookieToggle) qqCookieToggle.classList.remove('show');
    if (qqCard) { qqCard.style.display = 'none'; }
    if (st) { st.className = provStatus.reachable ? 'scan' : 'fail'; st.textContent = provStatus.summary; }
    if (refreshBtn) {
      refreshBtn.disabled = !provStatus.reachable;
      refreshBtn.textContent = provStatus.action;
      // A blocked provider has nothing to retry, so the button becomes the way
      // to find out why rather than a dead control.
      refreshBtn.onclick = provStatus.reachable ? null : function () {
        if (typeof window.openAppProxyPanel === 'function') window.openAppProxyPanel();
        else if (typeof showToast === 'function') showToast('No proxy panel is available in this build');
      };
    }
    if (qqCookieSaveBtn) { qqCookieSaveBtn.disabled = true; qqCookieSaveBtn.textContent = 'No sign-in needed'; }
    updateLoginNodeGraphUi();
    return;
  }
  updateLoginNodeGraphUi();
}
async function refreshQr() {
  stopQrPoll();
  updateLoginProviderUi();
  var refreshProvider = loginProvider;
  var refreshSeq = ++loginRefreshRequestSeq;
  if (loginProvider === 'spotify') {
    qrKey = null;
    var spotifyStatus = document.getElementById('qr-status');
    var spotifyImg = document.getElementById('qr-img');
    if (spotifyImg) spotifyImg.src = '';
    var spotifyInfo = await refreshSpotifyLoginStatus();
    if (!isLoginRefreshCurrent(refreshProvider, refreshSeq)) return;
    updateLoginProviderUi();
    if (spotifyStatus) {
      spotifyStatus.textContent = spotifyLoginStatusText(spotifyInfo);
      spotifyStatus.className = 'preview';
    }
    return;
  }
  // EN-FORK: other global providers (ytmusic/deezer/soundcloud) need no QR sign-in.
}
function startQrPoll() {
  if (qrPollTimer) {
    clearInterval(qrPollTimer);
    clearTimeout(qrPollTimer);
  }
  // EN-FORK: QR polling only used for Spotify; global providers need no QR.
}
function stopQrPoll() {
  if (qrPollTimer) {
    clearInterval(qrPollTimer);
    clearTimeout(qrPollTimer);
    qrPollTimer = null;
  }
}
// EN-FORK: scheduleQishuiQrPoll, pollQishuiQr removed — Chinese providers removed from UI.
function toggleQQCookiePanel() {
  // EN-FORK: cookie panel disabled for global providers.
}
function openProviderWebLogin() {
  if (loginProvider === 'spotify') return openSpotifyWebLogin();
  // EN-FORK: ytmusic/deezer/soundcloud need no web login.
}
async function openSpotifyWebLogin() {
  if (spotifyOAuthBusy) return;
  var statusEl = document.getElementById('qr-status');
  var api = window.desktopWindow;
  if (!api || !api.isDesktop || typeof api.openSpotifyMusicLogin !== 'function') {
    updateLoginProviderUi();
    if (statusEl) { statusEl.textContent = 'The Spotify local authorization bridge is unavailable here. Use the Mineradio desktop app.'; statusEl.className = 'fail'; }
    return;
  }
  if (!spotifyLoginStatus.oauthConfigured && !spotifyLoginStatus.tokenConfigured) {
    var latestStatus = await refreshSpotifyLoginStatus();
    if (!latestStatus.oauthConfigured && !latestStatus.tokenConfigured) {
      updateLoginProviderUi();
      if (statusEl) { statusEl.textContent = 'Paste a Spotify Client ID first, then click "Save & Authorize".'; statusEl.className = 'fail'; }
      return;
    }
  }
  spotifyOAuthBusy = true;
  updateLoginProviderUi();
  if (statusEl) { statusEl.textContent = 'Opening the official Spotify authorization window…'; statusEl.className = 'preview'; }
  var failText = '';
  try {
    var result = await api.openSpotifyMusicLogin();
    if (!result || !result.ok) {
      if (result && result.error === 'SPOTIFY_OAUTH_NOT_CONFIGURED') {
        throw new Error((result.message || 'Save a Spotify Client ID first') + (result.redirectUri ? (' / Callback URL: ' + result.redirectUri) : ''));
      }
      throw new Error((result && (result.message || result.error)) || 'Spotify authorization incomplete');
    }
    if (statusEl) { statusEl.textContent = 'Syncing Spotify account, membership and playlists…'; statusEl.className = 'preview'; }
    var info = await refreshSpotifyLoginStatus();
    if (!info || !info.loggedIn) throw new Error((info && (info.message || info.error)) || 'Spotify session unavailable');
    activeAccountProvider = 'spotify';
    renderUserBtn();
    await refreshUserPlaylists(true);
    loadHomeDiscover(true);
    if (statusEl) { statusEl.textContent = 'Spotify connected'; statusEl.className = 'scan'; }
    offerLoginCookieExport('spotify', info);
    setTimeout(function () {
      closeLoginModal();
      showToast('Spotify connected: ' + (info.nickname || info.userId || ''));
    }, 420);
  } catch (e) {
    failText = e && e.message ? e.message : 'Spotify authorization failed';
    if (statusEl) { statusEl.textContent = failText; statusEl.className = 'fail'; }
  } finally {
    spotifyOAuthBusy = false;
    updateLoginProviderUi();
    if (failText && statusEl) { statusEl.textContent = failText; statusEl.className = 'fail'; }
  }
}
async function submitSpotifyConfigLogin() {
  if (spotifyConfigBusy || spotifyOAuthBusy) return;
  var input = document.getElementById('qq-cookie-input');
  var statusEl = document.getElementById('qr-status');
  var saveBtn = document.getElementById('qq-cookie-save-btn');
  var config = parseSpotifyConfigInput(input ? input.value : '');
  if (!config.clientId && spotifyLoginStatus.oauthConfigured) return openSpotifyWebLogin();
  if (!config.clientId) {
    if (statusEl) { statusEl.textContent = 'Paste a Spotify Client ID first'; statusEl.className = 'fail'; }
    if (input) {
      try { input.focus({ preventScroll: true }); } catch (e) { try { input.focus(); } catch (_) { } }
    }
    return;
  }
  spotifyConfigBusy = true;
  if (saveBtn) saveBtn.classList.add('busy');
  if (statusEl) { statusEl.textContent = 'Saving Spotify Client ID…'; statusEl.className = 'preview'; }
  updateLoginProviderUi();
  var shouldOpenOAuth = false;
  try {
    var info = await apiJson('/api/spotify/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(config)
    });
    if (!info || info.error || info.ok === false) throw new Error((info && (info.message || info.error)) || 'Failed to save Spotify Client ID');
    spotifyLoginStatus = normalizeSpotifyLoginStatus(info);
    if (input) input.value = '';
    if (statusEl) { statusEl.textContent = 'Client ID saved. Opening official authorization…'; statusEl.className = 'preview'; }
    shouldOpenOAuth = true;
  } catch (e) {
    if (statusEl) { statusEl.textContent = e && e.message ? e.message : 'Failed to save Spotify Client ID'; statusEl.className = 'fail'; }
  } finally {
    spotifyConfigBusy = false;
    if (saveBtn) saveBtn.classList.remove('busy');
    updateLoginProviderUi();
  }
  if (shouldOpenOAuth) await openSpotifyWebLogin();
}
// EN-FORK: openNeteaseWebLogin, openQQWebLogin, openKugouWebLogin, openQishuiWebLogin,
// submitQQCookieLogin, submitNeteaseCookieLogin, checkQr, pollQishuiQr, scheduleQishuiQrPoll
// removed — Chinese providers (netease/qq/kugou/qishui) removed from login UI.
// Backends remain for lyric resolvers / hidden search fallback.
