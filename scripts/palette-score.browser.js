// ============================================================
//  Cover-palette scorer — browser-side.
//
//  Measures how far Mineradio's cover-derived palette is from the covers
//  themselves, so "every scene looks the same colour" can be answered with
//  numbers instead of a screenshot.
//
//  It is a BROWSER function, not a node script: it needs a canvas, the same
//  origin as the app (for /api/cover) and the app's own extractor
//  updateLyricPaletteFromCover(). Run it from the page:
//
//      const score = await scoreCoverSet();
//      console.table(score.sourceDominantHue);
//
//  It reads two hue distributions over the same images:
//
//    sourceDominantHue  the image's own dominant hue, each degree weighted by
//                       saturation * value, grey and near-grey pixels ignored.
//    appExtractedPrimary  what stageLyrics.palette.primary comes out as after
//                       handing those exact pixels to the app's extractor.
//
//  Comparing them answers the only question that matters: does the extractor
//  add a colour the pictures do not have, or does it just show what is there?
//
//  Reported per distribution, all circular so 359° and 1° are 2° apart:
//    meanHue      circular mean direction of the hues
//    stdHue       circular standard deviation in degrees (0 = all identical)
//    pinkRedBand  share of hues in 330-360 and 0-25, the band that reads as
//                 "pinkish red" on screen
//    meanPairwise mean shortest arc between two random hues (180 = opposite,
//                 80-100 = spread evenly round the wheel)
//    buckets      how many of the twelve 30° buckets are occupied
//    counts       per-bucket histogram, red first, rose last
// ============================================================

async function scoreCoverSet(options) {
  options = options || {};
  var queries = options.queries || [
    'pop', 'rock', 'jazz', 'electronic', 'hip hop', 'classical',
    'lofi', 'indie', 'rnb', 'metal', 'country', 'ambient'
  ];
  var perQuery = options.limit || 6;
  var concurrency = options.concurrency || 6;
  var size = options.size || 256;

  function rgb2hsv(r, g, b) {
    r /= 255; g /= 255; b /= 255;
    var mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
    var h = 0;
    if (d) {
      if (mx === r) h = ((g - b) / d) % 6;
      else if (mx === g) h = (b - r) / d + 2;
      else h = (r - g) / d + 4;
      h *= 60;
      if (h < 0) h += 360;
    }
    return [h, mx === 0 ? 0 : d / mx, mx];
  }

  function css2hue(css) {
    var m = /rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(String(css || ''));
    if (!m) return null;
    var out = rgb2hsv(+m[1], +m[2], +m[3]);
    // A near-grey primary is not a hue; counting it would fake a spread.
    return out[1] > 0.12 ? out[0] : null;
  }

  function circular(hues) {
    if (!hues.length) return { n: 0, meanHue: 'n/a', stdHue: 'n/a', R: 0 };
    var sx = 0, sy = 0;
    for (var i = 0; i < hues.length; i++) {
      var a = hues[i] * Math.PI / 180;
      sx += Math.cos(a);
      sy += Math.sin(a);
    }
    sx /= hues.length;
    sy /= hues.length;
    var R = Math.hypot(sx, sy);
    var mean = ((Math.atan2(sy, sx) * 180 / Math.PI) + 360) % 360;
    // sqrt(-2 ln R) is in radians; the conversion happens after the root,
    // not inside it — the inside-the-root version reports a std that is far
    // too small and makes a spread-out set look uniform.
    var std = Math.sqrt(Math.max(0, -2 * Math.log(Math.max(1e-9, R)))) * 180 / Math.PI;
    return { n: hues.length, meanHue: Math.round(mean) + '°', stdHue: Math.round(std) + '°', R: +R.toFixed(3) };
  }

  function pinkRedShare(hues) {
    if (!hues.length) return '0%';
    var hits = hues.filter(function (h) { return h >= 330 || h < 25; }).length;
    return Math.round(hits / hues.length * 100) + '%';
  }

  function meanPairwise(hues) {
    var sum = 0, n = 0;
    for (var i = 0; i < hues.length; i++) {
      for (var j = i + 1; j < hues.length; j++) {
        var d = Math.abs(hues[i] - hues[j]);
        if (d > 180) d = 360 - d;
        sum += d;
        n++;
      }
    }
    return Math.round(sum / Math.max(1, n)) + '°';
  }

  function histogram(hues) {
    var buckets = new Array(12).fill(0);
    for (var i = 0; i < hues.length; i++) buckets[Math.floor((hues[i] % 360) / 30)]++;
    return {
      buckets: buckets.filter(function (b) { return b > 0; }).length + '/12',
      counts: buckets.join(',')
    };
  }

  // ---- the set --------------------------------------------------------
  var urls = [];
  for (var q = 0; q < queries.length; q++) {
    try {
      var res = await fetch('/api/itunes/search?keywords=' + encodeURIComponent(queries[q]) + '&limit=' + perQuery);
      var json = await res.json();
      for (var s = 0; s < (json.songs || []).length; s++) {
        var song = json.songs[s];
        var cover = song.coverUrl || song.cover || song.artwork || song.pic;
        if (cover) urls.push(cover);
      }
    } catch (e) { /* one provider failing must not fail the run */ }
  }
  var list = Array.from(new Set(urls));
  if (!list.length) throw new Error('no covers returned by the search API');

  // ---- measure --------------------------------------------------------
  var canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  var ctx = canvas.getContext('2d', { willReadFrequently: true });
  var sourceHues = [];
  var extractedHues = [];
  var ok = 0, failed = 0;
  var cursor = 0;

  async function one(url) {
    var img = new Image();
    img.crossOrigin = 'anonymous';
    await new Promise(function (resolve, reject) {
      img.onload = resolve;
      img.onerror = reject;
      img.src = '/api/cover?url=' + encodeURIComponent(url);
    });
    ctx.clearRect(0, 0, size, size);
    ctx.drawImage(img, 0, 0, size, size);

    var data = ctx.getImageData(0, 0, size, size).data;
    var H = new Float64Array(360);
    for (var p = 0; p < data.length; p += 4) {
      if (data[p + 3] < 128) continue;
      var hsv = rgb2hsv(data[p], data[p + 1], data[p + 2]);
      if (hsv[1] > 0.18 && hsv[2] > 0.12) H[Math.round(hsv[0]) % 360] += hsv[1] * hsv[2];
    }
    var best = -1, bestW = 0, total = 0;
    for (var h = 0; h < 360; h++) {
      total += H[h];
      if (H[h] > bestW) { bestW = H[h]; best = h; }
    }
    if (total > 0 && best >= 0) sourceHues.push(best);

    if (typeof updateLyricPaletteFromCover === 'function') {
      updateLyricPaletteFromCover(canvas);
      var pal = (typeof stageLyrics !== 'undefined' && stageLyrics && stageLyrics.palette) || {};
      var extracted = css2hue(pal.primary);
      if (extracted != null) extractedHues.push(extracted);
    }
    ok++;
  }

  await Promise.all(Array.from({ length: concurrency }, async function () {
    while (cursor < list.length) {
      var i = cursor++;
      try { await one(list[i]); } catch (e) { failed++; }
    }
  }));

  var src = Object.assign({ pinkRedBand: pinkRedShare(sourceHues), meanPairwise: meanPairwise(sourceHues) }, circular(sourceHues), histogram(sourceHues));
  var ext = Object.assign({ pinkRedBand: pinkRedShare(extractedHues), meanPairwise: meanPairwise(extractedHues) }, circular(extractedHues), histogram(extractedHues));

  return {
    covers: { requested: list.length, measured: ok, failed: failed },
    sourceDominantHue: src,
    appExtractedPrimary: ext,
    // The one line that answers the question: if this is ~0% the extractor is
    // faithful; a large positive number means it is inventing warmth.
    pinkRedShareShift: (parseInt(ext.pinkRedBand, 10) - parseInt(src.pinkRedBand, 10)) + '% pts',
    // And this is how much variety survives the extraction.
    spreadChange: {
      std: src.stdHue + ' -> ' + ext.stdHue,
      buckets: src.buckets + ' -> ' + ext.buckets,
      meanPairwise: src.meanPairwise + ' -> ' + ext.meanPairwise
    }
  };
}
