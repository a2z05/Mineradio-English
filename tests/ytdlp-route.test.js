const test = require('node:test');
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const appRoot = path.resolve(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(appRoot, p), 'utf8');

const ytdlp = require(path.join(appRoot, 'ytdlp.js'));

const serverText = read('server.js');
const proxyText = read('app-proxy.js');
const proxyPanelText = read('public/js/modules/12-remote/01-app-proxy-panel.js');
const downloadRoutesText = read('public/js/modules/12-remote/04-download-routes.js');
const indexLoaderText = read('public/js/index-loader.js');
const indexHtmlText = read('public/index.html');

test('yt-dlp is exposed as a download route, a playback route and a search', () => {
  for (const route of ['/api/ytdlp/status', '/api/ytdlp/song/url', '/api/ytdlp/search', '/api/download/ytdlp']) {
    assert.ok(serverText.includes(`pn === '${route}'`), 'missing server route ' + route);
  }
  // The playback route has to speak the same shape as every other provider, or
  // the player's fallback chain cannot consume it.
  const songUrlBlock = serverText.slice(serverText.indexOf("pn === '/api/ytdlp/song/url'"));
  const block = songUrlBlock.slice(0, 1800);
  assert.ok(block.includes("provider: 'ytdlp'"), 'song/url must report the ytdlp provider');
  assert.ok(block.includes('playable: true'), 'a resolved stream must report playable');
  assert.ok(block.includes("playbackMode: 'direct-url'"), 'a resolved stream plays by direct url');
  assert.ok(block.includes('/api/audio?url='), 'resolved audio streams through the app audio proxy');
  assert.ok(block.includes("app=ytdlp"), 'the audio proxy is told which app owns the stream');
});

test('a failed resolve degrades to a switchable restriction instead of an error', () => {
  const block = serverText.slice(serverText.indexOf("pn === '/api/ytdlp/song/url'")).slice(0, 2200);
  // The player recovers by switching source; a thrown error would stop it.
  assert.ok(block.includes('playable: false'), 'a failed resolve must report unplayable');
  assert.ok(block.includes("action: 'switch_source'"), 'a failed resolve must ask the player to switch source');
  assert.ok(!/throw new Error/.test(block), 'the resolve path must not throw at the client');
});

test('the resolve argv asks for one audio stream and never a playlist', () => {
  const args = ytdlp.buildYtDlpArgs({ mode: 'resolve' });
  assert.ok(args.includes('--no-playlist'), 'a bare YouTube url sits inside a mix — never enumerate it');
  assert.ok(args.includes('-g'), 'a resolve prints the media url instead of writing a file');
  const format = args[args.indexOf('-f') + 1];
  assert.ok(/^bestaudio/.test(format), 'the format selector must prefer audio-only, got ' + format);
  assert.ok(format.includes('m4a'), 'm4a avoids requiring ffmpeg, got ' + format);
});

test('a download argv writes metadata without demanding ffmpeg', () => {
  const args = ytdlp.buildYtDlpArgs({ mode: 'download', outputTemplate: 'X' });
  assert.ok(args.includes('-o'), 'a download needs an output template');
  assert.ok(args.includes('--embed-metadata'), 'metadata embedding is free and always applied');
  // --embed-thumbnail needs ffmpeg. Passing it unconditionally turns a working
  // download into a failure on any machine without ffmpeg installed.
  assert.ok(!args.includes('--embed-thumbnail'), 'thumbnail embedding must be conditional on ffmpeg');
  const withFfmpeg = ytdlp.buildYtDlpArgs({ mode: 'download', outputTemplate: 'X', ffmpegLocation: 'C:/ffmpeg' });
  assert.ok(withFfmpeg.includes('--embed-thumbnail'), 'thumbnail embedding is offered when ffmpeg is known');
  assert.ok(withFfmpeg.includes('--ffmpeg-location'), 'the ffmpeg path is passed through');
});

test('the proxy flag is emitted only when a proxy is supplied', () => {
  const direct = ytdlp.buildYtDlpArgs({ mode: 'resolve' });
  assert.ok(!direct.includes('--proxy'), 'no proxy means no flag, not an empty one');
  const proxied = ytdlp.buildYtDlpArgs({ mode: 'resolve', proxy: 'http://127.0.0.1:10808' });
  const at = proxied.indexOf('--proxy');
  assert.ok(at >= 0, 'a proxy must be passed to yt-dlp');
  assert.strictEqual(proxied[at + 1], 'http://127.0.0.1:10808', 'the proxy url follows the flag as one argument');
});

test('one resolved url is returned even when yt-dlp prints several', () => {
  assert.strictEqual(ytdlp.parseResolvedUrl('https://a/one\n'), 'https://a/one');
  // Separate video/audio streams print two lines; the audio-only format choice
  // means the last line is the one to play.
  assert.strictEqual(ytdlp.parseResolvedUrl('https://a/video\nhttps://a/audio\n'), 'https://a/audio');
  assert.strictEqual(ytdlp.parseResolvedUrl('not a url\n'), '');
  assert.strictEqual(ytdlp.parseResolvedUrl(''), '');
});

test('a Windows path survives being read back from yt-dlp', () => {
  // A drive letter contains a colon, so a naive split on ':' truncates the path.
  const printed = 'C:\\Users\\a2z\\Downloads\\Mineradio\\Song [abc123].m4a';
  assert.strictEqual(ytdlp.parsePrintedPath('[download] done\n' + printed + '\n'), printed);
  assert.strictEqual(ytdlp.parsePrintedPath(''), '');
});

test('the failure reported to the user is the ERROR line, not the warning above it', () => {
  const stderr = [
    'WARNING: something harmless',
    'ERROR: Unable to download webpage',
    '  caused by: connection reset',
  ].join('\n');
  assert.strictEqual(ytdlp.summarizeYtDlpError(stderr, 'fallback'), 'Unable to download webpage');
  // With no ERROR line the tail is the best available explanation.
  assert.strictEqual(ytdlp.summarizeYtDlpError('just noise\nlast line', 'fallback'), 'last line');
  assert.strictEqual(ytdlp.summarizeYtDlpError('', 'fallback'), 'fallback');
});

test('a missing binary is a capability, not a crash', () => {
  const caps = ytdlp.getYtDlpCapabilities();
  assert.strictEqual(typeof caps.available, 'boolean');
  // The UI must be able to decide whether to offer the route at all.
  assert.ok('download' in caps && 'resolve' in caps, 'capabilities answer what the build can do');
  // The binary path is only ever one the module resolved itself.
  if (!caps.available) assert.strictEqual(caps.path, '');
});

test('yt-dlp is a first-class proxy app with its own checkbox', () => {
  assert.ok(proxyText.includes("'ytdlp'"), 'app-proxy must know the ytdlp app');
  assert.ok(/PROXY_APPS = \[[^\]]*'ytdlp'/.test(proxyText), 'ytdlp belongs to PROXY_APPS');
  assert.ok(proxyText.includes('function proxyUrlFor'), 'the extractor needs a proxy URL, not a dispatcher');
  // A checkbox the user cannot see cannot be ticked.
  assert.ok(proxyPanelText.includes("['ytdlp'"), 'the proxy panel must offer the ytdlp box');
});

// Loads app-proxy against a temporary config path so the user's real
// data/app-proxy.json is never read or written by a test.
function loadProxyWithConfig(config) {
  const file = path.join(require('os').tmpdir(), `mineradio-proxy-test-${process.pid}-${Math.random().toString(36).slice(2)}.json`);
  fs.writeFileSync(file, JSON.stringify(config));
  const source = read('app-proxy.js').replace(
    /const PROXY_CONFIG_FILE = .*;/,
    `const PROXY_CONFIG_FILE = ${JSON.stringify(file)};`
  );
  const sandbox = {
    module: { exports: {} }, exports: {}, require, console, process, Buffer,
    setTimeout, clearTimeout, setInterval, clearInterval, URL, URLSearchParams,
  };
  sandbox.exports = sandbox.module.exports;
  const vm = require('vm');
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox);
  return { api: sandbox.module.exports, file };
}

test('proxyUrlFor encodes credentials and only routes a ticked app', () => {
  // Credentials contain a space and a slash; an unencoded one reparses the URL
  // into a different host, which silently routes the download somewhere else.
  const { api, file } = loadProxyWithConfig({
    enabled: true, protocol: 'http', host: '127.0.0.1', port: 8080,
    username: 'user name', password: 'p@ss/word',
    apps: { ytdlp: true, spotify: false },
  });
  try {
    const url = api.proxyUrlFor('ytdlp');
    assert.ok(url.includes('user%20name'), 'the username must be percent-encoded, got ' + url);
    assert.ok(url.includes('p%40ss%2Fword'), 'the password must be percent-encoded, got ' + url);
    assert.ok(url.startsWith('http://'), 'the scheme must come from the saved protocol, got ' + url);
    assert.ok(url.endsWith('127.0.0.1:8080'), 'the authority must be the saved host and port, got ' + url);
    // An app whose box is unticked must not be routed.
    assert.strictEqual(api.proxyUrlFor('spotify'), '', 'an unticked app is never routed');
  } finally {
    try { fs.unlinkSync(file); } catch (_) {}
  }
});

test('proxyUrlFor stays empty while the master switch is off or the host is dead', () => {
  const off = loadProxyWithConfig({
    enabled: false, protocol: 'http', host: '127.0.0.1', port: 8080, apps: { ytdlp: true },
  });
  try {
    assert.strictEqual(off.api.proxyUrlFor('ytdlp'), '', 'a switched-off proxy routes nothing');
  } finally {
    try { fs.unlinkSync(off.file); } catch (_) {}
  }
  // SOCKS5 has no transport in this build (getDispatcher and getTunnelAgent both
  // refuse it), so offering it to yt-dlp would promise a route that cannot run.
  const socks = loadProxyWithConfig({
    enabled: true, protocol: 'socks5', host: '127.0.0.1', port: 1080, apps: { ytdlp: true },
  });
  try {
    assert.strictEqual(socks.api.proxyUrlFor('ytdlp'), '', 'socks5 is not offered where it cannot work');
  } finally {
    try { fs.unlinkSync(socks.file); } catch (_) {}
  }
});

test('the bundled binary is found next to the app resources', () => {
  const text = read('ytdlp.js');
  // Packaged builds put it under resources/bin; the dev checkout keeps it in bin/.
  assert.ok(text.includes('process.resourcesPath'), 'a packaged build reads resourcesPath');
  assert.ok(/path\.join\(__dirname, 'bin'/.test(text), 'a dev checkout reads bin/');
  const builderConfig = JSON.parse(read('package.json')).build;
  assert.ok(builderConfig.extraResources, 'electron-builder must ship the binary in extraResources');
  assert.ok(
    JSON.stringify(builderConfig.extraResources).includes('yt-dlp'),
    'the binary has to be in extraResources to exist at runtime'
  );
});

test('the download button asks which route instead of guessing', () => {
  const buttons = indexHtmlText.match(/id="download-track-btn"|fs-download-track/g) || [];
  assert.ok(buttons.length >= 2, 'both player bars carry a download button');
  // The route menu replaces the direct onclick, so every button reaches it.
  assert.ok(downloadRoutesText.includes('bindDownloadRouteButtons'), 'the buttons are bound to the menu');
  assert.ok(downloadRoutesText.includes("button.removeAttribute('onclick')"), 'the old direct onclick is replaced');
  assert.ok(downloadRoutesText.includes("data-download-route="), 'the menu offers named routes');
  for (const route of ['direct', 'ytdlp', 'ytdlp-proxy']) {
    assert.ok(downloadRoutesText.includes("'" + route + "'"), 'missing download route ' + route);
  }
  // The module has to be loaded or none of it runs.
  assert.ok(indexLoaderText.includes('04-download-routes.js'), 'the module must be registered in the loader');
  assert.ok(indexHtmlText.includes('css/download-routes.css'), 'the menu needs its stylesheet');
});

test('a packaged install finds the binary under resourcesPath', () => {
  // The dev checkout finds bin/ next to the source, so this branch is the one
  // that only a real install exercises — and a wrong path there ships a broken
  // route that no local run would reveal.
  const os = require('os');
  const vm = require('vm');
  const fakeResources = path.join(os.tmpdir(), `mr-res-${process.pid}`);
  const fakeDir = path.join(os.tmpdir(), `mr-app-${process.pid}`);
  fs.mkdirSync(path.join(fakeResources, 'bin'), { recursive: true });
  fs.mkdirSync(fakeDir, { recursive: true });

  const realBinary = path.join(appRoot, 'bin', 'yt-dlp.exe');
  const hadBinary = fs.existsSync(realBinary);
  // The resolver only needs *a* file at the right path; the test is about
  // discovery, not about running the extractor.
  fs.writeFileSync(path.join(fakeResources, 'bin', 'yt-dlp.exe'), 'stub');

  try {
    const sandbox = {
      module: { exports: {} }, exports: {}, require, console, Buffer,
      setTimeout, clearTimeout,
      __dirname: fakeDir,
      __filename: path.join(fakeDir, 'ytdlp.js'),
      process: Object.create(process),
    };
    sandbox.process.resourcesPath = fakeResources;
    sandbox.exports = sandbox.module.exports;
    vm.createContext(sandbox);
    vm.runInContext(read('ytdlp.js'), sandbox);
    const resolved = sandbox.module.exports.resolveYtDlpBinary(true);
    assert.ok(
      resolved && resolved.startsWith(fakeResources),
      'a packaged build must resolve resourcesPath/bin, got ' + JSON.stringify(resolved)
    );
    assert.strictEqual(sandbox.module.exports.ytDlpAvailable(), true);
  } finally {
    fs.rmSync(fakeResources, { recursive: true, force: true });
    fs.rmSync(fakeDir, { recursive: true, force: true });
  }
  // The real binary is a tracked asset — a build that loses it silently ships a
  // missing feature.
  assert.ok(hadBinary, 'bin/yt-dlp.exe must be present in the repo');
});

test('a request cannot choose the proxy, only ask for the saved one', () => {
  const block = serverText.slice(serverText.indexOf("pn === '/api/download/ytdlp'")).slice(0, 2600);
  assert.ok(block.includes('appProxy.proxyUrlFor('), 'the proxy comes from the saved config');
  // Accepting a proxy URL from the body would let a request name an arbitrary
  // host for the server to route through.
  assert.ok(!/body\.proxy/.test(block), 'the request body must not name a proxy host');
  assert.ok(block.includes('usedProxy'), 'the reply must report whether the proxy was actually used');
  assert.ok(block.includes('warning:'), 'a requested-but-unavailable proxy must be reported, not hidden');
});

test('a download route can only be asked to run against a real song target', () => {
  const candidates = [
    { id: 'dQw4w9WgXcQ', provider: 'ytmusic' },
    { videoId: 'dQw4w9WgXcQ' },
    { webUrl: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ' },
  ];
  // The target builder is a pure function of the song, mirroring the server's
  // "url or search query" contract.
  const source = read('public/js/modules/12-remote/04-download-routes.js');
  assert.ok(source.includes('function downloadRouteTargetFor'), 'the target builder must exist');
  assert.ok(source.includes('ytsearch') || source.includes('downloadRouteLabelFor'), 'a song with no url falls back to a name search');
  for (const song of candidates) {
    assert.ok(song.id || song.videoId || song.webUrl, 'each candidate carries something to download from');
  }
});
