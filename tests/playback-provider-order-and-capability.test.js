const test = require('node:test');
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const appRoot = path.resolve(__dirname, '..');
const fallbackPath = path.join(appRoot, 'public', 'js', 'modules', '05-playback', '11-provider-fallback.js');
const startPath = path.join(appRoot, 'public', 'js', 'modules', '05-playback', '13-playback-start-audio.js');
const loginStatusPath = path.join(appRoot, 'public', 'js', 'modules', '08-account', '02-login-status.js');
const userModalPath = path.join(appRoot, 'public', 'js', 'modules', '08-account', '04-user-modal-logout.js');
const indexHtml = fs.readFileSync(path.join(appRoot, 'public', 'index.html'), 'utf8');
const fallbackText = fs.readFileSync(fallbackPath, 'utf8');
const startText = fs.readFileSync(startPath, 'utf8');
const loginStatusText = fs.readFileSync(loginStatusPath, 'utf8');
const userModalText = fs.readFileSync(userModalPath, 'utf8');
const soundcloudText = fs.readFileSync(path.join(appRoot, 'soundcloud-api.js'), 'utf8');

function namedFunctionSource(text, name) {
  const start = text.indexOf('function ' + name);
  assert.ok(start >= 0, 'expected function ' + name);
  let depth = 0;
  let seenBody = false;
  for (let i = text.indexOf('{', start); i < text.length; i += 1) {
    if (text[i] === '{') { depth += 1; seenBody = true; }
    else if (text[i] === '}') {
      depth -= 1;
      if (seenBody && depth === 0) return text.slice(start, i + 1);
    }
  }
  throw new Error('unbalanced function ' + name);
}

// Loads the playback-order helpers with a stub localStorage so order
// persistence can be exercised the way the account modal drives it.
function loadOrderApi(initial) {
  const store = new Map();
  if (initial) store.set('mineradio-playback-provider-order-v1', JSON.stringify(initial));
  const sandbox = {
    console,
    JSON,
    Object,
    Array,
    // Real implementations, not a no-op: normalizePlaybackProvider maps every
    // unknown key to 'ytmusic', which would mask order bugs.
    normalizePlaybackProvider: (p) => (typeof p === 'string' && p ? p : 'ytmusic'),
    platformStatus: () => ({ loggedIn: true }),
    localStorage: {
      getItem: (k) => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => store.set(k, String(v)),
    },
  };
  vm.createContext(sandbox);
  const code = [
    fallbackText.slice(
      fallbackText.indexOf('var PLAYBACK_STREAM_CAPABILITY'),
      fallbackText.indexOf('function sourceFallbackProviderReady')
    ),
  ].join('\n');
  vm.runInContext(code, sandbox);
  return sandbox;
}

test('SoundCloud progressive transcodings are read from format, not the entry root', () => {
  // The API nests protocol under format.protocol; reading entry.protocol
  // silently rejected every full-length stream.
  // Search on a word boundary before the identifier: a bare "t." substring
  // also matches the tail of "format.".
  const unfixed = soundcloudText.match(/(?:^|[^.\w])[a-z]\.protocol\s*===\s*'progressive'/g) || [];
  assert.deepStrictEqual(unfixed, [], 'every progressive reader must use format.protocol');
  const fixedReads = soundcloudText.match(/format\.protocol\s*===\s*'progressive'/g) || [];
  assert.ok(fixedReads.length >= 3, 'expected all three progressive readers to use format.protocol');
});

test('providers that cannot stream are gated out of playback and sign-in', () => {
  const capability = fallbackText.slice(
    fallbackText.indexOf('var PLAYBACK_STREAM_CAPABILITY'),
    fallbackText.indexOf('function playbackProviderCapability')
  );
  assert.match(capability, /spotify:\s*\{\s*canStream:\s*false/);
  assert.match(capability, /ytmusic:\s*\{\s*canStream:\s*false/);
  assert.match(capability, /soundcloud:\s*\{\s*canStream:\s*true/);
  assert.match(capability, /deezer:\s*\{\s*canStream:\s*true/);

  // A dead provider must never be offered as an automatic fallback source.
  const ready = namedFunctionSource(fallbackText, 'sourceFallbackProviderReady');
  assert.match(ready, /if \(!playbackProviderCanStream\(provider\)\) return false;/);

  // nor may it drag the player into a sign-in window that cannot help.
  const unavailable = namedFunctionSource(fallbackText, 'handlePlaybackUnavailable');
  assert.match(unavailable, /if \(!playbackProviderCanStream\(provider\)\) return;/);
});

test('auth-shaped failures on a non-streaming provider switch source instead of asking for login', () => {
  const category = namedFunctionSource(fallbackText, 'playbackRestrictionCategory');
  const gate = category.indexOf('if (!playbackProviderCanStream(provider)) return \'provider_limited\';');
  assert.ok(gate > 0, 'expected a capability gate in playbackRestrictionCategory');
  // The gate must run before the login_required/vip inference below it.
  assert.ok(gate < category.indexOf('vip_required'), 'capability gate must precede vip/login inference');
  assert.ok(gate < category.indexOf('login_required'), 'capability gate must precede login inference');
});

test('Deezer preview banner explains the preview instead of a missing sign-in', () => {
  const banner = namedFunctionSource(startText, 'playQueueAt');
  assert.match(banner, /Deezer free preview/);
  assert.match(banner, /trialSignInHelps/);
  // The sign-in button only appears when signing in could actually help.
  assert.match(banner, /trialLoginBtn\.style\.display = \(data\.loggedIn \|\| !trialSignInHelps\) \? 'none' : '';/);
});

test('provider sign-in only opens for the four global providers', () => {
  const openLogin = namedFunctionSource(userModalText, 'openProviderLogin');
  assert.match(openLogin, /var supported = provider === 'ytmusic'[\s\S]*provider === 'spotify';/);
  assert.doesNotMatch(openLogin, /: 'spotify'\);/);
  assert.match(openLogin, /if \(!supported\)/);
  assert.match(openLogin, /return;/);
});

test('Spotify playbackKeyReady follows the server capability, not the login', () => {
  const normalize = namedFunctionSource(loginStatusText, 'normalizeSpotifyLoginStatus');
  assert.match(normalize, /playbackKeyReady: !!\(capabilities\.playableUrl\)/);
  assert.doesNotMatch(normalize, /playbackKeyReady: loggedIn/);
});

test('playback provider order persists, normalizes, and moves entries', () => {
  const api = loadOrderApi();
  const defaultOrder = api.playbackProviderOrder();
  // The keyless, proxy-free sources lead: they are the only ones that resolve
  // on a network where the streaming services are DNS-blocked.
  assert.strictEqual(defaultOrder[0], 'archive');
  assert.strictEqual(defaultOrder[1], 'itunes');
  assert.ok(defaultOrder.indexOf('spotify') > 0, 'spotify stays listed so it can be reordered');
  assert.ok(defaultOrder.includes('soundcloud'), 'soundcloud stays in the fallback list');
  assert.strictEqual(new Set(defaultOrder).size, defaultOrder.length, 'no duplicates in default order');

  // Unknown and duplicate entries are dropped; missing ones are appended.
  // vm realms make deepStrictEqual fail on identity, so compare as JSON.
  const normalized = api.normalizePlaybackProviderOrder(['deezer', 'deezer', 'bogus', 'qq']);
  assert.strictEqual(JSON.stringify(normalized.slice(0, 2)), JSON.stringify(['deezer', 'qq']));
  assert.strictEqual(normalized.length, api.PLAYBACK_PROVIDER_ORDER_DEFAULT.length);
  assert.strictEqual(new Set(normalized).size, normalized.length);

  // A stored order survives a reload and drives the fallback walk.
  const stored = api.savePlaybackProviderOrder(['deezer', 'soundcloud']);
  assert.strictEqual(JSON.stringify(api.playbackProviderOrder()), JSON.stringify(stored));
  const reloaded = loadOrderApi(stored);
  assert.strictEqual(JSON.stringify(reloaded.playbackProviderOrder()), JSON.stringify(stored));

  // Moving an entry rewrites the persisted order.
  const before = api.playbackProviderOrder();
  const from = before.indexOf('soundcloud');
  const movedDown = api.movePlaybackProvider('soundcloud', 1);
  assert.strictEqual(movedDown.indexOf('soundcloud'), from + 1, 'move down shifts the entry one slot');
  assert.strictEqual(movedDown.length, before.length);
  assert.strictEqual(JSON.stringify(api.playbackProviderOrder()), JSON.stringify(movedDown));

  const movedUp = api.movePlaybackProvider('soundcloud', -1);
  assert.strictEqual(movedUp.indexOf('soundcloud'), from, 'move up restores the slot');
  assert.strictEqual(JSON.stringify(api.playbackProviderOrder()), JSON.stringify(movedUp));
});

test('the account modal exposes a playback source order section', () => {
  assert.match(indexHtml, /id="playback-source-order"/);
  assert.match(indexHtml, /id="playback-provider-order-list"/);
  assert.match(indexHtml, /Playback sources/);
  assert.match(indexHtml, /onclick="resetPlaybackProviderOrderAndRender\(\)"/);
  const render = namedFunctionSource(fallbackText, 'renderPlaybackProviderOrderList');
  // The rows are built in JS, so the markup only carries the container.
  assert.match(render, /playback-provider-order-list/);
  assert.match(render, /movePlaybackProviderStep/);
  assert.match(render, /playbackProviderCapability/);
  assert.match(fallbackText, /function resetPlaybackProviderOrderAndRender\(\)/);
  // The modal refreshes the rows whenever it opens.
  const showModal = namedFunctionSource(userModalText, 'showUserModal');
  assert.match(showModal, /renderPlaybackProviderOrderList/);
});
