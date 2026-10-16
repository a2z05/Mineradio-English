const test = require('node:test');
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const appRoot = path.resolve(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(appRoot, p), 'utf8');

const ytmusic = require(path.join(appRoot, 'ytmusic-api.js'));

const indexHtml = read('public/index.html');
const flows = read('public/js/modules/08-account/03-login-modal-flows.js');
const utils = read('public/js/modules/08-account/01-login-modal-utils.js');
const coreStores = read('public/js/modules/00-state/00-core-stores.js');
const serverText = read('server.js');
const startupBindings = read('public/js/modules/10-shell/05-startup-bindings.js');
const homeEmpty = read('public/js/modules/05-playback/04-home-empty-wallpaper.js');

// Extracts a named function body so a behaviour can be asserted without
// standing up the whole renderer.
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

test('no login control calls a handler that does not exist', () => {
  // The Save button in the session panel used to call submitQQCookieLogin(),
  // deleted with the Chinese providers — a clickable button that threw. This
  // checks every inline login-surface handler against the whole renderer, so
  // the same class of dead reference cannot come back unnoticed.
  const moduleDir = path.join(appRoot, 'public', 'js');
  const allSource = (function walk(dir) {
    let out = '';
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) out += walk(full);
      else if (entry.name.endsWith('.js')) out += fs.readFileSync(full, 'utf8');
    }
    return out;
  })(moduleDir);

  const loginHtml = indexHtml.slice(indexHtml.indexOf('id="login-modal"'), indexHtml.indexOf('id="audio-output-workflow-modal"'));
  const inlineHandlers = (loginHtml.match(/onclick="([A-Za-z_$][\w$]*)\(/g) || [])
    .map((m) => m.replace(/onclick="/, '').replace(/\($/, ''));
  assert.ok(inlineHandlers.length > 0, 'expected inline handlers on the login surfaces');
  for (const name of new Set(inlineHandlers)) {
    const definedSomewhere = new RegExp('(function\\s+' + name + '\\b)|(window\\.' + name + '\\s*=)|(\\b' + name + '\\s*=\\s*function)')
      .test(allSource);
    assert.ok(definedSomewhere, 'login onclick handler ' + name + '() is not defined anywhere');
  }
  // The specific dead reference must stay gone.
  assert.ok(!indexHtml.includes('submitQQCookieLogin'), 'the dead QQ handler reference must be removed');
});

test('the session panel describes YouTube Music, not QQ', () => {
  const panel = indexHtml.slice(indexHtml.indexOf('id="qq-cookie-panel"'));
  const block = panel.slice(0, 900);
  assert.ok(!/uin=\.\.\./.test(block), 'the QQ cookie placeholder must be gone');
  assert.ok(/youtube/i.test(block), 'the panel must name the provider it actually serves');
  assert.ok(block.includes('submitProviderSessionImport'), 'the Save button must call the live handler');
  // The save button is disabled for a provider with no session to import.
  assert.ok(flows.includes('qqCookieSaveBtn.textContent = \'Save session\''), 'the button label follows the provider');
});

test('a provider with no account never reports one', () => {
  // Deezer and SoundCloud ship with loggedIn:true in the state store, which the
  // account modal rendered as a signed-in account nobody had created.
  for (const provider of ['ytmusic', 'deezer', 'soundcloud']) {
    const match = coreStores.match(new RegExp('var ' + provider + 'Status = \\{([^}]*)\\}'));
    assert.ok(match, 'expected a ' + provider + ' status default');
    assert.ok(/loggedIn:\s*false/.test(match[1]), provider + ' must not claim a login it does not have');
    // Being usable without an account is a separate, and true, claim.
    assert.ok(/keylessReady:\s*true/.test(match[1]), provider + ' needs a keyless-usable flag');
  }
});

test('the account status is a real probe, not a hardcoded default', () => {
  const caps = ytmusic.getYtMusicCapabilities();
  assert.strictEqual(caps.loggedIn, false, 'no cookie stored means not signed in');
  assert.ok(!/loggedIn:\s*true/.test(JSON.stringify(caps)), 'capabilities must not hardcode a login');

  // A stored cookie is not a login on its own; only the account endpoint can
  // say so. Guard the shape of that contract.
  const source = read('ytmusic-api.js');
  assert.ok(source.includes('account/account_menu'), 'the account endpoint is what verifies the cookie');
  assert.ok(source.includes('function checkAccountCookie'), 'a verification function must exist');
  const body = namedFunctionSource(source, 'checkAccountCookie');
  assert.ok(body.includes('walkJson'), 'the channel name is read out of the account response');
  assert.ok(/loggedIn:\s*!!name/.test(body), 'signed in only when an account name came back');
});

test('a cookie for the wrong site is refused, and the missing names are reported', () => {
  const junk = ytmusic.setYtMusicAuthCookie('tracking=1; prefs=en');
  assert.strictEqual(junk.accepted, false, 'an unrelated cookie is not a session');
  assert.ok(junk.missing.length > 0, 'the caller is told which cookie names are absent');
  assert.strictEqual(ytmusic.getYtMusicCapabilities().loggedIn, false);

  // A partial auth cookie (SID with no SAPISID) cannot sign an InnerTube call.
  assert.strictEqual(ytmusic.setYtMusicAuthCookie('SID=only').accepted, false, 'SID alone is not enough');

  // The forms a user actually copies: a raw header, and a JSON export.
  assert.strictEqual(ytmusic.setYtMusicAuthCookie('SID=a; SAPISID=b').accepted, true, 'a raw header is accepted');
  assert.strictEqual(
    ytmusic.setYtMusicAuthCookie(JSON.stringify({ cookies: [{ name: 'SID', value: 'x' }, { name: 'SAPISID', value: 'y' }] })).accepted,
    true,
    'a JSON cookie export is accepted'
  );
  assert.strictEqual(ytmusic.setYtMusicAuthCookie('__Secure-3PSID=z').accepted, true, 'the secure cookie alone is accepted');

  // Clearing must not leave a stale account behind.
  ytmusic.clearYtMusicAuthCookie();
  assert.strictEqual(ytmusic.getYtMusicCapabilities().loggedIn, false);
});

test('the YouTube Music auth routes exist and verify rather than assume', () => {
  for (const route of ['/api/ytmusic/auth/status', '/api/ytmusic/auth/cookie', '/api/ytmusic/auth/clear']) {
    assert.ok(serverText.includes(`pn === '${route}'`), 'missing auth route ' + route);
  }
  const cookieRoute = serverText.slice(serverText.indexOf("pn === '/api/ytmusic/auth/cookie'")).slice(0, 2000);
  // Saving a cookie must return what YouTube said, not what was hoped.
  assert.ok(cookieRoute.includes('checkAccountCookie'), 'the save must verify the cookie');
  assert.ok(cookieRoute.includes('INCOMPLETE_YT_MUSIC_COOKIE'), 'a rejected cookie must be named as such');
  assert.ok(/loggedIn:\s*!!caps\.loggedIn/.test(cookieRoute), 'the reply reports the verified state');
});

test('the modal asks for the real status instead of trusting render-time defaults', () => {
  assert.ok(flows.includes('function refreshYtMusicAuthStatus'), 'the modal needs a status refresh');
  // Opening the modal must trigger the probe, or the page shows stale defaults.
  const resume = namedFunctionSource(flows, 'resumeLoginModalAfterGate');
  assert.ok(resume.includes('refreshYtMusicAuthStatus'), 'opening the modal must check the real session');
  // A network failure must not be presented as a signed-out account.
  const refresh = namedFunctionSource(flows, 'refreshYtMusicAuthStatus');
  assert.ok(refresh.includes('reachable'), 'an unreachable provider is distinguished from a signed-out one');
});

test('Google-blocked embedded sign-in is not faked with a dead window', () => {
  const openWeb = namedFunctionSource(flows, 'openProviderWebLogin');
  assert.ok(openWeb.includes('openYtMusicWebSignIn'), 'YT Music routes to the real-browser path');
  // The honest action opens the user's own browser, where a cookie can be
  // copied from, instead of an Electron window Google will refuse.
  const signIn = namedFunctionSource(flows, 'openYtMusicWebSignIn');
  assert.ok(signIn.includes('music.youtube.com'), 'the real sign-in page is opened');
  assert.ok(signIn.includes('openExternal') || signIn.includes('window.open'), 'it opens outside the app');
  assert.ok(!/loginWindow|BrowserWindow/.test(flows), 'no embedded auth window is pretended');
});

test('being usable without an account is separate from being signed in', () => {
  // The app must render a home feed with no sign-in anywhere. The distinction is
  // what keeps the keyless sources from looking like a logged-out state.
  assert.ok(utils.includes('function hasPlayableSource'), 'a playable-source test must exist');
  assert.ok(utils.includes('function platformKeylessReady'), 'keyless usability is its own predicate');
  const playable = namedFunctionSource(utils, 'hasPlayableSource');
  assert.ok(playable.includes('platformKeylessReady'), 'the keyless providers count as a source');

  // The startup path must load the feed from a source, not from a login.
  assert.ok(startupBindings.includes('hasPlayableSource()'), 'startup must not require a login to load the feed');
  const emptyHome = namedFunctionSource(homeEmpty, 'updateEmptyHomeVisibility');
  assert.ok(emptyHome.includes('hasPlayableSource()'), 'the empty home is judged by sources, not accounts');
});

test('the YouTube Music page only reads state that exists at render time', () => {
  // Two startup crashes found by running the app, not by reading it:
  //
  // 1. The capability accessor was defined in a module that loads AFTER the
  //    search tabs call it, so the whole module chain aborted with
  //    "Cannot read properties of undefined".
  // 2. `spotifyBusy` is a local inside updateLoginProviderUi; the new provider
  //    branch referenced it from other functions, where it is not in scope.
  // The real invariant is ORDER, so assert order: whichever module defines the
  // accessor must appear before every module that calls it in the loader list.
  const loaderOrder = (read('public/js/index-loader.js').match(/'js\/modules\/[^']+\.js'/g) || [])
    .map((s) => s.slice(1, -1));
  assert.ok(loaderOrder.length > 10, 'expected the loader to list its modules');

  const moduleText = new Map(
    loaderOrder.map((rel) => [rel, fs.readFileSync(path.join(appRoot, 'public', rel), 'utf8')])
  );
  const definers = [...moduleText.entries()]
    .filter(([, text]) => /function\s+ytdlpRouteUsableForPlayback\s*\(/.test(text))
    .map(([rel]) => rel);
  assert.strictEqual(definers.length, 1, 'exactly one module must define the accessor, found ' + definers.join(', '));

  const definerIndex = loaderOrder.indexOf(definers[0]);
  const callers = [...moduleText.entries()]
    .filter(([, text]) => /\bytdlpRouteUsableForPlayback\s*\(/.test(text))
    .map(([rel]) => rel)
    .filter((rel) => rel !== definers[0]);
  assert.ok(callers.length > 0, 'something must call the accessor');
  for (const rel of callers) {
    assert.ok(
      loaderOrder.indexOf(rel) > definerIndex,
      rel + ' calls the accessor but loads before its definition in ' + definers[0] +
      ' — that is the startup crash this guards'
    );
  }

  // Every reference to spotifyBusy must be inside the function that declares it.
  const owner = namedFunctionSource(flows, 'updateLoginProviderUi');
  assert.ok(owner.includes('var spotifyBusy'), 'the local is declared in updateLoginProviderUi');
  // Comments are stripped first: prose that names the local is not a reference,
  // and matching prose would make this check pass for the wrong reason.
  const stripComments = (text) => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
  const flowsWithoutOwner = stripComments(flows.replace(owner, ''));
  const strayUses = flowsWithoutOwner.match(/\bspotifyBusy\b/g) || [];
  assert.strictEqual(
    strayUses.length,
    0,
    'spotifyBusy is a local and must not be referenced outside its function (found ' + strayUses.length + ')'
  );
  assert.ok(flows.includes('function providerBusy()'), 'a module-scope accessor must exist for other callers');
});

test('an import result is not erased by the re-render that follows it', () => {
  // Running it showed the specific answer ("not a YouTube cookie" / "saved but
  // unconfirmed") written to the status line and then immediately overwritten
  // by refreshYtMusicAuthStatus, leaving the user with no explanation.
  assert.ok(flows.includes('lastImport'), 'the import outcome must be remembered across the refresh');
  const renderer = flows.slice(flows.indexOf("if (loginProvider === 'ytmusic')"));
  assert.ok(
    /lastImport[\s\S]{0,400}?st\.textContent/.test(flows),
    'the stored outcome must take precedence over the generic status line'
  );
  const refresh = namedFunctionSource(flows, 'refreshYtMusicAuthStatus');
  assert.ok(refresh.includes('lastImport'), 'the refresh must carry the outcome forward rather than drop it');
  // A confirmed login supersedes it, and reopening the modal clears it.
  assert.ok(/lastImport:\s*verified\s*\?\s*null/.test(refresh), 'a verified login clears the stale outcome');
  const resume = namedFunctionSource(flows, 'resumeLoginModalAfterGate');
  assert.ok(resume.includes('lastImport = null'), 'reopening the modal drops the previous outcome');
});

test('the account helper keeps meaning "a signed-in account"', () => {
  // hasAnyPlatformLogin still drives the account pills and the sign-out list, so
  // it must not have been quietly redefined as "has a source".
  const body = namedFunctionSource(utils, 'hasAnyPlatformLogin');
  assert.ok(body.includes('hasPlatformLogin'), 'the account test still asks about logins');
  assert.ok(!body.includes('hasPlayableSource'), 'the account test must not become the source test');
});
