var loginRefreshRequestSeq = 0;
var loginWorkflowDrag = null;
var LOGIN_WORKFLOW_CONNECTION_STORE_KEY = 'mineradio-login-workflow-connections-v1';
var LOGIN_WORKFLOW_PROVIDERS = ['netease', 'qq', 'kugou', 'qishui', 'spotify'];
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

function normalizeLoginProviderKey(provider) {
  return provider === 'qq' ? 'qq' : (provider === 'kugou' ? 'kugou' : (provider === 'qishui' ? 'qishui' : (provider === 'spotify' ? 'spotify' : 'netease')));
}
function loginProviderSupportsCookieMode(provider) {
  provider = normalizeLoginProviderKey(provider);
  return provider !== 'spotify' && provider !== 'qishui';
}
function loginProviderOfficialModeText(provider) {
  provider = normalizeLoginProviderKey(provider);
  if (provider === 'spotify') return { title: 'OAuth', sub: 'Opens the Spotify authorization window' };
  if (provider === 'qishui') return { title: 'QR code', sub: 'Official Douyin app authorization' };
  if (provider === 'kugou') return { title: 'Website', sub: 'Opens the official Kugou window' };
  return { title: 'QR code', sub: 'Opens the official window after connecting' };
}
function setManualCookieOpenForProvider(provider, open) {
  provider = normalizeLoginProviderKey(provider);
  if (provider === 'netease') neteaseManualCookieOpen = !!open;
  else if (provider === 'qq') qqManualCookieOpen = !!open;
  else if (provider === 'kugou') kugouManualCookieOpen = !!open;
  else if (provider === 'qishui') qishuiManualCookieOpen = false;
}
function isManualCookieOpenForProvider(provider) {
  provider = normalizeLoginProviderKey(provider);
  if (provider === 'netease') return !!neteaseManualCookieOpen;
  if (provider === 'qq') return !!qqManualCookieOpen;
  if (provider === 'kugou') return !!kugouManualCookieOpen;
  if (provider === 'qishui') return false;
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
  if (modal) modal.classList.toggle('login-details-open', !!open);
  if (drawer) drawer.classList.toggle('show', !!open);
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
    showToast(loginProvider === 'qishui' ? 'Soda Music only supports official QR sign-in' : 'Spotify uses official OAuth sign-in');
    return;
  }
  setManualCookieOpenForProvider(loginProvider, mode === 'cookie');
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
  if (mode === 'cookie') {
    if (!loginProviderSupportsCookieMode(loginProvider)) {
      showToast(loginProvider === 'qishui' ? 'Soda Music only supports official QR sign-in' : 'Spotify uses official OAuth sign-in');
      return;
    }
    setManualCookieOpenForProvider(loginProvider, true);
    updateLoginProviderUi();
    var input = document.getElementById('qq-cookie-input');
    if (input) setTimeout(function () { try { input.focus({ preventScroll: true }); } catch (e) { input.focus(); } }, 80);
    return;
  }
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
  loginProvider = opts.provider ? normalizeLoginProviderKey(opts.provider) : 'netease';
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
function qishuiPublicSearchReady() {
  return !!(qishuiLoginStatus && (qishuiLoginStatus.searchReady || qishuiLoginStatus.publicCatalog));
}
function qishuiLoginStatusText(info) {
  info = info || qishuiLoginStatus || {};
  if (info.webSession) return 'Soda Music signed in · Syncs likes and playlists, plays with account perks';
  return 'Scan the QR code with the Douyin app and confirm sign-in';
}
function spotifyLoginStatusText(info) {
  info = info || spotifyLoginStatus || {};
  if (info.loggedIn) return 'Spotify connected / ' + (info.product === 'premium' ? 'Premium' : (info.product ? String(info.product).toUpperCase() : 'Plan unknown')) + ' / Syncs playlists and Liked Songs';
  if (info.reauthRequired) return 'Spotify long-term authorization expired. Reconnect official OAuth';
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
function openQishuiPublicSearch() {
  closeLoginModal();
  if (typeof setSearchMode === 'function') setSearchMode('qishui');
  var input = document.getElementById('search-input');
  if (input) {
    setTimeout(function () {
      try { input.focus({ preventScroll: true }); } catch (e) { try { input.focus(); } catch (_) { } }
    }, 60);
  }
  showToast('Soda search switched to match source');
}
function updateLoginProviderUi() {
  var meta = platformMeta(loginProvider);
  var isQQ = loginProvider === 'qq';
  var isKugou = loginProvider === 'kugou';
  var isQishui = loginProvider === 'qishui';
  var isNetease = loginProvider === 'netease';
  var isManualCookieProvider = isNetease || isQQ || isKugou;
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
  var neteaseBtn = document.getElementById('login-provider-netease');
  var qqBtn = document.getElementById('login-provider-qq');
  var kugouBtn = document.getElementById('login-provider-kugou');
  var qishuiBtn = document.getElementById('login-provider-qishui');
  var qqCookieSaveBtn = document.getElementById('qq-cookie-save-btn');
  var canOpenNeteaseWeb = !!(window.desktopWindow && typeof window.desktopWindow.openNeteaseMusicLogin === 'function');
  var canUseQishuiQrLogin = true;
  var qishuiSearchReady = qishuiPublicSearchReady();
  var qishuiBusy = !!(qishuiTokenBusy || qishuiOAuthBusy);
  var isSpotify = loginProvider === 'spotify';
  var spotifyBtn = document.getElementById('login-provider-spotify');
  var canOpenSpotifyOAuth = !!(window.desktopWindow && typeof window.desktopWindow.openSpotifyMusicLogin === 'function');
  var spotifyBusy = !!(spotifyConfigBusy || spotifyOAuthBusy);
  updateLoginNodeGraphUi();
  if (isSpotify) {
    if (neteaseBtn) neteaseBtn.classList.toggle('active', false);
    if (qqBtn) qqBtn.classList.toggle('active', false);
    if (kugouBtn) kugouBtn.classList.toggle('active', false);
    if (qishuiBtn) qishuiBtn.classList.toggle('active', false);
    if (spotifyBtn) spotifyBtn.classList.toggle('active', true);
    if (title) title.textContent = 'Connect Spotify';
    if (desc) desc.innerHTML = canOpenSpotifyOAuth
      ? 'Paste a <b>Spotify Client ID</b>, then save &amp; authorize to sync Premium/Free status, playlists and Liked Songs. Playback still auto-switches to match sources.'
      : 'The desktop authorization bridge is unavailable here; connect Spotify in the Mineradio desktop app.';
    if (shell) {
      shell.classList.add('web-login-preview');
      shell.classList.remove('qq-preview', 'netease-preview');
    }
    if (qqPanel) {
      qqPanel.classList.add('show', 'spotify-guide-panel');
    }
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
    if (st) {
      st.className = 'preview';
      st.textContent = spotifyLoginStatusText();
    }
    if (refreshBtn) {
      refreshBtn.disabled = spotifyBusy || !canOpenSpotifyOAuth;
      refreshBtn.textContent = spotifyConfigBusy ? 'Saving…' : (spotifyOAuthBusy ? 'Waiting for authorization…' : (spotifyLoginStatus.oauthConfigured ? 'Connect Spotify' : 'Save & Authorize'));
      refreshBtn.onclick = spotifyLoginStatus.oauthConfigured ? openSpotifyWebLogin : submitSpotifyConfigLogin;
    }
    updateLoginNodeGraphUi();
    return;
  }
  if (qqPanel) qqPanel.classList.remove('spotify-guide-panel');
  if (spotifyBtn) spotifyBtn.classList.toggle('active', false);
  if (neteaseBtn) neteaseBtn.classList.toggle('active', loginProvider === 'netease');
  if (qqBtn) qqBtn.classList.toggle('active', isQQ);
  if (kugouBtn) kugouBtn.classList.toggle('active', isKugou);
  if (qishuiBtn) qishuiBtn.classList.toggle('active', isQishui);
  if (title) title.textContent = isQishui ? 'Scan to sign in to Soda Music' : ('Scan to sign in - ' + meta.label);
  if (desc) desc.innerHTML = isQQ
    ? 'Open the <b>official QQ Music web login window</b>, scan the code, and your session syncs automatically.'
    : (isKugou
      ? 'Open the <b>official Kugou Music web login window</b> and sign in; your session syncs automatically.'
    : (isQishui
      ? 'Scan the official QR code with the signed-in <b>Douyin app</b> and confirm. Once signed in, likes and playlists sync and playback uses account perks.'
    : (canOpenNeteaseWeb
      ? 'Open the <b>official NetEase Cloud Music web login window</b> and scan, avoiding QR rate limits on the API. Your session syncs automatically.'
      : 'Scan with the <b>NetEase Cloud Music app</b> to sync playlists, liked songs and podcasts.')));
  var manualCookieOpen = isManualCookieOpenForProvider(loginProvider);
  if (shell) {
    var useWebPreview = isQQ || isKugou || (isNetease && (canOpenNeteaseWeb || manualCookieOpen));
    shell.classList.toggle('web-login-preview', useWebPreview);
    shell.classList.toggle('qq-preview', isQQ);
    shell.classList.toggle('netease-preview', isNetease && canOpenNeteaseWeb);
  }
  if (qqPanel) qqPanel.classList.toggle('show', isManualCookieProvider && manualCookieOpen);
  if (qqCookieToggle) {
    qqCookieToggle.classList.toggle('show', isManualCookieProvider);
    qqCookieToggle.textContent = manualCookieOpen ? 'Hide import' : 'Cookie import';
  }
  if (qqCookieInput) qqCookieInput.placeholder = isKugou ? 'KuGoo=...; token=...; userid=...; kg_mid=...' : (isNetease ? 'MUSIC_U=...; __csrf=...' : 'uin=...; qqmusic_key=...; qm_keyst=...');
  if (qqCookieNote) qqCookieNote.textContent = isKugou ? 'Import from a kugou.com login session.' : (isNetease ? 'Import from a music.163.com login session.' : 'Import from a y.qq.com login session.');
  if (qqCookieSaveBtn) qqCookieSaveBtn.textContent = 'Save Cookie';
  if (qqCard) {
    qqCard.style.display = '';
    qqCard.disabled = isQishui ? (qishuiBusy || !canUseQishuiQrLogin) : (isQQ ? !!qqWebLoginBusy : (isKugou ? !!kugouWebLoginBusy : !!neteaseWebLoginBusy));
    var cardMark = qqCard.querySelector('b');
    var cardLabel = qqCard.querySelector('span');
    if (cardMark) cardMark.textContent = isQQ ? 'QQ' : (isKugou ? 'KG' : (isQishui ? 'QS' : 'NE'));
    if (cardLabel) cardLabel.textContent = isQQ
      ? (qqWebLoginBusy ? 'Waiting for scan confirmation' : (qqLoginStatus.loggedIn ? 'Reopen official window to sync membership' : 'Open official scan window'))
      : (isKugou ? (kugouWebLoginBusy ? 'Waiting for sign-in confirmation' : 'Open official login window') : (isQishui ? (qishuiOAuthBusy ? 'Generating QR code' : 'Scan to sign in to Soda') : (neteaseWebLoginBusy ? 'Waiting for scan confirmation' : 'Open official login window')));
  }
  if (st) {
    st.className = isManualCookieProvider ? 'preview' : '';
    st.textContent = isQQ
      ? qqLoginStatusText(qqLoginStatus)
      : (isKugou
        ? (kugouLoginStatus.loggedIn ? ('Kugou Music session saved · ' + (kugouLoginStatus.nickname || '')) : 'Click "Sign in" to open the official Kugou Music window')
        : (isQishui
          ? qishuiLoginStatusText()
        : (canOpenNeteaseWeb ? 'Click "Web sign-in" to open the official NetEase Cloud Music window' : 'Generating QR code…')));
  }
  if (refreshBtn) {
    refreshBtn.disabled = isQishui ? (qishuiBusy || !canUseQishuiQrLogin) : (isQQ ? !!qqWebLoginBusy : (isKugou ? !!kugouWebLoginBusy : !!neteaseWebLoginBusy));
    var qqNeedsAuthRefresh = isQQ && qqLoginStatus.loggedIn && (
      qqLoginStatus.authorizationIncomplete ||
      qqLoginStatus.playbackKeyReady === false
    );
    var qqNeedsMembershipSync = isQQ && typeof qqMembershipNeedsSync === 'function' && qqMembershipNeedsSync(qqLoginStatus);
    refreshBtn.textContent = isQishui ? (qishuiOAuthBusy ? 'Generating…' : 'Refresh QR code') : (isQQ ? (qqWebLoginBusy ? 'Waiting for scan…' : (qqNeedsAuthRefresh ? 'Re-authorize' : (qqNeedsMembershipSync ? 'Sync membership' : (qqLoginStatus.loggedIn ? 'Refresh status' : 'Scan to sign in')))) : (isKugou ? (kugouWebLoginBusy ? 'Waiting for sign-in…' : 'Sign in') : (canOpenNeteaseWeb ? (neteaseWebLoginBusy ? 'Waiting for scan…' : 'Web sign-in') : 'Refresh QR code')));
    refreshBtn.onclick = isQishui ? openQishuiWebLogin : (isQQ ? (qqNeedsAuthRefresh ? openQQWebLogin : (qqLoginStatus.loggedIn ? refreshQr : openQQWebLogin)) : (isKugou ? openKugouWebLogin : (canOpenNeteaseWeb ? openNeteaseWebLogin : refreshQr)));
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
  if (loginProvider === 'qishui') {
    qrKey = null;
    var qishuiStatus = document.getElementById('qr-status');
    var qishuiImg = document.getElementById('qr-img');
    if (qishuiImg) qishuiImg.src = '';
    qishuiOAuthBusy = true;
    updateLoginProviderUi();
    try {
      var qishuiQr = await apiJson('/api/qishui/login/qrcode?t=' + Date.now());
      if (!isLoginRefreshCurrent(refreshProvider, refreshSeq)) return;
      if (!qishuiQr || !qishuiQr.token || !qishuiQr.qrcode) {
        throw new Error((qishuiQr && (qishuiQr.message || qishuiQr.error)) || 'Failed to generate Soda Music QR code');
      }
      qrKey = qishuiQr.token;
      if (qishuiImg) {
        qishuiImg.src = qishuiQr.qrcode;
        qishuiImg.alt = 'Soda Music sign-in QR code';
      }
      if (qishuiStatus) {
        qishuiStatus.textContent = 'Scan with the Douyin app and confirm sign-in';
        qishuiStatus.className = '';
      }
      startQrPoll();
    } catch (e) {
      if (!isLoginRefreshCurrent(refreshProvider, refreshSeq)) return;
      if (qishuiStatus) {
        qishuiStatus.textContent = 'Error: ' + (e && e.message ? e.message : e);
        qishuiStatus.className = 'fail';
      }
    } finally {
      qishuiOAuthBusy = false;
      if (isLoginRefreshCurrent(refreshProvider, refreshSeq)) updateLoginProviderUi();
      if (qishuiStatus && qrKey && isLoginRefreshCurrent(refreshProvider, refreshSeq)) {
        qishuiStatus.textContent = 'Scan with the Douyin app and confirm sign-in';
        qishuiStatus.className = '';
      }
    }
    return;
  }
  if (loginProvider === 'qq') {
    qrKey = null;
    var qqStatus = document.getElementById('qr-status');
    var qqImg = document.getElementById('qr-img');
    if (qqImg) qqImg.src = '';
    var info = await refreshQQVipStatusNow('login-panel');
    if (!isLoginRefreshCurrent(refreshProvider, refreshSeq)) return;
    if (qqStatus) {
      qqStatus.textContent = qqLoginStatusText(info);
      qqStatus.className = 'preview';
    }
    return;
  }
  if (loginProvider === 'kugou') {
    qrKey = null;
    var kugouStatus = document.getElementById('qr-status');
    var kugouImg = document.getElementById('qr-img');
    if (kugouImg) kugouImg.src = '';
    var kugouInfo = await refreshKugouLoginStatus();
    if (!isLoginRefreshCurrent(refreshProvider, refreshSeq)) return;
    if (kugouStatus) {
      kugouStatus.textContent = kugouInfo && kugouInfo.loggedIn ? ('Kugou Music session saved · ' + (kugouInfo.nickname || '')) : 'Click "Sign in" to open the official Kugou Music window';
      kugouStatus.className = 'preview';
    }
    return;
  }
  if (window.desktopWindow && typeof window.desktopWindow.openNeteaseMusicLogin === 'function') {
    qrKey = null;
    var neImg = document.getElementById('qr-img');
    var neStatus = document.getElementById('qr-status');
    if (neImg) neImg.src = '';
    if (neStatus) {
      neStatus.textContent = loginStatus.loggedIn ? ('NetEase Cloud Music session saved · ' + (loginStatus.nickname || '')) : 'Click "Web sign-in" to open the official NetEase Cloud Music window';
      neStatus.className = 'preview';
    }
    return;
  }
  try {
    var k = await apiJson('/api/login/qr/key');
    if (!isLoginRefreshCurrent(refreshProvider, refreshSeq)) return;
    if (!k.key) throw new Error('Failed to get key');
    qrKey = k.key;
    var q = await apiJson('/api/login/qr/create?key=' + encodeURIComponent(qrKey));
    if (!isLoginRefreshCurrent(refreshProvider, refreshSeq)) return;
    if (!q.img) throw new Error('Failed to generate QR code');
    document.getElementById('qr-img').src = q.img;
    document.getElementById('qr-status').textContent = 'Scan with the NetEase Cloud Music app';
    startQrPoll();
  } catch (e) {
    if (!isLoginRefreshCurrent(refreshProvider, refreshSeq)) return;
    document.getElementById('qr-status').textContent = 'Error: ' + e.message;
    document.getElementById('qr-status').className = 'fail';
  }
}
function startQrPoll() {
  if (qrPollTimer) {
    clearInterval(qrPollTimer);
    clearTimeout(qrPollTimer);
  }
  if (loginProvider === 'qishui') {
    var generation = qishuiQrPollGeneration;
    qrPollTimer = setTimeout(function () { pollQishuiQr(generation); }, 1200);
    return;
  }
  qrPollTimer = setInterval(checkQr, 2000);
}
function stopQrPoll() {
  if (qrPollTimer) {
    clearInterval(qrPollTimer);
    clearTimeout(qrPollTimer);
    qrPollTimer = null;
  }
  qishuiQrPollGeneration += 1;
  qishuiQrPollBusy = false;
}
function scheduleQishuiQrPoll(generation, delay) {
  if (generation !== qishuiQrPollGeneration || loginProvider !== 'qishui' || !qrKey) return;
  if (qrPollTimer) clearTimeout(qrPollTimer);
  qrPollTimer = setTimeout(function () { pollQishuiQr(generation); }, Math.max(1000, Number(delay) || 4500));
}
async function pollQishuiQr(generation) {
  if (generation !== qishuiQrPollGeneration || loginProvider !== 'qishui' || !qrKey || qishuiQrPollBusy) return;
  qishuiQrPollBusy = true;
  var statusEl = document.getElementById('qr-status');
  var nextDelay = 4500;
  try {
    var result = await apiJson('/api/qishui/login/check?token=' + encodeURIComponent(qrKey) + '&t=' + Date.now());
    if (generation !== qishuiQrPollGeneration || loginProvider !== 'qishui') return;
    if (result && result.loggedIn) {
      stopQrPoll();
      qishuiLoginStatus = normalizeQishuiLoginStatus(result);
      activeAccountProvider = 'qishui';
      markLoginWorkflowConnected('qishui');
      renderUserBtn();
      if (statusEl) {
        statusEl.textContent = 'Signed in!';
        statusEl.className = 'scan';
      }
      await refreshUserPlaylists(true);
      loadHomeDiscover(true);
      setTimeout(function () {
        closeLoginModal();
        showToast('Soda Music signed in: ' + (qishuiLoginStatus.nickname || qishuiLoginStatus.userId || ''));
      }, 450);
      return;
    }
    var code = Number(result && (result.errorCode || result.error_code) || 0);
    var qrStatus = String(result && result.status || 'waiting');
    if (code === 2 || qrStatus === 'expired') {
      stopQrPoll();
      if (statusEl) {
        statusEl.textContent = 'QR code expired. Refresh it';
        statusEl.className = 'fail';
      }
      return;
    }
    if (code === 7 || qrStatus === 'rate_limited') {
      nextDelay = Number(result && result.retryAfterMs) || 60000;
      if (statusEl) {
        statusEl.textContent = 'Requests are frequent; retrying automatically shortly…';
        statusEl.className = 'preview';
      }
    } else if (qrStatus === 'mfa_cancelled') {
      stopQrPoll();
      if (statusEl) {
        statusEl.textContent = 'Two-step verification cancelled. Refresh the QR code and try again';
        statusEl.className = 'fail';
      }
      return;
    } else if (statusEl) {
      statusEl.textContent = qrStatus === 'scanned' || qrStatus === '2'
        ? 'Scanned. Confirm on your phone…'
        : 'Waiting for scan confirmation…';
      statusEl.className = qrStatus === 'scanned' || qrStatus === '2' ? 'scan' : '';
    }
  } catch (e) {
    nextDelay = 8000;
    console.warn('Qishui QR check failed:', e);
    if (statusEl) {
      statusEl.textContent = 'Sign-in check failed; retrying…';
      statusEl.className = 'fail';
    }
  } finally {
    qishuiQrPollBusy = false;
    scheduleQishuiQrPoll(generation, nextDelay);
  }
}
function toggleQQCookiePanel() {
  if (loginProvider === 'spotify') return;
  setManualCookieOpenForProvider(loginProvider, !isManualCookieOpenForProvider(loginProvider));
  updateLoginProviderUi();
}
function openProviderWebLogin() {
  if (loginProvider === 'qq') return openQQWebLogin();
  if (loginProvider === 'kugou') return openKugouWebLogin();
  if (loginProvider === 'qishui') return openQishuiWebLogin();
  if (loginProvider === 'spotify') return openSpotifyWebLogin();
  return openNeteaseWebLogin();
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
async function openNeteaseWebLogin() {
  if (neteaseWebLoginBusy) return;
  var statusEl = document.getElementById('qr-status');
  var api = window.desktopWindow;
  if (!api || !api.isDesktop || typeof api.openNeteaseMusicLogin !== 'function') {
    if (statusEl) { statusEl.textContent = 'Official web sign-in unavailable here. Trying the legacy QR code…'; statusEl.className = 'fail'; }
    return refreshQr();
  }

  neteaseWebLoginBusy = true;
  updateLoginProviderUi();
  if (statusEl) { statusEl.textContent = 'NetEase Cloud Music window opened. Scan and sign in on the official page…'; statusEl.className = 'preview'; }
  try {
    var result = await api.openNeteaseMusicLogin();
    if (!result || !result.ok || !result.cookie) {
      throw new Error((result && (result.message || result.error)) || 'NetEase Cloud Music sign-in incomplete');
    }
    if (statusEl) { statusEl.textContent = 'Syncing NetEase Cloud Music session…'; statusEl.className = 'preview'; }
    var info = await apiJson('/api/login/cookie', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cookie: result.cookie })
    });
    if (!info || !info.loggedIn) throw new Error((info && (info.message || info.error)) || 'NetEase Cloud Music session unavailable');
    loginStatus = info;
    activeAccountProvider = 'netease';
    renderUserBtn();
    refreshUserPlaylists(true);
    loadHomeDiscover(true);
    if (statusEl) { statusEl.textContent = 'NetEase Cloud Music session saved'; statusEl.className = 'scan'; }
    offerLoginCookieExport('netease', info);
    setTimeout(function () {
      closeLoginModal();
      showToast('NetEase Cloud Music signed in: ' + (info.nickname || info.userId || ''));
    }, 420);
  } catch (e) {
    neteaseWebLoginBusy = false;
    updateLoginProviderUi();
    if (statusEl) { statusEl.textContent = e && e.message ? e.message : 'NetEase Cloud Music sign-in failed'; statusEl.className = 'fail'; }
  } finally {
    if (neteaseWebLoginBusy) {
      neteaseWebLoginBusy = false;
      updateLoginProviderUi();
    }
  }
}
async function openQQWebLogin() {
  if (qqWebLoginBusy) return;
  var statusEl = document.getElementById('qr-status');
  var api = window.desktopWindow;
  if (!api || !api.isDesktop || typeof api.openQQMusicLogin !== 'function') {
    qqManualCookieOpen = true;
    updateLoginProviderUi();
    if (statusEl) { statusEl.textContent = 'Automatic web sign-in is unavailable here. Use manual import instead.'; statusEl.className = 'fail'; }
    return;
  }

  qqWebLoginBusy = true;
  updateLoginProviderUi();
  if (statusEl) { statusEl.textContent = 'QQ Music window opened. Scan and confirm to sign in…'; statusEl.className = 'preview'; }
  try {
    var result = await api.openQQMusicLogin({
      forceReauth: !!(qqLoginStatus && qqLoginStatus.authorizationIncomplete && qqLoginStatus.playbackKeyReady === false)
    });
    if (!result || !result.ok || !result.cookie) {
      throw new Error((result && (result.message || result.error)) || 'QQ sign-in incomplete');
    }
    if (statusEl) { statusEl.textContent = 'Syncing QQ Music session…'; statusEl.className = 'preview'; }
    var info = await apiJson('/api/qq/login/cookie', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cookie: result.cookie })
    });
    if (!info || !info.loggedIn) throw new Error((info && (info.message || info.error)) || 'QQ session unavailable');
    qqLoginStatus = normalizeQQLoginStatus(info);
    auditProviderVipState('qq', qqLoginStatus);
    activeAccountProvider = 'qq';
    qqManualCookieOpen = false;
    renderUserBtn();
    refreshUserPlaylists(true);
    offerLoginCookieExport('qq', info);
    var qqPlaybackReady = !!info.playbackKeyReady && !result.partial;
    if (!qqPlaybackReady) {
      if (statusEl) { statusEl.textContent = 'QQ account synced, but playback authorization is incomplete. Reopen QQ Music sign-in and wait until the player page loads before closing the window.'; statusEl.className = 'preview'; }
      showToast('QQ account synced; playback authorization incomplete');
      return;
    }
    if (statusEl) { statusEl.textContent = qqPlaybackReady ? qqLoginStatusText(qqLoginStatus) : 'QQ account synced; playback authorization incomplete. Some songs will auto-switch sources'; statusEl.className = 'scan'; }
    setTimeout(function () {
      closeLoginModal();
      showToast((qqPlaybackReady ? 'QQ Music signed in: ' : 'QQ account synced: ') + (info.nickname || info.userId || ''));
    }, 420);
  } catch (e) {
    qqWebLoginBusy = false;
    updateLoginProviderUi();
    if (statusEl) { statusEl.textContent = e && e.message ? e.message : 'QQ sign-in failed'; statusEl.className = 'fail'; }
  } finally {
    if (qqWebLoginBusy) {
      qqWebLoginBusy = false;
      updateLoginProviderUi();
    }
  }
}
async function openKugouWebLogin() {
  if (kugouWebLoginBusy) return;
  var statusEl = document.getElementById('qr-status');
  var api = window.desktopWindow;
  if (!api || !api.isDesktop || typeof api.openKugouMusicLogin !== 'function') {
    kugouManualCookieOpen = true;
    updateLoginProviderUi();
    if (statusEl) { statusEl.textContent = 'Automatic web sign-in is unavailable here. Use manual import instead.'; statusEl.className = 'fail'; }
    return;
  }

  kugouWebLoginBusy = true;
  updateLoginProviderUi();
  if (statusEl) { statusEl.textContent = 'Kugou Music window opened. Complete the official sign-in…'; statusEl.className = 'preview'; }
  try {
    var result = await api.openKugouMusicLogin();
    if (!result || !result.ok || !result.cookie) {
      throw new Error((result && (result.message || result.error)) || 'Kugou sign-in incomplete');
    }
    if (statusEl) { statusEl.textContent = 'Syncing Kugou Music session…'; statusEl.className = 'preview'; }
    var info = await apiJson('/api/kugou/login/cookie', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cookie: result.cookie })
    });
    if (!info || !info.loggedIn) throw new Error((info && (info.message || info.error)) || 'Kugou session unavailable');
    kugouLoginStatus = normalizeKugouLoginStatus(info);
    activeAccountProvider = 'kugou';
    kugouManualCookieOpen = false;
    renderUserBtn();
    refreshUserPlaylists(true);
    offerLoginCookieExport('kugou', info);
    var ready = !!info.playbackKeyReady && !result.partial;
    if (statusEl) { statusEl.textContent = ready ? 'Kugou Music session saved' : 'Kugou account synced; playback authorization incomplete. Some songs may need re-signing'; statusEl.className = 'scan'; }
    setTimeout(function () {
      closeLoginModal();
      showToast((ready ? 'Kugou Music signed in: ' : 'Kugou account synced: ') + (info.nickname || info.userId || ''));
    }, 420);
  } catch (e) {
    kugouWebLoginBusy = false;
    updateLoginProviderUi();
    if (statusEl) { statusEl.textContent = e && e.message ? e.message : 'Kugou sign-in failed'; statusEl.className = 'fail'; }
  } finally {
    if (kugouWebLoginBusy) {
      kugouWebLoginBusy = false;
      updateLoginProviderUi();
    }
  }
}
async function openQishuiWebLogin() {
  if (qishuiTokenBusy || qishuiOAuthBusy) return;
  return refreshQr();
}
async function submitQQCookieLogin() {
  if (loginProvider === 'spotify') return submitSpotifyConfigLogin();
  if (loginProvider === 'qishui') return openQishuiWebLogin();
  if (loginProvider === 'netease') return submitNeteaseCookieLogin();
  var isKugou = loginProvider === 'kugou';
  if (isKugou ? kugouCookieBusy : qqCookieBusy) return;
  var input = document.getElementById('qq-cookie-input');
  var statusEl = document.getElementById('qr-status');
  var saveBtn = document.getElementById('qq-cookie-save-btn');
  var cookie = input ? input.value.trim() : '';
  if (!cookie) {
    if (statusEl) { statusEl.textContent = isKugou ? 'Paste a Kugou Music cookie first' : 'Paste a QQ Music cookie first'; statusEl.className = 'fail'; }
    return;
  }
  if (isKugou) kugouCookieBusy = true;
  else qqCookieBusy = true;
  if (saveBtn) saveBtn.classList.add('busy');
  if (statusEl) { statusEl.textContent = isKugou ? 'Saving Kugou session…' : 'Saving QQ session…'; statusEl.className = 'preview'; }
  try {
    var info = await apiJson(isKugou ? '/api/kugou/login/cookie' : '/api/qq/login/cookie', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cookie: cookie })
    });
    if (!info || !info.loggedIn) throw new Error((info && (info.message || info.error)) || (isKugou ? 'Kugou session unavailable' : 'QQ session unavailable'));
    if (isKugou) kugouLoginStatus = normalizeKugouLoginStatus(info);
    else {
      qqLoginStatus = normalizeQQLoginStatus(info);
      auditProviderVipState('qq', qqLoginStatus);
    }
    activeAccountProvider = isKugou ? 'kugou' : 'qq';
    if (input) input.value = '';
    renderUserBtn();
    refreshUserPlaylists(true);
    var manualPlaybackReady = !!info.playbackKeyReady;
    if (statusEl) { statusEl.textContent = manualPlaybackReady ? (isKugou ? 'Kugou Music session saved' : qqLoginStatusText(qqLoginStatus)) : (isKugou ? 'Kugou account synced; playback authorization incomplete. Some songs may need re-signing' : 'QQ account synced; playback authorization incomplete. Some songs will auto-switch sources'); statusEl.className = 'scan'; }
    setManualCookieOpenForProvider(activeAccountProvider, false);
    offerLoginCookieExport(activeAccountProvider, info);
    setTimeout(function () {
      closeLoginModal();
      showToast((manualPlaybackReady ? (isKugou ? 'Kugou Music signed in: ' : 'QQ Music signed in: ') : (isKugou ? 'Kugou account synced: ' : 'QQ account synced: ')) + (info.nickname || info.userId || ''));
    }, 420);
  } catch (e) {
    if (statusEl) { statusEl.textContent = e && e.message ? e.message : (isKugou ? 'Failed to save Kugou session' : 'Failed to save QQ session'); statusEl.className = 'fail'; }
  } finally {
    if (isKugou) kugouCookieBusy = false;
    else qqCookieBusy = false;
    if (saveBtn) saveBtn.classList.remove('busy');
  }
}

async function submitNeteaseCookieLogin() {
  if (qqCookieBusy) return;
  var input = document.getElementById('qq-cookie-input');
  var statusEl = document.getElementById('qr-status');
  var saveBtn = document.getElementById('qq-cookie-save-btn');
  var cookie = input ? input.value.trim() : '';
  if (!cookie) {
    if (statusEl) { statusEl.textContent = 'Paste a NetEase Cloud Music MUSIC_U cookie first'; statusEl.className = 'fail'; }
    return;
  }
  qqCookieBusy = true;
  if (saveBtn) saveBtn.classList.add('busy');
  if (statusEl) { statusEl.textContent = 'Saving NetEase Cloud Music session…'; statusEl.className = 'preview'; }
  try {
    var info = await apiJson('/api/login/cookie', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cookie: cookie })
    });
    if (!info || !info.loggedIn) throw new Error((info && (info.message || info.error)) || 'NetEase Cloud Music session unavailable');
    loginStatus = info;
    activeAccountProvider = 'netease';
    neteaseManualCookieOpen = false;
    if (input) input.value = '';
    renderUserBtn();
    refreshUserPlaylists(true);
    loadHomeDiscover(true);
    if (statusEl) { statusEl.textContent = 'NetEase Cloud Music session saved'; statusEl.className = 'scan'; }
    offerLoginCookieExport('netease', info);
    setTimeout(function () {
      closeLoginModal();
      showToast('NetEase Cloud Music signed in: ' + (info.nickname || info.userId || ''));
    }, 420);
  } catch (e) {
    if (statusEl) { statusEl.textContent = e && e.message ? e.message : 'Failed to save NetEase Cloud Music session'; statusEl.className = 'fail'; }
  } finally {
    qqCookieBusy = false;
    if (saveBtn) saveBtn.classList.remove('busy');
    updateLoginProviderUi();
  }
}
async function checkQr() {
  if (!qrKey) return;
  try {
    var r = await apiJson('/api/login/qr/check?key=' + encodeURIComponent(qrKey));
    var $st = document.getElementById('qr-status');
    if (r.code === 800) { $st.textContent = 'QR code expired. Please refresh'; $st.className = 'fail'; stopQrPoll(); }
    else if (r.code === 801) { $st.textContent = 'Scan the code in the app'; $st.className = ''; }
    else if (r.code === 802) { $st.textContent = 'Scanned. Confirm on your phone…'; $st.className = 'scan'; }
    else if (r.code === 803 && (r.loggedIn || r.hasCookie)) {
      $st.textContent = r.pendingProfile ? 'Signed in. Syncing account profile…' : 'Signed in!'; $st.className = 'scan';
      stopQrPoll();
      loginStatus = r.loggedIn ? r : Object.assign({}, r, { loggedIn: true, pendingProfile: true, nickname: r.nickname || 'NetEase user' });
      activeAccountProvider = 'netease';
      renderUserBtn();
      setTimeout(async function () {
        var fresh = await refreshLoginStatus(true);
        if (!fresh || !fresh.loggedIn) {
          loginStatus = Object.assign({}, loginStatus, { loggedIn: true, pendingProfile: true });
          renderUserBtn();
          fresh = loginStatus;
        }
        closeLoginModal();
        offerLoginCookieExport('netease', fresh);
        showToast('Welcome ' + (fresh && fresh.nickname ? fresh.nickname : ''));
      }, r.pendingProfile ? 1200 : 500);
    } else if (r.code === 803) {
      $st.textContent = 'Scan confirmed but no login credential received. Refresh the QR code and retry'; $st.className = 'fail';
      stopQrPoll();
    }
  } catch (e) { console.warn(e); }
}
