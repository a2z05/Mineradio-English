'use strict';

var FX_CONSOLE_TABS = [
  { key: 'home', label: 'Home' },
  { key: 'interface', label: 'Interface' },
  { key: 'lyrics', label: 'Lyrics' },
  { key: 'motion', label: 'Motion' },
  { key: 'shelf', label: 'Shelf' },
  { key: 'system', label: 'System' }
];

function fxConsoleItem(ref, title, aliases, history) {
  return {
    ref: ref,
    title: title,
    aliases: aliases || '',
    history: history !== false
  };
}

var FX_CONSOLE_LAYOUT = [
  {
    key: 'home',
    groups: [
      { key: 'presets', title: 'Visual presets', hint: 'Pick an overall style, then fine-tune the details', open: true, items: [
        fxConsoleItem('preset-grid', 'Visual presets', 'style scene Emily Requiem Sonic Star river Vinyl Planet Tunnel Void')
      ] },
      { key: 'archives', title: 'User archives', hint: 'Save, apply and share full visual configurations', items: [
        fxConsoleItem('user-archive-grid', 'User archives', 'profile snapshot share code apply rollback')
      ] },
      { key: 'reset', title: 'Reset & tidy up', hint: 'Restore all defaults', items: [
        fxConsoleItem({ selector: '.fx-actions' }, 'Restore defaults', 'reset all default')
      ] }
    ]
  },
  {
    key: 'interface',
    groups: [
      { key: 'background', title: 'Background media', hint: 'Color, cover, image, video and Wallpaper Engine', open: true, items: [
        fxConsoleItem('bg-color-picker', 'Background color', 'solid from cover'),
        fxConsoleItem('bg-media-preview', 'Background media', 'cover image video upload crop clear', false),
        fxConsoleItem('wallpaper-engine-value', 'Wallpaper Engine', 'wallpaper library detect import restore background', false),
        fxConsoleItem('fx-bgopacity', 'Background opacity', 'background strength'),
        fxConsoleItem('fx-bgcropx', 'Crop horizontal', 'background position x'),
        fxConsoleItem('fx-bgcropy', 'Crop vertical', 'background position y'),
        fxConsoleItem('fx-bgzoom', 'Crop zoom', 'background zoom in out')
      ] },
      { key: 'colors', title: 'Interface colors', hint: 'UI accent, visual tint and icon colors', items: [
        fxConsoleItem('ui-accent-picker', 'UI accent', 'theme accent color'),
        fxConsoleItem('visual-tint-picker', 'Visual tint', 'particle tint from cover'),
        fxConsoleItem('home-accent-picker', 'Home fill', 'home color'),
        fxConsoleItem('home-icon-picker', 'Home icon', 'home icon color'),
        fxConsoleItem('visual-icon-picker', 'Visual icon', 'console icon color')
      ] },
      { key: 'glass', title: 'Glass & left panel', hint: 'Window glass texture and playlist panel feel', items: [
        fxConsoleItem('fx-windowbgopacity', 'Window background opacity', 'window transparency'),
        fxConsoleItem('fx-bgglassopacity', 'Frosted glass opacity', 'glass blur'),
        fxConsoleItem('fx-glassaberration', 'Console glass aberration', 'RGB dispersion glass'),
        fxConsoleItem('fx-playlistblur', 'Panel frosted blur', 'playlist panel blur'),
        fxConsoleItem('fx-playlistdensity', 'Panel density', 'playlist panel density transparency'),
        fxConsoleItem('fx-playlistopen', 'Panel open speed', 'open duration seconds'),
        fxConsoleItem('fx-playlistclose', 'Panel close speed', 'close duration seconds')
      ] }
    ]
  },
  {
    key: 'lyrics',
    groups: [
      { key: 'display', title: 'Display & translation', hint: 'Lyric source, line count and bilingual text', open: true, items: [
        fxConsoleItem('lyric-source-seg', 'Lyric source', 'original custom lyrics', false),
        fxConsoleItem('lyric-display-mode-seg', 'Lyric lines', 'single double triple immersive custom'),
        fxConsoleItem('fx-lyriccustomlines', 'Visible lines', 'custom lyric line count'),
        fxConsoleItem('lyric-translation-mode-seg', 'Translation', 'current line dual multi off'),
        fxConsoleItem('fx-lyrictranslationgap', 'Translation gap', 'translation distance'),
        fxConsoleItem('fx-lyrictranslationscale', 'Translation size', 'translation font size'),
        fxConsoleItem('fx-lyrictranslationopacity', 'Translation opacity', 'translation transparency')
      ] },
      { key: 'colors', title: 'Colors & glow', hint: 'Text, highlight, glow and bright-background readability', items: [
        fxConsoleItem('lyric-color-grid', 'Lyric color', 'text color from cover'),
        fxConsoleItem('lyric-color-picker', 'Custom lyric color', 'text color wheel'),
        fxConsoleItem('lyric-highlight-picker', 'Sing-along highlight', 'highlight color per word'),
        fxConsoleItem('lyric-glow-picker', 'Lyric glow color', 'glow halo color'),
        fxConsoleItem({ selector: '.lyric-glow-effect-row' }, 'Lyric glow toggle', 'background glow follow beat'),
        fxConsoleItem('fx-lyricglow', 'Glow strength', 'lyric glow strength'),
        fxConsoleItem('fx-lyricbgadapt', 'Bright-background dimming', 'bright background readability auto dim'),
        fxConsoleItem('t-lyricGlow', 'Lyric glow', 'background glow on/off'),
        fxConsoleItem('t-lyricGlowBeat', 'Beat glow', 'lyric glow follows beat'),
        fxConsoleItem('t-lyricGlowParticles', 'Lyric light particles', 'lyric particles dots')
      ] },
      { key: 'type', title: 'Font & layout', hint: 'Font, weight, size, position and angle', items: [
        fxConsoleItem('lyric-texture-quality-seg', 'Lyric sharpness', 'resolution texture 1x 2x 3x 4x low high ultra vram upscale clear'),
        fxConsoleItem('lyric-font-grid', 'Lyric fonts', 'serif gothic mono upload font'),
        fxConsoleItem('fx-lyricspacing', 'Letter spacing', 'text spacing'),
        fxConsoleItem('fx-lyriclineheight', 'Line height', 'lyric line spacing'),
        fxConsoleItem('fx-lyricweight', 'Font weight', 'thickness boldness'),
        fxConsoleItem('fx-lyricscale', 'Lyric size', 'font size scale'),
        fxConsoleItem('fx-lyricx', 'Horizontal position', 'lyrics horizontal x'),
        fxConsoleItem('fx-lyricy', 'Vertical position', 'lyrics vertical y height'),
        fxConsoleItem('fx-lyricz', 'Depth position', 'lyrics near far z'),
        fxConsoleItem('fx-lyrictiltx', 'Tilt vertical', 'lyrics pitch'),
        fxConsoleItem('fx-lyrictilty', 'Rotate sideways', 'lyrics yaw side rotation')
      ] },
      { key: 'motion', title: 'Lyric animation', hint: 'Scroll feel, context layers and glitch effects', items: [
        fxConsoleItem('lyric-motion-style-seg', 'Lyric animation', 'float smooth glass line glow glitch'),
        fxConsoleItem('lyric-glitch-controls', 'Glitch details', 'glitch intensity slice chroma trigger speed jitter beat'),
        fxConsoleItem('fx-lyriccontextopacity', 'Context lines clarity', 'context opacity'),
        fxConsoleItem('fx-lyriccontextspread', 'Context spacing', 'context distance'),
        fxConsoleItem('fx-lyricedgefade', 'Edge fade', 'lyric edge fade out'),
        fxConsoleItem('fx-lyricmotionsoftness', 'Motion softness', 'lyric scroll smooth easing'),
        fxConsoleItem('t-lyricVerticalFloat', 'Vertical float', 'floating vertical'),
        fxConsoleItem('t-lyricCameraLock', 'Lock lyrics to camera', 'follow camera lock'),
        fxConsoleItem('t-lyricPauseHold', 'Keep lyrics when paused', 'pause not hidden')
      ] },
      { key: 'desktop', title: 'Desktop lyrics', hint: 'Desktop layer toggle, position, opacity and FPS', items: [
        fxConsoleItem('t-desktopLyrics', 'Desktop lyrics', 'fullscreen on-top lyrics'),
        fxConsoleItem('t-desktopLyricsClickThrough', 'Lock desktop lyrics', 'mouse pass-through prevent misclicks'),
        fxConsoleItem('t-desktopLyricsCinema', 'Desktop lyrics cinema shake', 'desktop lyrics beat shake'),
        fxConsoleItem('t-desktopLyricsHighlight', 'Desktop lyrics highlight follow', 'desktop per-word highlight'),
        fxConsoleItem('fx-desktoplyricssize', 'Desktop lyrics size', 'desktop font size'),
        fxConsoleItem('fx-desktoplyricsopacity', 'Desktop lyrics opacity', 'desktop lyrics transparent'),
        fxConsoleItem('fx-desktoplyricsy', 'Desktop lyrics height', 'desktop position'),
        fxConsoleItem('desktop-lyrics-fps-seg', 'Desktop lyrics FPS', '24 30 60 120 uncapped fps')
      ] }
    ]
  },
  {
    key: 'motion',
    groups: [
      { key: 'base', title: 'Base visuals', hint: 'Overall motion, depth, cover and cinematic camera', open: true, items: [
        fxConsoleItem('fx-intensity', 'Motion intensity', 'music response rhythm'),
        fxConsoleItem('fx-depth', 'Scene depth', 'depth of field stereo'),
        fxConsoleItem('fx-coverres', 'Cover sharpness', 'particle count resolution'),
        fxConsoleItem('fx-cineshake', 'Cinematic shake', 'camera shake strength'),
        fxConsoleItem('t-cinema', 'Cinematic camera toggle', 'dynamic camera')
      ] },
      { key: 'particles', title: 'Particles & light', hint: 'Particle size, motion, twist and bloom', items: [
        fxConsoleItem('t-float', 'Floating particle layer', 'floating particles'),
        fxConsoleItem('t-bloom', 'Particle bloom', 'particle halo'),
        fxConsoleItem('t-edge', 'Edge highlighting', 'edge light'),
        fxConsoleItem('t-backgroundStarRiver', 'Background star river', 'starry sky particle background'),
        fxConsoleItem('fx-point', 'Particle size', 'point size'),
        fxConsoleItem('fx-speed', 'Motion speed', 'particle flow speed'),
        fxConsoleItem('fx-twist', 'Particle twist', 'rotation swirl'),
        fxConsoleItem('fx-color', 'Color intensity', 'particle color saturation'),
        fxConsoleItem('fx-bloom', 'Halo strength', 'bloom glow'),
        fxConsoleItem('fx-scatter', 'Scatter', 'particles spread apart'),
        fxConsoleItem('fx-bgfade', 'Background dimming', 'background darken')
      ] },
      { key: 'sonic-terrain', title: 'Sonic terrain', hint: 'Ground shape, colors and spatial placement', items: [
        fxConsoleItem('fx-sonicamp', 'Ground amplitude', 'terrain amplitude'),
        fxConsoleItem('fx-sonicspeed', 'Terrain speed', 'ground motion'),
        fxConsoleItem('fx-sonicdensity', 'Terrain density', 'grid density'),
        fxConsoleItem('fx-sonicrange', 'Ground range', 'terrain size'),
        fxConsoleItem('fx-soniclower', 'Lyric clearance', 'terrain lower'),
        fxConsoleItem('fx-sonicdepth', 'Ground depth', 'terrain depth of field'),
        fxConsoleItem('fx-sonicautorotate', 'Auto rotation', 'rotation speed'),
        fxConsoleItem('sonic-ground-base-picker', 'Ground shadow', 'terrain base color'),
        fxConsoleItem('sonic-ground-cool-picker', 'Cool peaks', 'terrain cool color'),
        fxConsoleItem('sonic-ground-warm-picker', 'Warm peaks', 'terrain warm color'),
        fxConsoleItem('sonic-ground-accent-picker', 'Ripple highlight', 'terrain accent color'),
        fxConsoleItem('fx-sonicglow', 'Terrain glow', 'ground glow strength')
      ] },
      { key: 'sonic-audio', title: 'Spectrum response', hint: 'Kick detection, band range and band weights', items: [
        fxConsoleItem('t-sonicAudioMonitorEnabled', 'Live spectrum', 'audio analysis spectrum toggle'),
        fxConsoleItem('t-sonicAudioAutoTrack', 'Auto kick tracking', 'beat auto tracking'),
        fxConsoleItem('sonic-audio-monitor-toggle', 'Spectrum panel', 'audio monitor'),
        fxConsoleItem('fx-sonicaudiosensitivity', 'Kick sensitivity', 'beat sensitivity'),
        fxConsoleItem('fx-sonicaudiobandstart', 'Range start', 'spectrum start'),
        fxConsoleItem('fx-sonicaudiobandend', 'Range end', 'spectrum end'),
        fxConsoleItem('fx-sonicaudiothreshold', 'Trigger threshold', 'spectrum gate'),
        fxConsoleItem('fx-sonicaudiopulse', 'Pulse strength', 'spectrum pulse'),
        fxConsoleItem('fx-sonicsubbass', 'Center sub bass', 'Sub Bass'),
        fxConsoleItem('fx-sonicbass', 'Bass weight', 'Bass'),
        fxConsoleItem('fx-soniclowmid', 'Slow wave drift', 'Low Mid'),
        fxConsoleItem('fx-sonicmid', 'Directional flow', 'Mid'),
        fxConsoleItem('fx-sonichighmid', 'Sharp spikes', 'High Mid'),
        fxConsoleItem('fx-sonicpresence', 'Flash trigger', 'Presence'),
        fxConsoleItem('fx-sonicbrilliance', 'Edge shimmer', 'Brilliance'),
        fxConsoleItem('fx-sonicair', 'Air grains', 'Air high frequency')
      ] },
      { key: 'sonic-blocks', title: 'Sonic blocks', hint: 'Floating block count, size and speed', items: [
        fxConsoleItem('t-sonicGroundFloatingEnabled', 'Floating blocks', 'sonic blocks toggle'),
        fxConsoleItem('fx-sonicfloatcount', 'Block count', 'floating count'),
        fxConsoleItem('fx-sonicfloatintensity', 'Block intensity', 'floating intensity'),
        fxConsoleItem('fx-sonicfloatmin', 'Block min size', 'minimum size'),
        fxConsoleItem('fx-sonicfloatmax', 'Block max size', 'maximum size'),
        fxConsoleItem('fx-sonicfloatspeed', 'Block speed', 'floating speed')
      ] },
      { key: 'sonic-we', title: 'Sonic Topography · WE', hint: 'Response and colors for the Wallpaper Engine terrain', items: [
        fxConsoleItem('fx-sonicwegain', 'Input taming', 'WE input gain'),
        fxConsoleItem('fx-sonicweaudio', 'Audio response', 'WE audio intensity'),
        fxConsoleItem('fx-sonicwerange', 'Response range', 'WE range'),
        fxConsoleItem('fx-sonicwepeak', 'Center highlight', 'WE peak'),
        fxConsoleItem('sonic-workshop-cover-picker', 'WE theme base color', 'theme from cover'),
        fxConsoleItem('sonic-workshop-base-picker', 'Terrain base color', 'WE base color'),
        fxConsoleItem('sonic-workshop-warm-picker', 'Warm body', 'WE warm color'),
        fxConsoleItem('sonic-workshop-cool-picker', 'Upper highlight', 'WE cool color'),
        fxConsoleItem('sonic-workshop-ripple-picker', 'Ripple bright area', 'WE ripple'),
        fxConsoleItem('sonic-workshop-peak-picker', 'Peak highlight', 'WE highlight'),
        fxConsoleItem('sonic-workshop-theme-seg', 'WE theme', 'coral deep sea ice blue emerald minimal')
      ] }
    ]
  },
  {
    key: 'shelf',
    groups: [
      { key: 'display', title: 'Display mode', hint: 'Mode, camera, visibility and content source', open: true, items: [
        fxConsoleItem('shelf-seg', '3D playlist shelf', 'off side stage'),
        fxConsoleItem('shelf-camera-seg', 'Shelf camera', 'dynamic static camera'),
        fxConsoleItem('shelf-presence-seg', 'Shelf visibility', 'auto-hide always visible'),
        fxConsoleItem('t-shelfShowPodcasts', 'Show podcast playlists', '3D podcasts'),
        fxConsoleItem('t-shelfMergeCollections', 'Merge saved playlists', 'my playlists saved continuous scroll')
      ] },
      { key: 'look', title: 'Look & position', hint: 'Shelf color, size, position and opacity', items: [
        fxConsoleItem('shelf-accent-picker', 'Shelf color', '3D accent color'),
        fxConsoleItem('fx-shelfsize', 'Shelf size', '3D scale'),
        fxConsoleItem('fx-shelfx', 'Horizontal position', 'shelf x'),
        fxConsoleItem('fx-shelfy', 'Vertical position', 'shelf y'),
        fxConsoleItem('fx-shelfz', 'Depth position', 'shelf near far'),
        fxConsoleItem('fx-shelfangle', 'Side angle', 'shelf rotation'),
        fxConsoleItem('fx-shelfopacity', 'Overall opacity', 'shelf transparent'),
        fxConsoleItem('fx-shelfbgalpha', 'Background opacity', 'shelf background')
      ] },
      { key: 'detail-position', title: 'Detail page position', hint: 'Detail position, scale, angle and row gap', items: [
        fxConsoleItem('fx-shelfdetailx', 'Detail horizontal', 'detail page x'),
        fxConsoleItem('fx-shelfdetaily', 'Detail vertical', 'detail page y'),
        fxConsoleItem('fx-shelfdetailz', 'Detail depth', 'detail page depth'),
        fxConsoleItem('fx-shelfdetailscale', 'Detail size', 'detail page scale'),
        fxConsoleItem('fx-shelfdetailanglex', 'Detail pitch', 'detail vertical angle'),
        fxConsoleItem('fx-shelfdetailangley', 'Detail yaw', 'detail horizontal angle'),
        fxConsoleItem('fx-shelfdetailrowgap', 'Detail row gap', 'song row spacing')
      ] },
      { key: 'detail-motion', title: 'Detail animation', hint: 'Expand, close and song row entrance feel', items: [
        fxConsoleItem('fx-shelfdetailopen', 'Expand duration', 'detail open speed'),
        fxConsoleItem('fx-shelfdetailclose', 'Close duration', 'detail close speed'),
        fxConsoleItem('fx-shelfdetailrowtime', 'Row entrance duration', 'song row animation'),
        fxConsoleItem('fx-shelfdetailintro', 'Expand offset', 'detail entrance offset'),
        fxConsoleItem('fx-shelfdetailparallax', 'Hover parallax', 'detail parallax')
      ] },
      { key: 'summon', title: 'Summon animation', hint: 'Whole-shelf summon, collapse and camera speed', items: [
        fxConsoleItem('fx-shelfsummonopen', 'Summon duration', 'shelf open speed'),
        fxConsoleItem('fx-shelfsummonclose', 'Collapse duration', 'shelf close speed'),
        fxConsoleItem('fx-shelfsummonslide', 'Summon offset', 'shelf slide in'),
        fxConsoleItem('fx-shelfsummonstagger', 'Card stagger', 'card delay'),
        fxConsoleItem('fx-shelfsummonscale', 'Summon scale', 'card scale'),
        fxConsoleItem('fx-shelfsummonparallax', 'Summon parallax', 'card parallax'),
        fxConsoleItem('fx-shelfcamenter', 'Camera enter speed', 'shelf camera enter'),
        fxConsoleItem('fx-shelfcamexit', 'Camera exit speed', 'shelf camera exit')
      ] },
      { key: 'camera', title: 'Camera interaction', hint: 'Camera gesture touch toggle', items: [
        fxConsoleItem('cam-seg', 'Camera interaction', 'off gesture touch')
      ] }
    ]
  },
  {
    key: 'system',
    groups: [
      { key: 'startup', title: 'Startup & exit', hint: 'Close behavior and playback resume mode', open: true, items: [
        fxConsoleItem('close-behavior-seg', 'Closing the window', 'quit directly tray background'),
        fxConsoleItem('t-startupAutoplay', 'Autoplay on startup', 'resume playback when opening the app'),
        fxConsoleItem('t-startupFastSkip', 'Fast start skips splash', 'quick launch'),
        fxConsoleItem('startup-resume-mode-seg', 'Resume position', 'from last progress replay whole song')
      ] },
      { key: 'output', title: 'Playback output', hint: 'Audio output devices and routing panel', items: [
        fxConsoleItem('audio-output-panel', 'Playback output device', 'sound card headphones speakers routing', false)
      ] },
      { key: 'performance', title: 'Performance & background', hint: 'Quality tiers, background rendering and keep-alive', items: [
        fxConsoleItem('performance-quality-seg', 'Quality tier', 'low medium high ultra render quality'),
        fxConsoleItem('foreground-fps-seg', 'Foreground FPS cap', 'fps vsync vsync high refresh power saving 45 60 75 90 120'),
        fxConsoleItem('performance-background-seg', 'Background rendering policy', 'auto optimize keep running stop release'),
        fxConsoleItem('t-liveBackgroundKeep', 'Background keep-alive', 'keep rendering when minimized')
      ] },
      { key: 'memory', title: 'Memory management', hint: 'Player trimming, system release scope and thresholds', items: [
        fxConsoleItem('memory-status-chip', 'System memory status', 'Mem Reduct usage', false),
        fxConsoleItem('memory-status-sub', 'Memory notes', 'working set standby pages', false),
        fxConsoleItem('t-memoryAutoTrimApp', 'Auto-trim player process', 'memory trim Electron'),
        fxConsoleItem('t-memoryAutoTrimOnBackground', 'Trim in background', 'minimized memory'),
        fxConsoleItem('t-memoryAutoSystemTrim', 'Timed system release', 'Mem Reduct auto'),
        fxConsoleItem('t-memorySystemAutoElevate', 'Request admin when needed', 'UAC elevate'),
        fxConsoleItem('memory-mask-seg', 'System release scope', 'working set modified pages standby pages'),
        fxConsoleItem('fx-memory-interval', 'Timed release', 'minutes interval'),
        fxConsoleItem('fx-memory-threshold', 'Usage threshold', 'memory percentage'),
        fxConsoleItem({ selector: '.memory-action-row' }, 'Manual memory actions', 'trim player system release elevated release', false)
      ] },
      { key: 'cache', title: 'Cache & storage', hint: 'Unified cache directory, usage and paths', items: [
        fxConsoleItem('cache-storage-panel', 'Local cache', 'cache path cache directory usage lyrics covers audio updates', false)
      ] },
      { key: 'experimental', title: 'Experimental', hint: 'Not fully open yet or use with care', items: [
        fxConsoleItem('t-wallpaperMode', 'Full desktop mode', 'full Mineradio desktop layer Ctrl Shift M toggle this session only', false)
      ] }
    ]
  }
];

var fxConsoleRegistry = [];
var fxConsoleGroups = {};

function fxConsoleResolveBlock(ref) {
  var el = null;
  if (typeof ref === 'string') el = document.getElementById(ref);
  else if (ref && ref.element) el = ref.element;
  else if (ref && ref.selector) el = document.querySelector('#fx-panel ' + ref.selector) || document.querySelector(ref.selector);
  if (!el) return null;
  var selector = '.fx-slider,.lyric-color-row,.lyric-color-grid,.fx-seg,.preset-grid,.user-archive-grid,.fx-font-grid,.fx-toggle,.lyric-glitch-controls,.lyric-glow-effect-row,.sonic-audio-monitor,.audio-output-section,.cache-storage-panel,.memory-status-chip,.memory-status-sub,.memory-action-row,.fx-actions';
  if (el.matches && el.matches(selector)) return el;
  return el.closest ? (el.closest(selector) || el) : el;
}

function fxConsoleMakeToolbar(panel) {
  var toolbar = document.createElement('div');
  toolbar.className = 'fx-console-toolbar';
  toolbar.id = 'fx-console-toolbar';
  toolbar.innerHTML =
    '<div class="fx-console-search-row" role="search">' +
    '<span class="fx-console-search-icon" aria-hidden="true">⌕</span>' +
    '<input id="fx-console-search" class="fx-console-search" type="search" autocomplete="off" spellcheck="false" aria-label="Search visual console controls" aria-controls="fx-console-search-results" aria-expanded="false" placeholder="Search controls, e.g. particles, cache, lyrics">' +
    '<button id="fx-console-undo" class="fx-console-tool-btn" type="button" disabled aria-label="Undo last change" title="Undo last change">↶<span>Undo</span></button>' +
    '<button id="fx-console-history-toggle" class="fx-console-tool-btn" type="button" aria-label="Recent changes" aria-controls="fx-console-history" aria-haspopup="true" aria-expanded="false" title="Recent changes">◷<span>History</span></button>' +
    '</div>' +
    '<div id="fx-console-search-results" class="fx-console-popover fx-console-search-results" hidden></div>' +
    '<div id="fx-panel-tabs" class="fx-panel-tabs" role="tablist" aria-label="Visual console categories"></div>' +
    '<div id="fx-console-history" class="fx-console-popover fx-console-history-popover" hidden></div>';
  var tabs = toolbar.querySelector('#fx-panel-tabs');
  FX_CONSOLE_TABS.forEach(function (meta) {
    var btn = document.createElement('button');
    btn.type = 'button';
    btn.id = 'fx-console-tab-' + meta.key;
    btn.setAttribute('role', 'tab');
    btn.setAttribute('data-fx-tab', meta.key);
    btn.setAttribute('aria-controls', 'fx-console-page-' + meta.key);
    btn.setAttribute('aria-selected', 'false');
    btn.setAttribute('tabindex', '-1');
    btn.textContent = meta.label;
    tabs.appendChild(btn);
  });
  panel.appendChild(toolbar);
  return toolbar;
}

function fxConsoleMakeGroup(page, tabMeta, groupMeta) {
  var fold = document.createElement('section');
  fold.className = 'fx-fold fx-console-group' + (groupMeta.open ? ' open' : '');
  fold.setAttribute('data-fx-console-group', groupMeta.key);
  fold.setAttribute('data-fx-console-tab', tabMeta.key);
  var groupId = 'fx-console-' + tabMeta.key + '-' + groupMeta.key;
  var head = document.createElement('button');
  head.type = 'button';
  head.id = groupId + '-head';
  head.className = 'fx-fold-head fx-console-group-head';
  head.setAttribute('aria-expanded', groupMeta.open ? 'true' : 'false');
  head.setAttribute('aria-controls', groupId + '-body');
  var title = document.createElement('span');
  title.className = 'fx-fold-title';
  var strong = document.createElement('strong');
  strong.textContent = groupMeta.title;
  var small = document.createElement('small');
  small.textContent = groupMeta.hint || '';
  title.appendChild(strong);
  title.appendChild(small);
  var arrow = document.createElement('span');
  arrow.className = 'arrow';
  arrow.textContent = '▶';
  head.appendChild(title);
  head.appendChild(arrow);
  var body = document.createElement('div');
  body.id = groupId + '-body';
  body.className = 'fx-fold-body fx-console-group-body';
  fold.setAttribute('aria-labelledby', head.id);
  head.addEventListener('click', function () {
    var open = !fold.classList.contains('open');
    fold.classList.toggle('open', open);
    head.setAttribute('aria-expanded', open ? 'true' : 'false');
    if (typeof repositionFxFloatingPanels === 'function') repositionFxFloatingPanels();
  });
  fold.appendChild(head);
  fold.appendChild(body);
  page.appendChild(fold);
  fxConsoleGroups[tabMeta.key + ':' + groupMeta.key] = fold;
  return body;
}

function fxConsoleAppendItem(body, tabMeta, groupMeta, item, state) {
  var node = fxConsoleResolveBlock(item.ref);
  if (!node) {
    console.warn('[FxConsole] control missing:', item.title, item.ref);
    return;
  }
  var existing = null;
  for (var i = 0; i < fxConsoleRegistry.length; i++) {
    if (fxConsoleRegistry[i].element === node) { existing = fxConsoleRegistry[i]; break; }
  }
  if (existing) {
    existing.aliases += ' ' + item.aliases;
    return;
  }
  if (node.classList.contains('fx-toggle')) {
    if (!state.toggleGrid) {
      state.toggleGrid = document.createElement('div');
      state.toggleGrid.className = 'fx-toggle-grid fx-console-toggle-grid';
      body.appendChild(state.toggleGrid);
    }
    state.toggleGrid.appendChild(node);
  } else {
    state.toggleGrid = null;
    body.appendChild(node);
  }
  var entry = {
    id: 'fx-console-entry-' + (fxConsoleRegistry.length + 1),
    title: item.title,
    aliases: item.aliases || '',
    tab: tabMeta.key,
    tabLabel: tabMeta.label,
    group: groupMeta.key,
    groupLabel: groupMeta.title,
    history: item.history !== false,
    element: node
  };
  node.setAttribute('data-fx-console-entry', entry.id);
  node.setAttribute('data-fx-console-tab', entry.tab);
  node.setAttribute('data-fx-console-group', entry.group);
  node.setAttribute('data-fx-console-title', entry.title);
  node.setAttribute('data-fx-console-history', entry.history ? 'on' : 'off');
  fxConsoleRegistry.push(entry);
}

function fxConsoleFindUnclassifiedControls(roots) {
  var blockSelector = '.fx-slider,.lyric-color-row,.lyric-color-grid,.fx-seg,.preset-grid,.user-archive-grid,.fx-font-grid,.fx-toggle,.lyric-glitch-controls,.lyric-glow-effect-row,.sonic-audio-monitor,.audio-output-section,.cache-storage-panel,.memory-status-chip,.memory-status-sub,.memory-action-row,.fx-actions';
  var blocks = [];
  roots.forEach(function (root) {
    if (!root || !root.isConnected) return;
    if (root.matches && root.matches('input:not([type="hidden"]),select,textarea,button') && !root.closest('[data-fx-console-entry],.fx-console-toolbar,.fx-fold-head,.fx-advanced-head')) {
      blocks.push(root);
    }
    root.querySelectorAll('input:not([type="hidden"]),select,textarea,button').forEach(function (control) {
      if (control.closest('.fx-console-toolbar') || control.closest('[data-fx-console-entry]')) return;
      if (control.closest('.fx-fold-head,.fx-advanced-head')) return;
      var block = control.matches && control.matches(blockSelector) ? control : (control.closest ? control.closest(blockSelector) : null);
      if (!block) block = control;
      if (blocks.indexOf(block) < 0) blocks.push(block);
    });
  });
  return blocks;
}

function organizeFxConsoleWorkspace() {
  var panel = document.getElementById('fx-panel');
  if (!panel) return;
  if (panel._fxConsoleWorkspaceOrganized) {
    setFxPanelTab(fxPanelTab);
    return;
  }
  var head = panel.querySelector('.fx-head');
  var oldRoots = Array.prototype.slice.call(panel.children).filter(function (node) { return node !== head; });
  fxConsoleRegistry = [];
  fxConsoleGroups = {};
  var oldTabs = document.getElementById('fx-panel-tabs');
  if (oldTabs && oldTabs.parentNode) oldTabs.parentNode.removeChild(oldTabs);
  var toolbar = fxConsoleMakeToolbar(panel);
  var pages = {};
  FX_CONSOLE_TABS.forEach(function (meta) {
    var page = document.createElement('div');
    page.id = 'fx-console-page-' + meta.key;
    page.className = 'fx-tab-page';
    page.setAttribute('data-fx-page', meta.key);
    page.setAttribute('role', 'tabpanel');
    page.setAttribute('aria-labelledby', 'fx-console-tab-' + meta.key);
    page.setAttribute('aria-hidden', 'true');
    panel.appendChild(page);
    pages[meta.key] = page;
  });
  FX_CONSOLE_LAYOUT.forEach(function (tabLayout) {
    var tabMeta = null;
    FX_CONSOLE_TABS.some(function (meta) {
      if (meta.key === tabLayout.key) { tabMeta = meta; return true; }
      return false;
    });
    if (!tabMeta || !pages[tabMeta.key]) return;
    tabLayout.groups.forEach(function (groupMeta) {
      var body = fxConsoleMakeGroup(pages[tabMeta.key], tabMeta, groupMeta);
      var state = { toggleGrid: null };
      groupMeta.items.forEach(function (item) {
        fxConsoleAppendItem(body, tabMeta, groupMeta, item, state);
      });
    });
  });
  var residual = fxConsoleFindUnclassifiedControls(oldRoots);
  if (residual.length) {
    var fallbackMeta = { key: 'other', title: 'Other settings', hint: 'Compatibility controls not yet categorized' };
    var fallbackBody = fxConsoleMakeGroup(pages.system, { key: 'system', label: 'System' }, fallbackMeta);
    residual.forEach(function (node, index) {
      fxConsoleAppendItem(fallbackBody, { key: 'system', label: 'System' }, fallbackMeta, {
        ref: { element: node },
        title: String(node.textContent || 'Legacy setting').trim().slice(0, 40) || 'Legacy setting',
        aliases: 'other legacy',
        history: true
      }, { toggleGrid: null });
    });
    console.warn('[FxConsole] residual controls:', residual.length);
  }
  oldRoots.forEach(function (node) {
    if (node && node.isConnected && node.parentNode === panel && node !== toolbar && !node.classList.contains('fx-tab-page')) node.remove();
  });
  toolbar.querySelector('#fx-panel-tabs').addEventListener('click', function (e) {
    var btn = e.target && e.target.closest ? e.target.closest('[data-fx-tab]') : null;
    if (!btn) return;
    setFxPanelTab(btn.getAttribute('data-fx-tab'));
    if (typeof closeFxConsolePopovers === 'function') closeFxConsolePopovers();
  });
  toolbar.querySelector('#fx-panel-tabs').addEventListener('keydown', function (e) {
    if (!/^(ArrowLeft|ArrowRight|Home|End)$/.test(e.key)) return;
    var buttons = Array.prototype.slice.call(toolbar.querySelectorAll('[data-fx-tab]'));
    var current = buttons.indexOf(document.activeElement);
    if (current < 0) return;
    e.preventDefault();
    var next = e.key === 'Home' ? 0 : (e.key === 'End' ? buttons.length - 1 : (current + (e.key === 'ArrowRight' ? 1 : -1) + buttons.length) % buttons.length);
    buttons[next].focus();
    setFxPanelTab(buttons[next].getAttribute('data-fx-tab'));
  });
  panel._fxConsoleWorkspaceOrganized = true;
  panel.setAttribute('data-console-layout', 'task-first-v2');
  setFxPanelTab(fxPanelTab);
}

function fxConsoleEntryForElement(element) {
  var node = element && element.closest ? element.closest('[data-fx-console-entry]') : null;
  if (!node) return null;
  var id = node.getAttribute('data-fx-console-entry');
  for (var i = 0; i < fxConsoleRegistry.length; i++) {
    if (fxConsoleRegistry[i].id === id) return fxConsoleRegistry[i];
  }
  return null;
}

function fxConsoleNormalizeSearch(value) {
  return String(value || '').toLowerCase().replace(/[\s\-_./]+/g, '');
}

function fxConsoleCurrentValue(entry) {
  if (!entry || !entry.element) return '';
  var el = entry.element;
  var range = el.matches && el.matches('input[type="range"]') ? el : el.querySelector && el.querySelector('input[type="range"]');
  if (range) {
    var output = range.parentElement && range.parentElement.querySelector('output');
    return output && output.textContent ? output.textContent : range.value;
  }
  var color = el.matches && el.matches('input[type="color"]') ? el : el.querySelector && el.querySelector('input[type="color"]');
  if (color) return String(color.value || '').toUpperCase();
  if (el.classList && el.classList.contains('fx-toggle')) return el.classList.contains('on') ? 'On' : 'Off';
  var active = el.querySelector && el.querySelector('.active');
  if (active && active.textContent) return active.textContent.trim();
  return '';
}

function closeFxConsolePopovers() {
  var results = document.getElementById('fx-console-search-results');
  var history = document.getElementById('fx-console-history');
  var historyBtn = document.getElementById('fx-console-history-toggle');
  var search = document.getElementById('fx-console-search');
  if (results) results.hidden = true;
  if (history) history.hidden = true;
  if (historyBtn) historyBtn.setAttribute('aria-expanded', 'false');
  if (search) search.setAttribute('aria-expanded', 'false');
}

var fxConsoleSearchHitDelayTimer = 0;
var fxConsoleSearchHitClearTimer = 0;
function fxConsoleFocusEntry(entry) {
  if (!entry || !entry.element) return;
  setFxPanelTab(entry.tab);
  var group = fxConsoleGroups[entry.tab + ':' + entry.group];
  if (group) {
    group.classList.add('open');
    var head = group.querySelector('.fx-console-group-head');
    if (head) head.setAttribute('aria-expanded', 'true');
  }
  closeFxConsolePopovers();
  requestAnimationFrame(function () {
    var reduceMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    entry.element.scrollIntoView({ block: 'center', behavior: reduceMotion ? 'auto' : 'smooth' });
    var focusTarget = entry.element.matches && entry.element.matches('input,button,select,textarea,[tabindex]')
      ? entry.element
      : (entry.element.querySelector && entry.element.querySelector('input:not([type="hidden"]),button,select,textarea,[tabindex]'));
    if (!focusTarget && group) focusTarget = group.querySelector('.fx-console-group-head');
    if (focusTarget && focusTarget.focus) focusTarget.focus({ preventScroll: true });
    if (fxConsoleSearchHitDelayTimer) clearTimeout(fxConsoleSearchHitDelayTimer);
    if (fxConsoleSearchHitClearTimer) clearTimeout(fxConsoleSearchHitClearTimer);
    document.querySelectorAll('#fx-panel .fx-search-hit').forEach(function (node) { node.classList.remove('fx-search-hit'); });
    fxConsoleSearchHitDelayTimer = setTimeout(function () {
      fxConsoleSearchHitDelayTimer = 0;
      if (!entry.element || !entry.element.isConnected) return;
      entry.element.classList.remove('fx-search-hit');
      void entry.element.offsetWidth;
      entry.element.classList.add('fx-search-hit');
      fxConsoleSearchHitClearTimer = setTimeout(function () {
        fxConsoleSearchHitClearTimer = 0;
        if (entry.element) entry.element.classList.remove('fx-search-hit');
      }, reduceMotion ? 1100 : 1650);
    }, reduceMotion ? 0 : 220);
  });
}

function renderFxConsoleSearchResults(query) {
  var results = document.getElementById('fx-console-search-results');
  var history = document.getElementById('fx-console-history');
  var historyBtn = document.getElementById('fx-console-history-toggle');
  var search = document.getElementById('fx-console-search');
  if (!results) return;
  var needle = fxConsoleNormalizeSearch(query);
  results.innerHTML = '';
  if (!needle) {
    results.hidden = true;
    if (search) search.setAttribute('aria-expanded', 'false');
    return;
  }
  if (history) history.hidden = true;
  if (historyBtn) historyBtn.setAttribute('aria-expanded', 'false');
  var matches = fxConsoleRegistry.filter(function (entry) {
    var text = [entry.title, entry.aliases, entry.tabLabel, entry.groupLabel, entry.element && entry.element.textContent].join(' ');
    return fxConsoleNormalizeSearch(text).indexOf(needle) >= 0;
  }).slice(0, 18);
  if (!matches.length) {
    var empty = document.createElement('div');
    empty.className = 'fx-console-empty';
    empty.textContent = 'No results for “' + String(query || '').trim().slice(0, 30) + '”';
    results.appendChild(empty);
  } else {
    matches.forEach(function (entry) {
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'fx-console-search-result';
      var main = document.createElement('span');
      main.className = 'fx-console-result-main';
      var title = document.createElement('strong');
      title.textContent = entry.title;
      var crumb = document.createElement('small');
      crumb.className = 'fx-console-breadcrumb';
      crumb.textContent = entry.tabLabel + ' › ' + entry.groupLabel;
      main.appendChild(title);
      main.appendChild(crumb);
      var value = document.createElement('b');
      value.textContent = fxConsoleCurrentValue(entry);
      btn.appendChild(main);
      btn.appendChild(value);
      btn.addEventListener('click', function () { fxConsoleFocusEntry(entry); });
      results.appendChild(btn);
    });
  }
  results.hidden = false;
  if (search) search.setAttribute('aria-expanded', 'true');
}

var fxConsoleHistory = [];
var fxConsoleHistoryTxn = null;
var fxConsoleHistoryApplying = false;
var FX_CONSOLE_HISTORY_LIMIT = 40;

function captureFxConsoleState() {
  var snapshot = null;
  if (typeof captureFxArchiveSnapshot === 'function') snapshot = captureFxArchiveSnapshot();
  if (!snapshot) {
    var raw = { visualPresetSchema: typeof VISUAL_PRESET_SCHEMA !== 'undefined' ? VISUAL_PRESET_SCHEMA : 2 };
    Object.keys(fx || {}).forEach(function (key) { raw[key] = fx[key]; });
    snapshot = typeof normalizeFxArchiveSnapshot === 'function' ? normalizeFxArchiveSnapshot(raw) : Object.assign({}, raw);
  }
  return {
    fx: snapshot || {},
    closeBehavior: typeof closeBehaviorPreference !== 'undefined' ? closeBehaviorPreference : null,
    startupResumeMode: typeof startupResumeModePreference !== 'undefined' ? startupResumeModePreference : null,
    startupAutoplay: typeof startupAutoplayPreference !== 'undefined' ? !!startupAutoplayPreference : null,
    startupFastSkip: typeof startupFastSkipPreference !== 'undefined' ? !!startupFastSkipPreference : null
  };
}

var FX_CONSOLE_PREF_KEYS = ['closeBehavior', 'startupResumeMode', 'startupAutoplay', 'startupFastSkip'];
var FX_CONSOLE_EXCLUDED_FX_KEYS = { backgroundAlbumCover: true };

function fxConsoleValueEqual(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

function fxConsoleChangedKeys(before, after) {
  var changed = { fx: [], prefs: [] };
  var keys = {};
  Object.keys(before && before.fx || {}).forEach(function (key) { keys[key] = true; });
  Object.keys(after && after.fx || {}).forEach(function (key) { keys[key] = true; });
  Object.keys(keys).forEach(function (key) {
    if (!FX_CONSOLE_EXCLUDED_FX_KEYS[key] && !fxConsoleValueEqual(before.fx[key], after.fx[key])) changed.fx.push(key);
  });
  FX_CONSOLE_PREF_KEYS.forEach(function (key) {
    if (!fxConsoleValueEqual(before && before[key], after && after[key])) changed.prefs.push(key);
  });
  return changed;
}

function fxConsoleChangesEmpty(changes) {
  return !changes || (!changes.fx.length && !changes.prefs.length);
}

function fxConsoleStateEqual(a, b) {
  if (!a || !b) return false;
  return fxConsoleChangesEmpty(fxConsoleChangedKeys(a, b));
}

function fxConsoleFormatHistoryValue(value) {
  if (value === true) return 'On';
  if (value === false) return 'Off';
  if (typeof value === 'number') return Math.abs(value - Math.round(value)) < 0.0001 ? String(Math.round(value)) : String(Math.round(value * 100) / 100);
  if (value == null) return 'None';
  return String(value);
}

function fxConsoleHistoryDetail(before, after, changes) {
  var changed = [];
  changes = changes || fxConsoleChangedKeys(before, after);
  changes.fx.forEach(function (key) {
    changed.push([before.fx[key], after.fx[key]]);
  });
  changes.prefs.forEach(function (key) {
    changed.push([before[key], after[key]]);
  });
  if (!changed.length) return '';
  if (changed.length > 1) return changed.length + ' parameters';
  return fxConsoleFormatHistoryValue(changed[0][0]) + ' → ' + fxConsoleFormatHistoryValue(changed[0][1]);
}

function fxConsoleHistoryControlLabel(entry, target) {
  var label = entry ? entry.title : 'Visual settings';
  var button = target && target.closest ? target.closest('button') : null;
  if (button && button.textContent && !button.classList.contains('fx-reset-one')) {
    var text = button.textContent.replace(/\s+/g, ' ').trim();
    if (text && text !== label && text.length < 22) label += ' · ' + text;
  }
  return label;
}

function pushFxConsoleHistory(label, controlKey, before, after, mergeable, adapter) {
  var changes = fxConsoleChangedKeys(before, after);
  if (fxConsoleHistoryApplying || fxConsoleChangesEmpty(changes)) return;
  var now = Date.now();
  var last = fxConsoleHistory[fxConsoleHistory.length - 1];
  if (mergeable && last && last.controlKey === controlKey && now - last.time < 650) {
    last.after = after;
    last.changes = fxConsoleChangedKeys(last.before, last.after);
    last.time = now;
    last.detail = fxConsoleHistoryDetail(last.before, last.after, last.changes);
    if (adapter) {
      last.adapter = last.adapter || adapter;
      last.adapter.afterValue = adapter.afterValue;
    }
    if (fxConsoleChangesEmpty(last.changes)) fxConsoleHistory.pop();
  } else {
    fxConsoleHistory.push({
      label: label,
      controlKey: controlKey,
      before: before,
      after: after,
      changes: changes,
      adapter: adapter || null,
      time: now,
      detail: fxConsoleHistoryDetail(before, after, changes)
    });
    if (fxConsoleHistory.length > FX_CONSOLE_HISTORY_LIMIT) fxConsoleHistory.shift();
  }
  renderFxConsoleHistory();
}

function fxConsoleMergeChanges(records) {
  var merged = { fx: [], prefs: [] };
  var fxSeen = {};
  var prefSeen = {};
  (records || []).forEach(function (record) {
    var changes = record && record.changes || fxConsoleChangedKeys(record.before, record.after);
    changes.fx.forEach(function (key) { if (!fxSeen[key]) { fxSeen[key] = true; merged.fx.push(key); } });
    changes.prefs.forEach(function (key) { if (!prefSeen[key]) { prefSeen[key] = true; merged.prefs.push(key); } });
  });
  return merged;
}

function fxConsoleStateMatchesChanges(current, target, changes) {
  if (!current || !target) return false;
  for (var i = 0; i < changes.fx.length; i++) {
    var fxKey = changes.fx[i];
    if (!fxConsoleValueEqual(current.fx[fxKey], target.fx[fxKey])) return false;
  }
  for (var j = 0; j < changes.prefs.length; j++) {
    var prefKey = changes.prefs[j];
    if (!fxConsoleValueEqual(current[prefKey], target[prefKey])) return false;
  }
  return true;
}

function fxConsoleTryApplyInputAdapter(record, targetState, changes) {
  var adapter = record && record.adapter;
  if (!adapter || adapter.kind !== 'input' || changes.prefs.length) return false;
  var control = document.getElementById(adapter.controlId);
  if (!control || !control.matches('input[type="range"],input[type="color"]')) return false;
  control.value = adapter.beforeValue;
  control.dispatchEvent(new Event('input', { bubbles: true }));
  control.dispatchEvent(new Event('change', { bubbles: true }));
  return fxConsoleStateMatchesChanges(captureFxConsoleState(), targetState, changes);
}

function fxConsoleApplyPreferences(state, changes) {
  if (changes.prefs.indexOf('closeBehavior') >= 0 && state.closeBehavior != null && typeof setCloseBehaviorPreference === 'function') {
    setCloseBehaviorPreference(state.closeBehavior, { toast: false });
  }
  if (changes.prefs.indexOf('startupResumeMode') >= 0 && state.startupResumeMode != null && typeof setStartupResumeModePreference === 'function') {
    setStartupResumeModePreference(state.startupResumeMode, { toast: false });
  }
  if (changes.prefs.indexOf('startupAutoplay') >= 0 && state.startupAutoplay != null && typeof startupAutoplayPreference !== 'undefined' && startupAutoplayPreference !== state.startupAutoplay && typeof toggleStartupAutoplay === 'function') {
    toggleStartupAutoplay();
  }
  if (changes.prefs.indexOf('startupFastSkip') >= 0 && state.startupFastSkip != null && typeof startupFastSkipPreference !== 'undefined' && startupFastSkipPreference !== state.startupFastSkip && typeof toggleStartupFastSkip === 'function') {
    toggleStartupFastSkip();
  }
}

function fxConsoleApplyState(state, label, records, allowAdapter) {
  if (!state || fxConsoleHistoryApplying) return false;
  records = records || [];
  var changes = fxConsoleMergeChanges(records);
  if (fxConsoleChangesEmpty(changes)) return false;
  fxConsoleHistoryApplying = true;
  try {
    var applied = allowAdapter && records.length === 1 && fxConsoleTryApplyInputAdapter(records[0], state, changes);
    if (!applied && changes.fx.length) {
      var current = captureFxConsoleState();
      var merged = Object.assign({}, current.fx);
      changes.fx.forEach(function (key) { merged[key] = state.fx[key]; });
      if (typeof applyFxArchiveSnapshot !== 'function' || !applyFxArchiveSnapshot(merged)) throw new Error('Failed to restore visual state');
    }
    fxConsoleApplyPreferences(state, changes);
    if (typeof configureMemoryReductFromFx === 'function') configureMemoryReductFromFx('history-undo', false);
    if (typeof saveLyricLayout === 'function') saveLyricLayout({ user: true, reason: 'consoleHistoryUndo' });
    if (typeof showToast === 'function') showToast('Reverted: ' + label);
    return true;
  } catch (error) {
    console.error('[FxConsole] history rollback failed', error);
    if (typeof showToast === 'function') showToast('Revert failed, please retry');
    return false;
  } finally {
    setTimeout(function () {
      fxConsoleHistoryApplying = false;
      renderFxConsoleHistory();
    }, 0);
  }
}

function undoFxConsoleHistory() {
  if (!fxConsoleHistory.length || fxConsoleHistoryApplying) return;
  var record = fxConsoleHistory[fxConsoleHistory.length - 1];
  if (!fxConsoleApplyState(record.before, record.label, [record], true)) return;
  fxConsoleHistory.pop();
  renderFxConsoleHistory();
}

function rollbackFxConsoleHistoryTo(index) {
  index = Math.max(0, Math.min(fxConsoleHistory.length - 1, Number(index) || 0));
  var record = fxConsoleHistory[index];
  var records = fxConsoleHistory.slice(index);
  if (!record || !fxConsoleApplyState(record.before, record.label, records, false)) return;
  fxConsoleHistory.length = index;
  renderFxConsoleHistory();
}

function renderFxConsoleHistory() {
  var undo = document.getElementById('fx-console-undo');
  var pop = document.getElementById('fx-console-history');
  if (undo) undo.disabled = !fxConsoleHistory.length || fxConsoleHistoryApplying;
  if (!pop) return;
  pop.innerHTML = '';
  var head = document.createElement('div');
  head.className = 'fx-console-popover-head';
  head.innerHTML = '<strong>Recent changes</strong><small>This session · up to 40 entries</small>';
  pop.appendChild(head);
  if (!fxConsoleHistory.length) {
    var empty = document.createElement('div');
    empty.className = 'fx-console-empty';
    empty.textContent = 'Changes you make will appear here as revertible history';
    pop.appendChild(empty);
    return;
  }
  for (var i = fxConsoleHistory.length - 1; i >= 0; i--) {
    (function (index) {
      var record = fxConsoleHistory[index];
      var row = document.createElement('div');
      row.className = 'fx-console-history-item';
      var text = document.createElement('span');
      var title = document.createElement('strong');
      title.textContent = record.label;
      var meta = document.createElement('small');
      var d = new Date(record.time);
      meta.textContent = [String(d.getHours()).padStart(2, '0'), String(d.getMinutes()).padStart(2, '0'), String(d.getSeconds()).padStart(2, '0')].join(':') + (record.detail ? ' · ' + record.detail : '');
      text.appendChild(title);
      text.appendChild(meta);
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.textContent = index === fxConsoleHistory.length - 1 ? 'Undo' : 'Revert to before this';
      btn.addEventListener('click', function () {
        if (index === fxConsoleHistory.length - 1) undoFxConsoleHistory();
        else rollbackFxConsoleHistoryTo(index);
      });
      row.appendChild(text);
      row.appendChild(btn);
      pop.appendChild(row);
    })(i);
  }
}

function fxConsoleClickIsReversible(target, entry) {
  if (!target || !entry || !entry.history) return false;
  if (target.closest('.fx-console-toolbar,.fx-console-group-head')) return false;
  if (target.matches('input[type="range"],input[type="color"]')) return false;
  if (target.closest('#audio-output-panel,#cache-storage-panel,.memory-action-row,.bg-media-row,.wallpaper-engine-row')) return false;
  var archive = target.closest('#user-archive-grid');
  if (archive) {
    var archiveBtn = target.closest('button');
    return !!(archiveBtn && archiveBtn.textContent.trim() === 'Apply');
  }
  return !!target.closest('button,.fx-toggle,.fx-seg,.lyric-color-row,.fx-font-grid,.preset-card,.fx-actions');
}

function fxConsoleBeginRangeTxn(target) {
  if (fxConsoleHistoryApplying || !target) return;
  var entry = fxConsoleEntryForElement(target);
  if (!entry || !entry.history) return;
  var input = target.matches && target.matches('input[type="range"],input[type="color"]') ? target : target.closest('input[type="range"],input[type="color"]');
  if (!input) return;
  if (fxConsoleHistoryTxn && fxConsoleHistoryTxn.control === input) return;
  fxConsoleHistoryTxn = {
    control: input,
    entry: entry,
    before: captureFxConsoleState(),
    beforeValue: input.value,
    label: entry.title,
    key: input.id || entry.id
  };
}

function fxConsoleCommitRangeTxn(target) {
  if (!fxConsoleHistoryTxn || fxConsoleHistoryApplying) return;
  if (target && fxConsoleHistoryTxn.control !== target && !(target.closest && target.closest('#color-lab-pop'))) return;
  var txn = fxConsoleHistoryTxn;
  fxConsoleHistoryTxn = null;
  pushFxConsoleHistory(txn.label, txn.key, txn.before, captureFxConsoleState(), true, {
    kind: 'input',
    controlId: txn.control.id,
    beforeValue: txn.beforeValue,
    afterValue: txn.control.value
  });
}

function fxConsoleRegisterHotkeySearchEntry() {
  var hotkey = document.getElementById('hotkey-settings-btn');
  if (!hotkey || hotkey.getAttribute('data-fx-console-entry')) return;
  var entry = {
    id: 'fx-console-entry-' + (fxConsoleRegistry.length + 1),
    title: 'Hotkey settings',
    aliases: 'shortcut in-app hotkeys global hotkeys keyboard',
    tab: 'system',
    tabLabel: 'System',
    group: 'startup',
    groupLabel: 'Startup & exit',
    history: false,
    element: hotkey
  };
  hotkey.setAttribute('data-fx-console-entry', entry.id);
  hotkey.setAttribute('data-fx-console-history', 'off');
  fxConsoleRegistry.push(entry);
}

function initFxConsoleSearchAndHistory() {
  var panel = document.getElementById('fx-panel');
  var search = document.getElementById('fx-console-search');
  if (!panel || !search || panel._fxConsoleSearchHistoryBound) return;
  panel._fxConsoleSearchHistoryBound = true;
  fxConsoleRegisterHotkeySearchEntry();
  search.addEventListener('input', function () { renderFxConsoleSearchResults(search.value); });
  search.addEventListener('focus', function () { if (search.value) renderFxConsoleSearchResults(search.value); });
  search.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') {
      search.value = '';
      renderFxConsoleSearchResults('');
      search.blur();
    } else if (e.key === 'Enter') {
      var first = document.querySelector('#fx-console-search-results .fx-console-search-result');
      if (first) { e.preventDefault(); first.click(); }
    }
  });
  var undo = document.getElementById('fx-console-undo');
  if (undo) undo.addEventListener('click', undoFxConsoleHistory);
  var historyBtn = document.getElementById('fx-console-history-toggle');
  var historyPop = document.getElementById('fx-console-history');
  if (historyBtn && historyPop) historyBtn.addEventListener('click', function () {
    var open = historyPop.hidden;
    closeFxConsolePopovers();
    historyPop.hidden = !open;
    historyBtn.setAttribute('aria-expanded', open ? 'true' : 'false');
  });
  panel.addEventListener('pointerdown', function (e) {
    if (e.target && e.target.matches && e.target.matches('input[type="range"],input[type="color"]')) fxConsoleBeginRangeTxn(e.target);
  }, true);
  panel.addEventListener('focusin', function (e) {
    if (e.target && e.target.matches && e.target.matches('input[type="range"],input[type="color"]')) fxConsoleBeginRangeTxn(e.target);
  }, true);
  panel.addEventListener('keydown', function (e) {
    if (e.target && e.target.matches && e.target.matches('input[type="range"]')) fxConsoleBeginRangeTxn(e.target);
  }, true);
  panel.addEventListener('change', function (e) {
    if (!e.target || !e.target.matches || !e.target.matches('input[type="range"],input[type="color"]')) return;
    queueMicrotask(function () { fxConsoleCommitRangeTxn(e.target); });
  }, true);
  panel.addEventListener('focusout', function (e) {
    if (!fxConsoleHistoryTxn || fxConsoleHistoryTxn.control !== e.target) return;
    queueMicrotask(function () { fxConsoleCommitRangeTxn(e.target); });
  }, true);
  panel.addEventListener('click', function (e) {
    if (fxConsoleHistoryApplying) return;
    var entry = fxConsoleEntryForElement(e.target);
    if (!fxConsoleClickIsReversible(e.target, entry)) return;
    var before = captureFxConsoleState();
    var label = fxConsoleHistoryControlLabel(entry, e.target);
    var key = entry.id + ':' + label;
    // The console listens in capture phase, while many controls still use
    // inline/bubble click handlers. Defer to the next task so the target
    // handler has committed its value before the "after" snapshot is read.
    setTimeout(function () {
      pushFxConsoleHistory(label, key, before, captureFxConsoleState(), false);
    }, 0);
  }, true);
  document.addEventListener('pointerdown', function (e) {
    if (!e.target || !e.target.closest || !e.target.closest('#color-lab-pop')) return;
    if (!fxConsoleHistoryTxn && typeof colorLabState !== 'undefined' && colorLabState && colorLabState.picker) fxConsoleBeginRangeTxn(colorLabState.picker);
  }, true);
  document.addEventListener('pointerup', function (e) {
    if (!fxConsoleHistoryTxn) return;
    if (e.target && e.target.closest && e.target.closest('#color-lab-pop button')) return;
    var colorTxn = fxConsoleHistoryTxn.control.matches('input[type="color"]');
    if (colorTxn && (!e.target || !e.target.closest || !e.target.closest('#color-lab-pop'))) return;
    queueMicrotask(function () { fxConsoleCommitRangeTxn(colorTxn ? e.target : null); });
  }, true);
  document.addEventListener('pointercancel', function () {
    if (fxConsoleHistoryTxn) queueMicrotask(function () { fxConsoleCommitRangeTxn(null); });
  }, true);
  document.addEventListener('click', function (e) {
    if (!fxConsoleHistoryTxn || !e.target || !e.target.closest || !e.target.closest('#color-lab-pop')) return;
    queueMicrotask(function () { fxConsoleCommitRangeTxn(e.target); });
  }, true);
  document.addEventListener('change', function (e) {
    if (!fxConsoleHistoryTxn || !e.target || !e.target.closest || !e.target.closest('#color-lab-pop')) return;
    queueMicrotask(function () { fxConsoleCommitRangeTxn(e.target); });
  }, true);
  document.addEventListener('pointerdown', function (e) {
    if (!e.target || !e.target.closest || e.target.closest('#fx-console-toolbar,#color-lab-pop')) return;
    closeFxConsolePopovers();
  }, true);
  document.addEventListener('keydown', function (e) {
    if (e.key !== 'Escape') return;
    var results = document.getElementById('fx-console-search-results');
    var history = document.getElementById('fx-console-history');
    if ((!results || results.hidden) && (!history || history.hidden)) return;
    closeFxConsolePopovers();
    if (document.activeElement && document.activeElement.closest && document.activeElement.closest('.fx-console-popover')) search.focus();
  }, true);
  window.addEventListener('blur', function () {
    if (fxConsoleHistoryTxn) fxConsoleCommitRangeTxn(null);
  });
  renderFxConsoleHistory();
}

window.undoFxConsoleHistory = undoFxConsoleHistory;
window.rollbackFxConsoleHistoryTo = rollbackFxConsoleHistoryTo;
