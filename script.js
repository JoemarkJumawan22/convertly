(function () {
  var FORMATS = {
    jpg:  { mime: 'image/jpeg', ext: 'jpg',  name: 'JPG',  note: 'Opens on every device and app. JPG cannot hold transparency, so see-through areas get a solid fill.' },
    png:  { mime: 'image/png',  ext: 'png',  name: 'PNG',  note: 'Lossless and keeps transparency. Photos usually come out larger than JPG or WebP.' },
    webp: { mime: 'image/webp', ext: 'webp', name: 'WebP', note: 'Smallest files and keeps transparency. A few older apps and devices cannot open WebP.' }
  };
  var $ = function (id) { return document.getElementById(id); };
  var items = [], nextId = 1, sel = null;
  var defaults = { fmt: 'jpg', qMode: 'balanced', q: 85, maxDim: 0, bg: '#ffffff', cL: 0, cR: 0, cT: 0, cB: 0 };

  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }
  function say(msg, node) {
    var s = $('status');
    s.textContent = msg || '';
    if (node) { s.append(' '); s.append(node); }
  }
  function fmtBytes(n) {
    if (n < 1024) return n + ' B';
    if (n < 1048576) { var k = n / 1024; return (k >= 100 ? Math.round(k) : k.toFixed(1)) + ' KB'; }
    return (n / 1048576).toFixed(2) + ' MB';
  }
  function baseName(name) {
    var b = String(name).replace(/\.[^.\/\\]+$/, '').replace(/[\\\/:*?"<>|]+/g, '-').trim();
    return b || 'image';
  }
  function srcLabel(it) {
    var t = (it.srcType || '').toLowerCase();
    if (t === 'image/jpeg') return 'JPG';
    if (t === 'image/png') return 'PNG';
    if (t === 'image/webp') return 'WebP';
    var m = /\.([a-z0-9]+)$/i.exec(it.name);
    return m ? m[1].toUpperCase() : 'Image';
  }

  async function decode(blob) {
    try { return await createImageBitmap(blob); }
    catch (e) {
      return await new Promise(function (res, rej) {
        var u = URL.createObjectURL(blob), im = new Image();
        im.onload = function () { URL.revokeObjectURL(u); res(im); };
        im.onerror = function () { URL.revokeObjectURL(u); rej(new Error('decode')); };
        im.src = u;
      });
    }
  }

  /* Every photo has its own settings object (it.s). */
  function newS() {
    var s = Object.assign({}, defaults);
    s.cL = s.cR = s.cT = s.cB = 0;
    return s;
  }

  var TARGET = { balanced: 0.6, small: 0.35, best: 1 };
  function pct(id) { return Math.min(90, Math.max(0, Number($(id).value) || 0)); }
  function cropRect(it) {
    var s = it.s, l = s.cL, r = s.cR, t = s.cT, b = s.cB;
    if (l + r > 90) r = 90 - l;
    if (t + b > 90) b = 90 - t;
    var sx = Math.round(it.w * l / 100), sy = Math.round(it.h * t / 100);
    return { sx: sx, sy: sy, sw: Math.max(1, it.w - sx - Math.round(it.w * r / 100)), sh: Math.max(1, it.h - sy - Math.round(it.h * b / 100)) };
  }
  function drawCrop(it, type) {
    var k = cropRect(it);
    var maxDim = it.s.maxDim || 0;
    var scale = maxDim ? Math.min(1, maxDim / Math.max(k.sw, k.sh)) : 1;
    var w = Math.max(1, Math.round(k.sw * scale)), h = Math.max(1, Math.round(k.sh * scale));
    var c = document.createElement('canvas');
    c.width = w; c.height = h;
    var ctx = c.getContext('2d');
    ctx.imageSmoothingQuality = 'high';
    if (type === 'jpg') { ctx.fillStyle = it.s.bg; ctx.fillRect(0, 0, w, h); }
    ctx.drawImage(it.img, k.sx, k.sy, k.sw, k.sh, 0, 0, w, h);
    return { c: c, w: w, h: h };
  }
  function toBlob(c, mime, q) {
    return new Promise(function (res) { c.toBlob(res, mime, q); });
  }

  /* ---------- Enhance: unblur + add color ---------- */
  var PALETTES = {
    natural: [[0, [14, 18, 34]], [0.3, [84, 70, 78]], [0.6, [176, 142, 120]], [1, [255, 244, 226]]],
    sepia:   [[0, [30, 18, 10]], [0.5, [150, 108, 70]], [1, [255, 240, 214]]],
    cool:    [[0, [10, 20, 45]], [0.5, [100, 130, 160]], [1, [235, 246, 255]]],
    sunset:  [[0, [35, 15, 50]], [0.5, [200, 100, 90]], [1, [255, 225, 170]]]
  };
  function blurPass(src, dst, w, h, r, horiz) {
    var n = horiz ? w : h, lines = horiz ? h : w, step = horiz ? 4 : 4 * w, lstep = horiz ? 4 * w : 4, d = 2 * r + 1;
    for (var ln = 0; ln < lines; ln++) {
      var base = ln * lstep;
      for (var ch = 0; ch < 3; ch++) {
        var sum = 0, i;
        for (i = -r; i <= r; i++) sum += src[base + Math.min(n - 1, Math.max(0, i)) * step + ch];
        for (i = 0; i < n; i++) {
          dst[base + i * step + ch] = sum / d;
          sum += src[base + Math.min(n - 1, i + r + 1) * step + ch] - src[base + Math.max(0, i - r) * step + ch];
        }
      }
    }
  }
  function blurRGB(px, w, h, r) {
    var a = new Uint8ClampedArray(px), b = new Uint8ClampedArray(px.length);
    for (var k = 0; k < 3; k++) { blurPass(a, b, w, h, r, true); blurPass(b, a, w, h, r, false); }
    return a;
  }
  function sharpen(px, w, h, strength) {
    var r = Math.max(1, Math.round(Math.max(w, h) / 600)), amt = strength / 100 * 3.4;
    var b1 = blurRGB(px, w, h, r), b2 = blurRGB(px, w, h, Math.max(r * 3, r + 2));
    for (var i = 0; i < px.length; i += 4) {
      for (var c = 0; c < 3; c++) {
        var o = px[i + c];
        var v = o + amt * (o - b1[i + c]) + amt * 0.35 * (o - b2[i + c]);
        px[i + c] = v < 0 ? 0 : v > 255 ? 255 : v;
      }
    }
  }

  /* Stronger Richardson-Lucy deconvolution on luminance + multi-scale pass. */
  function boxF(src, dst, w, h, r, horiz) {
    var n = horiz ? w : h, lines = horiz ? h : w, step = horiz ? 1 : w, ls = horiz ? w : 1, d = 2 * r + 1;
    for (var l = 0; l < lines; l++) {
      var b = l * ls, sum = 0, i;
      for (i = -r; i <= r; i++) sum += src[b + Math.min(n - 1, Math.max(0, i)) * step];
      for (i = 0; i < n; i++) {
        dst[b + i * step] = sum / d;
        sum += src[b + Math.min(n - 1, i + r + 1) * step] - src[b + Math.max(0, i - r) * step];
      }
    }
  }
  function blurF(a, w, h, r) {
    var x = new Float32Array(a), t = new Float32Array(a.length);
    for (var k = 0; k < 2; k++) { boxF(x, t, w, h, r, true); boxF(t, x, w, h, r, false); }
    return x;
  }
  async function deblur(px, w, h, amount) {
    var n = w * h, Y = new Float32Array(n), i, k;
    for (i = 0; i < n; i++) Y[i] = (0.299 * px[i * 4] + 0.587 * px[i * 4 + 1] + 0.114 * px[i * 4 + 2]) / 255;
    var long = Math.max(w, h);
    var r = Math.max(1, Math.round(long / 700 * (0.7 + amount / 40)));
    var its = Math.min(12 + Math.round(amount / 100 * 28), Math.max(8, Math.floor(8e7 / n)));
    var est = new Float32Array(Y), ratio = new Float32Array(n);
    /* Coarse pass (larger kernel) then fine pass. */
    var stages = [
      { r: Math.max(1, Math.round(r * 1.6)), its: Math.max(4, Math.round(its * 0.4)) },
      { r: r, its: its }
    ];
    for (var s = 0; s < stages.length; s++) {
      var sr = stages[s].r, sits = stages[s].its;
      for (k = 0; k < sits; k++) {
        var cv = blurF(est, w, h, sr);
        for (i = 0; i < n; i++) ratio[i] = Y[i] / (cv[i] + 0.0015);
        var cr = blurF(ratio, w, h, sr);
        for (i = 0; i < n; i++) est[i] = Math.min(2.2, Math.max(0, est[i] * cr[i]));
        if ((k & 1) === 0) await new Promise(function (res) { setTimeout(res, 0); });
      }
    }
    for (i = 0; i < n; i++) {
      var g = Math.min(4.5, (est[i] + 0.003) / (Y[i] + 0.003)), p = i * 4;
      var nr = px[p] * g, ng = px[p + 1] * g, nb = px[p + 2] * g;
      px[p] = nr > 255 ? 255 : nr; px[p + 1] = ng > 255 ? 255 : ng; px[p + 2] = nb > 255 ? 255 : nb;
    }
  }

  /* Fast edge-aware smoothness: reduces noise/grain while keeping edges. */
  function smoothPx(px, w, h, amount) {
    if (amount <= 0) return;
    var r = Math.max(1, Math.min(3, Math.round(1 + amount / 40)));
    var spat = 1 / (2 * r * r), colSigma = 16 + amount * 0.5, colS = 1 / (2 * colSigma * colSigma);
    var src = new Uint8ClampedArray(px), y, x, dy, dx;
    /* Subsample for very large images so the page stays responsive. */
    var step = (w * h > 900000) ? 2 : 1;
    for (y = 0; y < h; y += step) {
      for (x = 0; x < w; x += step) {
        var p = (y * w + x) * 4;
        var cr = src[p], cg = src[p + 1], cb = src[p + 2];
        var wr = 0, wg = 0, wb = 0, ws = 0;
        for (dy = -r; dy <= r; dy++) {
          var yy = y + dy; if (yy < 0 || yy >= h) continue;
          for (dx = -r; dx <= r; dx++) {
            var xx = x + dx; if (xx < 0 || xx >= w) continue;
            var q = (yy * w + xx) * 4;
            var dr = src[q] - cr, dg = src[q + 1] - cg, db = src[q + 2] - cb;
            var wt = Math.exp(-(dx * dx + dy * dy) * spat - (dr * dr + dg * dg + db * db) * colS);
            wr += src[q] * wt; wg += src[q + 1] * wt; wb += src[q + 2] * wt; ws += wt;
          }
        }
        if (ws > 0) {
          var t = amount / 100;
          var nr = cr + (wr / ws - cr) * t;
          var ng = cg + (wg / ws - cg) * t;
          var nb = cb + (wb / ws - cb) * t;
          px[p] = nr; px[p + 1] = ng; px[p + 2] = nb;
          if (step === 2) {
            if (x + 1 < w) { var p2 = p + 4; px[p2] = nr; px[p2 + 1] = ng; px[p2 + 2] = nb; }
            if (y + 1 < h) {
              var p3 = ((y + 1) * w + x) * 4; px[p3] = nr; px[p3 + 1] = ng; px[p3 + 2] = nb;
              if (x + 1 < w) { var p4 = p3 + 4; px[p4] = nr; px[p4 + 1] = ng; px[p4 + 2] = nb; }
            }
          }
        }
      }
    }
  }

  function colorize(px, name, s) {
    var st = PALETTES[name]; if (!st) return;
    var R = new Float32Array(256), G = new Float32Array(256), B = new Float32Array(256);
    for (var g = 0; g < 256; g++) {
      var t = g / 255, j = 0;
      while (j < st.length - 2 && t > st[j + 1][0]) j++;
      var a = st[j], b = st[j + 1], f = Math.min(1, Math.max(0, (t - a[0]) / (b[0] - a[0])));
      var m0 = a[1][0] + (b[1][0] - a[1][0]) * f, m1 = a[1][1] + (b[1][1] - a[1][1]) * f, m2 = a[1][2] + (b[1][2] - a[1][2]) * f;
      var lm = 0.299 * m0 + 0.587 * m1 + 0.114 * m2, k = lm > 1 ? g / lm : 1;
      R[g] = m0 * k; G[g] = m1 * k; B[g] = m2 * k;
    }
    for (var i = 0; i < px.length; i += 4) {
      var gr = (299 * px[i] + 587 * px[i + 1] + 114 * px[i + 2]) / 1000 | 0;
      px[i]     += (R[gr] - px[i]) * s;
      px[i + 1] += (G[gr] - px[i + 1]) * s;
      px[i + 2] += (B[gr] - px[i + 2]) * s;
    }
  }
  async function applyFx(canvas, fx) {
    var ctx = canvas.getContext('2d'), w = canvas.width, h = canvas.height;
    var id = ctx.getImageData(0, 0, w, h), px = id.data;
    if (fx.smooth > 0) smoothPx(px, w, h, fx.smooth);
    if (fx.sharp > 0) { await deblur(px, w, h, fx.sharp); sharpen(px, w, h, fx.sharp * 0.55); }
    if (fx.color !== 'off' && fx.str > 0) colorize(px, fx.color, fx.str / 100);
    ctx.putImageData(id, 0, 0);
  }
  function fxOff(fx) { return fx.sharp === 0 && (fx.smooth || 0) === 0 && fx.color === 'off'; }
  /* Quick guess: is the photo grayscale, and is it soft / out of focus? */
  function analyze(src) {
    var s = Math.min(1, 800 / Math.max(src.width, src.height));
    var w = Math.max(3, Math.round(src.width * s)), h = Math.max(3, Math.round(src.height * s));
    var c = document.createElement('canvas'); c.width = w; c.height = h;
    var x = c.getContext('2d'); x.drawImage(src, 0, 0, w, h);
    var d = x.getImageData(0, 0, w, h).data, n = w * h, diff = 0, lum = new Float32Array(n), i;
    for (i = 0; i < n; i++) {
      var r = d[i * 4], g = d[i * 4 + 1], b = d[i * 4 + 2];
      diff += Math.max(r, g, b) - Math.min(r, g, b);
      lum[i] = 0.299 * r + 0.587 * g + 0.114 * b;
    }
    var sum = 0, sq = 0, cnt = 0;
    for (var yy = 1; yy < h - 1; yy++) for (var xx = 1; xx < w - 1; xx++) {
      var p = yy * w + xx, l = 4 * lum[p] - lum[p - 1] - lum[p + 1] - lum[p - w] - lum[p + w];
      sum += l; sq += l * l; cnt++;
    }
    var mean = sum / cnt, variance = sq / cnt - mean * mean;
    return { gray: diff / n < 6, blurry: variance < 100 };
  }

  async function encode(it) {
    var s = it.s, fmt = s.fmt, f = FORMATS[fmt];
    var d = drawCrop(it, fmt), mode = s.qMode, q, b;
    if (it.fx) await applyFx(d.c, it.fx);
    if (fmt === 'png') { b = await toBlob(d.c, f.mime); }
    else if (mode === 'manual') { q = s.q; b = await toBlob(d.c, f.mime, q / 100); }
    else {
      var goal = it.srcSize * TARGET[mode], lo = 40, hi = 100;
      q = lo; b = await toBlob(d.c, f.mime, lo / 100);
      for (var i = 0; i < 6 && b && lo < hi; i++) {
        var mid = Math.ceil((lo + hi) / 2), t = await toBlob(d.c, f.mime, mid / 100);
        if (t && t.size <= goal) { lo = mid; q = mid; b = t; } else hi = mid - 1;
      }
    }
    if (!b) throw new Error('Could not convert this photo. It may be too large for this browser.');
    if (b.type !== f.mime) throw new Error('This browser cannot create ' + f.name + ' files. Try JPG or PNG.');
    return { blob: b, fmt: fmt, w: d.w, h: d.h, q: q, auto: mode !== 'manual' };
  }

  /* Each photo is converted on its own, so changing one photo never redoes the others. */
  async function convertItems(list) {
    for (var i = 0; i < list.length; i++) {
      var it = list[i], tk = it.tok = (it.tok || 0) + 1;
      it.busy = true; render();
      try {
        var r = await encode(it);
        if (tk !== it.tok) continue;
        if (it.out) URL.revokeObjectURL(it.out.url);
        it.out = { blob: r.blob, url: URL.createObjectURL(r.blob), fmt: r.fmt, w: r.w, h: r.h, q: r.q, auto: r.auto };
        it.err = null;
      } catch (e) { if (tk === it.tok) { it.err = e.message; it.out = null; } }
      if (tk === it.tok) it.busy = false;
    }
    render();
  }
  function convertAll() { return convertItems(items.slice()); }

  function clearAll() {
    items.forEach(function (it) {
      it.tok = (it.tok || 0) + 1;
      if (it.out) URL.revokeObjectURL(it.out.url);
      if (it.img && it.img.close) it.img.close();
    });
    items = [];
    sel = null;
  }

  async function addFiles(files) {
    var list = Array.prototype.slice.call(files).filter(function (f) {
      return (f.type && f.type.indexOf('image/') === 0) || /\.(jpe?g|png|webp|gif|bmp|avif)$/i.test(f.name);
    });
    if (!list.length) { say('Choose image files such as JPG, PNG, or WebP.'); return; }
    if (items.some(function (i) { return i.sample; })) clearAll();
    var bad = 0;
    for (var i = 0; i < list.length; i++) {
      var f = list[i];
      try {
        var img = await decode(f);
        items.push({ id: nextId++, name: f.name, srcType: f.type, srcSize: f.size, img: img, w: img.naturalWidth || img.width, h: img.naturalHeight || img.height, out: null, err: null, s: newS() });
      } catch (e) { bad++; }
    }
    say(bad ? bad + (bad === 1 ? ' file' : ' files') + ' could not be read as an image.' : '');
    if (!sel && items.length) select(items[0]);
    render();
    convertItems(items.filter(function (i) { return !i.out && !i.busy; }));
  }

  async function loadSample() {
    var W = 720, H = 480, c = document.createElement('canvas');
    c.width = W; c.height = H;
    var x = c.getContext('2d'), r = 56;
    x.beginPath();
    x.moveTo(r, 0); x.arcTo(W, 0, W, H, r); x.arcTo(W, H, 0, H, r); x.arcTo(0, H, 0, 0, r); x.arcTo(0, 0, W, 0, r); x.closePath();
    x.clip();
    var sky = x.createLinearGradient(0, 0, 0, H);
    sky.addColorStop(0, '#1f2a5a'); sky.addColorStop(0.55, '#e8703a'); sky.addColorStop(1, '#ffd48a');
    x.fillStyle = sky; x.fillRect(0, 0, W, H);
    x.fillStyle = '#fff3c4'; x.beginPath(); x.arc(470, 300, 74, 0, Math.PI * 2); x.fill();
    x.fillStyle = '#4a2c52'; x.beginPath(); x.moveTo(0, 330); x.bezierCurveTo(140, 250, 260, 360, 400, 300); x.bezierCurveTo(520, 250, 620, 330, W, 280); x.lineTo(W, H); x.lineTo(0, H); x.fill();
    x.fillStyle = '#1b1426'; x.beginPath(); x.moveTo(0, 400); x.bezierCurveTo(160, 340, 300, 430, 460, 380); x.bezierCurveTo(580, 345, 660, 400, W, 370); x.lineTo(W, H); x.lineTo(0, H); x.fill();
    var blob = await new Promise(function (res) { c.toBlob(res, 'image/png'); });
    if (!blob) return;
    var img = await createImageBitmap(blob);
    items.push({ id: nextId++, name: 'sample-sunset.png', srcType: 'image/png', srcSize: blob.size, img: img, w: W, h: H, out: null, err: null, sample: true, s: newS() });
  }

  /* ---------- Saving ----------
     Order of attempts:
     1. Phones and tablets: the native share sheet, which has "Save to Files" / "Save Image".
     2. A normal download link click (desktop browsers).
     3. A fallback link that opens the file in a new tab, where it can be saved by hand. */
  function openLink(url) {
    var a = el('a', 'fallback', 'Not in your files? Open it in a new tab.');
    a.href = url; a.target = '_blank'; a.rel = 'noopener';
    return a;
  }
  async function saveBlob(filename, blob) {
    var coarse = window.matchMedia && window.matchMedia('(pointer: coarse)').matches;
    if (coarse && navigator.canShare && navigator.share) {
      try {
        var file = new File([blob], filename, { type: blob.type });
        if (navigator.canShare({ files: [file] })) {
          await navigator.share({ files: [file] });
          say('Shared ' + filename + '. Choose “Save to Files” or “Save Image”.');
          return;
        }
      } catch (e) {
        if (e && e.name === 'AbortError') return;
      }
    }
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.rel = 'noopener';
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    setTimeout(function () { a.remove(); }, 1000);
    say('Saving ' + filename + '…', openLink(url));
    setTimeout(function () { URL.revokeObjectURL(url); }, 120000);
  }
  function outName(it) { return baseName(it.name) + '.' + FORMATS[it.out.fmt].ext; }

  async function saveZip() {
    var done = items.filter(function (i) { return i.out; });
    if (!done.length || !window.JSZip) return;
    var zip = new window.JSZip(), used = {};
    done.forEach(function (it) {
      var n = outName(it), k = n, c = 2;
      while (used[k]) { k = n.replace(/(\.[^.]+)$/, ' (' + c++ + ')$1'); }
      used[k] = 1; zip.file(k, it.out.blob);
    });
    say('Packing ' + done.length + ' files…');
    var z = await zip.generateAsync({ type: 'blob' });
    saveBlob('converted-images.zip', z);
  }

  function updateSelLabel() {
    $('selName').textContent = sel ? 'Settings for: ' + sel.name : 'No photo yet. These settings are used for the photos you add.';
  }

  function render() {
    var list = $('list');
    list.replaceChildren();
    updateSelLabel();
    $('count').textContent = items.length ? String(items.length) : '';
    if (!items.length) list.append(el('li', 'empty', 'No photos yet. Add some above and they convert right here.'));
    var totBefore = 0, totAfter = 0;
    items.forEach(function (it) {
      var li = el('li', 'row' + (it.busy ? ' busy' : '') + (it.err ? ' failed' : '') + (it === sel ? ' sel' : ''));
      var th = el('div', 'thumb');
      if (it.out) { var im = document.createElement('img'); im.src = it.out.url; im.alt = 'Preview of ' + baseName(it.name); th.append(im); }
      var f = FORMATS[it.out ? it.out.fmt : it.s.fmt];
      var info = el('div', 'info');
      var nm = el('p', 'fname');
      nm.append(el('span', 'stem', baseName(it.name)), el('span', 'ext', '.' + f.ext));
      if (it.sample) nm.append(el('span', 'tag', 'Sample'));
      if (it === sel) nm.append(el('span', 'tag', 'Editing'));
      info.append(nm);
      var dims = it.out ? (it.out.w === it.w && it.out.h === it.h ? it.w + '×' + it.h : it.w + '×' + it.h + ' → ' + it.out.w + '×' + it.out.h) : it.w + '×' + it.h;
      var meta = srcLabel(it) + ' ' + fmtBytes(it.srcSize) + '  →  ' + (it.out ? f.name + ' ' + fmtBytes(it.out.blob.size) : '…') + '  ·  ' + dims + ' px' + (it.out && it.out.q ? '  ·  Q' + it.out.q + (it.out.auto ? ' auto' : '') : '');
      info.append(el('p', 'meta', meta));
      if (it.out) {
        totBefore += it.srcSize; totAfter += it.out.blob.size;
        var ratio = it.out.blob.size / it.srcSize;
        var bar = el('div', 'bar' + (ratio <= 1 ? '' : ' over')), fill = el('span');
        fill.style.width = Math.min(100, Math.max(4, ratio * 100)) + '%';
        bar.append(fill);
        info.append(bar);
      }
      if (it.err) info.append(el('p', 'err', it.err));
      var side = el('div', 'side');
      if (it.out) {
        var pct = Math.round((it.out.blob.size / it.srcSize - 1) * 100);
        side.append(el('span', 'delta ' + (pct <= 0 ? 'down' : 'up'), (pct > 0 ? '+' : pct < 0 ? '−' : '') + Math.abs(pct) + '%'));
        var open = el('a', 'open', 'Open');
        open.href = it.out.url; open.target = '_blank'; open.rel = 'noopener';
        open.setAttribute('aria-label', 'Open ' + outName(it) + ' in a new tab');
        side.append(open);
      }
      if (it.out) {
        var cb = el('button', '', 'Compare');
        cb.type = 'button';
        cb.addEventListener('click', function () { openCompare(it); });
        side.append(cb);
      }
      var btn = el('button', 'primary', 'Download');
      btn.type = 'button';
      btn.disabled = !it.out || !!it.busy;
      btn.setAttribute('aria-label', 'Download ' + baseName(it.name) + '.' + f.ext);
      btn.addEventListener('click', function () { if (it.out) saveBlob(outName(it), it.out.blob); });
      side.append(btn);
      li.append(th, info, side);
      li.addEventListener('click', function (e) {
        if (e.target.closest && e.target.closest('button, a')) return;
        if (it !== sel) select(it);
      });
      list.append(li);
    });
    var ready = items.filter(function (i) { return i.out; }).length;
    $('zipBtn').hidden = !window.JSZip;
    $('zipBtn').disabled = ready < 2;
    $('clearBtn').disabled = !items.length;
    var sm = $('summary');
    sm.hidden = !ready;
    if (ready) {
      $('sFiles').textContent = String(ready);
      $('sBefore').textContent = fmtBytes(totBefore);
      $('sAfter').textContent = fmtBytes(totAfter);
      var sp = Math.round((totAfter / totBefore - 1) * 100);
      var sv = $('sSaved');
      sv.textContent = (sp > 0 ? '+' : sp < 0 ? '−' : '') + Math.abs(sp) + '%';
      sv.className = 'v ' + (sp <= 0 ? 'down' : 'up');
      var mx = Math.max(totBefore, totAfter);
      $('bBefore').style.width = (totBefore / mx * 100) + '%';
      $('bAfter').style.width = (totAfter / mx * 100) + '%';
      var diff = totBefore - totAfter;
      $('sFree').textContent = diff >= 0 ? '· frees ' + fmtBytes(diff) : '· uses ' + fmtBytes(-diff) + ' more';
      deviceStorage(totAfter);
    }
  }
  function deviceStorage(after) {
    var p = $('devStore');
    if (!navigator.storage || !navigator.storage.estimate) { p.textContent = ''; return; }
    navigator.storage.estimate().then(function (e) {
      if (e && e.quota) p.textContent = 'Converted files take ' + fmtBytes(after) + ' of this browser’s ' + fmtBytes(e.quota) + ' storage allowance.';
    }).catch(function () {});
  }

  /* ---------- Before / after compare ---------- */
  var cmpUrls = [], cmpState = null, fxTimer = null, pvUrl = null;
  function readFx() {
    return {
      sharp: Number($('fxSharp').value) || 0,
      smooth: Number(($('fxSmooth') && $('fxSmooth').value) || 0),
      color: $('fxColor').value,
      str: Number($('fxStr').value) || 0
    };
  }
  function writeFx(fx) {
    $('fxSharp').value = fx.sharp || 0;
    if ($('fxSmooth')) { $('fxSmooth').value = fx.smooth || 0; $('fxSmoothOut').textContent = fx.smooth || 0; }
    $('fxColor').value = fx.color || 'off';
    $('fxStr').value = fx.str != null ? fx.str : 80;
    $('fxSharpOut').textContent = fx.sharp || 0;
    $('fxStrOut').textContent = fx.str != null ? fx.str : 80;
    $('fxStr').disabled = (fx.color || 'off') === 'off';
  }
  async function updateFxPreview() {
    var st = cmpState; if (!st) return;
    var fx = readFx();
    if (fxOff(fx) && !st.it.fx) { $('cmpAfter').src = st.it.out.url; return; }
    var tk = ++st.token;
    var c = document.createElement('canvas'); c.width = st.pv.width; c.height = st.pv.height;
    c.getContext('2d').drawImage(st.pv, 0, 0);
    await applyFx(c, fx);
    var b = await toBlob(c, 'image/png');
    if (!b || cmpState !== st || tk !== st.token) return;
    if (pvUrl) URL.revokeObjectURL(pvUrl);
    pvUrl = URL.createObjectURL(b);
    $('cmpAfter').src = pvUrl;
  }
  function queueFx() { clearTimeout(fxTimer); fxTimer = setTimeout(updateFxPreview, 300); }
  async function openCompare(it) {
    var dlg = $('cmp');
    cmpUrls.forEach(function (u) { URL.revokeObjectURL(u); }); cmpUrls = [];
    if (pvUrl) { URL.revokeObjectURL(pvUrl); pvUrl = null; }
    var d = drawCrop(it, it.out.fmt === 'jpg' ? 'jpg' : 'png');
    var pre = await toBlob(d.c, 'image/png');
    var bu = URL.createObjectURL(pre); cmpUrls.push(bu);
    var pv = d.c, long = Math.max(d.w, d.h);
    if (long > 1400) {
      var sc = 1400 / long;
      pv = document.createElement('canvas');
      pv.width = Math.max(1, Math.round(d.w * sc)); pv.height = Math.max(1, Math.round(d.h * sc));
      var pc = pv.getContext('2d'); pc.imageSmoothingQuality = 'high'; pc.drawImage(d.c, 0, 0, pv.width, pv.height);
    }
    var an = analyze(pv);
    cmpState = { it: it, pv: pv, token: 0 };
    var fx = it.fx || { sharp: an.blurry ? 100 : 0, smooth: an.blurry ? 25 : 0, color: an.gray ? 'natural' : 'off', str: 80 };
    writeFx(fx);
    var tips = [];
    if (it.fx) tips.push('These changes are saved for the download.');
    else {
      if (an.blurry) tips.push('This photo looks blurry, so Unblur is on full and a little Smoothness is on.');
      if (an.gray) tips.push('This photo looks black and white, so color is switched on.');
      if (tips.length) tips.push('This is a preview only until you press Use for download.');
      else tips.push('Move the sliders to unblur, smooth, or add color. Nothing changes in your download until you press Use for download.');
    }
    $('fxHint').textContent = tips.join(' ') + ' Unblur uses deconvolution to reverse blur (stronger than simple sharpen). It works best on mild/medium blur and soft focus. Extremely blurry photos improve a lot but cannot become perfectly sharp because missing detail cannot be invented. Smoothness reduces noise/grain while keeping edges. Color is a tint, not the photo’s real colors.';
    $('cmpBefore').src = bu; $('cmpAfter').src = it.out.url;
    $('cmpTitle').textContent = baseName(it.name) + '.' + FORMATS[it.out.fmt].ext;
    $('cmpInfo').textContent = 'Before: ' + srcLabel(it) + ' ' + fmtBytes(it.srcSize) + '   After: ' + FORMATS[it.out.fmt].name + ' ' + fmtBytes(it.out.blob.size) + ' · ' + it.out.w + '×' + it.out.h + ' px. The before side uses the same trim and size.';
    $('cmpRange').value = 50; setSplit(50);
    if (dlg.showModal) dlg.showModal(); else dlg.setAttribute('open', '');
    updateFxPreview();
  }
  function setSplit(v) {
    $('cmpTop').style.clipPath = 'inset(0 ' + (100 - v) + '% 0 0)';
    $('cmpLine').style.left = v + '%';
  }
  function closeCmp() { var d = $('cmp'); cmpState = null; if (d.close) d.close(); else d.removeAttribute('open'); }
  $('cmpRange').addEventListener('input', function (e) { setSplit(Number(e.target.value)); });
  $('cmpClose').addEventListener('click', closeCmp);
  $('cmp').addEventListener('click', function (e) { if (e.target === $('cmp')) closeCmp(); });

  /* ---------- Per-photo settings panel ---------- */
  function curFmt() {
    var r = document.querySelector('input[name="fmt"]:checked');
    return r ? r.value : 'jpg';
  }
  function syncControls() {
    var fmt = curFmt(), f = FORMATS[fmt];
    $('fmtNote').textContent = f.note;
    var manual = $('qMode').value === 'manual';
    $('qField').dataset.off = fmt === 'png' ? 'true' : 'false';
    $('qMode').disabled = fmt === 'png';
    $('q').disabled = fmt === 'png' || !manual;
    $('q').hidden = !manual;
    $('qOut').textContent = fmt === 'png' ? 'Lossless' : manual ? $('q').value : 'Auto';
    $('qHint').textContent = fmt === 'png' ? 'PNG is lossless, so it has no quality setting.' : manual ? 'Lower quality makes a smaller file.' : 'Each photo gets the best quality that fits the size goal.';
    $('bgField').dataset.off = fmt === 'jpg' ? 'false' : 'true';
    $('bg').disabled = fmt !== 'jpg';
  }
  function readS(s) {
    s.fmt = curFmt(); s.qMode = $('qMode').value; s.q = Number($('q').value) || 85;
    s.maxDim = Number($('maxDim').value) || 0; s.bg = $('bg').value;
    s.cL = pct('cL'); s.cR = pct('cR'); s.cT = pct('cT'); s.cB = pct('cB');
  }
  function writeS(s) {
    $('f-' + s.fmt).checked = true; $('qMode').value = s.qMode; $('q').value = s.q;
    $('maxDim').value = String(s.maxDim); $('bg').value = s.bg;
    $('cL').value = s.cL; $('cR').value = s.cR; $('cT').value = s.cT; $('cB').value = s.cB;
  }
  function select(it) {
    sel = it;
    writeS(it.s);
    syncControls();
    render();
  }
  /* Called whenever a control changes: saves it to the selected photo and converts only that photo. */
  function changed(wait) {
    var it = sel;
    readS(it ? it.s : defaults);
    if (it) { Object.assign(defaults, it.s); defaults.cL = defaults.cR = defaults.cT = defaults.cB = 0; }
    syncControls();
    if (!it) return;
    clearTimeout(it.timer);
    it.timer = setTimeout(function () { convertItems([it]); }, wait || 0);
  }

  /* Small extra UI and styles for the per-photo panel (added here so only this file changes). */
  (function () {
    var st = document.createElement('style');
    st.textContent = '.sel-box{display:grid;gap:7px;padding:12px 14px;border:1px solid var(--line);border-radius:var(--radius-sm);background:var(--bg)}' +
      '.sel-box p{margin:0}.sel-box #selName{color:var(--ink);font-weight:600;font-size:13.5px;overflow-wrap:anywhere}' +
      '.sel-box .link{justify-self:start;padding:0}' +
      '.row{cursor:pointer}.row.sel{border-color:var(--accent);box-shadow:var(--shadow),0 0 0 1px var(--accent),0 0 18px var(--accent-glow)}';
    document.head.append(st);
    var box = el('div', 'sel-box'), nm = el('p', '', ''); nm.id = 'selName';
    var tip = el('p', 'hint', 'Click a photo in the list to give it its own format, quality, size and crop.');
    var all = el('button', 'link', 'Use these settings for all photos'); all.type = 'button'; all.id = 'applyAll';
    box.append(nm, tip, all);
    document.querySelector('.controls').prepend(box);
    var lb = document.querySelector('label[for="fxSharp"]');
    if (lb) lb.textContent = 'Unblur strength';
    /* Inject Smoothness control into the Compare FX panel (so only script.js changes). */
    if (!$('fxSmooth')) {
      var grid = document.querySelector('.fx-grid');
      if (grid) {
        var item = el('div', 'fx-item');
        var head = el('div', 'field-head');
        var lab = el('label', 'field-label', 'Smoothness');
        lab.setAttribute('for', 'fxSmooth');
        var out = el('output', '', '0'); out.id = 'fxSmoothOut'; out.setAttribute('for', 'fxSmooth');
        head.append(lab, out);
        var range = document.createElement('input');
        range.type = 'range'; range.id = 'fxSmooth'; range.min = '0'; range.max = '100'; range.value = '0';
        item.append(head, range);
        var sharpItem = grid.querySelector('#fxSharp') && grid.querySelector('#fxSharp').closest('.fx-item');
        if (sharpItem && sharpItem.nextSibling) grid.insertBefore(item, sharpItem.nextSibling);
        else grid.append(item);
      }
    }
    all.addEventListener('click', function () {
      if (!sel) return;
      items.forEach(function (it) {
        if (it === sel) return;
        var keep = { cL: it.s.cL, cR: it.s.cR, cT: it.s.cT, cB: it.s.cB };
        Object.assign(it.s, sel.s, keep);
      });
      say('Format, quality and size copied to all photos. Each photo keeps its own crop.');
      convertAll();
    });
  })();

  /* ---------- Theme toggle ---------- */
  function currentTheme() {
    var t = document.documentElement.getAttribute('data-theme');
    if (t) return t;
    return window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }
  function syncTheme() { $('themeLabel').textContent = currentTheme() === 'dark' ? 'Light mode' : 'Dark mode'; }
  $('themeBtn').addEventListener('click', function () {
    document.documentElement.setAttribute('data-theme', currentTheme() === 'dark' ? 'light' : 'dark');
    syncTheme();
  });

  document.querySelectorAll('input[name="fmt"]').forEach(function (r) {
    r.addEventListener('change', function () { changed(0); });
  });
  $('qMode').addEventListener('change', function () { changed(0); });
  ['cL', 'cR', 'cT', 'cB'].forEach(function (id) {
    $(id).addEventListener('input', function () { changed(300); });
  });
  $('trimReset').addEventListener('click', function () {
    ['cL', 'cR', 'cT', 'cB'].forEach(function (id) { $(id).value = 0; });
    changed(0);
  });
  $('q').addEventListener('input', function () { changed(220); });
  $('bg').addEventListener('input', function () { changed(220); });
  $('maxDim').addEventListener('change', function () { changed(0); });
  $('file').addEventListener('change', function (e) { addFiles(e.target.files).then(function () { e.target.value = ''; }); });
  var drop = $('drop');
  ['dragenter', 'dragover'].forEach(function (t) { drop.addEventListener(t, function (e) { e.preventDefault(); drop.classList.add('over'); }); });
  ['dragleave', 'drop'].forEach(function (t) { drop.addEventListener(t, function (e) { e.preventDefault(); drop.classList.remove('over'); }); });
  drop.addEventListener('drop', function (e) { if (e.dataTransfer && e.dataTransfer.files) addFiles(e.dataTransfer.files); });
  $('zipBtn').addEventListener('click', saveZip);
  $('clearBtn').addEventListener('click', function () { clearAll(); say(''); render(); });

  /* ---------- Crop tool (works on the selected photo only) ---------- */
  var cropSt = { x0: 0, y0: 0, x1: 100, y1: 100 }, cropDrag = null, CROP_MIN = 8;
  function clampN(v, a, b) { return Math.min(b, Math.max(a, v)); }
  function drawCropBox() {
    var s = cropSt, st = ['left', 'top', 'width', 'height'], v = [s.x0, s.y0, s.x1 - s.x0, s.y1 - s.y0];
    [$('cropBox'), $('cropDim')].forEach(function (n) { st.forEach(function (k, i) { n.style[k] = v[i] + '%'; }); });
    var it = sel;
    if (it) $('cropInfo').textContent = 'Keeps ' + Math.round((s.x1 - s.x0) / 100 * it.w) + '×' + Math.round((s.y1 - s.y0) / 100 * it.h) + ' px of ' + it.w + '×' + it.h + '. This crop is only for ' + it.name + '.';
  }
  function sizeCrop() {
    var cv = $('cropCanvas'), stage = $('cropStage');
    var aw = Math.max(120, stage.clientWidth - 40), ah = Math.max(120, window.innerHeight * 0.56);
    var k = Math.min(aw / cv.width, ah / cv.height);
    cv.style.width = Math.round(cv.width * k) + 'px';
    cv.style.height = Math.round(cv.height * k) + 'px';
  }
  function openCrop() {
    var it = sel;
    if (!it) { say('Add a photo first, then press Crop.'); return; }
    var cv = $('cropCanvas'), s = Math.min(1, 1200 / Math.max(it.w, it.h));
    cv.width = Math.max(1, Math.round(it.w * s)); cv.height = Math.max(1, Math.round(it.h * s));
    var x = cv.getContext('2d'); x.imageSmoothingQuality = 'high'; x.drawImage(it.img, 0, 0, cv.width, cv.height);
    cropSt = { x0: it.s.cL, y0: it.s.cT, x1: 100 - it.s.cR, y1: 100 - it.s.cB };
    if (cropSt.x1 - cropSt.x0 < CROP_MIN) cropSt.x1 = cropSt.x0 + CROP_MIN;
    if (cropSt.y1 - cropSt.y0 < CROP_MIN) cropSt.y1 = cropSt.y0 + CROP_MIN;
    var dlg = $('crop');
    if (dlg.showModal) dlg.showModal(); else dlg.setAttribute('open', '');
    sizeCrop(); drawCropBox();
  }
  function closeCrop() { var d = $('crop'); if (d.close) d.close(); else d.removeAttribute('open'); }
  (function () {
    var stage = $('cropStage');
    stage.addEventListener('pointerdown', function (e) {
      var h = e.target.closest && e.target.closest('[data-h]');
      var mode = h ? h.dataset.h : (e.target.closest && e.target.closest('#cropBox') ? 'move' : null);
      if (!mode) return;
      e.preventDefault();
      cropDrag = { mode: mode, sx: e.clientX, sy: e.clientY, r: Object.assign({}, cropSt), rect: $('cropInner').getBoundingClientRect() };
      stage.setPointerCapture(e.pointerId);
    });
    stage.addEventListener('pointermove', function (e) {
      if (!cropDrag) return;
      var d = cropDrag, r = d.r, m = d.mode, n = Object.assign({}, r);
      var dx = (e.clientX - d.sx) / d.rect.width * 100, dy = (e.clientY - d.sy) / d.rect.height * 100;
      if (m === 'move') {
        var w = r.x1 - r.x0, hh = r.y1 - r.y0;
        n.x0 = clampN(r.x0 + dx, 0, 100 - w); n.y0 = clampN(r.y0 + dy, 0, 100 - hh);
        n.x1 = n.x0 + w; n.y1 = n.y0 + hh;
      } else {
        if (m.indexOf('l') >= 0) n.x0 = clampN(r.x0 + dx, 0, r.x1 - CROP_MIN);
        if (m.indexOf('r') >= 0) n.x1 = clampN(r.x1 + dx, r.x0 + CROP_MIN, 100);
        if (m.indexOf('t') >= 0) n.y0 = clampN(r.y0 + dy, 0, r.y1 - CROP_MIN);
        if (m.indexOf('b') >= 0) n.y1 = clampN(r.y1 + dy, r.y0 + CROP_MIN, 100);
      }
      cropSt = n; drawCropBox();
    });
    ['pointerup', 'pointercancel'].forEach(function (t) { stage.addEventListener(t, function () { cropDrag = null; }); });
  })();
  window.addEventListener('resize', function () { if ($('crop').open) sizeCrop(); });
  $('cropBtn').addEventListener('click', openCrop);
  $('cropClose').addEventListener('click', closeCrop);
  $('crop').addEventListener('click', function (e) { if (e.target === $('crop')) closeCrop(); });
  $('cropReset').addEventListener('click', function () { cropSt = { x0: 0, y0: 0, x1: 100, y1: 100 }; drawCropBox(); });
  $('cropApply').addEventListener('click', function () {
    var l = Math.round(cropSt.x0), t = Math.round(cropSt.y0), r = Math.round(100 - cropSt.x1), b = Math.round(100 - cropSt.y1);
    if (l + r > 90) r = 90 - l;
    if (t + b > 90) b = 90 - t;
    $('cL').value = l; $('cR').value = r; $('cT').value = t; $('cB').value = b;
    closeCrop();
    say('Crop applied to ' + (sel ? sel.name : 'this photo') + ' only. Press Reset under Trim edges to undo it.');
    changed(0);
  });

  $('fxSharp').addEventListener('input', function () { $('fxSharpOut').textContent = $('fxSharp').value; queueFx(); });
  document.addEventListener('input', function (e) {
    if (e.target && e.target.id === 'fxSmooth') {
      var o = $('fxSmoothOut'); if (o) o.textContent = e.target.value;
      queueFx();
    }
  });
  $('fxStr').addEventListener('input', function () { $('fxStrOut').textContent = $('fxStr').value; queueFx(); });
  $('fxColor').addEventListener('change', function () { $('fxStr').disabled = $('fxColor').value === 'off'; queueFx(); });
  $('fxReset').addEventListener('click', function () { writeFx({ sharp: 0, smooth: 0, color: 'off', str: 80 }); queueFx(); });
  $('fxApply').addEventListener('click', function () {
    var st = cmpState; if (!st) return;
    var fx = readFx();
    st.it.fx = fxOff(fx) ? null : fx;
    $('fxHint').textContent = st.it.fx ? 'Saved. Download now includes these changes.' : 'Turned off. Download is back to the normal conversion.';
    convertItems([st.it]);
  });

  syncControls();
  syncTheme();
  render();
  loadSample().then(function () { if (items[0]) select(items[0]); render(); convertAll(); }).catch(function () { render(); });
})();