// Scanned table layout extractor.
//
// Pick a PDF, pick a page, drag a rectangle around a table. Everything below
// runs on the pixels inside that rectangle: no OCR, no text layer, no vector
// paths from the PDF. Every page is treated as a scan, because in practice the
// documents this was built for are scans.
//
// The page is rendered by the server; every stage after that happens here.

const $ = id => document.getElementById(id);
let DOCS = [], DOC = null, PAGES = [], POINTS = [], DPI = 150;
let W = 0, H = 0, pageImg = null;

// The rectangle the user drew, in raster pixels at the current dpi, or null.
let BOX = null;
// Remembered per page, so flipping away and back does not lose the work.
const BOXES = new Map();
const boxKey = () => `${DOC ? DOC.id : '?'}:${$('pageSel').value}`;

const api = {
  async docs() { return (await fetch('/api/docs')).json(); },
  async detail(id) { return (await fetch(`/api/docs/${id}?dpi=${DPI}`)).json(); },
  async upload(file) {
    const fd = new FormData();
    fd.append('file', file);
    const r = await fetch('/api/docs', { method: 'POST', body: fd });
    return r.json();
  },
  pageUrl(id, i) { return `/api/docs/${id}/page/${i}.png?dpi=${DPI}`; },
};

function setStatus(m) { $('status').textContent = m || ''; }
function count(m) { let n = 0; for (let i = 0; i < m.length; i++) n += m[i]; return n; }

// an arrow between cards, so the order reads as a pipeline rather than a gallery
function arrow(label) {
  const a = document.createElement('div');
  a.className = 'arrow';
  a.innerHTML = `<div class="ar">→</div>` + (label ? `<div class="al">${label}</div>` : '');
  return a;
}
// a labelled break where the pipeline forks
function fork(label) {
  const f = document.createElement('div');
  f.className = 'fork';
  f.innerHTML = `<div class="fl">${label}</div>`;
  return f;
}

// A PDF page is described in points (1/72 in), not pixels — the pixel count only
// exists once it is rendered and changes with dpi. Physical size does not, so it
// leads; pixels follow as the render detail.
const UNITS = {
  mm: { label: 'mm', from: pt => pt / 72 * 25.4, dp: 0 },
  cm: { label: 'cm', from: pt => pt / 72 * 2.54, dp: 1 },
  in: { label: 'in', from: pt => pt / 72,        dp: 2 },
  pt: { label: 'pt', from: pt => pt,             dp: 1 },
};
function unit() { return UNITS[$('unit').value] || UNITS.mm; }
function size(wPt, hPt) {
  const u = unit();
  return `${u.from(wPt).toFixed(u.dp)} × ${u.from(hPt).toFixed(u.dp)} ${u.label}`;
}

function loadImage(src) {
  return new Promise(res => {
    const img = new Image();
    img.onload = () => res(img);
    img.onerror = () => res(null);
    img.src = src;
  });
}

// ---------------------------------------------------------------------------
// Library
// ---------------------------------------------------------------------------
async function refreshDocs(selectId) {
  DOCS = await api.docs();
  const s = $('docSel');
  s.innerHTML = '';
  for (const d of DOCS) {
    const o = document.createElement('option');
    o.value = d.id; o.textContent = `${d.title}  (${d.pages}p)`;
    s.appendChild(o);
  }
  $('empty').hidden = DOCS.length > 0;
  $('work').hidden = DOCS.length === 0;
  if (DOCS.length) await openDoc(selectId || DOCS[0].id);
}

async function openDoc(id) {
  setStatus('loading…');
  const d = await api.detail(id);
  if (d.error) return setStatus(d.error);
  DOC = d; PAGES = d.geometry || []; POINTS = d.points || [];
  const sel = $('pageSel');
  sel.innerHTML = '';
  PAGES.forEach((p, i) => {
    const o = document.createElement('option');
    o.value = i; o.textContent = `page ${i + 1} / ${PAGES.length}`;
    sel.appendChild(o);
  });
  $('docSel').value = id;
  await showPage(0);
}

// ---------------------------------------------------------------------------
// The page, and the rectangle drawn on it.
//
// Drawing cannot happen on a thumbnail: an A4 page at 150 dpi is 1240x1755, and
// at thumbnail size one screen pixel would be ten raster pixels — coarser than
// the gaps the mend stage bridges. So the page gets its own view, displayed at
// whatever width fits and CSS-scaled, with the canvas backing store left at full
// raster resolution. Screen coordinates are converted through the element's own
// measured rectangle, so the mapping holds at any display scale and survives a
// window resize.
// ---------------------------------------------------------------------------
async function showPage(i) {
  $('pageSel').value = i;
  setStatus('loading…');
  $('out').innerHTML = '';

  pageImg = await loadImage(api.pageUrl(DOC.id, i));
  if (!pageImg) { setStatus('page failed to load'); return; }
  W = pageImg.naturalWidth; H = pageImg.naturalHeight;

  const c = $('page');
  c.width = W; c.height = H;
  c.getContext('2d').drawImage(pageImg, 0, 0);
  fitPage();

  BOX = BOXES.get(boxKey()) || null;
  drawBox();
  if (BOX) runBox(); else hint();
}

function hint() {
  $('out').innerHTML = '';
  const e = document.createElement('div');
  e.className = 'empty-note';
  e.textContent = 'Drag a rectangle around a table to run the pipeline.';
  $('out').appendChild(e);
  const pt = POINTS[+$('pageSel').value];
  setStatus(`${W} × ${H} px @ ${DPI} dpi` + (pt ? `  ·  ${size(pt.w, pt.h)}` : ''));
}

// display scale of the page canvas: CSS width over backing-store width
function pageScale() {
  const c = $('page');
  return c.clientWidth / c.width || 1;
}

function fitPage() {
  const avail = $('picker').clientWidth - 24;
  const c = $('page');
  c.style.width = Math.min(avail, W) + 'px';
  c.style.height = 'auto';
  drawBox();
}

// Screen point -> raster pixel. Read the rect live rather than caching a scale:
// a resize or a browser zoom then cannot desync the mapping.
function toRaster(ev) {
  const c = $('page');
  const r = c.getBoundingClientRect();
  const k = c.width / r.width;
  return {
    x: Math.round((ev.clientX - r.left) * k),
    y: Math.round((ev.clientY - r.top) * k),
  };
}

function clampBox(b) {
  const x0 = Math.max(0, Math.min(b.x0, b.x1)), x1 = Math.min(W, Math.max(b.x0, b.x1));
  const y0 = Math.max(0, Math.min(b.y0, b.y1)), y1 = Math.min(H, Math.max(b.y0, b.y1));
  return { x0, y0, x1, y1 };
}

function drawBox() {
  const r = $('rubber');
  if (!BOX) { r.hidden = true; syncFields(); return; }
  const k = pageScale();
  r.hidden = false;
  r.style.left = (BOX.x0 * k) + 'px';
  r.style.top = (BOX.y0 * k) + 'px';
  r.style.width = ((BOX.x1 - BOX.x0) * k) + 'px';
  r.style.height = ((BOX.y1 - BOX.y0) * k) + 'px';
  r.querySelector('.rlabel').textContent =
    `${BOX.x0}, ${BOX.y0} → ${BOX.x1}, ${BOX.y1}  ·  ${BOX.x1 - BOX.x0} × ${BOX.y1 - BOX.y0} px`;
  syncFields();
}

function syncFields() {
  for (const k of ['x0', 'y0', 'x1', 'y1']) $('f' + k).value = BOX ? BOX[k] : '';
}

function commitBox(b) {
  const n = clampBox(b);
  // an accidental click is not a box
  if (n.x1 - n.x0 < 20 || n.y1 - n.y0 < 20) { BOX = null; BOXES.delete(boxKey()); drawBox(); hint(); return; }
  BOX = n;
  BOXES.set(boxKey(), n);
  drawBox();
  runBox();
}

function initPicker() {
  const layer = $('drawLayer');
  let start = null;

  layer.addEventListener('pointerdown', e => {
    if (e.button !== 0) return;
    layer.setPointerCapture(e.pointerId);   // the drag survives leaving the page
    start = toRaster(e);
    BOX = { x0: start.x, y0: start.y, x1: start.x, y1: start.y };
    drawBox();
  });

  layer.addEventListener('pointermove', e => {
    if (!start) return;
    const p = toRaster(e);
    BOX = clampBox({ x0: start.x, y0: start.y, x1: p.x, y1: p.y });
    drawBox();
  });

  const finish = e => {
    if (!start) return;
    const p = toRaster(e);
    const b = { x0: start.x, y0: start.y, x1: p.x, y1: p.y };
    start = null;
    // the pipeline is several full-image passes plus an O(n^2) union-find, so it
    // runs once on release rather than on every pointermove
    commitBox(b);
  };
  layer.addEventListener('pointerup', finish);
  layer.addEventListener('pointercancel', () => { start = null; });

  // typed coordinates, so a box is reproducible and can be pasted from elsewhere
  for (const k of ['x0', 'y0', 'x1', 'y1']) {
    $('f' + k).addEventListener('change', () => {
      const b = { x0: +$('fx0').value, y0: +$('fy0').value, x1: +$('fx1').value, y1: +$('fy1').value };
      if ([b.x0, b.y0, b.x1, b.y1].every(v => Number.isFinite(v))) commitBox(b);
    });
  }

  $('clearBox').addEventListener('click', () => {
    BOX = null; BOXES.delete(boxKey()); drawBox(); hint();
  });

  // nudging, because at a fitted display scale one screen pixel is not one
  // raster pixel and some edges cannot be hit by dragging alone
  document.addEventListener('keydown', e => {
    if (!BOX || !$('zoom').hidden) return;
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;
    const d = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[e.key];
    if (!d) return;
    e.preventDefault();
    const s = e.shiftKey ? 10 : 1;
    const b = { ...BOX };
    if (e.altKey) { b.x1 += d[0] * s; b.y1 += d[1] * s; }         // resize
    else { b.x0 += d[0] * s; b.x1 += d[0] * s; b.y0 += d[1] * s; b.y1 += d[1] * s; }
    commitBox(b);
  });

  window.addEventListener('resize', fitPage);
}

// ---------------------------------------------------------------------------
// The pipeline, one card per stage.
// ---------------------------------------------------------------------------
function runBox() {
  const out = $('out');
  out.innerHTML = '';
  if (!BOX) return hint();

  const b = BOX;
  const bw = b.x1 - b.x0, bh = b.y1 - b.y0;
  const pt = POINTS[+$('pageSel').value];
  const ptW = pt ? (bw / W * pt.w) : 0, ptH = pt ? (bh / H * pt.h) : 0;
  const areaPct = 100 * (bw * bh) / (W * H);
  const k = enlargeFactor(bw, bh);

  setStatus(`box ${bw} × ${bh} px` + (pt ? `  ·  ${size(ptW, ptH)}` : ''));

  const dims = [
    ...(pt ? [['table', size(ptW, ptH)]] : []),
    ['box', `${b.x0}, ${b.y0} → ${b.x1}, ${b.y1}`],
    ['rendered', `${bw} × ${bh} px`],
    ['of page', `${areaPct.toFixed(1)}% area`],
  ];

  // 1 · straight out of the page, untouched
  out.appendChild(card(
    'as extracted',
    () => cropCanvas(b, 1, 'off'),
    dims,
    `as extracted, ${bw} × ${bh} px`
  ));

  // 2 · enlarged if it is small enough to need it, otherwise say so
  out.appendChild(arrow(k > 1 ? 'enlarge' : 'size check'));
  out.appendChild(card(
    k > 1 ? `enlarged ×${k.toFixed(1)}` : 'not enlarged',
    () => cropCanvas(b, k, 'off'),
    k > 1
      ? [['enlarged', `×${k.toFixed(2)}`],
         ['now', `${Math.round(bw * k)} × ${Math.round(bh * k)} px`],
         ['why', `${areaPct.toFixed(1)}% < ${ENLARGE_BELOW}% of page`]]
      : [['not enlarged', `${areaPct.toFixed(1)}% ≥ ${ENLARGE_BELOW}% of page`],
         ['shown at', `${bw} × ${bh} px`]],
    k > 1 ? `enlarged ×${k.toFixed(2)}` : 'natural size'
  ));

  // 3 · ink pushed toward black, greys kept
  out.appendChild(arrow('darken'));
  out.appendChild(card(
    'darkened',
    () => cropCanvas(b, k, 'darken'),
    [['tone', 'darken ink'],
     ['cut', `grey < ${$('cut').value}`],
     ['keeps', 'the grey gradient']],
    'darkened'
  ));

  // 4 · two values only
  out.appendChild(arrow('threshold'));
  out.appendChild(card(
    'binary',
    () => cropCanvas(b, k, 'binary'),
    [['tone', 'binary'],
     ['cut', `grey < ${$('cut').value}`],
     ['values', '0 or 255, nothing between']],
    'binary'
  ));

  const a = analyse(b, k);

  // 5 · repair the scan: bridge toner voids that split one rule into pieces
  out.appendChild(arrow('mend breaks'));
  out.appendChild(card(
    'mended',
    () => mendCanvas(a),
    a.mendSpan > 1
      ? [['bridges', `gaps under ${a.mendSpan} px`],
         ['added', `${a.mended.toLocaleString()} px (${(100 * a.mended / Math.max(1, count(a.scanned))).toFixed(1)}%)`],
         ['axes', 'closed separately, then unioned'],
         ['amber', 'the pixels filled in']]
      : [['mend', 'off'], ['note', 'raise the slider to bridge breaks']],
    'mended, added pixels in amber'
  ));

  out.appendChild(fork('every run of ink, read both ways'));
  out.appendChild(card(
    'horizontal lines',
    () => maskCanvas(a, 'h'),
    [['runs', `${a.hRuns.toLocaleString()} — every one`],
     ['longest', `${a.hMax} px`],
     ['filter', 'none: no length, no thickness'],
     ['shading', 'darker = longer run']],
    'horizontal lines'
  ));
  out.appendChild(arrow('rotate the test'));
  out.appendChild(card(
    'vertical lines',
    () => maskCanvas(a, 'v'),
    [['runs', `${a.vRuns.toLocaleString()} — every one`],
     ['longest', `${a.vMax} px`],
     ['filter', 'none: no length, no thickness'],
     ['shading', 'darker = longer run']],
    'vertical lines'
  ));
  out.appendChild(arrow('overlay'));
  out.appendChild(card(
    'lines combined',
    () => maskCanvas(a, 'both'),
    [['red', 'runs further horizontally'],
     ['blue', 'runs further vertically'],
     ['filter', 'none — every dark pixel is shown']],
    'lines combined'
  ));

  out.appendChild(arrow('merge runs into lines'));
  out.appendChild(card(
    'merged lines',
    () => lineCanvas(a, 'both', false),
    [['horizontal', `${a.hLines.length.toLocaleString()} lines`],
     ['vertical', `${a.vLines.length.toLocaleString()} lines`],
     ['from', `${a.hRuns.toLocaleString()} + ${a.vRuns.toLocaleString()} raw runs`],
     ['note', 'still unfiltered — glyph strokes included']],
    'merged lines'
  ));

  out.appendChild(arrow('keep only those that cross'));
  out.appendChild(card(
    'crossing lines',
    () => lineCanvas(a, 'both', true),
    [['horizontal', `${a.hKept.length} kept of ${a.hLines.length.toLocaleString()}`],
     ['vertical', `${a.vKept.length} kept of ${a.vLines.length.toLocaleString()}`],
     ['rule', `≥ ${a.minCross} crossings, each partner ≥ ${Math.round(a.minPartner)} px`],
     ['amber', 'the 90° crossings themselves']],
    'crossing lines: borders and dividers'
  ));

  out.appendChild(arrow('drop lines that never reach a second perpendicular'));
  out.appendChild(card(
    'spanning lines',
    () => lineCanvas(a, 'both', 'span'),
    [['horizontal', `${a.hSpan.length} kept of ${a.hKept.length}`],
     ['vertical', `${a.vSpan.length} kept of ${a.vKept.length}`],
     ['rule', 'both ends land inside a different perpendicular'],
     ['edge', 'the crop border counts as an anchor']],
    'spanning lines: each end on a different perpendicular'
  ));

  out.appendChild(arrow('keep the connected frame'));
  out.appendChild(card(
    'connected only',
    () => lineCanvas(a, 'both', 'conn'),
    [['horizontal', `${a.hConn.length}`],
     ['vertical', `${a.vConn.length}`],
     ['components', `${a.components} found, largest kept`],
     ['dropped', `${a.dropped} with no path to the frame`],
     ['green', 'the frame it spans']],
    'connected to the outer frame'
  ));

  out.appendChild(arrow('flood the closed regions'));
  out.appendChild(card(
    'cells',
    () => cellCanvas(a),
    [['cells', `${a.table ? a.table.cells.length : 0}`],
     ['lattice', a.table ? `${a.table.rows} × ${a.table.cols}` : '—'],
     ['merged', a.table ? `${a.table.spans} span more than one unit` : '—'],
     ['content', a.table ? `${a.table.filled} filled, ${a.table.empty} empty` : '—'],
     ['green', 'holds content; red is empty; amber outline merged']],
    'cells, green holds content'
  ));

  out.appendChild(arrow('lay them out as a table'));
  out.appendChild(card(
    'reconstructed',
    () => tableCanvas(a),
    [['rows', a.table ? `${a.table.rows}` : '—'],
     ['columns', a.table ? `${a.table.cols}` : '—'],
     ['cells', `${a.table ? a.table.cells.length : 0}`],
     ['filled', a.table ? `${a.table.filled} of ${a.table.cells.length}` : '—'],
     ['ragged', a.table ? `${a.table.ragged} not rectangular` : '—']],
    'reconstructed structure'
  ));
}

// ---------------------------------------------------------------------------
// Reading lines off the crop.
//
// Every long-thin run of ink is a candidate line. Length is a PERCENTAGE of the
// table, not a pixel count, so the same setting means the same thing whether the
// crop was enlarged or not, and at any dpi.
// ---------------------------------------------------------------------------

// run length through every pixel, both directions
function runLengths(ink, w, h) {
  const hl = new Uint16Array(w * h), vl = new Uint16Array(w * h);
  for (let y = 0; y < h; y++) {
    let x = 0;
    while (x < w) {
      if (ink[y * w + x]) {
        const s = x;
        while (x < w && ink[y * w + x]) x++;
        for (let k = s; k < x; k++) hl[y * w + k] = x - s;
      } else x++;
    }
  }
  for (let x = 0; x < w; x++) {
    let y = 0;
    while (y < h) {
      if (ink[y * w + x]) {
        const s = y;
        while (y < h && ink[y * w + x]) y++;
        for (let k = s; k < y; k++) vl[k * w + x] = y - s;
      } else y++;
    }
  }
  return { hl, vl };
}


// Raw runs are per-row, so a 6px-thick rule arrives as 6 separate one-pixel
// runs and every one of them looks short. Merge them into whole lines first:
// segments that sit in adjacent rows and overlap along their length are the
// same line. On the observed table this takes 12,117 raw horizontal runs down
// to 1,336 lines, of which 8 are ≥30px — the 6 rules plus the 2 strip dividers.
function mergeLines(mask, w, h, horiz) {
  const segs = [];
  const outer = horiz ? h : w, inner = horiz ? w : h;
  for (let i = 0; i < outer; i++) {
    let j = 0;
    while (j < inner) {
      const on = horiz ? mask[i * w + j] : mask[j * w + i];
      if (on) {
        const s = j;
        while (j < inner && (horiz ? mask[i * w + j] : mask[j * w + i])) j++;
        segs.push([i, i, s, j]);   // [lo, hi, start, end] in the run direction
      } else j++;
    }
  }
  segs.sort((a, b) => a[2] - b[2] || a[0] - b[0]);
  const out = [];
  for (const sg of segs) {
    let hit = null;
    for (const o of out) {
      if (o[1] + 1 < sg[0] || o[0] - 1 > sg[1]) continue;
      const ov = Math.min(o[3], sg[3]) - Math.max(o[2], sg[2]);
      if (ov > 0.6 * Math.min(o[3] - o[2], sg[3] - sg[2])) { hit = o; break; }
    }
    if (hit) {
      hit[0] = Math.min(hit[0], sg[0]); hit[1] = Math.max(hit[1], sg[1]);
      hit[2] = Math.min(hit[2], sg[2]); hit[3] = Math.max(hit[3], sg[3]);
    } else out.push(sg);
  }
  return out.map(([lo, hi, s, e]) => ({
    x0: horiz ? s : lo, x1: horiz ? e : hi + 1,
    y0: horiz ? lo : s, y1: horiz ? hi + 1 : e,
    len: e - s, thick: hi - lo + 1,
  }));
}

// Two lines cross when their spans overlap. Kept as its own step so the next
// stage can walk the connected paths.
function crosses(a, b) {
  return a.x0 <= b.x1 && b.x0 <= a.x1 && a.y0 <= b.y1 && b.y0 <= a.y1;
}

// a pixel belongs to the direction it runs further in
function hDom(ink, hl, vl, w, h, horiz) {
  const m = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) {
    if (!ink[i]) continue;
    m[i] = horiz ? (hl[i] >= vl[i] ? 1 : 0) : (vl[i] > hl[i] ? 1 : 0);
  }
  return m;
}

// ---------------------------------------------------------------------------
// Mend the scan before any line is read.
//
// A printed rule reaches the page as several pieces: the F-28 title block's
// y=298 rule arrives in five, split by holes of one and two pixels where the
// toner simply did not take. Those are defects in the paper, not structure, and
// every later stage — merging, crossing, spanning — treats each piece as its own
// short line and throws it away.
//
// A morphological close along ONE axis bridges a gap in a line without fattening
// it, so the two axes are closed separately and unioned. Text barely moves: the
// gaps inside a letter are two-dimensional and survive a purely horizontal or
// purely vertical close (measured on BRACKET: 577 ink px becomes 599).
//
// Width is in pixels of the working raster because a scan defect is physical —
// a toner void is the same size whether the table is large or small — but it is
// exposed as a control so it can be turned off or widened per document.
// ---------------------------------------------------------------------------
function closeGaps(ink, w, h, span) {
  if (!(span > 1)) return ink;
  const out = new Uint8Array(ink);
  // horizontal: fill a run of blanks shorter than `span` that has ink both sides
  for (let y = 0; y < h; y++) {
    const row = y * w;
    let last = -1;
    for (let x = 0; x < w; x++) {
      if (!ink[row + x]) continue;
      if (last >= 0 && x - last - 1 > 0 && x - last - 1 < span)
        for (let q = last + 1; q < x; q++) out[row + q] = 1;
      last = x;
    }
  }
  // vertical: the same test down each column
  for (let x = 0; x < w; x++) {
    let last = -1;
    for (let y = 0; y < h; y++) {
      if (!ink[y * w + x]) continue;
      if (last >= 0 && y - last - 1 > 0 && y - last - 1 < span)
        for (let q = last + 1; q < y; q++) out[q * w + x] = 1;
      last = y;
    }
  }
  let n = 0;
  for (let i = 0; i < out.length; i++) if (out[i] && !ink[i]) n++;
  out.added = n;
  return out;
}

function analyse(b, k) {
  const w = Math.round((b.x1 - b.x0) * k), h = Math.round((b.y1 - b.y0) * k);
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const x = c.getContext('2d');
  x.imageSmoothingEnabled = false;
  x.drawImage(pageImg, b.x0, b.y0, b.x1 - b.x0, b.y1 - b.y0, 0, 0, w, h);
  const d = x.getImageData(0, 0, w, h).data;
  const cut = +$('cut').value;
  const scanned = new Uint8Array(w * h);
  for (let i = 0, j = 0; i < w * h; i++, j += 4) scanned[i] = d[j] < cut ? 1 : 0;
  // repair the scan first: every stage below reads `ink`, so a rule broken by a
  // toner void must be whole before the first run is counted
  const mendSpan = +$('mend').value;
  const ink = closeGaps(scanned, w, h, mendSpan);
  const mended = ink.added || 0;

  // NO length filter and NO thickness filter. Every horizontal run of dark
  // pixels is a horizontal line; every vertical run is a vertical line. A glyph
  // stroke is therefore a line too — that is what "show all" means, and the two
  // masks below are dense because the image genuinely is.
  const { hl, vl } = runLengths(ink, w, h);
  const hLine = new Uint8Array(w * h), vLine = new Uint8Array(w * h);
  let hRuns = 0, vRuns = 0, hMax = 0, vMax = 0;
  for (let i = 0; i < w * h; i++) {
    if (!ink[i]) continue;
    hLine[i] = 1; vLine[i] = 1;
    if (hl[i] > hMax) hMax = hl[i];
    if (vl[i] > vMax) vMax = vl[i];
  }
  for (let y = 0; y < h; y++) {
    let x2 = 0;
    while (x2 < w) {
      if (ink[y * w + x2]) { hRuns++; while (x2 < w && ink[y * w + x2]) x2++; } else x2++;
    }
  }
  for (let x2 = 0; x2 < w; x2++) {
    let y = 0;
    while (y < h) {
      if (ink[y * w + x2]) { vRuns++; while (y < h && ink[y * w + x2]) y++; } else y++;
    }
  }
  // merged whole lines, and which of them actually cross something
  const hLines = mergeLines(hDom(ink, hl, vl, w, h, true), w, h, true);
  const vLines = mergeLines(hDom(ink, hl, vl, w, h, false), w, h, false);
  const minPartner = (+$('crossMin').value / 100) * Math.min(w, h);
  const minCross = +$('crossN').value;
  const vBig = vLines.filter(l => l.len >= minPartner);
  const hBig = hLines.filter(l => l.len >= minPartner);

  // A line is kept when it crosses at least `minCross` distinct partners.
  // Default 1: a single 90° connection is the rule. The control exists only
  // because a denser table may want more; it is not applied by default.
  const hKept = hLines.filter(a => vBig.filter(b => crosses(a, b)).length >= minCross);
  const vKept = vLines.filter(a => hBig.filter(b => crosses(a, b)).length >= minCross);

  // Trim each survivor to the span its crossings actually cover, so a rule ends
  // at the grid rather than running on into whatever ink continues past it.
  // No trimming: a line is kept whole, exactly as merged.

  // A real divider runs from one perpendicular ACROSS to another. A glyph stroke
  // touches a rule and dies inside the same cell, so both of its ends land on the
  // same partner — or on no partner at all. Require the two ends to be anchored
  // on DIFFERENT perpendiculars; the crop border counts as an anchor, and each
  // border is its own, so a frame rule spanning the whole crop still passes.
  // (Page 8 of the equipment list: 288 verticals fall to 74, every one of the 214
  // dropped being a Chinese glyph stem; both pages keep all their real rules.)
  const spanOK = (line, partners, horiz, limit) => {
    const lo = horiz ? line.x0 : line.y0;
    const hi = horiz ? line.x1 : line.y1;
    const holds = (p, v) => horiz ? (p.x0 <= v && v <= p.x1) : (p.y0 <= v && v <= p.y1);
    const hits = partners.filter(p => crosses(line, p));
    const a = lo <= 0 ? ['lo'] : hits.filter(p => holds(p, lo));
    const b = hi >= limit ? ['hi'] : hits.filter(p => holds(p, hi));
    if (!a.length || !b.length) return false;
    return a.some(p => b.some(q => p !== q));
  };
  const hSpan = hKept.filter(l => spanOK(l, vKept, true, w));
  const vSpan = vKept.filter(l => spanOK(l, hKept, false, h));

  // Connected paths. Treat every surviving line as a node and every 90° crossing
  // as an edge, then keep only the component the outer border belongs to — the
  // largest by bounding box. Anything floating inside a cell, with no path out to
  // the frame, is not part of the table. (Measured on the manual's title block:
  // 27 components collapse to 1, dropping 26 fragments.)
  const all = [...hSpan.map(l => ({ ...l, horiz: true })),
               ...vSpan.map(l => ({ ...l, horiz: false }))];
  const parent = all.map((_, i) => i);
  const find = a => { while (parent[a] !== a) { parent[a] = parent[parent[a]]; a = parent[a]; } return a; };
  const union = (a, b) => { const ra = find(a), rb = find(b); if (ra !== rb) parent[ra] = rb; };
  for (let i = 0; i < all.length; i++) {
    for (let j = i + 1; j < all.length; j++) {
      if (all[i].horiz !== all[j].horiz && crosses(all[i], all[j])) union(i, j);
    }
  }
  const box = new Map();
  all.forEach((l, i) => {
    const r = find(i);
    const b2 = box.get(r) || { x0: w, y0: h, x1: 0, y1: 0, n: 0 };
    b2.x0 = Math.min(b2.x0, l.x0); b2.y0 = Math.min(b2.y0, l.y0);
    b2.x1 = Math.max(b2.x1, l.x1); b2.y1 = Math.max(b2.y1, l.y1);
    b2.n++;
    box.set(r, b2);
  });
  let root = null, bestArea = -1;
  for (const [r, b2] of box) {
    const area = (b2.x1 - b2.x0) * (b2.y1 - b2.y0);
    if (area > bestArea) { bestArea = area; root = r; }
  }
  const connected = all.filter((_, i) => find(i) === root);
  const hConn = connected.filter(l => l.horiz);
  const vConn = connected.filter(l => !l.horiz);
  const frame = box.get(root) || { x0: 0, y0: 0, x1: w, y1: h };

  // Clustering has one job: merge the two edges of a single thick rule into one
  // lattice coordinate. So the tolerance is the thickest rule actually found —
  // read off the data, not chosen. (7px on the F-28 title block, 16px here.)
  const ruleThick = Math.max(1,
    ...hConn.map(l => l.y1 - l.y0), ...vConn.map(l => l.x1 - l.x0));
  const table = buildTable(hConn, vConn, frame, ruleThick);
  if (table) fillCells(table, ink, w, h);

  return { w, h, ink, scanned, mended, mendSpan,
           hl, vl, hLine, vLine, text: ink, hRuns, vRuns, hMax, vMax,
           hLines, vLines, hKept, vKept, hSpan, vSpan, hConn, vConn,
           components: box.size, dropped: all.length - connected.length,
           frame, minPartner, minCross, ruleThick, table };
}

// ---------------------------------------------------------------------------
// Lines -> cells.
//
// Snap every rule onto a shared lattice, record which lattice edges carry a real
// rule, then flood each open interior. A flood cannot step across a rule, so it
// stops exactly at the cell walls: a merged cell comes out as one region however
// many lattice units it covers, and nothing has to be told in advance which
// merges exist.
//
// The frame's own four sides are added as implicit rules. A table's outermost
// column is bounded on one side by the sheet border rather than by a printed
// line, so without them the side strip never closes and its cells are lost.
// ---------------------------------------------------------------------------
function buildTable(hConn, vConn, frame, tol) {
  const cluster = vals => {
    const s = [...vals].sort((a, b) => a - b), out = [];
    let grp = [];
    for (const v of s) {
      if (grp.length && v - grp[grp.length - 1] <= tol) grp.push(v);
      else { if (grp.length) out.push(Math.round(grp.reduce((a, b) => a + b) / grp.length)); grp = [v]; }
    }
    if (grp.length) out.push(Math.round(grp.reduce((a, b) => a + b) / grp.length));
    return out;
  };

  const hs = [...hConn,
              { x0: frame.x0, x1: frame.x1, y0: frame.y0, y1: frame.y0 + 1 },
              { x0: frame.x0, x1: frame.x1, y0: frame.y1 - 1, y1: frame.y1 }];
  const vs = [...vConn,
              { x0: frame.x0, x1: frame.x0 + 1, y0: frame.y0, y1: frame.y1 },
              { x0: frame.x1 - 1, x1: frame.x1, y0: frame.y0, y1: frame.y1 }];

  const xs = cluster(vs.map(v => (v.x0 + v.x1) / 2));
  const ys = cluster(hs.map(h => (h.y0 + h.y1) / 2));
  if (xs.length < 2 || ys.length < 2) return null;
  const nx = xs.length - 1, ny = ys.length - 1;
  const snap = (arr, v) => {
    let best = 0;
    for (let i = 1; i < arr.length; i++) if (Math.abs(arr[i] - v) < Math.abs(arr[best] - v)) best = i;
    return best;
  };

  // vwall[i][j]: a vertical rule stands on lattice column j across row band i
  const vwall = Array.from({ length: ny }, () => new Array(nx + 1).fill(false));
  const hwall = Array.from({ length: ny + 1 }, () => new Array(nx).fill(false));
  for (const v of vs) {
    const j = snap(xs, (v.x0 + v.x1) / 2);
    const a = snap(ys, v.y0), b = snap(ys, v.y1);
    for (let i = Math.min(a, b); i < Math.max(a, b); i++) vwall[i][j] = true;
  }
  for (const hh of hs) {
    const i = snap(ys, (hh.y0 + hh.y1) / 2);
    const a = snap(xs, hh.x0), b = snap(xs, hh.x1);
    for (let j = Math.min(a, b); j < Math.max(a, b); j++) hwall[i][j] = true;
  }

  const lab = Array.from({ length: ny }, () => new Array(nx).fill(-1));
  const cells = [];
  for (let i = 0; i < ny; i++) {
    for (let j = 0; j < nx; j++) {
      if (lab[i][j] >= 0) continue;
      const n = cells.length, stack = [[i, j]], mem = [];
      lab[i][j] = n;
      while (stack.length) {
        const [r, c] = stack.pop();
        mem.push([r, c]);
        if (c + 1 < nx && !vwall[r][c + 1] && lab[r][c + 1] < 0) { lab[r][c + 1] = n; stack.push([r, c + 1]); }
        if (c - 1 >= 0 && !vwall[r][c] && lab[r][c - 1] < 0) { lab[r][c - 1] = n; stack.push([r, c - 1]); }
        if (r + 1 < ny && !hwall[r + 1][c] && lab[r + 1][c] < 0) { lab[r + 1][c] = n; stack.push([r + 1, c]); }
        if (r - 1 >= 0 && !hwall[r][c] && lab[r - 1][c] < 0) { lab[r - 1][c] = n; stack.push([r - 1, c]); }
      }
      const r0 = Math.min(...mem.map(m => m[0])), r1 = Math.max(...mem.map(m => m[0]));
      const c0 = Math.min(...mem.map(m => m[1])), c1 = Math.max(...mem.map(m => m[1]));
      cells.push({
        row: r0, col: c0, rowspan: r1 - r0 + 1, colspan: c1 - c0 + 1,
        x0: xs[c0], x1: xs[c1 + 1], y0: ys[r0], y1: ys[r1 + 1],
        units: mem.length,
        // an L- or T-shaped region covers fewer units than its bounding box;
        // HTML cannot express that, so it is worth flagging rather than hiding
        rect: mem.length === (r1 - r0 + 1) * (c1 - c0 + 1),
      });
    }
  }
  cells.sort((a, b) => a.row - b.row || a.col - b.col);
  return {
    xs, ys, rows: ny, cols: nx, cells,
    spans: cells.filter(c => c.rowspan > 1 || c.colspan > 1).length,
    ragged: cells.filter(c => !c.rect).length,
  };
}

// merged lines, optionally only those that cross the other direction
function lineCanvas(a, which, keptOnly) {
  const { w, h } = a;
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, w, h);
  // the ink underneath, very pale, for orientation
  const im = ctx.getImageData(0, 0, w, h), d = im.data;
  for (let i = 0, j = 0; i < w * h; i++, j += 4) if (a.ink[i]) { d[j] = d[j+1] = d[j+2] = 226; }
  ctx.putImageData(im, 0, 0);

  const pick = { conn: ['hConn', 'vConn'], span: ['hSpan', 'vSpan'] }[keptOnly];
  const hs = pick ? a[pick[0]] : keptOnly ? a.hKept : a.hLines;
  const vs = pick ? a[pick[1]] : keptOnly ? a.vKept : a.vLines;
  if (which !== 'v') {
    ctx.fillStyle = 'rgba(200,30,30,.9)';
    for (const l of hs) ctx.fillRect(l.x0, l.y0, Math.max(1, l.x1 - l.x0), Math.max(1, l.y1 - l.y0));
  }
  if (which !== 'h') {
    ctx.fillStyle = 'rgba(30,90,210,.9)';
    for (const l of vs) ctx.fillRect(l.x0, l.y0, Math.max(1, l.x1 - l.x0), Math.max(1, l.y1 - l.y0));
  }
  if (keptOnly === 'conn' && a.frame) {
    ctx.strokeStyle = 'rgba(40,180,90,.95)'; ctx.lineWidth = 2;
    ctx.strokeRect(a.frame.x0 + .5, a.frame.y0 + .5,
                   a.frame.x1 - a.frame.x0, a.frame.y1 - a.frame.y0);
  }
  // mark every crossing
  if (which === 'both' && keptOnly) {
    ctx.fillStyle = 'rgba(255,170,0,.95)';
    for (const p of hs) for (const q of vs) {
      if (!crosses(p, q)) continue;
      const x = Math.max(p.x0, q.x0), y = Math.max(p.y0, q.y0);
      ctx.fillRect(x - 2, y - 2, Math.max(5, Math.min(p.x1, q.x1) - x + 4),
                                 Math.max(5, Math.min(p.y1, q.y1) - y + 4));
    }
  }
  return c;
}

function maskCanvas(a, which) {
  const { w, h } = a;
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const ctx = c.getContext('2d');
  const im = ctx.createImageData(w, h), d = im.data;
  const len = which === 'h' ? a.hl : a.vl;
  const max = which === 'h' ? a.hMax : a.vMax;
  for (let i = 0, j = 0; i < w * h; i++, j += 4) {
    let col = [255, 255, 255];
    if (which === 'both') {
      // whichever direction this pixel runs further in
      if (a.ink[i]) col = a.hl[i] >= a.vl[i] ? [200, 30, 30] : [30, 90, 210];
    } else if (a.ink[i]) {
      // every run is drawn; longer runs darker, so the rules stand out of the
      // text without anything being filtered away
      const t = max ? Math.min(1, len[i] / max) : 0;
      col = which === 'h'
        ? [Math.round(255 - 215 * t), Math.round(200 - 190 * t), Math.round(200 - 190 * t)]
        : [Math.round(200 - 190 * t), Math.round(210 - 130 * t), Math.round(255 - 60 * t)];
    }
    d[j] = col[0]; d[j + 1] = col[1]; d[j + 2] = col[2]; d[j + 3] = 255;
  }
  ctx.putImageData(im, 0, 0);
  return c;
}
function pageCanvas(box) {
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  const x = c.getContext('2d');
  x.drawImage(pageImg, 0, 0);
  if (box) {
    x.strokeStyle = 'rgba(230,30,160,.95)';
    x.lineWidth = Math.max(2, Math.round(W / 500));
    x.strokeRect(box.x0, box.y0, box.x1 - box.x0, box.y1 - box.y0);
  }
  return c;
}

// A table covering most of the sheet needs no help; a small one is unreadable at
// natural size. The trigger is AREA, not width: a wide thin strip and a small
// square can share a width while occupying very different amounts of the page.
// Measured here, 33 of 47 tables fall under the threshold.
const ENLARGE_BELOW = 40;   // % of page area
const CROP_TARGET = 1000;   // px wide to aim for
const CROP_MAX_UP = 4;      // never magnify beyond this

function enlargeFactor(bw, bh) {
  if (!$('upscale').checked) return 1;
  const areaPct = 100 * (bw * bh) / (W * H);
  if (areaPct >= ENLARGE_BELOW) return 1;
  return Math.max(1, Math.min(CROP_MAX_UP, CROP_TARGET / bw));
}

function cropCanvas(b, k, mode) {
  const w = b.x1 - b.x0, h = b.y1 - b.y0;
  k = k || 1;
  const c = document.createElement('canvas');
  c.width = Math.round(w * k); c.height = Math.round(h * k);
  const x = c.getContext('2d');
  // Smoothing off for line art, and always off in binary: interpolation invents
  // midtones between black and white, which the threshold would then split on an
  // arbitrary edge and leave ragged.
  x.imageSmoothingEnabled = k < 1.5 && mode !== 'binary';
  x.drawImage(pageImg, b.x0, b.y0, w, h, 0, 0, c.width, c.height);
  applyTone(x, c.width, c.height, mode);
  return c;
}

// The render is already 8-bit grey, but antialiasing leaves strokes averaging
// well above black (measured: mean grey 61, with 1.5% of pixels in a soft
// 128-190 midtone). Two ways to tighten that:
//
//   binary  — one threshold, every pixel goes pure black or pure white. Sharpest
//             for line art, but a faint stroke can vanish entirely.
//   darken  — keep the greys, push anything below the cut toward black and
//             anything above it toward white. Safer: nothing is lost outright.
function applyTone(ctx, w, h, mode) {
  if (!mode || mode === 'off' || !w || !h) return;
  const cut = +$('cut').value;
  const im = ctx.getImageData(0, 0, w, h), d = im.data;

  for (let i = 0; i < d.length; i += 4) {
    const v = d[i];
    let out;
    if (mode === 'binary') {
      out = v < cut ? 0 : 255;
    } else {
      // piecewise stretch about the cut: ink to black, paper to white, and the
      // gradient between them preserved rather than clipped
      out = v < cut
        ? Math.round(v * 0.35 * (v / cut))
        : Math.round(255 - (255 - v) * 0.35 * ((255 - v) / (255 - cut || 1)));
    }
    d[i] = d[i + 1] = d[i + 2] = out;
  }
  ctx.putImageData(im, 0, 0);
}

function dimsNode(rows) {
  const d = document.createElement('dl');
  d.className = 'dims';
  for (const [k, v] of rows) d.innerHTML += `<dt>${k}</dt><dd>${v}</dd>`;
  return d;
}

// `make` is called twice: once for the card thumbnail, once full size for the viewer
// ---------------------------------------------------------------------------
// Which cells hold content.
//
// Read the same binary ink the lines came from, inset so a cell's own borders
// fall outside the sample, and group what is left into blobs. A cell is filled
// when a blob survives two tests:
//
//   size  — bigger than a speck of scanner dirt (0.05% of the cell)
//   shape — not a residual rule. A border that outlives the inset spans nearly
//           the full width or height while being a sliver in the other axis;
//           a glyph never is. Without this the 60px "1" in a QTY cell and a
//           leftover 2x94 border sliver both read as content.
//
// Both thresholds are fractions of the cell, so a tall narrow strip and a wide
// data cell are judged on the same terms and nothing depends on the dpi.
// ---------------------------------------------------------------------------
const CELL_INSET = 0.06;   // of the cell's shorter side
const BLOB_MIN = 0.0005;   // of the cell's area
const RULE_SPAN = 0.9;     // a blob reaching this much of an axis...
const RULE_THIN = 0.05;    // ...while this thin in the other, is a leftover rule

function fillCells(table, ink, w, h) {
  for (const c of table.cells) {
    const cw = c.x1 - c.x0, ch = c.y1 - c.y0;
    const m = Math.max(3, Math.round(Math.min(cw, ch) * CELL_INSET));
    const x0 = Math.max(0, c.x0 + m), x1 = Math.min(w, c.x1 - m);
    const y0 = Math.max(0, c.y0 + m), y1 = Math.min(h, c.y1 - m);
    const sw = x1 - x0, sh = y1 - y0;
    c.ink = 0; c.blobs = 0; c.filled = false;
    if (sw <= 0 || sh <= 0) continue;

    // flood each blob once, tracking its area and bounding box
    const seen = new Uint8Array(sw * sh);
    const area = sw * sh;
    const minArea = Math.max(6, Math.round(area * BLOB_MIN));
    const stack = [];
    let total = 0;
    for (let y = 0; y < sh; y++) {
      for (let x = 0; x < sw; x++) {
        const i = y * sw + x;
        if (seen[i] || !ink[(y0 + y) * w + (x0 + x)]) continue;
        let n = 0, bx0 = x, bx1 = x, by0 = y, by1 = y;
        seen[i] = 1; stack.length = 0; stack.push(i);
        while (stack.length) {
          const p = stack.pop(), py = (p / sw) | 0, px = p - py * sw;
          n++;
          if (px < bx0) bx0 = px; if (px > bx1) bx1 = px;
          if (py < by0) by0 = py; if (py > by1) by1 = py;
          for (let dy = -1; dy <= 1; dy++) {
            for (let dx = -1; dx <= 1; dx++) {
              const qx = px + dx, qy = py + dy;
              if (qx < 0 || qy < 0 || qx >= sw || qy >= sh) continue;
              const q = qy * sw + qx;
              if (seen[q] || !ink[(y0 + qy) * w + (x0 + qx)]) continue;
              seen[q] = 1; stack.push(q);
            }
          }
        }
        total += n;
        if (n < minArea) continue;
        const bw = bx1 - bx0 + 1, bh = by1 - by0 + 1;
        if (bw >= sw * RULE_SPAN && bh <= Math.max(2, sh * RULE_THIN)) continue;
        if (bh >= sh * RULE_SPAN && bw <= Math.max(2, sw * RULE_THIN)) continue;
        c.blobs++;
      }
    }
    c.ink = total / area;
    c.filled = c.blobs > 0;
  }
  table.filled = table.cells.filter(c => c.filled).length;
  table.empty = table.cells.length - table.filled;
}

// The scan in black with the repaired pixels in amber, so what the mend invented
// is always visible rather than silently folded into the ink.
function mendCanvas(a) {
  const { w, h } = a;
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const ctx = c.getContext('2d');
  const im = ctx.createImageData(w, h), d = im.data;
  for (let i = 0, j = 0; i < w * h; i++, j += 4) {
    const added = a.ink[i] && !a.scanned[i];
    d[j]     = added ? 240 : (a.ink[i] ? 20 : 255);
    d[j + 1] = added ? 140 : (a.ink[i] ? 20 : 255);
    d[j + 2] = added ? 0   : (a.ink[i] ? 20 : 255);
    d[j + 3] = 255;
  }
  ctx.putImageData(im, 0, 0);
  return c;
}

// Each cell filled and outlined over the page ink, so a merged cell is visibly
// one block rather than a run of separate ones.
function cellCanvas(a) {
  const { w, h } = a, t = a.table;
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, w, h);
  const im = ctx.getImageData(0, 0, w, h), d = im.data;
  for (let i = 0, j = 0; i < w * h; i++, j += 4) if (a.ink[i]) { d[j] = d[j+1] = d[j+2] = 216; }
  ctx.putImageData(im, 0, 0);
  if (!t) return c;

  ctx.lineWidth = Math.max(1, Math.round(Math.min(w, h) / 700));
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.font = `${Math.max(9, Math.round(Math.min(w, h) / 70))}px ui-monospace,monospace`;
  for (const cell of t.cells) {
    const span = cell.rowspan > 1 || cell.colspan > 1;
    // fill says content, hatching says empty; the outline still says merged
    ctx.fillStyle = cell.filled ? 'rgba(60,150,90,.18)' : 'rgba(210,70,70,.13)';
    ctx.fillRect(cell.x0, cell.y0, cell.x1 - cell.x0, cell.y1 - cell.y0);
    ctx.strokeStyle = span ? 'rgba(220,120,0,.95)' : 'rgba(70,90,120,.55)';
    ctx.lineWidth = span ? Math.max(2, Math.round(Math.min(w, h) / 450)) : 1;
    ctx.strokeRect(cell.x0 + .5, cell.y0 + .5, cell.x1 - cell.x0 - 1, cell.y1 - cell.y0 - 1);
    ctx.fillStyle = cell.filled ? 'rgba(20,90,50,.9)' : 'rgba(150,40,40,.85)';
    const lbl = span ? `r${cell.row}c${cell.col} ${cell.rowspan}×${cell.colspan}`
                     : `r${cell.row}c${cell.col}`;
    ctx.fillText(lbl, (cell.x0 + cell.x1) / 2, (cell.y0 + cell.y1) / 2);
  }
  return c;
}

// The same cells laid out as a table of their own: every cell at its real
// proportions, nothing of the page behind it. This is the structure that would
// become HTML.
function tableCanvas(a) {
  const t = a.table;
  const c = document.createElement('canvas');
  if (!t) { c.width = c.height = 1; return c; }
  const w = t.xs[t.xs.length - 1] - t.xs[0], h = t.ys[t.ys.length - 1] - t.ys[0];
  const pad = Math.round(Math.min(w, h) * 0.02);
  c.width = w + pad * 2; c.height = h + pad * 2;
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
  const ox = pad - t.xs[0], oy = pad - t.ys[0];

  ctx.lineWidth = Math.max(1, Math.round(Math.min(w, h) / 500));
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  const fs = Math.max(9, Math.round(Math.min(w, h) / 60));
  for (const cell of t.cells) {
    const span = cell.rowspan > 1 || cell.colspan > 1;
    const x = cell.x0 + ox, y = cell.y0 + oy;
    const cw = cell.x1 - cell.x0, chh = cell.y1 - cell.y0;
    ctx.fillStyle = cell.filled ? '#e8f4ec' : '#fff';
    ctx.fillRect(x, y, cw, chh);
    ctx.strokeStyle = span ? '#c07000' : '#444';
    ctx.lineWidth = span ? Math.max(2, Math.round(Math.min(w, h) / 400)) : 1;
    ctx.strokeRect(x + .5, y + .5, cw - 1, chh - 1);
    ctx.fillStyle = cell.filled ? '#2a6b45' : '#bbb';
    ctx.font = `${fs}px ui-monospace,monospace`;
    ctx.fillText(cell.filled ? `${cell.row},${cell.col}` : '—',
                 x + cw / 2, y + chh / 2 - (span ? fs * 0.6 : 0));
    if (span) {
      ctx.fillStyle = '#b06000';
      ctx.font = `${Math.round(fs * 0.95)}px ui-monospace,monospace`;
      ctx.fillText(`${cell.rowspan}×${cell.colspan}`, x + cw / 2, y + chh / 2 + fs * 0.6);
    }
  }
  return c;
}

function card(label, make, dims, zoomTitle) {
  const el = document.createElement('div');
  el.className = 'card';
  el.innerHTML = `<div class="lbl">${label}</div>`;

  const th = document.createElement('div');
  th.className = 'thumb';
  th.appendChild(make());
  th.addEventListener('click', () => openZoom(make(), zoomTitle, dims));
  el.appendChild(th);

  el.appendChild(dimsNode(dims));
  const h = document.createElement('div');
  h.className = 'hintline'; h.textContent = 'click to view full size';
  el.appendChild(h);
  return el;
}
// ---------- full-size viewer ----------
let zCanvas = null, zScale = 1;

function openZoom(canvas, title, dims) {
  zCanvas = canvas;
  $('ztitle').textContent = title + '  ·  ' + dims.map(([k, v]) => `${k} ${v}`).join('  ·  ');
  $('zbody').innerHTML = '';
  $('zbody').appendChild(canvas);
  $('zoom').hidden = false;
  zoomFit();
}
function applyZoom() {
  if (!zCanvas) return;
  zCanvas.style.width = Math.round(zCanvas.width * zScale) + 'px';
  zCanvas.style.height = 'auto';
  $('zpct').textContent = Math.round(zScale * 100) + '%';
}
function setZoom(z) { zScale = Math.max(0.05, Math.min(8, z)); applyZoom(); }
function zoomFit() {
  if (!zCanvas) return;
  const body = $('zbody');
  setZoom(Math.min(
    (body.clientWidth - 40) / zCanvas.width,
    (body.clientHeight - 40) / zCanvas.height,
  ));
}
function closeZoom() { $('zoom').hidden = true; zCanvas = null; }

$('zin').addEventListener('click', () => setZoom(zScale * 1.25));
$('zout').addEventListener('click', () => setZoom(zScale / 1.25));
$('zfit').addEventListener('click', zoomFit);
$('z100').addEventListener('click', () => setZoom(1));
$('zclose').addEventListener('click', closeZoom);
$('zoom').addEventListener('click', e => { if (e.target.id === 'zoom') closeZoom(); });
document.addEventListener('keydown', e => {
  if ($('zoom').hidden) return;
  if (e.key === 'Escape') closeZoom();
  if (e.key === '+' || e.key === '=') setZoom(zScale * 1.25);
  if (e.key === '-' || e.key === '_') setZoom(zScale / 1.25);
  if (e.key === '0') zoomFit();
});

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------
$('docSel').addEventListener('change', e => openDoc(e.target.value));
$('pageSel').addEventListener('change', e => showPage(+e.target.value));
$('unit').addEventListener('change', () => { if (BOX) runBox(); else hint(); });
$('upscale').addEventListener('change', () => { if (BOX) runBox(); });

for (const id of ['cut', 'mend', 'crossMin', 'crossN']) {
  $(id).addEventListener('input', () => {
    $('cutOut').textContent = $('cut').value;
    $('mendOut').textContent = +$('mend').value ? $('mend').value + ' px' : 'off';
    $('crossMinOut').textContent = $('crossMin').value + '%';
    $('crossNOut').textContent = $('crossN').value;
  });
  $(id).addEventListener('change', () => { if (BOX) runBox(); });
}

// Changing dpi re-renders the page at a new pixel size, so the box has to be
// rescaled or it would mark a different region of the paper.
$('dpi').addEventListener('change', async () => {
  const was = DPI;
  DPI = +$('dpi').value;
  const k = DPI / was;
  for (const [key, b] of BOXES) {
    BOXES.set(key, {
      x0: Math.round(b.x0 * k), y0: Math.round(b.y0 * k),
      x1: Math.round(b.x1 * k), y1: Math.round(b.y1 * k),
    });
  }
  if (DOC) {
    const at = +$('pageSel').value;
    await openDoc(DOC.id);
    await showPage(at);
  }
});

async function handleFiles(files) {
  const pdfs = [...files].filter(f => /\.pdf$/i.test(f.name) || f.type === 'application/pdf');
  if (!pdfs.length) return setStatus('not a PDF');
  setStatus(`uploading ${pdfs.length} file(s)…`);
  let last = null;
  for (const f of pdfs) {
    const r = await api.upload(f);
    if (r.error) { setStatus(r.error); return; }
    last = r.id;
  }
  await refreshDocs(last);
}

$('file').addEventListener('change', e => handleFiles(e.target.files));
$('file2').addEventListener('change', e => handleFiles(e.target.files));

// drop anywhere on the window, not just on the drop zone
for (const ev of ['dragenter', 'dragover']) {
  document.addEventListener(ev, e => { e.preventDefault(); document.body.classList.add('dragging'); });
}
for (const ev of ['dragleave', 'drop']) {
  document.addEventListener(ev, e => {
    e.preventDefault();
    if (ev === 'drop' || e.relatedTarget === null) document.body.classList.remove('dragging');
  });
}
document.addEventListener('drop', e => {
  if (e.dataTransfer && e.dataTransfer.files.length) handleFiles(e.dataTransfer.files);
});

$('delDoc').addEventListener('click', async () => {
  if (!DOC) return;
  if (!confirm(`Remove "${DOC.title}" from the library?`)) return;
  await fetch(`/api/docs/${DOC.id}`, { method: 'DELETE' });
  BOXES.clear();
  DOC = null;
  $('out').innerHTML = '';
  await refreshDocs();
});

(async function init() {
  initPicker();
  await refreshDocs();
  if (!DOCS.length) setStatus('no documents yet');
})();
