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

// How large the page is drawn, as a multiple of its raster size. null = fit the
// window. It only ever affects display: a box is always recorded in raster
// pixels, so the pipeline sees the same crop whatever the zoom.
let PAGEZOOM = null;

// Show only the stages that produce the table, or every stage of every route.
// Defaults to the short route: the full strip is for working on the pipeline.
let SHORT_VIEW = true;

// Which panels of a stacked comparison view are shown: crop, graph, cells.
// One to study something closely, two to compare, three for the overview.
const PANELS = [true, true, true];

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

// ---------------------------------------------------------------------------
// Telling the user the app is busy rather than broken.
//
// The pipeline is synchronous and runs on the main thread: a dozen full-crop
// canvas renders plus an O(n^2) union-find over every surviving line. Nothing
// repaints while that runs, so a spinner set immediately before the work would
// never be drawn — the browser would go straight from "spinner hidden" to
// "spinner hidden, cards done" without a frame in between.
//
// So `busy()` sets the message and then WAITS for a painted frame before
// returning. Two rAFs: the first fires before the coming paint, the second
// after it, at which point the spinner is provably on screen. Only then does
// the caller start blocking.
// ---------------------------------------------------------------------------
// busyDepth counts holders, so a page load starting inside a pipeline run does
// not clear the spinner when only one of the two finishes. Each showBusy is
// paired with exactly one hideBusy; setBusyMsg changes the wording without
// taking another hold.
let busyDepth = 0;

function showBusy(msg) {
  busyDepth++;
  setBusyMsg(msg);
  $('busy').hidden = false;
}

function setBusyMsg(msg) { $('busyMsg').textContent = msg || 'working…'; }

function hideBusy() {
  busyDepth = Math.max(0, busyDepth - 1);
  if (!busyDepth) $('busy').hidden = true;
}

const painted = () => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));

// Show `msg`, let it paint, run `work`, then clear. `work` may be sync or async.
async function busy(msg, work) {
  showBusy(msg);
  try {
    await painted();
    return await work();
  } finally {
    hideBusy();
  }
}

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

  // A page render is a server round trip — at 400 dpi it is not instant — so it
  // gets the spinner too, and the picker dims until the new page is on screen.
  showBusy(`rendering page ${+i + 1} at ${DPI} dpi…`);
  $('picker').classList.add('busy');
  try {
    pageImg = await loadImage(api.pageUrl(DOC.id, i));
  } finally {
    $('picker').classList.remove('busy');
    hideBusy();
  }
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

// The scale that shows the whole page inside the scroll viewport. Both axes are
// considered: a portrait A4 is limited by height, so fitting on width alone
// would still leave the table below the fold.
function fitScale() {
  const v = $('scroll');
  if (!W || !H) return 1;
  const pad = 22;                                   // the viewport's own padding
  const kw = (v.clientWidth - pad) / W;
  const kh = (v.clientHeight - pad) / H;
  return Math.max(0.05, Math.min(kw, kh));
}

// null means "track the window": the page re-fits on resize until the user
// picks a scale, and going back to `fit` restores that behaviour.
// Named apart from the card viewer's applyZoom/setZoom further down: two
// function declarations sharing a name would leave only the last one.
function applyPageZoom() {
  const k = PAGEZOOM === null ? fitScale() : PAGEZOOM;
  const c = $('page');
  c.style.width = (W * k) + 'px';
  c.style.height = (H * k) + 'px';
  $('pzPct').textContent = PAGEZOOM === null
    ? `fit ${Math.round(k * 100)}%` : `${Math.round(k * 100)}%`;
  drawBox();
}

const fitPage = applyPageZoom;

// Zoom about a fixed point of the paper, so the table under the cursor — or in
// the middle of the view — stays put instead of sliding off as the page grows.
function setPageZoom(k, anchor) {
  const v = $('scroll');
  const prev = PAGEZOOM === null ? fitScale() : PAGEZOOM;
  const ax = anchor ? anchor.x : (v.scrollLeft + v.clientWidth / 2) / prev;
  const ay = anchor ? anchor.y : (v.scrollTop + v.clientHeight / 2) / prev;
  const ox = anchor ? anchor.ox : v.clientWidth / 2;
  const oy = anchor ? anchor.oy : v.clientHeight / 2;

  PAGEZOOM = k === null ? null : Math.max(0.05, Math.min(8, k));
  applyPageZoom();

  const now = PAGEZOOM === null ? fitScale() : PAGEZOOM;
  v.scrollLeft = ax * now - ox;
  v.scrollTop = ay * now - oy;
}

const pageZoomStep = f => setPageZoom((PAGEZOOM === null ? fitScale() : PAGEZOOM) * f);

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

  // ---- page zoom ----
  $('pzIn').addEventListener('click', () => pageZoomStep(1.25));
  $('pzOut').addEventListener('click', () => pageZoomStep(1 / 1.25));
  $('pzFit').addEventListener('click', () => setPageZoom(null));
  $('pz100').addEventListener('click', () => setPageZoom(1));

  // Ctrl/⌘ + wheel, the gesture every map and image viewer already uses. The
  // anchor is the pixel of paper under the cursor, so it does not drift.
  $('scroll').addEventListener('wheel', e => {
    if (!e.ctrlKey && !e.metaKey) return;
    e.preventDefault();
    const v = $('scroll'), r = v.getBoundingClientRect();
    const k = PAGEZOOM === null ? fitScale() : PAGEZOOM;
    const ox = e.clientX - r.left, oy = e.clientY - r.top;
    setPageZoom(k * Math.exp(-e.deltaY * 0.0015),
                { x: (v.scrollLeft + ox) / k, y: (v.scrollTop + oy) / k, ox, oy });
  }, { passive: false });

  // Zoom keys are their own handler: they work before a box exists, which is
  // exactly when you need them — to find the table in the first place.
  document.addEventListener('keydown', e => {
    if (!$('zoom').hidden) return;                  // the card viewer has its own
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;
    if (e.key === '+' || e.key === '=') { e.preventDefault(); pageZoomStep(1.25); }
    else if (e.key === '-' || e.key === '_') { e.preventDefault(); pageZoomStep(1 / 1.25); }
    else if (e.key === '0') { e.preventDefault(); setPageZoom(null); }
    else if (e.key === '1') { e.preventDefault(); setPageZoom(1); }
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
// Re-entrancy guard: dragging a slider fires `change` repeatedly, and a second
// run starting mid-flight would interleave cards from two different settings.
// Each run takes a ticket; a run whose ticket is stale stops appending.
let runTicket = 0;

async function runBox() {
  const out = $('out');
  out.innerHTML = '';
  if (!BOX) return hint();

  const ticket = ++runTicket;
  const stale = () => ticket !== runTicket;

  // Stand-in for the cards, so the strip is never just an empty gap.
  const note = document.createElement('div');
  note.className = 'working';
  note.innerHTML = '<span class="spin"></span><span>running the pipeline…</span>'
                 + '<span class="sub">finding lines, then cells</span>';
  out.appendChild(note);

  showBusy('reading the crop…');
  await painted();              // let the spinner and the note reach the screen
  if (stale()) { hideBusy(); return; }

  try {
    await buildCards(out, note, stale);
  } finally {
    if (!stale()) note.remove();
    hideBusy();
  }
}

async function buildCards(out, note, stale) {
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

  // ---------------------------------------------------------------------
  // Which stages to show.
  //
  // The full strip is every stage of every route, which is what you want when
  // working on the pipeline and far too much when you only want to see it run.
  // The short route keeps the path that actually produces the table and drops
  // the rest — the line-based stages, the per-direction masks, the variant
  // pickers. Nothing about the pipeline changes; the cards it does not show are
  // simply not appended.
  // ---------------------------------------------------------------------
  const SHORT = ['as extracted', 'enlarged', 'not enlarged', 'darkened', 'binary',
                 'mended', 'junctions', 'junction graph', 'table from junctions'];
  const showAll = !SHORT_VIEW;
  const keep = title => showAll ||
    SHORT.some(s => title === s || title.startsWith(s + ' '));
  // append a card only when its stage is in the chosen set; an arrow is kept
  // only if the card that follows it is
  let pendingArrow = null;
  const add = (el, title) => {
    if (title === undefined) { pendingArrow = el; return; }   // an arrow or fork
    if (!keep(title)) { pendingArrow = null; return; }
    if (pendingArrow && out.children.length) out.appendChild(pendingArrow);
    pendingArrow = null;
    out.appendChild(el);
  };

  // 1 · straight out of the page, untouched
  add(card(
    'as extracted',
    () => cropCanvas(b, 1, 'off'),
    dims,
    `as extracted, ${bw} × ${bh} px`
  ),
    'as extracted');

  // 2 · enlarged if the box is ticked, otherwise shown at natural size
  add(arrow(k > 1 ? 'enlarge' : 'size check'));
  add(card(
    k > 1 ? `enlarged ×${k.toFixed(2)}` : 'not enlarged',
    () => cropCanvas(b, k, 'off'),
    k > 1
      ? [['area', `×${ENLARGE_AREA} — twice the pixel count`],
         ['each side', `×${k.toFixed(3)}  (√${ENLARGE_AREA})`],
         ['now', `${Math.round(bw * k)} × ${Math.round(bh * k)} px`],
         ['from', `${bw} × ${bh} px`],
         ['note', 'upscaling interpolates: a rule that wanders 2px on the paper ' +
           'wanders more once enlarged, and the junction pairing absorbs that']]
      : [['shown at', `${bw} × ${bh} px`],
         ['of page', `${areaPct.toFixed(1)}% area`],
         ['enlarge', 'off — tick “enlarge” in the toolbar for twice the area']],
    k > 1 ? `enlarged ×${k.toFixed(2)}` : 'natural size'
  ),
    k > 1 ? `enlarged ×${k.toFixed(2)}` : 'not enlarged');

  // 3 · every pixel toward black, none toward white
  const g = darkenGamma();
  add(arrow('darken'));
  add(card(
    'darkened',
    () => cropCanvas(b, k, 'darken'),
    [['curve', g > 1 ? `gamma ×${g.toFixed(1)}` : 'off — raw scan'],
     ['moves', 'every pixel toward black'],
     ['example', g > 1
        ? `grey 150 → ${darkenValue(150, g)}, 90 → ${darkenValue(90, g)}`
        : 'unchanged']],
    'darkened'
  ),
    'darkened');

  // 4 · two values only, read off the darkened grey
  add(arrow('threshold'));
  add(card(
    'binary',
    () => cropCanvas(b, k, 'binary'),
    [['tone', 'binary'],
     ['cut', `darkened grey < ${$('cut').value}`],
     ['values', '0 or 255, nothing between']],
    'binary'
  ),
    'binary');

  // The four tone cards are cheap and already on screen. `analyse` is the
  // expensive part — run-lengths over every pixel, merging, then the O(n^2)
  // union-find — so hand the browser a frame to draw them first, and say what
  // is happening while it runs.
  if (stale()) return;
  setBusyMsg('finding lines…');
  await painted();
  if (stale()) return;

  const t0 = performance.now();
  const a = analyse(b, k);
  const took = Math.round(performance.now() - t0);

  if (stale()) return;
  setBusyMsg('drawing the stages…');
  await painted();
  if (stale()) return;

  // 5 · repair the scan: bridge toner voids that split one rule into pieces
  add(arrow('mend breaks'));
  add(card(
    'mended',
    () => mendCanvas(a),
    a.mendSpan > 1
      ? [['bridges', `gaps under ${Math.round(a.mendSpan)} px (${a.mendPct}% of the crop)`],
         ['added', `${a.mended.toLocaleString()} px (${(100 * a.mended / Math.max(1, count(a.scanned))).toFixed(1)}%)`],
         ['axes', 'closed separately, then unioned'],
         ['amber', 'the pixels filled in']]
      : [['mend', 'off'], ['note', 'raise the slider to bridge breaks']],
    'mended, added pixels in amber'
  ),
    'mended');

  add(fork('every run of ink, read both ways'));
  // Each direction gets the full set of cleaning variants, applied to ITS OWN
  // axis: the horizontal mask judged on x-continuity, the vertical on y. The
  // counts under each row are recomputed from that mask, so they are what the
  // pipeline would really see, not an estimate.
  add(listCard(
    'horizontal lines',
    sel => dirCanvas(a, sel ? sel.key : 'none', true),
    [['runs', `${a.hRuns.toLocaleString()} — every one`],
     ['longest', `${a.hMax} px`],
     ['ink', `${a.inkPx.toLocaleString()} px (${(100 * a.inkPx / a.area).toFixed(1)}% of crop)`],
     ['mean run', `${a.hRuns ? (a.inkPx / a.hRuns).toFixed(1) : 0} px`],
     ['filter', 'none: no length, no thickness'],
     ['drawing', 'flat black — every detected pixel, no shading'],
     ['try', 'pick a cleaning rule below — each is tested along x']],
    'horizontal lines',
    dirRows(a, true)
  ),
    'horizontal lines');
  add(arrow('rotate the test'));
  add(listCard(
    'vertical lines',
    sel => dirCanvas(a, sel ? sel.key : 'none', false),
    [['runs', `${a.vRuns.toLocaleString()} — every one`],
     ['longest', `${a.vMax} px`],
     ['ink', `${a.inkPx.toLocaleString()} px (${(100 * a.inkPx / a.area).toFixed(1)}% of crop)`],
     ['mean run', `${a.vRuns ? (a.inkPx / a.vRuns).toFixed(1) : 0} px`],
     ['filter', 'none: no length, no thickness'],
     ['drawing', 'flat black — every detected pixel, no shading'],
     ['try', 'pick a cleaning rule below — each is tested along y']],
    'vertical lines',
    dirRows(a, false)
  ),
    'vertical lines');
  add(arrow('overlay'));
  // The morphology comparison. Each row recomputes the mask, the run lengths
  // and the merge from scratch, so the counts underneath are what the pipeline
  // would really see if that variant were switched on — not an estimate.
  const variantRows = MASK_VARIANTS.map(m => ({
    key: m.key, colour: m.key === 'none' ? '#8a8f99'
                       : m.key.startsWith('erode') ? '#1a9850'
                       : m.key.startsWith('open') ? '#66bd63' : '#a50026',
    label: m.label.replace(/ \(.*\)/, ''),
    get note() { const v = variantOf(a, m.key); return `${(v.hRuns + v.vRuns).toLocaleString()} runs`; },
    get dims() {
      const v = variantOf(a, m.key);
      const base = variantOf(a, 'none');
      const dRuns = v.hRuns + v.vRuns, bRuns = base.hRuns + base.vRuns;
      const dLines = v.hL.length + v.vL.length, bLines = base.hL.length + base.vL.length;
      const pc = (x, b) => b ? `${x > b ? '+' : ''}${(100 * (x - b) / b).toFixed(0)}%` : '—';
      return [
        ['variant', m.label],
        ['what it does', m.note],
        ['—— what the pipeline would see ——', ''],
        ['ink', `${v.px.toLocaleString()} px (${(100 * v.px / a.area).toFixed(1)}% of crop)` +
                (m.key === 'none' ? '' : `   ${pc(v.px, base.px)} vs current`)],
        ['raw runs', `${dRuns.toLocaleString()}` +
                (m.key === 'none' ? '' : `   ${pc(dRuns, bRuns)} vs current`)],
        ['merged lines', `${dLines.toLocaleString()}` +
                (m.key === 'none' ? '' : `   ${pc(dLines, bLines)} vs current`)],
        ['rule-length lines', `${v.longH} h + ${v.longV} v = ${v.longH + v.longV}` +
                (m.key === 'none' ? '' : `   was ${base.longH + base.longV}`)],
        ['worst fusion', `${v.worst} runs in one group` +
                (m.key === 'none' ? '' : `   was ${base.worst}`)],
        ['—— reading it ——', ''],
        ...(m.key === 'none'
          ? [['the picture', 'the original on its own — pick any row below to see it ' +
                             'beside that variant']]
          : [['left panel', 'ORIGINAL — the pipeline as it works today'],
             ['right panel', 'this variant'],
             ['pale grey', 'ink the variant removed, shown in place']]),
        ['red', 'runs further horizontally'],
        ['blue', 'runs further vertically'],
        ['what to look for', 'rules should stay solid while text breaks up; ' +
          'rule-length lines going UP means the text was fragmenting them'],
      ];
    },
  }));
  add(listCard(
    'lines combined',
    sel => variantCanvas(a, sel ? sel.key : 'none'),
    [['crop', `${a.w} × ${a.h} px = ${(a.area / 1e6).toFixed(2)} Mpx`],
     ['ink', `${a.inkPx.toLocaleString()} px (${(100 * a.inkPx / a.area).toFixed(1)}%)`],
     ['runs', `${a.hRuns.toLocaleString()} h + ${a.vRuns.toLocaleString()} v = ${(a.hRuns + a.vRuns).toLocaleString()}`],
     ['red', 'runs further horizontally'],
     ['blue', 'runs further vertically'],
     ['try', 'pick a morphology below to see it on this page']],
    'lines combined',
    variantRows
  ),
    'lines combined');

  // ---- junctions, straight off the pixels ----
  // Before any line is built: where is a pixel part of a long horizontal run
  // AND a long vertical one at once? That is a crossing, and on a table the
  // answers land on the lattice.
  const JREACH = Math.max(8, Math.round(0.02 * Math.min(a.w, a.h)));
  const jn = findJunctions(a, JREACH);
  // the graph annotates its own copy of these points with degree/missing, so
  // look the matching one up by position to report what the edges made of it
  const jGraph = junctionGraph(a, JREACH);
  for (const p of jn.list) {
    const q = jGraph.pts.find(g => g.x === p.x && g.y === p.y);
    if (q) { p.degree = q.degree; p.missing = q.missing; p.missingArms = q.missingArms; }
  }
  const kindCount = k => jn.list.filter(p => p.kind === k).length;
  const jRows = jn.list.map(p => ({
    pt: p,
    colour: (JUNCTION_KINDS[p.kind] || JUNCTION_KINDS.end)[0],
    label: `${p.x}, ${p.y}`,
    note: p.kind,
    dims: [
      ['at', `x=${p.x}  y=${p.y}`],
      ['kind', `${p.kind} — ${(JUNCTION_KINDS[p.kind] || JUNCTION_KINDS.end)[1]}`],
      ['arms', `${p.nArms} of 4 reach ≥ ${JREACH} px`],
      ...(p.degree !== undefined ? [
        ['edges built', `${p.degree}` + (p.missing
          ? `  — ${p.missing} arm${p.missing === 1 ? '' : 's'} unmatched: ${p.missingArms.join(', ')}`
          : '  — every arm matched')],
      ] : []),
      ['left', `${p.armL} px`], ['right', `${p.armR} px`],
      ['up', `${p.armU} px`], ['down', `${p.armD} px`],
      ['cluster', `${p.n} px, ${p.x1 - p.x0 + 1} × ${p.y1 - p.y0 + 1}`],
      ['drawn', 'the qualifying arms are drawn through the selected point'],
    ],
  }));
  add(arrow('where the runs cross'));
  add(listCard(
    'junctions',
    sel => junctionCanvas(a, JREACH, sel),
    [['found', `${jn.list.length} junctions from ${jn.px.toLocaleString()} junction pixels`],
     ['test', `the run through the pixel is ≥ ${JREACH} px in BOTH axes`],
     ['why a reach', 'neighbour counting alone is useless — every pixel inside a ' +
       '3px rule has all four neighbours, so a third of the ink looks like a junction'],
     ['clustered', 'touching junction pixels are one crossing, reported at its centre'],
     ...Object.entries(JUNCTION_KINDS).map(([k, [col, why]]) =>
        [k, `${kindCount(k)} — ${why}`]),
     ['note', 'read straight off the pixels: no lines, no merging, no filtering']],
    `junctions: runs long in both axes, reach ≥ ${JREACH} px`,
    jRows
  ),
    'junctions');

  // ---- the junction graph ----
  // Join each junction to its nearest neighbour along each axis, but only where
  // ink actually runs the whole way. Components fall out of that graph, and the
  // one enclosing the most area is the table; everything else — the title text,
  // the stamp — has no ink path to the frame and drops away.
  const G = junctionGraph(a, JREACH);
  const gRows = G.comps.map((cp, i) => ({
    comp: cp,
    colour: cp === G.main ? '#0a7d2c' : '#b03030',
    label: `${cp.x0},${cp.y0} → ${cp.x1},${cp.y1}`,
    note: `${cp.n} pts`,
    dims: [
      ['component', cp === G.main ? 'THE TABLE — kept' : `#${i + 1} — dropped`],
      ['junctions', `${cp.n}`],
      ['edges', `${cp.edges}`],
      ['bounds', `${cp.x0},${cp.y0} → ${cp.x1},${cp.y1}`],
      ['size', `${cp.x1 - cp.x0} × ${cp.y1 - cp.y0} px`],
      ['area', `${(cp.area / (a.w * a.h) * 100).toFixed(1)}% of the crop`],
      ['why kept', cp === G.main
        ? 'its junctions enclose the largest area, so it is the outer frame'
        : 'no ink path to the frame — a stamp, a heading box, or text'],
    ],
  }));
  add(arrow('join adjacent junctions'));
  add(listCard(
    'junction graph',
    sel => graphCanvas(a, JREACH, sel),
    [['junctions', `${G.pts.length}`],
     ['edges', `${G.edges.length} — ink runs the whole way between the two points`],
     ['components', `${G.comps.length}`],
     ['kept', G.main ? `${G.main.n} junctions, ${G.main.edges} edges` : '—'],
     ['dropped', `${G.pts.length - (G.main ? G.main.n : 0)} junctions in ${Math.max(0, G.comps.length - 1)} other components`],
     ['lattice', `${G.lattice.cols.length} columns × ${G.lattice.rows.length} rows`],
     ['green', 'the component that holds the frame'],
     ['red', 'everything with no path to it'],
     ['dashed blue', 'the lattice the kept junctions imply'],
     ['edge test', 'ink along ≥ 90% of the span, no gap wider than 2% of the crop'],
     ['rescued', `${G.rescued} edge${G.rescued === 1 ? '' : 's'} found behind a ` +
       `candidate that failed — these were lost outright before`],
     ['straightened', `${G.straightened} junctions moved onto their rule’s line` +
       (G.straightened ? `, largest correction ${G.maxShift} px` : '')],
     ['why straighten', 'a rule that is straight on paper wanders a few px in the ' +
       'raster; the table snaps edge ends to the lattice independently, so a ' +
       'drifting rule lands on two different grid lines and cells leak through'],
     ...(G.suspect ? [['⚠ over-corrected', `${G.suspect} junctions moved further ` +
       `than the pairing tolerance — that group may be two rules, not one`]] : []),
     ['unmatched arms', `${G.unmatched}` + (G.unmatched
       ? ' — a rule the pixels show but no edge was built for. Ringed in orange.'
       : ' — every arm the pixels show has an edge')],
     ['lattice tol', `${G.tol} px — 0.4% of the page, for grouping rows and columns`],
     ['pair tol', `${G.pairBase} px + ${(G.pairDrift * 100).toFixed(1)}% of the span ` +
       `— ${G.pairTol(100)} px at 100 px apart, ${G.pairTol(Math.max(a.w, a.h))} px across the page`],
     ['why two', 'grouping needs a tight tolerance or adjacent columns merge; pairing ' +
       'needs a loose one, because skew and the wobble in a junction’s own position ' +
       'both grow with distance'],
     ['vs the old step', 'that one asks whether two LINE BOXES overlap, so a fused ' +
       'text bar welds unrelated things together. This asks whether ink actually runs ' +
       'between two real crossings.']],
    'junction graph: adjacent junctions joined where ink runs between them',
    gRows
  ),
    'junction graph');

  // ---- the table, built from the graph ----
  // Lattice from the junction coordinates, walls from the graph edges, cells by
  // flooding. Nothing here comes from a merged line.
  const GT = tableFromGraph(a, JREACH);
  const gt = GT && GT.table;
  const gtRows = gt ? gt.cells.map(cell => ({
    cell,
    colour: !cell.rect ? '#7b1fa2'
          : (cell.rowspan > 1 || cell.colspan > 1) ? '#c07000'
          : cell.filled ? '#2e7d32' : '#b03030',
    label: `r${cell.row} c${cell.col}` +
      ((cell.rowspan > 1 || cell.colspan > 1) ? ` · ${cell.rowspan}×${cell.colspan}` : '') +
      (cell.holes && cell.holes.length ? ` −${cell.holes.length}` : ''),
    note: cell.filled ? 'filled' : 'empty',
    dims: [
      ['cell', `row ${cell.row}, col ${cell.col}`],
      ['span', `${cell.rowspan} row${cell.rowspan > 1 ? 's' : ''} × ${cell.colspan} col${cell.colspan > 1 ? 's' : ''}`],
      ['box', `${cell.x0},${cell.y0} → ${cell.x1},${cell.y1}`],
      ['corners', `${cell.corners} turns, from ${cell.nodes} junctions on the ` +
        'boundary — a junction the side passes through is not a corner'],
      ...(cell.holes && cell.holes.length ? [
        ['contains', `${cell.holes.length} cell${cell.holes.length > 1 ? 's' : ''} — ` +
          cell.holes.map(o => `${o.rowspan}×${o.colspan} at ${o.x0},${o.y0}`).join('; ')],
        ['so really', `${cell.rowspan}×${cell.colspan} minus ` +
          cell.holes.map(o => `${o.rowspan}×${o.colspan}`).join(' and ')],
        ['net area', `${cell.netArea.toLocaleString()} px of ` +
          `${((cell.x1 - cell.x0) * (cell.y1 - cell.y0)).toLocaleString()}`],
      ] : []),
      ['size', `${cell.x1 - cell.x0} × ${cell.y1 - cell.y0} px`],
      ['content', cell.filled ? 'holds ink' : 'empty'],
      ['ink in it', `${((cell.ink || 0) * 100).toFixed(1)}% of the cell, in ${cell.blobs || 0} blob${cell.blobs === 1 ? '' : 's'}`],
      ['shape', cell.rect ? 'rectangular — four turns'
        : `${cell.corners} turns — an L or T, which HTML cannot express`],
      ['on the page', `x ${cell.x0}–${cell.x1}, y ${cell.y0}–${cell.y1} of the crop`],
      ['highlight', 'marked on both panels — the region on the scan, the cell on ' +
        'the right; blue dots are the junctions that close it'],
    ],
  })) : [];
  add(arrow('close the loops'));
  add(listCard(
    'table from junctions',
    sel => graphTableCanvas(a, JREACH, sel),
    gt
      ? [['cells', `${gt.cells.length} — each the smallest loop through an edge`],
         ['euler check', `${gt.euler} expected from E − V + C` +
           (gt.euler === gt.cells.length ? '  ✓ matches'
             : `  ⚠ found ${gt.cells.length}`)],
         ['merged', `${gt.spans} span more than one row or column`],
         ['content', `${gt.cells.filter(c => c.filled).length} filled, ${gt.cells.filter(c => !c.filled).length} empty`],
         ['ragged', `${gt.ragged} with more than four extreme corners`],
         ...(gt.cells.some(c => c.holes.length) ? [['nested',
           `${gt.cells.filter(c => c.holes.length).length} cells contain others — ` +
           'reported as the outer minus its inners, and their content is not ' +
           'counted twice. Marked ⌧ on the cells panel.']] : []),
         ...(gt.stubs ? [['stubs', `${gt.stubs} edges enclose nothing`]] : []),
         ...(gt.orphans.length ? [['orphan junctions',
           `${gt.orphans.length} closed no loop — the graph found them but they ` +
           'bound no cell. Ringed on the graph panel.']] : []),
         ['grid', `${gt.cols} columns × ${gt.rows} rows — indices only, derived ` +
           'from where the cells sit'],
         ['—— the panels ——', ''],
         ['crop', 'the scan, untouched'],
         ['graph', 'the junction graph the cells were read from'],
         ['cells', 'the cells themselves, on white'],
         ['switching', 'the crop / graph / cells buttons in the header show any ' +
           'one, two or all three — one to study, two to compare, three for the ' +
           'overview. The zoom and position are held while you switch.'],
         ['arrangement', 'whichever tiling renders the panels largest in the ' +
           'window you have — stacked, abreast, or an L — so a wide crop in a ' +
           'wide window does not stack and waste the width'],
         ['hovering', 'points at the same spot on every panel at once — crosshairs ' +
           'plus the cell under the cursor, so the crop, the graph and the cells ' +
           'can be read against each other'],
         ['—— the graph panel ——', ''],
         ['green line', 'an edge in the kept component — ink runs the whole way'],
         ['red line', 'an edge in some other component, with no path to the frame'],
         ['green dot', 'a junction in the kept component'],
         ['red dot', 'a junction dropped with its component'],
         ['orange ring', 'a junction with an arm the pixels show but no edge for'],
         ['purple ring', 'a junction no loop closed around — it bounds no cell'],
         ['—— the cells panel ——', ''],
         ['green', 'holds content'],
         ['red', 'empty'],
         ['amber', 'spans more than one row or column'],
         ['purple', 'more than four turns — an L or T'],
         ['blue dots', 'the junctions where each cell’s boundary turns'],
         ['—— how ——', ''],
         ['straightened', `${GT.G.straightened} junctions moved onto their rule’s line` +
           (GT.G.straightened ? `, largest ${GT.G.maxShift} px` : '')],
         ['geometry', 'every cell box is its own junctions, at the measured ' +
           'positions — so the content test samples the real pixels'],
         ['no lattice', 'a cell is the smallest loop of edges through an edge — ' +
           'nodes and edges only, no directions or angles. A region that is not ' +
           'enclosed cannot close a loop, so an empty margin cannot become a cell'],
         ['compare', `the line-based route gives ${a.table ? `${a.table.rows} × ${a.table.cols}, ${a.table.cells.length} cells` : 'nothing'}`]]
      : [['result', 'no closed loops — the graph encloses nothing'],
         ['try', 'a smaller reach, or check the junction graph card above']],
    'table from junctions: crop, the graph, and the cells read off it',
    gtRows
  ),
    'table from junctions');

  // Each stage reported as "in -> out", and the length histogram spelled out,
  // because the totals alone hide the shape. The peak list is the useful view:
  // a coordinate where the lines actually pile up, with how much of the span
  // they cover and in how many pieces — one piece at 98% is a printed rule,
  // forty pieces at 40% is a row of type.
  const peakList = (ps, axis) => ps.length
    ? ps.slice(0, 8).map(p =>
        `${axis}=${p.at} ${Math.round(p.cover * 100)}%/${p.pieces}p`).join('  ')
    : 'none above the threshold';
  add(arrow('merge runs into lines, then straighten broken rules'));
  add(card(
    'merged lines',
    () => lineCanvas(a, 'both', false),
    [['raw runs', `${a.hRuns.toLocaleString()} h + ${a.vRuns.toLocaleString()} v = ${(a.hRuns + a.vRuns).toLocaleString()}`],
     ['after merge', `${a.hMerged.length.toLocaleString()} h + ${a.vMerged.length.toLocaleString()} v = ${(a.hMerged.length + a.vMerged.length).toLocaleString()}`],
     ['after join', `${a.hLines.length.toLocaleString()} h + ${a.vLines.length.toLocaleString()} v = ${(a.hLines.length + a.vLines.length).toLocaleString()}`],
     ['longest', `${a.hLongest} px h · ${a.vLongest} px v`],
     ['rule rows', `${a.hPeaks.length} at ≥ ${Math.round(a.ruleCover * 100)}% of the width`],
     ['at y', peakList(a.hPeaks, 'y')],
     ['rule cols', `${a.vPeaks.length} at ≥ ${Math.round(a.ruleCover * 100)}% of the height`],
     ['at x', peakList(a.vPeaks, 'x')],
     ['reading', '“y=247 98%/1p” = that row is 98% covered, by 1 fragment'],
     ['note', 'still unfiltered — glyph strokes included']],
    'merged lines'
  ),
    'merged lines');

  // What the merge actually did, run by run. Two views: the before/after pair
  // with every absorption drawn, and the same page tinted by how many runs each
  // line swallowed.
  const allMerged = [...a.hMerged, ...a.vMerged];
  const byParts = allMerged.slice().sort((p, q) => q.parts.length - p.parts.length);
  const tally = MERGE_HEAT.map(([lo, hi, , label]) => ({
    label, n: allMerged.filter(l => l.parts.length >= lo && l.parts.length <= hi).length,
  }));

  // One row per merged group, biggest first, each clickable. Selecting a row
  // redraws with that group alone and replaces the rail with EVERYTHING known
  // about it: the diagnosis, then a table with one line per raw run and the
  // exact numbers its join turned on. Nothing truncated.
  // Row objects are built on demand: the label and count are cheap and needed
  // for every row, but the dims and the per-run table are only ever read for
  // the one that is selected, and building 2,000+ of them up front is wasted
  // work on every re-render.
  const rowData = l => {
    const axis = l.horiz ? 'y' : 'x';
    const at = l.horiz ? l.y0 : l.x0;
    const j = l.joins;
    // the loosest join this group made: the one that passed by the least
    const worst = j.length
      ? j.reduce((m, q) => (q.ov - q.need < m.ov - m.need ? q : m), j[0])
      : null;

    // A rule occupies `thick` rows and should therefore be built from about
    // `thick` runs — one per row. Far more means it also ate things sitting on
    // those rows, which on a scan means text.
    const expect = Math.max(1, l.thick);
    const ratio = l.parts.length / expect;
    const verdict = ratio <= 1.5 ? 'consistent with one printed rule'
                  : ratio <= 3 ? 'more runs than rows — some fusion'
                  : `${ratio.toFixed(0)}× more runs than rows — fused text`;

    // distinct start positions: a real rule starts at the same x on every row
    const starts = l.parts.map(p => p.s);
    const uniqStarts = new Set(starts).size;

    return {
      line: l, colour: mergeColour(l.parts.length),
      label: `${axis}=${at} · ${l.len}px`,
      note: `${l.parts.length} runs`,
      dims: [
        ['—— the merged line ——', ''],
        ['position', `${axis}=${at}   box ${l.x0},${l.y0} → ${l.x1},${l.y1}`],
        ['size', `${l.len} px long · ${l.thick} px thick`],
        ['direction', l.horiz ? 'horizontal' : 'vertical'],
        ['—— what built it ——', ''],
        ['raw runs', `${l.parts.length}`],
        ['rows it spans', `${l.thick}  (a clean rule needs about one run per row)`],
        ['runs per row', `${ratio.toFixed(1)}×`],
        ['verdict', verdict],
        ['distinct starts', `${uniqStarts} of ${l.parts.length}` +
          (uniqStarts <= 2 ? '  — one column, so these are rows of one rule'
                           : '  — scattered, so these are separate marks')],
        ['start range', `${Math.min(...starts)} … ${Math.max(...starts)}`],
        ...(worst ? [
          ['—— the loosest join ——', ''],
          ['overlap', `${Math.round(worst.ov)} px`],
          ['needed', `${worst.need.toFixed(1)} px  = 60% of ${worst.shorter}px`],
          ['the 60% is of', `the SHORTER side — so a wide bar is never measured on its own width`],
          ['group was', `${worst.groupWas[2]}..${worst.groupWas[3]} (${worst.groupWas[3] - worst.groupWas[2]}px) at that moment`],
        ] : [['joins', 'none — a single run, untouched']]),
        ['—— colours ——', ''],
        ['green', 'the seed run'],
        ['orange', 'every run absorbed into it'],
      ],
      // the full table, rendered separately so it can be wide and scrollable
      table: {
        head: ['#', l.horiz ? 'row y' : 'col x', 'from', 'to', 'len', 'overlap', 'needed', 'passed by'],
        body: l.parts.map((p, i) => {
          const q = i === 0 ? null : l.joins[i - 1];
          return [
            i === 0 ? 'seed' : String(i),
            String(p.lo),
            String(p.s), String(p.e), String(p.e - p.s),
            q ? String(Math.round(q.ov)) : '—',
            q ? q.need.toFixed(1) : '—',
            q ? (q.ov - q.need).toFixed(1) : '—',
          ];
        }),
      },
    };
  };

  // the cheap half, one per group; `dims` and `table` are computed on first
  // read and cached, so opening a row costs one build rather than two
  const rows = byParts.map(l => {
    let full = null;
    const of = () => (full || (full = rowData(l)));
    return {
      line: l, colour: mergeColour(l.parts.length),
      label: `${l.horiz ? 'y' : 'x'}=${l.horiz ? l.y0 : l.x0} · ${l.len}px`,
      note: `${l.parts.length} runs`,
      get dims() { return of().dims; },
      get table() { return of().table; },
    };
  });

  add(arrow('runs → groups'));
  add(listCard(
    'merge: before and after',
    sel => mergeCompareCanvas(a, sel && sel.line),
    [['left', `the ${(a.hRuns + a.vRuns).toLocaleString()} raw runs that went in`],
     ['right', `the ${allMerged.length.toLocaleString()} groups that came out`],
     ['tint', 'how many runs the group swallowed'],
     ...tally.map(t => [' ', `${t.n.toLocaleString()} — ${t.label}`]),
     ['list below', 'the 40 biggest merges — click one to isolate it']],
    'merge: raw runs on the left, groups on the right',
    rows
  ),
    'merge: before and after');

  add(arrow('tint by runs swallowed'));
  add(listCard(
    'merge heat',
    sel => mergeHeatCanvas(a, sel && sel.line),
    [...MERGE_HEAT.map(([lo, hi, col, label]) => [
        hi === Infinity ? `${lo}+` : (lo === hi ? `${lo}` : `${lo}-${hi}`),
        `${label}`]),
     ['read it', 'green is a rule; red is text fused into a bar']],
    'merge heat: every line tinted by how many raw runs it absorbed',
    rows
  ),
    'merge heat');

  // ---- joinCollinear, its own card ----
  // The second half of "merged lines", which until now was only a number. It
  // joins pieces END TO END along a rule, where mergeLines stacks them side by
  // side across one — and unlike mergeLines it MOVES the result, averaging the
  // two bands, so it deserves to be seen rather than inferred.
  const joined = [...a.hLines, ...a.vLines].filter(l => l.src && l.src.length > 1);
  const joinedBy = joined.slice().sort((p, q) => q.src.length - p.src.length);
  const totalShift = joined.reduce((s, l) =>
    s + (l.steps || []).reduce((t, q) => t + q.moved, 0), 0);

  const joinRows = joinedBy.map(l => {
    let full = null;
    const build = () => {
      const axis = l.horiz ? 'y' : 'x';
      const at = l.horiz ? l.y0 : l.x0;
      const st = l.steps || [];
      const maxMove = st.reduce((m, q) => Math.max(m, q.moved), 0);
      const widest = st.reduce((m, q) => Math.max(m, q.gap), -Infinity);
      const srcSpan = l.src.map(p => l.horiz ? p.len : p.len);
      return {
        dims: [
          ['—— the joined line ——', ''],
          ['position', `${axis}=${at}   box ${l.x0},${l.y0} → ${l.x1},${l.y1}`],
          ['size', `${l.len} px long · ${l.thick} px thick`],
          ['pieces joined', `${l.src.length}`],
          ['piece lengths', srcSpan.join(' + ') + ` = ${srcSpan.reduce((x, y) => x + y, 0)}`],
          ['—— the gaps it bridged ——', ''],
          ['tolerance', `${st.length ? st[0].tol.toFixed(1) : '—'} px  (the mend slider)`],
          ['widest gap', `${widest === -Infinity ? '—' : widest.toFixed(1)} px`],
          ['—— the averaging ——', ''],
          ['band now', `${l.horiz ? `y ${l.y0}..${l.y1}` : `x ${l.x0}..${l.x1}`}`],
          ['largest shift', `${maxMove.toFixed(1)} px — how far a piece was moved`],
          ['why average', 'a union band would be fatter than the real rule, and ' +
            'crosses() tests that box, so the line would reach perpendiculars it ' +
            'never touched'],
          ['—— colours ——', ''],
          ['green', 'the first piece'], ['orange', 'each piece joined to it'],
          ['purple', 'the straightened result'],
        ],
        table: {
          head: ['#', 'gap', 'a band', 'a len', 'b band', 'b len', 'new band', 'thick', 'moved'],
          body: st.map((q, i) => [
            String(i + 1),
            q.gap.toFixed(1),
            `${q.aBand[0]}..${q.aBand[1]}`, String(q.aLen),
            `${q.bBand[0]}..${q.bBand[1]}`, String(q.bLen),
            `${q.band[0]}..${q.band[1]}`, String(q.thick),
            q.moved.toFixed(1),
          ]),
        },
      };
    };
    const of = () => (full || (full = build()));
    return {
      line: l,
      colour: l.src.length > 4 ? '#7b1fa2' : l.src.length > 2 ? '#9c5ab8' : '#c1a3d4',
      label: `${l.horiz ? 'y' : 'x'}=${l.horiz ? l.y0 : l.x0} · ${l.len}px`,
      note: `${l.src.length} pieces`,
      get dims() { return of().dims; },
      get table() { return of().table; },
    };
  });

  add(arrow('join pieces end to end'));
  add(listCard(
    'collinear joins',
    sel => joinCompareCanvas(a, sel),
    [['left', `${(a.hMerged.length + a.vMerged.length).toLocaleString()} lines out of the merge`],
     ['right', `${(a.hLines.length + a.vLines.length).toLocaleString()} after joining`],
     ['absorbed', `${(a.hMerged.length + a.vMerged.length) - (a.hLines.length + a.vLines.length)} lines folded into others`],
     ['joins made', `${joined.length} lines are built from more than one piece`],
     ['purple', 'a line that was joined; plain colour means untouched'],
     ['tolerance', `${a.mendSpan.toFixed(1)} px — the mend slider sets it`],
     ['total shift', `${totalShift.toFixed(0)} px of position change from averaging`],
     ['vs mergeLines', 'that stacks pieces ACROSS a rule; this joins them ALONG it']],
    'collinear joins: pieces of one rule stitched end to end',
    joinRows
  ),
    'collinear joins');

  add(arrow('keep the ones that touch a perpendicular'));
  add(card(
    'crossing lines',
    () => lineCanvas(a, 'both', true),
    [['horizontal', `${a.hKept.length} kept of ${a.hLines.length.toLocaleString()}`],
     ['vertical', `${a.vKept.length} kept of ${a.vLines.length.toLocaleString()}`],
     ['rule', `≥ ${a.minCross} crossings, any partner — no length test`],
     ['amber', 'the 90° crossings themselves']],
    'crossing lines: borders and dividers'
  ),
    'crossing lines');

  add(arrow('drop lines that never reach a second perpendicular'));
  add(card(
    'spanning lines',
    () => lineCanvas(a, 'both', 'span'),
    [['horizontal', `${a.hSpan.length} kept of ${a.hKept.length}`],
     ['vertical', `${a.vSpan.length} kept of ${a.vKept.length}`],
     ['rule', 'both ends land inside a different perpendicular'],
     ['edge', 'the crop border counts as an anchor']],
    'spanning lines: each end on a different perpendicular'
  ),
    'spanning lines');

  add(arrow('keep the connected frame'));
  add(card(
    'connected only',
    () => lineCanvas(a, 'both', 'conn'),
    [['horizontal', `${a.hConn.length}`],
     ['vertical', `${a.vConn.length}`],
     ['components', `${a.components} found, largest kept`],
     ['dropped', `${a.dropped} with no path to the frame`],
     ['green', 'the frame it spans']],
    'connected to the outer frame'
  ),
    'connected only');

  add(arrow('flood the closed regions'));
  add(card(
    'cells',
    () => cellCanvas(a),
    [['cells', `${a.table ? a.table.cells.length : 0}`],
     ['lattice', a.table ? `${a.table.rows} × ${a.table.cols}` : '—'],
     ['merged', a.table ? `${a.table.spans} span more than one unit` : '—'],
     ['content', a.table ? `${a.table.filled} filled, ${a.table.empty} empty` : '—'],
     ['green', 'holds content; red is empty; amber outline merged']],
    'cells, green holds content'
  ),
    'cells');

  add(arrow('lay them out as a table'));
  add(card(
    'reconstructed',
    () => tableCanvas(a),
    [['rows', a.table ? `${a.table.rows}` : '—'],
     ['columns', a.table ? `${a.table.cols}` : '—'],
     ['cells', `${a.table ? a.table.cells.length : 0}`],
     ['filled', a.table ? `${a.table.filled} of ${a.table.cells.length}` : '—'],
     ['ragged', a.table ? `${a.table.ragged} not rectangular` : '—']],
    'reconstructed structure'
  ),
    'reconstructed');

  // How long the analysis took, so a slow crop reads as a big crop rather than
  // as the app having stalled.
  setStatus(`box ${bw} × ${bh} px` + (pt ? `  ·  ${size(ptW, ptH)}` : '')
            + `  ·  analysed in ${took} ms`);
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

  // Every group keeps its own history: the segments that went into it, and for
  // each absorption the two numbers the test turned on. Nothing is summarised
  // away, so a merge that looks wrong can be read back exactly as it happened.
  const out = [];
  const logs = [];
  for (const sg of segs) {
    let hit = null, hitIdx = -1, why = null;
    for (let gi = 0; gi < out.length; gi++) {
      const o = out[gi];
      if (o[1] + 1 < sg[0] || o[0] - 1 > sg[1]) continue;
      const ov = Math.min(o[3], sg[3]) - Math.max(o[2], sg[2]);
      const need = 0.6 * Math.min(o[3] - o[2], sg[3] - sg[2]);
      if (ov > need) {
        hit = o; hitIdx = gi;
        why = { ov, need, shorter: Math.min(o[3] - o[2], sg[3] - sg[2]),
                groupWas: [o[0], o[1], o[2], o[3]] };
        break;
      }
    }
    if (hit) {
      logs[hitIdx].parts.push({ lo: sg[0], hi: sg[1], s: sg[2], e: sg[3] });
      logs[hitIdx].joins.push(why);
      hit[0] = Math.min(hit[0], sg[0]); hit[1] = Math.max(hit[1], sg[1]);
      hit[2] = Math.min(hit[2], sg[2]); hit[3] = Math.max(hit[3], sg[3]);
    } else {
      out.push(sg);
      logs.push({ parts: [{ lo: sg[0], hi: sg[1], s: sg[2], e: sg[3] }], joins: [] });
    }
  }
  return out.map(([lo, hi, s, e], i) => ({
    x0: horiz ? s : lo, x1: horiz ? e : hi + 1,
    y0: horiz ? lo : s, y1: horiz ? hi + 1 : e,
    len: e - s, thick: hi - lo + 1,
    // provenance: how many raw runs became this line, and each join's numbers
    parts: logs[i].parts, joins: logs[i].joins, horiz,
  }));
}

// Two pieces of one rule, split along its length by a void the mend pass did not
// reach, are one line. mergeLines cannot join them: its 60% overlap test is about
// stacking PARALLEL runs into a thick line, and two pieces separated along their
// length overlap by 0 there, by construction. So this is its own pass.
//
// The result is a STRAIGHT line, not the bounding box of the two pieces. On a
// skewed scan the pieces sit at slightly different heights, and their union band
// is fatter than either one — crosses() tests that box, so a union would widen
// the line's reach and let it meet perpendiculars neither piece touched. Average
// instead: centre weighted by length, thickness likewise, so a joined rule stays
// as thin as the rule really is and ruleThick below stays honest (it is a max
// over every band, so one fattened join would inflate the lattice tolerance for
// the whole table).
//
// NO EXTENSION ALONG THE LENGTH. The run extent is the union of two spans that
// already exist, so no endpoint moves outward and no free end grows into empty
// space. A crossing that holds after a join held before it. That is the point: a
// line reaching a perpendicular only because it was stretched is not connected,
// and must not be allowed to look connected.
// A note on cost, because this used to be the slowest thing in the app by a
// wide margin. The original restarted the whole double scan after EVERY merge
// (`while (merged)` with `break`), which is O(n^3): 1,200 lines took 63 ms,
// 3,000 took 644 ms, and a dense 1204x1717 form yielding ~20,000 lines took
// over four MINUTES — per direction — which is what made the tab unresponsive.
//
// The sweep below is O(n log n + merges). Sorting by run-start means any piece
// that can join line `i` starts at or before `runHi(i) + tol`, so a single
// forward walk with a live "open" set finds every join without rescanning, and
// an open line whose end is behind the sweep can never match again and is
// retired. Same joins, same order of preference (nearest start first), same
// output — just without re-examining pairs that were already rejected.
function joinCollinear(lines, horiz, tol) {
  if (!(tol > 0) || lines.length < 2) return lines;
  const runLo = l => horiz ? l.x0 : l.y0, runHi = l => horiz ? l.x1 : l.y1;
  const bndLo = l => horiz ? l.y0 : l.x0, bndHi = l => horiz ? l.y1 : l.x1;

  const straighten = (a, b, gap) => {
    // weight by length: a long piece knows where the rule is, a stub does not
    const wa = Math.max(1, a.len), wb = Math.max(1, b.len);
    const mid = (wa * (bndLo(a) + bndHi(a)) / 2 + wb * (bndLo(b) + bndHi(b)) / 2) / (wa + wb);
    const th = Math.max(1, Math.round((wa * a.thick + wb * b.thick) / (wa + wb)));
    const lo = Math.round(mid - th / 2), hi = lo + th;
    const s = Math.min(runLo(a), runLo(b)), e = Math.max(runHi(a), runHi(b));
    const out = horiz
      ? { x0: s, x1: e, y0: lo, y1: hi, len: e - s, thick: th }
      : { y0: s, y1: e, x0: lo, x1: hi, len: e - s, thick: th };
    // Provenance, for the same reason mergeLines keeps it: this step MOVES a
    // line to a band neither input occupied, and that is invisible in the
    // result unless the inputs are recorded alongside it.
    out.horiz = horiz;
    out.src = [...(a.src || [a]), ...(b.src || [b])];
    out.steps = [...(a.steps || []), ...(b.steps || []), {
      gap, tol,
      aBand: [bndLo(a), bndHi(a)], aLen: a.len, aThick: a.thick,
      bBand: [bndLo(b), bndHi(b)], bLen: b.len, bThick: b.thick,
      band: [lo, hi], thick: th,
      moved: Math.abs(mid - (bndLo(b) + bndHi(b)) / 2),
    }];
    return out;
  };

  const sorted = lines.slice().sort((a, b) => runLo(a) - runLo(b));
  const open = [];        // lines still able to absorb a later piece
  const done = [];        // swept past; nothing can reach them any more

  for (const line of sorted) {
    let cur = line;
    // Retire anything whose end is further back than this line's start can
    // reach. `open` is not sorted by end, so this is a filtering pass, but each
    // line is retired exactly once across the whole sweep.
    for (let i = open.length - 1; i >= 0; i--) {
      if (runHi(open[i]) + tol < runLo(cur)) { done.push(open[i]); open.splice(i, 1); }
    }
    // Absorb every open line this one joins. Repeat until nothing more matches:
    // a join extends `cur`, which can bring a further piece into reach.
    let grew = true;
    while (grew) {
      grew = false;
      for (let i = 0; i < open.length; i++) {
        const o = open[i];
        // same band? inclusive, zero slack, exactly as crosses() asks it
        if (bndLo(o) > bndHi(cur) || bndLo(cur) > bndHi(o)) continue;
        // negative gap means they already overlap — still a legal join
        const gap = Math.max(runLo(o), runLo(cur)) - Math.min(runHi(o), runHi(cur));
        if (gap > tol) continue;
        cur = straighten(o, cur, gap);
        open.splice(i, 1);
        grew = true; break;
      }
    }
    open.push(cur);
  }
  return done.concat(open);
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
// A printed rule reaches the page as several pieces. On one scanned title block
// a single horizontal rule arrived in five, split by holes of one and two pixels
// where the toner simply did not take. Those are defects in the paper, not
// structure, and every later stage — merging, crossing, spanning — treats each
// piece as its own short line and throws it away.
//
// A morphological close along ONE axis bridges a gap in a line without fattening
// it, so the two axes are closed separately and unioned. Text barely moves: the
// gaps inside a letter are two-dimensional and survive a purely horizontal or
// purely vertical close (measured on a word of body text: 577 ink px → 599).
//
// Width is in pixels of the working raster because a scan defect is physical —
// a toner void is the same size whether the table is large or small — but it is
// exposed as a control so it can be turned off or widened per document.
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// Erode in place: a k x k MIN pool at stride 1.
//
// A pixel survives only if every pixel in its k x k neighbourhood is ink — the
// "any 0 makes it 0" rule. Stride 1 rather than k keeps the image the same size,
// so no coordinate anywhere else has to be rescaled.
//
// Why it separates rules from text: a printed rule is 2-3px of solid black, so
// every window inside it is all-ink and survives whole. Antialiased type is
// 1-2px with soft edges, so most of its windows contain a light pixel and go to
// zero. Measured on one scan: raw runs 32,144 -> 7,377 (-77%), while the count
// of rule-length lines went UP, 15 -> 23, because the text that was fragmenting
// them had gone.
//
// Separable: the min over a k x k square is the min along k columns of the min
// along k rows, so this is two O(n) passes rather than one O(n*k*k).
// ---------------------------------------------------------------------------
function erodeInPlace(ink, w, h, k) {
  if (!(k > 1)) return ink;
  const r0 = Math.floor((k - 1) / 2), r1 = k - 1 - r0;   // window around a pixel
  const tmp = new Uint8Array(w * h);
  // horizontal pass: min across the row window
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) {
      let on = 1;
      for (let d = -r0; d <= r1 && on; d++) {
        const xx = x + d;
        if (xx < 0 || xx >= w || !ink[row + xx]) on = 0;
      }
      tmp[row + x] = on;
    }
  }
  // vertical pass over that result: together they give the k x k min
  const out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let on = 1;
      for (let d = -r0; d <= r1 && on; d++) {
        const yy = y + d;
        if (yy < 0 || yy >= h || !tmp[yy * w + x]) on = 0;
      }
      out[y * w + x] = on;
    }
  }
  return out;
}

// The same shape of pass with MAX instead of MIN: a pixel turns on if any
// pixel in its window is ink. Kept alongside erode so the two can be compared,
// and because erode-then-dilate (an opening) restores a rule's original width
// after the erosion has thinned it.
function dilateInPlace(ink, w, h, k) {
  if (!(k > 1)) return ink;
  const r0 = Math.floor((k - 1) / 2), r1 = k - 1 - r0;
  const tmp = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) {
      let on = 0;
      for (let d = -r0; d <= r1 && !on; d++) {
        const xx = x + d;
        if (xx >= 0 && xx < w && ink[row + xx]) on = 1;
      }
      tmp[row + x] = on;
    }
  }
  const out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let on = 0;
      for (let d = -r0; d <= r1 && !on; d++) {
        const yy = y + d;
        if (yy >= 0 && yy < h && tmp[yy * w + x]) on = 1;
      }
      out[y * w + x] = on;
    }
  }
  return out;
}

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
  // Darken first, then threshold — the same order, and the same two numbers, as
  // the `darkened` and `binary` cards show. Before this the pipeline thresholded
  // the RAW page, so the darken card was a preview of something no later stage
  // ever saw and moving the slider changed nothing downstream.
  const g = darkenGamma();
  const scanned = new Uint8Array(w * h);
  // Optional, off by default: divide out a printed ground before the threshold,
  // so a guilloche or watermark never reaches the mask. It must run here — the
  // mend below would fuse surviving ground into the rules it touches, and no
  // later stage could separate them again.
  if (groundOn()) removeGround(d, w, h, groundShare());
  for (let i = 0, j = 0; i < w * h; i++, j += 4) scanned[i] = darkenValue(d[j], g) < cut ? 1 : 0;
  // repair the scan first: every stage below reads `ink`, so a rule broken by a
  // toner void must be whole before the first run is counted
  // A toner void is physical, but the raster is not: enlargeFactor() can double
  // the crop's area, so a fixed px gap means different things depending on
  // whether it ran. Measure the bridge against the crop's own area —
  // sqrt(w*h) is the side of the equal-area square, which holds up on a wide thin
  // strip where min(w,h) collapses. w and h are already post-enlargement, so this
  // is the same physical gap whatever the magnification.
  const mendPct = +$('mend').value;
  const mendSpan = mendPct ? (mendPct / 100) * Math.sqrt(w * h) : 0;
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
  // merged whole lines, with collinear pieces of one rule joined back together.
  // The two halves are kept apart so the counts can be reported separately:
  // mergeLines stacks parallel runs, joinCollinear stitches end-to-end pieces,
  // and knowing which one changed a number is the difference between reading
  // the pipeline and guessing at it.
  const hMerged = mergeLines(hDom(ink, hl, vl, w, h, true), w, h, true);
  const vMerged = mergeLines(hDom(ink, hl, vl, w, h, false), w, h, false);
  const hLines = joinCollinear(hMerged, true, mendSpan);
  const vLines = joinCollinear(vMerged, false, mendSpan);
  const minCross = +$('crossN').value;

  // ---------------------------------------------------------------------
  // WHERE the lines are, not how long they are.
  //
  // A rule is many fragments sharing one coordinate; a text row is many
  // fragments sharing one coordinate too — but they differ in how much of the
  // span they actually cover, and in how many pieces. So project every line
  // onto its perpendicular axis and, per coordinate, record:
  //
  //   cover  — px of line length sitting at that coordinate, as a share of the
  //            crop's width (or height). A full-width rule is ~1.0; a text row
  //            of scattered words is 0.2-0.5.
  //   pieces — how many separate fragments make up that coverage. A printed
  //            rule is 1, or a few if a void split it. A text row is dozens.
  //
  // Those two numbers separate a rule from a line of type, which a length
  // histogram cannot: both contain many short fragments.
  // ---------------------------------------------------------------------
  const project = (lines, horiz) => {
    const n = horiz ? h : w, span = horiz ? w : h;
    const cover = new Float32Array(n), pieces = new Int32Array(n);
    for (const l of lines) {
      const lo = horiz ? l.y0 : l.x0, hi = horiz ? l.y1 : l.x1;
      for (let i = Math.max(0, lo); i < Math.min(n, hi); i++) {
        cover[i] += l.len; pieces[i]++;
      }
    }
    for (let i = 0; i < n; i++) cover[i] = Math.min(1, cover[i] / span);
    return { cover, pieces, span };
  };
  const hProj = project(hLines, true), vProj = project(vLines, false);

  // The coordinates that read as rules: a local maximum of coverage above the
  // threshold, with neighbouring rows of one thick rule reported once.
  const peaks = (proj, minCover) => {
    const { cover, pieces } = proj;
    const out = [];
    let i = 0;
    while (i < cover.length) {
      if (cover[i] < minCover) { i++; continue; }
      let j = i, best = i;
      while (j < cover.length && cover[j] >= minCover) {
        if (cover[j] > cover[best]) best = j;
        j++;
      }
      out.push({ at: best, cover: cover[best], pieces: pieces[best], thick: j - i });
      i = j;
    }
    return out.sort((p, q) => q.cover - p.cover);
  };
  const RULE_COVER = 0.5;                 // half the span before it reads as a rule
  const hPeaks = peaks(hProj, RULE_COVER), vPeaks = peaks(vProj, RULE_COVER);

  const longest = lines => lines.reduce((m, l) => Math.max(m, l.len), 0);

  // No length test here, and none anywhere below. A line is not valid or invalid
  // on its own merits — size says nothing about whether it is structure, and a
  // short rule between two close columns is as real as the frame. The only
  // question is whether it touches a perpendicular AT ALL, and crosses() answers
  // that by inclusive overlap with zero tolerance: lines that touch, touch. A
  // line that would meet a partner only if it were extended is not connected, so
  // it is not a table boundary. Everything that survives goes to the connected
  // component stage, which is where table membership is actually decided.
  const hKept = hLines.filter(a => vLines.filter(b => crosses(a, b)).length >= minCross);
  const vKept = vLines.filter(a => hLines.filter(b => crosses(a, b)).length >= minCross);

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
  // the frame, is not part of the table. (Measured on one scanned title block:
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
  // read off the data, not chosen. (7px on one scan, 16px on another.)
  const ruleThick = Math.max(1,
    ...hConn.map(l => l.y1 - l.y0), ...vConn.map(l => l.x1 - l.x0));
  const table = buildTable(hConn, vConn, frame, ruleThick);
  if (table) fillCells(table, ink, w, h);

  return { w, h, ink, scanned, mended, mendSpan, mendPct,
           hl, vl, hLine, vLine, text: ink, hRuns, vRuns, hMax, vMax,
           hMerged, vMerged, hProj, vProj, hPeaks, vPeaks, ruleCover: RULE_COVER,
           hLongest: longest(hLines), vLongest: longest(vLines),
           inkPx: count(ink), area: w * h,
           // identifies this particular analysis, so the variant cache knows
           // when the mask underneath it has changed
           stamp: `${w}x${h}:${count(ink)}:${cut}:${g}:${mendPct}`,
           hLines, vLines, hKept, vKept, hSpan, vSpan, hConn, vConn,
           components: box.size, dropped: all.length - connected.length,
           frame, minCross, ruleThick, table };
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

// ---------------------------------------------------------------------------
// Before and after, on one canvas, with the merges drawn.
//
// Left panel: the raw runs, each one its own colour, so a rule arriving in five
// pieces reads as five things. Right panel: what mergeLines made of them, every
// group tinted by how many runs it swallowed. A line that ate two runs is a
// repaired rule; one that ate forty is a row of type that has been fused into a
// bar, and that is visible without reading a single number.
//
// Between the panels, every absorption is drawn as a hairline from the run to
// the group that took it — the actual decisions, not a count of them.
// ---------------------------------------------------------------------------
const MERGE_HEAT = [
  [1, 1, '#1a9850', 'alone — one run, untouched'],
  [2, 3, '#66bd63', '2-3 runs — a thick rule, or a mended break'],
  [4, 8, '#fdae61', '4-8 runs'],
  [9, 20, '#f46d43', '9-20 runs'],
  [21, Infinity, '#a50026', '21+ runs — almost certainly fused text'],
];
const mergeColour = n => (MERGE_HEAT.find(([lo, hi]) => n >= lo && n <= hi) || MERGE_HEAT[0])[2];

// `sel` is one merged line to single out, or null for the overview. Drawing a
// connector per run only works for ONE group at a time: with every group drawn
// at once the connectors lie along the very axis the lines occupy and bury the
// picture, which is why the overview has none.
function mergeCompareCanvas(a, sel) {
  const { w, h } = a;
  const gap = Math.max(12, Math.round(w * 0.03));
  const c = document.createElement('canvas');
  c.width = w * 2 + gap; c.height = h;
  // tell the viewer this canvas is two panels, so the hover readout reports a
  // coordinate within a panel rather than the raw canvas offset
  c.panelW = w; c.panelH = h; c.panelGap = gap;
  c.panelPlaces = [{ panel: 0, cx: 0, cy: 0 }, { panel: 2, cx: 1, cy: 0 }];
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
  ctx.fillStyle = '#e9ebef'; ctx.fillRect(w, 0, gap, h);

  const lines = [...a.hMerged, ...a.vMerged];
  const dim = sel ? 0.13 : 0.75;      // everything else recedes when one is picked

  // LEFT: the raw runs that went in, one rectangle per run
  for (const l of lines) {
    if (l === sel) continue;
    ctx.globalAlpha = dim;
    ctx.fillStyle = l.horiz ? 'rgb(200,30,30)' : 'rgb(30,60,200)';
    for (const p of l.parts) {
      // parts are in (lo,hi,s,e) run-space; put them back on the page
      const x0 = l.horiz ? p.s : p.lo, x1 = l.horiz ? p.e : p.hi + 1;
      const y0 = l.horiz ? p.lo : p.s, y1 = l.horiz ? p.hi + 1 : p.e;
      ctx.fillRect(x0, y0, Math.max(1, x1 - x0), Math.max(1, y1 - y0));
    }
  }

  // RIGHT: the merged groups, tinted by how many runs each absorbed
  ctx.save();
  ctx.translate(w + gap, 0);
  for (const l of lines) {
    if (l === sel) continue;
    ctx.globalAlpha = sel ? 0.13 : 0.85;
    ctx.fillStyle = mergeColour(l.parts.length);
    ctx.fillRect(l.x0, l.y0, Math.max(1, l.x1 - l.x0), Math.max(1, l.y1 - l.y0));
  }
  ctx.restore();
  ctx.globalAlpha = 1;

  if (!sel) return c;

  // ---- the chosen group, in full ----
  // its runs on the left, numbered in absorption order
  const mark = Math.max(2, Math.round(Math.min(w, h) / 300));
  sel.parts.forEach((p, i) => {
    const x0 = sel.horiz ? p.s : p.lo, x1 = sel.horiz ? p.e : p.hi + 1;
    const y0 = sel.horiz ? p.lo : p.s, y1 = sel.horiz ? p.hi + 1 : p.e;
    ctx.fillStyle = i === 0 ? '#0a7d2c' : '#d84315';   // seed vs absorbed
    ctx.fillRect(x0 - 1, y0 - 1, Math.max(3, x1 - x0 + 2), Math.max(3, y1 - y0 + 2));
  });

  // the group it became, on the right
  ctx.save();
  ctx.translate(w + gap, 0);
  ctx.fillStyle = mergeColour(sel.parts.length);
  ctx.fillRect(sel.x0, sel.y0, Math.max(2, sel.x1 - sel.x0), Math.max(2, sel.y1 - sel.y0));
  ctx.strokeStyle = '#000'; ctx.lineWidth = mark;
  ctx.strokeRect(sel.x0 - mark, sel.y0 - mark,
                 Math.max(2, sel.x1 - sel.x0) + mark * 2,
                 Math.max(2, sel.y1 - sel.y0) + mark * 2);
  ctx.restore();

  // connectors, bowed away from the line's own axis so they stay readable
  // instead of lying flat along it
  ctx.strokeStyle = 'rgba(216,67,21,.5)';
  ctx.lineWidth = Math.max(0.6, mark * 0.3);
  const tx = w + gap + (sel.x0 + sel.x1) / 2, ty = (sel.y0 + sel.y1) / 2;
  for (const p of sel.parts) {
    const sx = sel.horiz ? (p.s + p.e) / 2 : (p.lo + p.hi) / 2;
    const sy = sel.horiz ? (p.lo + p.hi) / 2 : (p.s + p.e) / 2;
    ctx.beginPath();
    ctx.moveTo(sx, sy);
    // control point pushed perpendicular to the run direction
    const bow = sel.horiz ? Math.min(h, w) * 0.10 : 0;
    ctx.quadraticCurveTo((sx + tx) / 2, (sy + ty) / 2 - bow, tx, ty);
    ctx.stroke();
  }
  return c;
}

// Just the merged side, tinted by run count — the same heat map without the
// comparison, for looking at the page on its own. `sel` singles one out, with
// the runs that built it drawn over the top so the fusion is visible in place.
function mergeHeatCanvas(a, sel) {
  const { w, h } = a;
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, w, h);
  for (const l of [...a.hMerged, ...a.vMerged]) {
    if (l === sel) continue;
    ctx.globalAlpha = sel ? 0.12 : 1;
    ctx.fillStyle = mergeColour(l.parts.length);
    ctx.fillRect(l.x0, l.y0, Math.max(1, l.x1 - l.x0), Math.max(1, l.y1 - l.y0));
  }
  ctx.globalAlpha = 1;
  if (!sel) return c;

  // the group, then the runs inside it, so you can see what it swallowed
  ctx.fillStyle = mergeColour(sel.parts.length);
  ctx.fillRect(sel.x0, sel.y0, Math.max(2, sel.x1 - sel.x0), Math.max(2, sel.y1 - sel.y0));
  sel.parts.forEach((p, i) => {
    const x0 = sel.horiz ? p.s : p.lo, x1 = sel.horiz ? p.e : p.hi + 1;
    const y0 = sel.horiz ? p.lo : p.s, y1 = sel.horiz ? p.hi + 1 : p.e;
    ctx.fillStyle = i === 0 ? '#0a7d2c' : 'rgba(255,255,255,.8)';
    ctx.fillRect(x0, y0, Math.max(1, x1 - x0), Math.max(1, y1 - y0));
  });
  const mark = Math.max(2, Math.round(Math.min(w, h) / 300));
  ctx.strokeStyle = '#000'; ctx.lineWidth = mark;
  ctx.strokeRect(sel.x0 - mark, sel.y0 - mark,
                 Math.max(2, sel.x1 - sel.x0) + mark * 2,
                 Math.max(2, sel.y1 - sel.y0) + mark * 2);
  return c;
}

function maskCanvas(a, which) {
  const { w, h } = a;
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const ctx = c.getContext('2d');
  const im = ctx.createImageData(w, h), d = im.data;
  for (let i = 0, j = 0; i < w * h; i++, j += 4) {
    let col = [255, 255, 255];
    if (which === 'both') {
      // whichever direction this pixel runs further in
      if (a.ink[i]) col = a.hl[i] >= a.vl[i] ? [200, 30, 30] : [30, 90, 210];
    } else if (a.ink[i]) {
      // Flat black, no run-length ramp. The picture answers one question —
      // is this pixel detected — and a shaded near-white pixel answered it
      // wrongly at every crossing.
      col = [0, 0, 0];
    }
    d[j] = col[0]; d[j + 1] = col[1]; d[j + 2] = col[2]; d[j + 3] = 255;
  }
  ctx.putImageData(im, 0, 0);
  return c;
}
// ---------------------------------------------------------------------------
// The same mask under different morphology, so the options can be compared on
// the real page rather than argued about. Each variant recomputes the run
// lengths from its own mask, because which direction a pixel "runs further in"
// changes once the mask changes.
// ---------------------------------------------------------------------------
const MASK_VARIANTS = [
  { key: 'none', label: 'ORIGINAL — no morphology',
    note: 'every dark pixel, exactly as the pipeline reads it today. The baseline.',
    fn: (ink, w, h) => ink },
  { key: 'erode2', label: 'erode 2×2 (min pool, stride 1)',
    note: 'a pixel survives only if its whole 2×2 window is ink',
    fn: (ink, w, h) => erodeInPlace(ink, w, h, 2) },
  { key: 'erode3', label: 'erode 3×3',
    note: 'stricter — thin rules start to go too',
    fn: (ink, w, h) => erodeInPlace(ink, w, h, 3) },
  { key: 'open2', label: 'open 2×2 (erode then dilate)',
    note: 'erode to kill text, dilate to give the rules their width back',
    fn: (ink, w, h) => dilateInPlace(erodeInPlace(ink, w, h, 2), w, h, 2) },
  { key: 'open3', label: 'open 3×3',
    note: 'the same, one size up',
    fn: (ink, w, h) => dilateInPlace(erodeInPlace(ink, w, h, 3), w, h, 3) },
  { key: 'dilate2', label: 'dilate 2×2 (max pool)',
    note: 'the opposite: text gets bolder — shown for contrast',
    fn: (ink, w, h) => dilateInPlace(ink, w, h, 2) },
];

// ---------------------------------------------------------------------------
// Directional cleaning: test each mask along the axis it is meant to detect.
//
// The dominance test alone asks only "does this pixel run further horizontally
// than vertically" — a 4px letter stroke passes as easily as a 900px rule. The
// variants below add a second question, asked per direction: the horizontal
// mask is judged on its x-continuity, the vertical on its y-continuity, so a
// rule is never judged on its thickness.
//
// Measured on two scans, every setting below keeps ALL the rule-length lines
// (15h/6v on one, 15h/2v on the other, unchanged throughout) while cutting the
// runs that feed the expensive stages by up to 93%, and worst-case fusion from
// 456 runs to 66. Unlike a square kernel, which took one of those scans from 15
// long horizontals to 4 at 3x3, this cannot thin a rule: it only tests length.
// ---------------------------------------------------------------------------
const DIR_VARIANTS = [
  { key: 'none', label: 'ORIGINAL — what the pipeline does today',
    note: 'kept if the run is longer in this direction than the other. No length test at all. ' +
          'This is the baseline every other row is measured against.',
    keep: () => true },

  // ---- the purely local rule ----
  // Forget direction and forget length. Ask one question of the two pixels
  // either side: is this pixel continuous with a neighbour ALONG this axis?
  //
  //   horizontal  ink to the left OR to the right
  //   vertical    ink above OR below
  //
  // The two answers are independent, so a crossing pixel is simply in both
  // masks — no tie-break, nothing punched out. The only thing rejected is an
  // isolated speck with no neighbour on that axis.
  //
  // Measured: full-length runs on a crossing-dense page go 58->75 horizontal
  // and 18->22 vertical, because rules are no longer broken at junctions. It
  // filters almost nothing (145 specks of 210,304 ink pixels), which is correct
  // for this stage — finding continuous lines is not the same job as deciding
  // which are structural. Pair it with a length floor for that.
  { key: 'nbr', label: 'neighbour — continuous along this axis',
    note: 'kept if there is ink immediately left OR right (vertical: above OR below). ' +
          'No direction test, no length test. A crossing pixel is in both masks.',
    neighbour: true, shared: true },
  { key: 'nbr2', label: 'neighbour on BOTH sides',
    note: 'stricter: ink to the left AND right, so a run end is dropped and only ' +
          'interior pixels of a stretch survive',
    neighbour: 'both', shared: true },
  { key: 'nbrPct1', label: 'neighbour ✚ run ≥ 1%',
    note: 'the local continuity test, then a length floor — ownership fixed AND ' +
          'text removed',
    neighbour: true, shared: true, pct: 1 },

  { key: 'run5', label: 'run ≥ 5 px',
    note: 'the run through this pixel must itself be at least 5 px long',
    keep: (len) => len >= 5 },
  { key: 'run8', label: 'run ≥ 8 px',
    note: 'same test, stricter',
    keep: (len) => len >= 8 },
  { key: 'run12', label: 'run ≥ 12 px',
    note: 'same test, stricter again — a fixed px count means different things at different dpi',
    keep: (len) => len >= 12 },

  { key: 'erode3', label: '1-D erode 3 (along this axis)',
    note: 'the pixel needs ink 1 px either side ALONG its own direction — no thickness test',
    erode: 3 },
  { key: 'erode5', label: '1-D erode 5',
    note: 'ink 2 px either side',
    erode: 5 },
  { key: 'erode9', label: '1-D erode 9',
    note: 'ink 4 px either side',
    erode: 9 },

  { key: 'pct05', label: 'run ≥ 0.5% of the crop',
    note: 'as a fraction of the crop, so it means the same at any dpi or page size',
    pct: 0.5 },
  { key: 'pct1', label: 'run ≥ 1% of the crop',
    note: 'the sweet spot on both test scans: −91% runs, fusion 456 → 66, every rule kept',
    pct: 1 },
  { key: 'pct2', label: 'run ≥ 2% of the crop',
    note: 'little extra gain over 1%, and closer to the edge',
    pct: 2 },

  // ---- shared ownership ----
  // Dominance forces every pixel into ONE mask, so at a crossing the losing
  // direction gets a hole — a vertical rule crossed by ten horizontals arrives
  // in eleven pieces, and any length test then judges the pieces, not the rule.
  //
  // A junction pixel genuinely belongs to both lines. Drop the tie-break and
  // ask each direction only about its own axis: is the run through this pixel
  // long enough to be part of a rule in THIS direction? A pixel can answer yes
  // to both, and then it is in both masks.
  //
  // Measured: on a crossing-dense page (32,037 junction pixels) full-length
  // horizontal runs go 58 -> 75 and vertical 18 -> 22, because the rules are no
  // longer punched through. On a sparse drawing (1,370 junctions) it changes
  // nothing, which is the expected shape of the fix.
  { key: 'sh05', label: 'shared ✚ run ≥ 0.5%',
    note: 'no dominance test at all: kept if its own run clears the floor, so a ' +
          'junction pixel belongs to BOTH masks and neither rule is broken',
    pct: 0.5, shared: true },
  { key: 'sh1', label: 'shared ✚ run ≥ 1%',
    note: 'the same at the 1% floor — rules stay whole through every crossing',
    pct: 1, shared: true },
  { key: 'sh2', label: 'shared ✚ run ≥ 2%',
    note: 'stricter floor, still shared',
    pct: 2, shared: true },
];

// 1-D erosion along one axis: survive only if the whole k-window is ink.
function erode1d(mask, w, h, k, horiz) {
  if (!(k > 1)) return mask;
  const r0 = Math.floor((k - 1) / 2), r1 = k - 1 - r0;
  const out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (!mask[i]) continue;
      let on = 1;
      for (let d = -r0; d <= r1 && on; d++) {
        const xx = horiz ? x + d : x, yy = horiz ? y : y + d;
        if (xx < 0 || xx >= w || yy < 0 || yy >= h || !mask[yy * w + xx]) on = 0;
      }
      out[i] = on;
    }
  }
  return out;
}

// The dominance mask for one direction, with a variant's extra test applied.
function dirMask(a, key, horiz) {
  const { w, h, ink, hl, vl } = a;
  const v = DIR_VARIANTS.find(m => m.key === key) || DIR_VARIANTS[0];
  const len = horiz ? hl : vl;
  const floor = v.pct ? (v.pct / 100) * (horiz ? w : h) : 0;
  const base = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (!ink[i]) continue;

      // The local test: is this pixel continuous with a neighbour along THIS
      // axis? Two pixels either side, nothing else — no direction comparison,
      // no run length. Independent per axis, so a junction is in both masks.
      if (v.neighbour) {
        const before = horiz ? (x > 0 && ink[i - 1]) : (y > 0 && ink[i - w]);
        const after = horiz ? (x < w - 1 && ink[i + 1]) : (y < h - 1 && ink[i + w]);
        const ok = v.neighbour === 'both' ? (before && after) : (before || after);
        if (!ok) continue;
      } else if (!v.shared) {
        // `shared` drops the tie-break: a pixel is judged only on its own axis,
        // so a junction can belong to both masks and no rule is left with a hole
        const dom = horiz ? (hl[i] >= vl[i]) : (vl[i] > hl[i]);
        if (!dom) continue;
      }

      if (v.pct) { if (len[i] >= floor) base[i] = 1; }
      else if (v.keep) { if (v.keep(len[i])) base[i] = 1; }
      else base[i] = 1;
    }
  }
  return v.erode ? erode1d(base, w, h, v.erode, horiz) : base;
}

// cached per (variant, direction): each one re-runs the merge to report counts
const dirCache = new Map();
function dirOf(a, key, horiz) {
  const ck = `${key}:${horiz ? 'h' : 'v'}`;
  const hit = dirCache.get(ck);
  if (hit && hit.stamp === a.stamp) return hit;
  const { w, h } = a;
  const mask = dirMask(a, key, horiz);
  let px = 0, runs = 0;
  for (let i = 0; i < w * h; i++) if (mask[i]) px++;
  const outer = horiz ? h : w, inner = horiz ? w : h;
  for (let i = 0; i < outer; i++) {
    let j = 0;
    while (j < inner) {
      const on = horiz ? mask[i * w + j] : mask[j * w + i];
      if (on) { runs++; while (j < inner && (horiz ? mask[i * w + j] : mask[j * w + i])) j++; }
      else j++;
    }
  }
  const lines = mergeLines(mask, w, h, horiz);
  const span = horiz ? w : h;
  const long = lines.filter(l => l.len > 0.2 * span).length;
  const worst = lines.reduce((m, l) => Math.max(m, l.parts.length), 0);
  const rec = { stamp: a.stamp, key, horiz, mask, px, runs, lines, long, worst,
                meta: DIR_VARIANTS.find(m => m.key === key) || DIR_VARIANTS[0] };
  dirCache.set(ck, rec);
  return rec;
}

// One direction's mask under one variant. Kept pixels in the direction's own
// colour, shaded by run length; pixels the variant removed in pale grey, so the
// cost of the setting is as visible as the benefit.
function dirCanvas(a, key, horiz) {
  const { w, h } = a;
  const v = dirOf(a, key || 'none', horiz);
  const base = dirOf(a, 'none', horiz);
  // No shading. Every detected pixel is the same pure black, so what is present
  // and what is absent are the only two things the picture says. Run-length
  // shading was hiding real pixels: at a crossing the other direction's run is
  // a few px, and against a 1500px rule that rendered as paper — a rule looked
  // punched through when its ink was continuous all along.
  const shade = () => [0, 0, 0];

  // With nothing picked, draw the current pipeline alone. With a variant
  // picked, draw the ORIGINAL beside it so the two can be read against each
  // other without clicking back and forth.
  const pair = !!key && key !== 'none';
  const gap = pair ? Math.max(12, Math.round(w * 0.03)) : 0;
  const c = document.createElement('canvas');
  c.width = pair ? w * 2 + gap : w;
  c.height = h;
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);

  if (pair) {
    // LEFT: the original, exactly as the pipeline works today
    const im0 = ctx.createImageData(w, h), d0 = im0.data;
    for (let i = 0, j = 0; i < w * h; i++, j += 4) {
      const col = base.mask[i] ? shade(i) : [255, 255, 255];
      d0[j] = col[0]; d0[j + 1] = col[1]; d0[j + 2] = col[2]; d0[j + 3] = 255;
    }
    ctx.putImageData(im0, 0, 0);
    ctx.fillStyle = '#e9ebef'; ctx.fillRect(w, 0, gap, h);
  }

  // RIGHT (or the whole canvas): the variant, with what it dropped in pale grey
  const im = ctx.createImageData(w, h), d = im.data;
  for (let i = 0, j = 0; i < w * h; i++, j += 4) {
    let col = [255, 255, 255];
    if (v.mask[i]) col = shade(i);
    else if (base.mask[i]) col = [226, 228, 232];   // dropped by this variant
    d[j] = col[0]; d[j + 1] = col[1]; d[j + 2] = col[2]; d[j + 3] = 255;
  }
  ctx.putImageData(im, pair ? w + gap : 0, 0);
  return c;
}

// the rows shared by the horizontal and vertical cards
// ---------------------------------------------------------------------------
// Junctions: where a horizontal rule actually meets a vertical one.
//
// Read off the pixels, with no lines built first. A junction pixel is one whose
// run is long in BOTH axes at once — it is part of a long horizontal stretch
// AND a long vertical one, which only happens where two rules cross or meet.
//
// `reach` is what makes it work. Counting neighbours alone is useless: any
// pixel inside a 3px-thick rule has all four, so 36% of the ink comes back as
// "degree 4". Requiring each run to EXTEND at least `reach` px rejects that —
// a rule's interior is long one way and 3px the other, so it fails.
//
// Touching junction pixels are then flooded into one cluster, so a crossing of
// two 3px rules is reported once, at its centre, not as nine separate hits.
//
// Measured on one drawing: reach 5 gives 1,249 clusters (still text), reach 20
// gives 55, reach 30 gives 37 — and those 37 sit on a clean lattice, x =
// 232/649/750/855/1057 repeating down the page. That is the table's skeleton,
// found without building a single line.
// ---------------------------------------------------------------------------
function findJunctions(a, reach) {
  const { w, h, ink, hl, vl } = a;
  const J = new Uint8Array(w * h);
  let px = 0;
  for (let i = 0; i < w * h; i++) {
    if (ink[i] && hl[i] >= reach && vl[i] >= reach) { J[i] = 1; px++; }
  }
  // flood touching junction pixels into one cluster
  const seen = new Uint8Array(w * h);
  const out = [];
  const stack = [];
  for (let s = 0; s < w * h; s++) {
    if (!J[s] || seen[s]) continue;
    stack.length = 0; stack.push(s); seen[s] = 1;
    let n = 0, sx = 0, sy = 0, x0 = w, x1 = 0, y0 = h, y1 = 0;
    while (stack.length) {
      const i = stack.pop();
      const x = i % w, y = (i - x) / w;
      n++; sx += x; sy += y;
      if (x < x0) x0 = x; if (x > x1) x1 = x;
      if (y < y0) y0 = y; if (y > y1) y1 = y;
      if (x > 0 && J[i - 1] && !seen[i - 1]) { seen[i - 1] = 1; stack.push(i - 1); }
      if (x < w - 1 && J[i + 1] && !seen[i + 1]) { seen[i + 1] = 1; stack.push(i + 1); }
      if (y > 0 && J[i - w] && !seen[i - w]) { seen[i - w] = 1; stack.push(i - w); }
      if (y < h - 1 && J[i + w] && !seen[i + w]) { seen[i + w] = 1; stack.push(i + w); }
    }
    const cx = Math.round(sx / n), cy = Math.round(sy / n);
    // how far each arm reaches from the centre says what KIND of junction it is
    const armL = cx > 0 ? runBack(ink, w, h, cx, cy, -1, 0) : 0;
    const armR = runBack(ink, w, h, cx, cy, 1, 0);
    const armU = cy > 0 ? runBack(ink, w, h, cx, cy, 0, -1) : 0;
    const armD = runBack(ink, w, h, cx, cy, 0, 1);
    const arms = [armL >= reach, armR >= reach, armU >= reach, armD >= reach];
    const nArms = arms.filter(Boolean).length;
    out.push({
      x: cx, y: cy, n, x0, x1, y0, y1,
      armL, armR, armU, armD, nArms,
      kind: nArms >= 4 ? 'cross' : nArms === 3 ? 'tee' : nArms === 2
              ? ((arms[0] || arms[1]) && (arms[2] || arms[3]) ? 'corner' : 'through')
              : 'end',
    });
  }
  return { mask: J, px, list: out.sort((p, q) => p.y - q.y || p.x - q.x) };
}

// how far unbroken ink extends from (x,y) in one direction
function runBack(ink, w, h, x, y, dx, dy) {
  let n = 0, cx = x + dx, cy = y + dy;
  while (cx >= 0 && cx < w && cy >= 0 && cy < h && ink[cy * w + cx]) {
    n++; cx += dx; cy += dy;
  }
  return n;
}

const JUNCTION_KINDS = {
  cross:   ['#c62828', 'all four arms — two rules crossing'],
  tee:     ['#ef6c00', 'three arms — a rule meeting another and stopping'],
  corner:  ['#2e7d32', 'two arms at 90° — a frame corner'],
  through: ['#1565c0', 'two arms in line — not a junction, a thick spot'],
  end:     ['#6a1b9a', 'one arm or none'],
};

// ---------------------------------------------------------------------------
// The junction graph: connect each junction to its neighbours, then keep the
// component the frame belongs to.
//
// An edge is drawn only when ink actually runs the whole way between two
// junctions — the same continuity test the junctions themselves came from, so
// nothing is inferred from bounding boxes. That is the difference from the
// existing connected-components step, which asks crosses() whether two LINE
// BOXES overlap: a fused text bar spanning the page "crosses" everything it
// covers and welds unrelated things into one component. Ink between two points
// is evidence; overlapping boxes are not.
//
// Components then fall out of the graph, and the one containing the outermost
// junction is the table. The text clusters that survive junction detection have
// no ink path to the frame, so they drop here without a special rule.
// ---------------------------------------------------------------------------
function junctionGraph(a, reach, opts) {
  const { w, h, ink } = a;
  // Two different jobs, so two tolerances.
  //
  //   tol     — clustering coordinates into lattice rows and columns. Must stay
  //             small or two adjacent table columns merge into one.
  //   pairTol — deciding whether two junctions lie on the SAME rule. Needs to
  //             absorb scan skew, which accumulates with distance, and the
  //             wobble in a junction's own position (a corner's cluster centroid
  //             pulls inward, a tee's pulls toward its stem, so two junctions on
  //             one straight rule can differ by more than the ink does).
  //
  // Both are fractions of the page, so they mean the same thing at 150 dpi and
  // at 400, and on A4 or A3. pairTol also grows with the span being tested:
  // junctions 1100 px apart may drift further than ones 40 px apart, and the
  // ink test below is what actually guards against a false pair.
  const page = Math.min(w, h);
  const tol = (opts && opts.tol) || Math.max(2, Math.round(0.004 * page));
  const pairBase = (opts && opts.pairTol) || Math.max(3, Math.round(0.008 * page));
  const pairDrift = (opts && opts.drift !== undefined) ? opts.drift : 0.012;
  const pairTol = span => pairBase + Math.round(pairDrift * span);
  const gapPct = (opts && opts.gap !== undefined) ? opts.gap : 0.02;
  const pts = findJunctions(a, reach).list;

  // ink coverage along a straight run between two points, as a fraction
  const solid = (x0, y0, x1, y1) => {
    const horiz = y0 === y1 || Math.abs(x1 - x0) > Math.abs(y1 - y0);
    const n = horiz ? Math.abs(x1 - x0) : Math.abs(y1 - y0);
    if (n < 2) return { frac: 1, gap: 0, len: n };
    let on = 0, worst = 0, run = 0;
    for (let k = 0; k <= n; k++) {
      const t = k / n;
      const x = Math.round(x0 + (x1 - x0) * t), y = Math.round(y0 + (y1 - y0) * t);
      // allow the rule to wander by a pixel or two across its own width
      let hit = 0;
      for (let d = -1; d <= 1 && !hit; d++) {
        const xx = horiz ? x : x + d, yy = horiz ? y + d : y;
        if (xx >= 0 && xx < w && yy >= 0 && yy < h && ink[yy * w + xx]) hit = 1;
      }
      if (hit) { on++; run = 0; }
      else { run++; if (run > worst) worst = run; }
    }
    return { frac: on / (n + 1), gap: worst, len: n };
  };

  // Candidate edges.
  //
  // This used to pick ONE candidate per direction — the nearest sharing the
  // axis — and test only that. The intent was to stop A also linking to C when
  // A-B-C lie on one rule, which would double-mark the same span. But it made
  // distance the filter as well as the ordering: if the nearest candidate
  // failed the ink test, the loop moved on and the genuine partner behind it
  // was never examined. A junction reporting four solid arms could end up with
  // three edges, because a fourth point happened to stand ahead in the queue.
  //
  // Now: walk candidates outward in distance order and STOP AT THE FIRST that
  // passes. That still prevents A->C (the walk stops at B), but a candidate
  // that fails no longer blocks the ones behind it. Distance decides the order
  // of testing; ink decides the outcome.
  const edges = [];
  const seen = new Set();
  const tryEdge = (i, j, horiz) => {
    const key = i < j ? `${i}:${j}` : `${j}:${i}`;
    if (seen.has(key)) return true;            // already joined, nothing to add
    const p = pts[i], q = pts[j];
    const s = solid(p.x, p.y, q.x, q.y);
    const maxGap = Math.max(3, gapPct * (horiz ? w : h));
    if (s.frac >= 0.9 && s.gap <= maxGap) {
      seen.add(key);
      edges.push({ a: i, b: j, horiz, frac: s.frac, gap: s.gap, len: s.len,
                   off: horiz ? Math.abs(p.y - q.y) : Math.abs(p.x - q.x) });
      return true;
    }
    return false;
  };
  // how many candidates were rejected before one worked — a non-zero total is
  // the count of edges the old single-candidate rule would have lost outright
  let rescued = 0;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i];
    // every junction to the right / below that shares the axis, nearest first.
    // The allowed perpendicular offset grows with the span, so a frame edge
    // crossing the whole page is not rejected for a few px of accumulated skew.
    const rightC = [], downC = [];
    for (let j = 0; j < pts.length; j++) {
      if (j === i) continue;
      const q = pts[j];
      if (q.x > p.x && Math.abs(p.y - q.y) <= pairTol(q.x - p.x)) rightC.push(j);
      if (q.y > p.y && Math.abs(p.x - q.x) <= pairTol(q.y - p.y)) downC.push(j);
    }
    rightC.sort((m, n) => pts[m].x - pts[n].x);
    downC.sort((m, n) => pts[m].y - pts[n].y);
    for (let k = 0; k < rightC.length; k++) {
      if (tryEdge(i, rightC[k], true)) { rescued += k; break; }
    }
    for (let k = 0; k < downC.length; k++) {
      if (tryEdge(i, downC[k], false)) { rescued += k; break; }
    }
  }

  // Arms versus degree: the junction's OWN pixels say how many directions carry
  // a rule; the graph says how many edges were built. They should agree. Where
  // arms > degree there is a connection the ink supports and the graph missed,
  // and until this was measured such a loss was completely silent.
  const deg = pts.map(() => ({ L: false, R: false, U: false, D: false }));
  for (const e of edges) {
    const p = pts[e.a], q = pts[e.b];
    if (e.horiz) {
      if (q.x > p.x) { deg[e.a].R = true; deg[e.b].L = true; }
      else { deg[e.a].L = true; deg[e.b].R = true; }
    } else {
      if (q.y > p.y) { deg[e.a].D = true; deg[e.b].U = true; }
      else { deg[e.a].U = true; deg[e.b].D = true; }
    }
  }
  let unmatched = 0;
  pts.forEach((p, i) => {
    const d = deg[i];
    // an arm only counts as missing if the junction is not at the crop edge,
    // where a rule legitimately runs off the page with nothing to meet
    const miss = [
      p.armL >= reach && !d.L && p.x - p.armL > 1,
      p.armR >= reach && !d.R && p.x + p.armR < w - 2,
      p.armU >= reach && !d.U && p.y - p.armU > 1,
      p.armD >= reach && !d.D && p.y + p.armD < h - 2,
    ];
    p.degree = (d.L ? 1 : 0) + (d.R ? 1 : 0) + (d.U ? 1 : 0) + (d.D ? 1 : 0);
    p.missing = miss.filter(Boolean).length;
    p.missingArms = ['left', 'right', 'up', 'down'].filter((_, k) => miss[k]);
    unmatched += p.missing;
  });

  // ---------------------------------------------------------------------
  // Straighten each rule to one coordinate.
  //
  // A rule that is straight on paper arrives in the raster wandering by a few
  // px over its length (measured: a frame rule drifting x=156 to x=159 down the
  // page), and a junction's own position adds more wobble because it is the
  // centroid of an L- or T-shaped cluster — a corner's centroid pulls inward, a
  // tee's toward its stem.
  //
  // The graph tolerates that because its edge test follows the actual ink. The
  // TABLE cannot: it snaps each edge's two endpoints to the lattice
  // independently, so a rule drifting across the midpoint between two columns
  // has its ends land on different lattice lines, and the wall is placed wrong
  // or split in two — which is where cells leak.
  //
  // So give every junction on one rule the same coordinate. Membership comes
  // from the GRAPH, not from proximity: junctions on a common rule are joined
  // by a chain of same-orientation edges, so two points 3px apart that belong
  // to different rules are never grouped.
  const rail = dir => {
    const par = pts.map((_, i) => i);
    const f = x => { while (par[x] !== x) { par[x] = par[par[x]]; x = par[x]; } return x; };
    for (const e of edges) {
      if (e.horiz !== dir) continue;
      const ra = f(e.a), rb = f(e.b);
      if (ra !== rb) par[ra] = rb;
    }
    const groups = new Map();
    pts.forEach((_, i) => {
      const r = f(i);
      if (!groups.has(r)) groups.set(r, []);
      groups.get(r).push(i);
    });
    return groups;
  };
  // vertical edges chain the junctions of one VERTICAL rule, which share an x
  const vGroups = rail(false), hGroups = rail(true);
  const median = xs => {
    const s = xs.slice().sort((p, q) => p - q);
    const m = s.length >> 1;
    return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2);
  };
  pts.forEach(p => { p.gx = p.x; p.gy = p.y; });
  let straightened = 0, maxShift = 0, suspect = 0;
  const apply = (groups, axis) => {
    for (const g of groups.values()) {
      if (g.length < 2) continue;
      const at = median(g.map(i => pts[i][axis]));
      for (const i of g) {
        const p = pts[i];
        const shift = Math.abs(p[axis] - at);
        p[axis === 'x' ? 'gx' : 'gy'] = at;
        if (shift) { straightened++; if (shift > maxShift) maxShift = shift; }
        // a correction larger than the pairing tolerance means this group has
        // probably swallowed two genuinely different rules
        if (shift > pairTol(0)) { p.overShift = true; suspect++; }
      }
    }
  };
  apply(vGroups, 'x');     // vertical rules share an x
  apply(hGroups, 'y');     // horizontal rules share a y

  // components over the junctions
  const parent = pts.map((_, i) => i);
  const find = x => { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; };
  for (const e of edges) {
    const ra = find(e.a), rb = find(e.b);
    if (ra !== rb) parent[ra] = rb;
  }
  const comp = new Map();
  pts.forEach((p, i) => {
    const r = find(i);
    const c = comp.get(r) || { root: r, n: 0, x0: w, y0: h, x1: 0, y1: 0, pts: [], edges: 0 };
    c.n++; c.pts.push(i);
    c.x0 = Math.min(c.x0, p.x); c.x1 = Math.max(c.x1, p.x);
    c.y0 = Math.min(c.y0, p.y); c.y1 = Math.max(c.y1, p.y);
    comp.set(r, c);
  });
  for (const e of edges) { const c = comp.get(find(e.a)); if (c) c.edges++; }

  // the table is the component whose junctions enclose the most area
  let main = null;
  for (const c of comp.values()) {
    c.area = (c.x1 - c.x0) * (c.y1 - c.y0);
    if (!main || c.area > main.area) main = c;
  }
  const inMain = new Set(main ? main.pts : []);
  return {
    pts, edges, comps: [...comp.values()].sort((p, q) => q.area - p.area),
    main, inMain, tol, pairBase, pairDrift, pairTol, rescued, unmatched,
    straightened, maxShift, suspect,
    // the lattice is built from the STRAIGHTENED coordinates, so both ends of
    // an edge snap to the same line by construction
    lattice: {
      cols: cluster(pts.filter((_, i) => inMain.has(i)).map(p => p.gx), tol),
      rows: cluster(pts.filter((_, i) => inMain.has(i)).map(p => p.gy), tol),
    },
  };
}

// group near-equal coordinates into one lattice position
function cluster(vals, tol) {
  const s = vals.slice().sort((a, b) => a - b);
  const out = [];
  for (const v of s) {
    const last = out[out.length - 1];
    if (last && v - last.at <= tol) { last.n++; last.sum += v; last.at = Math.round(last.sum / last.n); }
    else out.push({ at: v, n: 1, sum: v });
  }
  return out;
}

// ---------------------------------------------------------------------------
// The faces of the junction graph.
//
// A cell is a closed loop of edges. The graph is planar and its edges are
// axis-aligned, so its bounded faces ARE the cells, and they can be walked
// directly: from each directed edge, arrive at a node, then take the next edge
// clockwise from the reverse of the arrival direction. Follow that until the
// walk returns to where it started. Each directed edge belongs to exactly one
// face, so marking them used finds every face once, in O(E).
//
// This replaces a lattice. The old conversion split each junction into an x and
// a y, clustered the two lists independently and crossed every column line with
// every row line — which assumes the table fills a rectangle. Real tables do
// not. A table whose header row starts one column in still got a column line to
// its left and a row line across its top, and their crossing was a point the
// paper never had; the flood, which knows only walls, read that empty region as
// open interior and made it a cell.
//
// Requiring every cell corner to be a junction does not fix it — that was tried
// and reverted. When an edge spans several lattice lines it walls each
// intermediate crossing, and those crossings by construction have no junction
// on that rule, because the edge walk stopped at the first junction it reached.
// A row rule running past a divider that stops elsewhere is a legitimate corner
// with no junction at it, so non-junction crossings are normal.
//
// A face walk needs no such test. A region that is not enclosed cannot close a
// loop, so the phantom is impossible rather than filtered out, and a merged cell
// needs no special handling: it is simply a face whose side is one long edge.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Cells as the smallest loop through each edge.
//
// Nodes and edges, nothing else — no directions, no angles, no geometry. For
// each edge, find the shortest cycle containing it: a BFS from one end to the
// other, forbidden from using that edge directly. That cycle is the smallest
// loop through it, which is the cell on one side; the same loop found from
// several of its own edges is deduplicated by its node set.
//
// This replaces a clockwise face walk, which needed a consistent angular order
// at every node and kept failing to get one. `pairTol` lets an edge's two ends
// differ in the perpendicular axis, so a "vertical" edge can run (-5, +3);
// straightening can put two junctions on the SAME point, leaving an edge with
// no direction at all. Either breaks the turn order and the walk never closes —
// measured on three pages: not one face found, 69 to 82 directed edges
// unconsumed. A loop has no such requirement.
//
// Verified against Euler's formula on five pages: for a planar graph the number
// of bounded faces is E - V + C, and the loop count equals it exactly every
// time. Where the face walk worked the two agree (118 and 244 cells); where it
// failed this still returns 11, 19 and 6.
// ---------------------------------------------------------------------------
function loopsFromGraph(G) {
  const { pts, edges, inMain } = G;
  const live = edges.filter(e => inMain.has(e.a) && inMain.has(e.b));
  const adj = pts.map(() => []);
  live.forEach((e, i) => {
    adj[e.a].push({ to: e.b, e: i });
    adj[e.b].push({ to: e.a, e: i });
  });

  const seen = new Map();
  const inLoop = new Set();
  const stubs = [];
  for (let ei = 0; ei < live.length; ei++) {
    const { a, b } = live[ei];
    // shortest path b -> a that does not use this edge
    const prev = new Map([[b, null]]);
    const queue = [b];
    let found = false;
    for (let qi = 0; qi < queue.length && !found; qi++) {
      for (const link of adj[queue[qi]]) {
        if (link.e === ei || prev.has(link.to)) continue;
        prev.set(link.to, queue[qi]);
        if (link.to === a) { found = true; break; }
        queue.push(link.to);
      }
    }
    if (!found) { stubs.push(ei); continue; }   // encloses nothing
    const loop = [];
    for (let n = a; n !== null && n !== undefined; n = prev.get(n)) loop.push(n);
    for (const n of loop) inLoop.add(n);
    const key = loop.slice().sort((x, y) => x - y).join(',');
    if (!seen.has(key)) seen.set(key, loop);
  }
  // junctions that no loop closed around — a dangling stub, or a rule that
  // reaches nothing. Worth flagging: the graph found them but they bound no cell.
  const orphans = [...inMain].filter(i => !inLoop.has(i));
  return { loops: [...seen.values()], stubs, orphans, live: live.length };
}

// ---------------------------------------------------------------------------
// Junction graph -> table.
//
// Cells come from the graph's faces. Rows and columns are assigned afterwards,
// by looking up where each cell sits among the straightened edge coordinates —
// a reporting step over real cells rather than a grid they are forced into, so
// a table that is not a rectangle produces the cells it has and no filler.
// ---------------------------------------------------------------------------
function tableFromGraph(a, reach) {
  const G = junctionGraph(a, reach);
  if (!G.main) return null;

  const F = loopsFromGraph(G);
  if (!F.loops.length) return { G, table: null, faces: F };

  // Row and column lines, for indexing only. These come from the straightened
  // coordinates of the junctions that actually bound cells — they are used to
  // say WHICH row a cell is in, never to generate a cell.
  const tol = G.tol;
  const usedPts = new Set();
  for (const loop of F.loops) for (const n of loop) usedPts.add(n);
  const xs = cluster([...usedPts].map(i => G.pts[i].gx), tol).map(c => c.at);
  const ys = cluster([...usedPts].map(i => G.pts[i].gy), tol).map(c => c.at);
  const near = (arr, v) => {
    let best = 0;
    for (let i = 1; i < arr.length; i++)
      if (Math.abs(arr[i] - v) < Math.abs(arr[best] - v)) best = i;
    return best;
  };

  const cells = F.loops.map(loop => {
    const ps = loop.map(i => G.pts[i]);
    // Geometry from the MEASURED positions: this box is where the ink is, so
    // fillCells samples the real pixels rather than an idealised grid.
    const x0 = Math.min(...ps.map(p => p.x)), x1 = Math.max(...ps.map(p => p.x));
    const y0 = Math.min(...ps.map(p => p.y)), y1 = Math.max(...ps.map(p => p.y));
    // straightened bounds, for the row/column lookup
    const gx0 = Math.min(...ps.map(p => p.gx)), gx1 = Math.max(...ps.map(p => p.gx));
    const gy0 = Math.min(...ps.map(p => p.gy)), gy1 = Math.max(...ps.map(p => p.gy));
    const c0 = near(xs, gx0), c1 = near(xs, gx1);
    const r0 = near(ys, gy0), r1 = near(ys, gy1);
    return {
      row: r0, col: c0,
      rowspan: Math.max(1, r1 - r0), colspan: Math.max(1, c1 - c0),
      x0, x1, y0, y1,
      nodes: loop.length,
      // the junctions the loop passes through, drawn on the picture
      pts: ps.map(p => ({ x: p.x, y: p.y })),
      // A rectangle's loop visits four corners plus any junction sitting along
      // a side, so count only the points at an EXTREME of the box — more than
      // four of those is an L or a T, which rowspan/colspan cannot express.
      corners: ps.filter(p => (p.x === x0 || p.x === x1) && (p.y === y0 || p.y === y1)).length,
      rect: ps.filter(p => (p.x === x0 || p.x === x1) && (p.y === y0 || p.y === y1)).length === 4,
    };
  });
  cells.sort((p, q) => p.row - q.row || p.col - q.col);

  // A cell contains no other cell.
  //
  // BFS returns the SHORTEST cycle through an edge, and where the true boundary
  // is long a shorter path exists that cuts across the interior — so a loop can
  // come back enclosing other cells. Seen on a title block: a 5x4 region whose
  // loop detoured around two 1x2 boxes in its top-right corner and reported
  // them as part of itself, with 3 turns from 9 junctions where a rectangle
  // needs 4. (Euler's check passed throughout: the COUNT was right, the loops
  // were not.)
  //
  // So mark what each cell properly contains. Only the immediate children, so a
  // nested stack is not subtracted twice, and the cell then describes itself as
  // the outer region minus those inners.
  const encloses = (outer, inner) =>
    inner.x0 >= outer.x0 && inner.x1 <= outer.x1 &&
    inner.y0 >= outer.y0 && inner.y1 <= outer.y1 &&
    (inner.x1 - inner.x0) * (inner.y1 - inner.y0) <
    (outer.x1 - outer.x0) * (outer.y1 - outer.y0);
  cells.forEach((c, i) => {
    const all = cells.filter((o, j) => j !== i && encloses(c, o));
    // drop any that sits inside another of them — keep the immediate children
    c.holes = all.filter(o => !all.some(p => p !== o && encloses(p, o)));
    c.netArea = (c.x1 - c.x0) * (c.y1 - c.y0) -
      c.holes.reduce((s, o) => s + (o.x1 - o.x0) * (o.y1 - o.y0), 0);
  });

  const table = {
    xs, ys, rows: Math.max(1, ys.length - 1), cols: Math.max(1, xs.length - 1),
    cells,
    spans: cells.filter(c => c.rowspan > 1 || c.colspan > 1).length,
    ragged: cells.filter(c => !c.rect).length,
    // edges enclosing nothing, and junctions no loop closed around — the graph
    // found them but they bound no cell, which is worth seeing rather than
    // silently dropping
    stubs: F.stubs.length, orphans: F.orphans,
    // Euler's formula for a planar graph: bounded faces = E - V + C. A mismatch
    // means loops were missed or double-counted, so it is checked rather than
    // assumed.
    euler: F.live - G.inMain.size + 1,
  };
  fillCells(table, a.ink, a.w, a.h);
  return { G, table, faces: F };
}

// Three panels STACKED: the crop, the junction graph it produced, and the table
// read off that graph. The graph panel is the point — when a cell is wrong, the
// question is always whether the graph was wrong too, and that is only
// answerable by seeing both.
//
// Stacked rather than side by side because a table crop is usually far wider
// than it is tall: three of them abreast leaves each a third of the width and
// nothing legible, while three stacked keep the full width each.
function graphTableCanvas(a, reach, sel) {
  const { w, h } = a;
  const R = tableFromGraph(a, reach);
  const gap = Math.max(12, Math.round(Math.min(w, h) * 0.04));
  // Which panels to draw, and how to arrange them.
  //
  // Stacking three wide crops leaves each a sliver of a tall window, and laying
  // three tall crops abreast wastes the height. So the arrangement follows the
  // crop's own shape: a wide crop stacks (its panels are short, so they fit),
  // a tall one goes side by side. Three panels of a squarish crop go in an
  // L — two on top, one below — which uses a rectangular window far better
  // than a 1x3 in either direction.
  const want = PANELS.filter(p => p).length ? PANELS : [true, true, true];
  const shown = [];
  for (let i = 0; i < 3; i++) if (want[i]) shown.push(i);
  const n = shown.length;

  // Choose the arrangement that renders the panels LARGEST in the window that
  // is actually available. Picking it from the crop's shape alone was wrong: a
  // wide crop in a wide window still stacked, so each panel took a third of the
  // height while the width sat unused.
  const layouts = {
    1: [{ cells: [[0, 0]], cols: 1, rows: 1 }],
    2: [{ cells: [[0, 0], [0, 1]], cols: 1, rows: 2 },        // stacked
        { cells: [[0, 0], [1, 0]], cols: 2, rows: 1 }],       // abreast
    3: [{ cells: [[0, 0], [0, 1], [0, 2]], cols: 1, rows: 3 },
        { cells: [[0, 0], [1, 0], [2, 0]], cols: 3, rows: 1 },
        { cells: [[0, 0], [1, 0], [0, 1]], cols: 2, rows: 2 }],  // the L
  }[n];
  // The canvas is built BEFORE the viewer is unhidden, so on a first open
  // #zbody has no size yet — fall back to the window, less the rail and the
  // header, which is what it will be once shown.
  const view = $('zbody');
  const vw = view.clientWidth || (window.innerWidth - 340);
  const vh = view.clientHeight || (window.innerHeight - 60);
  const availW = Math.max(200, vw - 40);
  const availH = Math.max(200, vh - 40);
  let grid = layouts[0], bestScale = -1;
  for (const g of layouts) {
    const cw = g.cols * w + (g.cols - 1) * gap;
    const ch = g.rows * h + (g.rows - 1) * gap;
    // how big each panel ends up once the whole tiling is fitted to the window
    const scale = Math.min(availW / cw, availH / ch);
    if (scale > bestScale) { bestScale = scale; grid = g; }
  }

  const slot = [-1, -1, -1];         // panel index -> position in `shown`
  shown.forEach((p, k) => { slot[p] = k; });
  const cellOf = i => grid.cells[slot[i]];
  const atX = i => cellOf(i)[0] * (w + gap);
  const atY = i => cellOf(i)[1] * (h + gap);

  const c = document.createElement('canvas');
  c.width = grid.cols * w + (grid.cols - 1) * gap;
  c.height = grid.rows * h + (grid.rows - 1) * gap;
  // tell the viewer how the canvas is tiled, so the hover readout can report a
  // coordinate within a panel rather than the raw canvas offset
  c.panelW = w; c.panelH = h; c.panelGap = gap;
  c.panelPlaces = shown.map((p, k) => ({ panel: p, cx: grid.cells[k][0], cy: grid.cells[k][1] }));
  c.panelToggles = true;            // this view offers the crop/graph/cells buttons
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#f4f5f7'; ctx.fillRect(0, 0, c.width, c.height);
  ctx.fillStyle = '#fff';
  for (const pl of c.panelPlaces)
    ctx.fillRect(pl.cx * (w + gap), pl.cy * (h + gap), w, h);

  // the crop exactly as it is, nothing drawn over it
  if (pageImg && BOX && slot[0] >= 0) {
    ctx.drawImage(pageImg, BOX.x0, BOX.y0, BOX.x1 - BOX.x0, BOX.y1 - BOX.y0,
                  atX(0), atY(0), w, h);
  }
  if (!R || !R.table) return c;

  // the junction graph, exactly as its own card draws it
  if (slot[1] >= 0) {
    const G = R.G;
    ctx.save();
    ctx.translate(atX(1), atY(1));
    const jr = Math.max(2, Math.round(Math.min(w, h) / 200));
    const jlw = Math.max(1.5, jr / 2.5);
    for (const e of G.edges) {
      const p = G.pts[e.a], q = G.pts[e.b];
      const keep = G.inMain.has(e.a) && G.inMain.has(e.b);
      ctx.strokeStyle = keep ? 'rgba(20,130,60,.95)' : 'rgba(190,60,60,.45)';
      ctx.lineWidth = keep ? jlw : jlw * 0.7;
      ctx.beginPath(); ctx.moveTo(p.x, p.y); ctx.lineTo(q.x, q.y); ctx.stroke();
    }
    const orphan = new Set(R.table ? R.table.orphans : []);
    G.pts.forEach((p, i) => {
      const keep = G.inMain.has(i);
      if (p.missing) {
        ctx.strokeStyle = '#ef6c00'; ctx.lineWidth = Math.max(1.5, jr / 2);
        ctx.beginPath(); ctx.arc(p.x, p.y, jr * 2.2, 0, Math.PI * 2); ctx.stroke();
      }
      // a junction no loop closed around — it bounds no cell
      if (orphan.has(i)) {
        ctx.strokeStyle = '#7b1fa2'; ctx.lineWidth = Math.max(1.5, jr / 2);
        ctx.beginPath(); ctx.arc(p.x, p.y, jr * 3.2, 0, Math.PI * 2); ctx.stroke();
      }
      ctx.fillStyle = keep ? '#0a7d2c' : '#b03030';
      ctx.beginPath(); ctx.arc(p.x, p.y, keep ? jr : jr * 0.8, 0, Math.PI * 2); ctx.fill();
    });
    ctx.restore();
  }

  const lw = Math.max(1.5, Math.round(Math.min(w, h) / 500));
  const r = Math.max(2, Math.round(Math.min(w, h) / 320));
  const colourOf = cell => !cell.rect ? '#7b1fa2'
                         : (cell.rowspan > 1 || cell.colspan > 1) ? '#c07000'
                         : cell.filled ? '#2e7d32' : '#b03030';

  // tableFromGraph rebuilds on every render, so a stored cell is never the same
  // OBJECT as the one being drawn — compare by lattice position instead
  // match on geometry: row/col indices are derived and need not be unique on a
  // table that is not a rectangle, but a face's box is
  const isSel = cell => sel && sel.cell &&
    cell.x0 === sel.cell.x0 && cell.y0 === sel.cell.y0 &&
    cell.x1 === sel.cell.x1 && cell.y1 === sel.cell.y1;

  // the table alone, on white — the structure with no scan behind it
  if (slot[2] >= 0) {
  ctx.save();
  ctx.translate(atX(2), atY(2));
  for (const cell of R.table.cells) {
    const on = !sel || isSel(cell);
    ctx.globalAlpha = on ? 1 : 0.25;
    ctx.fillStyle = cell.filled ? 'rgba(46,125,50,.22)' : 'rgba(198,40,40,.12)';
    ctx.fillRect(cell.x0, cell.y0, cell.x1 - cell.x0, cell.y1 - cell.y0);
    ctx.strokeStyle = colourOf(cell);
    ctx.lineWidth = (cell.rowspan > 1 || cell.colspan > 1 || !cell.rect) ? lw * 2 : lw;
    ctx.strokeRect(cell.x0 + .5, cell.y0 + .5, cell.x1 - cell.x0 - 1, cell.y1 - cell.y0 - 1);
    // a cell containing others is hatched over the part that is not its own,
    // so the subtraction is visible rather than only stated in the panel
    for (const o of cell.holes) {
      ctx.save();
      ctx.beginPath(); ctx.rect(o.x0, o.y0, o.x1 - o.x0, o.y1 - o.y0); ctx.clip();
      ctx.strokeStyle = 'rgba(123,31,162,.5)'; ctx.lineWidth = lw;
      const step = Math.max(6, lw * 6);
      ctx.beginPath();
      for (let d = -(o.y1 - o.y0); d < (o.x1 - o.x0); d += step) {
        ctx.moveTo(o.x0 + d, o.y0); ctx.lineTo(o.x0 + d + (o.y1 - o.y0), o.y1);
      }
      ctx.stroke();
      ctx.restore();
    }
  }
  ctx.globalAlpha = sel ? 0.3 : 1;
  ctx.fillStyle = '#1565c0';
  R.G.pts.forEach((p, i) => {
    if (!R.G.inMain.has(i)) return;
    ctx.beginPath(); ctx.arc(p.x, p.y, r, 0, Math.PI * 2); ctx.fill();
  });
  ctx.globalAlpha = 1;
  ctx.restore();
  }

  // the selected cell, marked on EVERY VISIBLE panel so the region, the graph that
  // enclosed it and the cell that claims it can be compared directly
  if (sel && sel.cell) {
    // use the freshly-built cell where one matches, so the box drawn is the one
    // this render actually produced rather than a stale copy
    const cell = R.table.cells.find(isSel) || sel.cell;
    const cw = cell.x1 - cell.x0, ch = cell.y1 - cell.y0;
    for (let pi = 0; pi < 3; pi++) {
      if (slot[pi] < 0) continue;
      ctx.save();
      ctx.translate(atX(pi), atY(pi));
      if (pi === 0) {
        // on the scan: a tint light enough to leave the content readable
        ctx.fillStyle = 'rgba(255,214,0,.16)';
      } else if (pi === 1) {
        // over the graph: lighter still, so the edges stay legible under it
        ctx.fillStyle = 'rgba(255,214,0,.12)';
      } else {
        ctx.fillStyle = cell.filled ? 'rgba(46,125,50,.30)' : 'rgba(198,40,40,.18)';
      }
      ctx.fillRect(cell.x0, cell.y0, cw, ch);
      ctx.strokeStyle = colourOf(cell);
      ctx.lineWidth = lw * 3;
      ctx.strokeRect(cell.x0 + lw, cell.y0 + lw, cw - lw * 2, ch - lw * 2);
      ctx.strokeStyle = 'rgba(0,0,0,.75)'; ctx.lineWidth = lw;
      ctx.strokeRect(cell.x0 - lw, cell.y0 - lw, cw + lw * 2, ch + lw * 2);
      // the face's actual corner junctions — an L-shaped cell has five or more,
      // and they sit where the pixels are, not at the corners of a bounding box
      ctx.fillStyle = '#1565c0';
      for (const p of (cell.pts || [])) {
        ctx.beginPath(); ctx.arc(p.x, p.y, r * 1.8, 0, Math.PI * 2); ctx.fill();
      }
      ctx.restore();
    }
  }

  // The hovered point, marked on every panel. Crosshairs rather than a dot, so
  // it is findable at any zoom, and the cell under the cursor outlined with it
  // — pointing at a spot in the crop shows which cell claims it and where the
  // graph put its junctions.
  if (zHover) {
    const under = R.table.cells.find(cl =>
      zHover.x >= cl.x0 && zHover.x <= cl.x1 && zHover.y >= cl.y0 && zHover.y <= cl.y1 &&
      // the innermost cell containing the point, so a nested one wins
      !cl.holes.some(o => zHover.x >= o.x0 && zHover.x <= o.x1 &&
                          zHover.y >= o.y0 && zHover.y <= o.y1));
    for (let pi = 0; pi < 3; pi++) {
      if (slot[pi] < 0) continue;
      ctx.save();
      ctx.beginPath(); ctx.rect(atX(pi), atY(pi), w, h); ctx.clip();
      ctx.translate(atX(pi), atY(pi));
      if (under) {
        ctx.fillStyle = 'rgba(255,193,7,.20)';
        ctx.fillRect(under.x0, under.y0, under.x1 - under.x0, under.y1 - under.y0);
        ctx.strokeStyle = '#f9a825'; ctx.lineWidth = lw * 2;
        ctx.strokeRect(under.x0 + lw, under.y0 + lw,
                       under.x1 - under.x0 - lw * 2, under.y1 - under.y0 - lw * 2);
      }
      ctx.strokeStyle = 'rgba(0,0,0,.45)'; ctx.lineWidth = 1;
      ctx.setLineDash([4, 4]);
      ctx.beginPath();
      ctx.moveTo(0, zHover.y + .5); ctx.lineTo(w, zHover.y + .5);
      ctx.moveTo(zHover.x + .5, 0); ctx.lineTo(zHover.x + .5, h);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.restore();
    }
  }
  return c;
}

function graphCanvas(a, reach, sel) {
  const { w, h, ink } = a;
  const G = junctionGraph(a, reach);
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const ctx = c.getContext('2d');
  const im = ctx.createImageData(w, h), d = im.data;
  for (let i = 0, k = 0; i < w * h; i++, k += 4) {
    const v = ink[i] ? 222 : 255;
    d[k] = d[k + 1] = d[k + 2] = v; d[k + 3] = 255;
  }
  ctx.putImageData(im, 0, 0);

  const r = Math.max(3, Math.round(Math.min(w, h) / 200));
  const lw = Math.max(1.5, r / 2.5);

  // junctionGraph rebuilds on every render, so a stored component's point
  // indices belong to a different run. Re-find it by its bounds, which are
  // stable, and work from THIS run's membership.
  let picked = null;
  if (sel && sel.comp) {
    picked = G.comps.find(cp => cp.x0 === sel.comp.x0 && cp.y0 === sel.comp.y0 &&
                                cp.x1 === sel.comp.x1 && cp.y1 === sel.comp.y1);
  }
  const inPick = picked ? new Set(picked.pts) : null;

  // edges: in the main component solid green, elsewhere faint
  for (const e of G.edges) {
    const p = G.pts[e.a], q = G.pts[e.b];
    const keep = G.inMain.has(e.a) && G.inMain.has(e.b);
    if (inPick && !(inPick.has(e.a) && inPick.has(e.b))) continue;
    ctx.strokeStyle = keep ? 'rgba(20,130,60,.95)' : 'rgba(190,60,60,.45)';
    ctx.lineWidth = keep ? lw : lw * 0.7;
    ctx.beginPath(); ctx.moveTo(p.x, p.y); ctx.lineTo(q.x, q.y); ctx.stroke();
  }
  // junctions; any with an arm the graph failed to match gets an orange ring,
  // so a silent loss becomes a visible one
  G.pts.forEach((p, i) => {
    const keep = G.inMain.has(i);
    if (inPick && !inPick.has(i)) return;
    if (p.missing) {
      ctx.strokeStyle = '#ef6c00'; ctx.lineWidth = Math.max(1.5, r / 2);
      ctx.beginPath(); ctx.arc(p.x, p.y, r * 2.2, 0, Math.PI * 2); ctx.stroke();
    }
    ctx.fillStyle = keep ? '#0a7d2c' : '#b03030';
    ctx.beginPath(); ctx.arc(p.x, p.y, keep ? r : r * 0.8, 0, Math.PI * 2); ctx.fill();
  });
  // the lattice the kept component implies
  if (!sel && G.main) {
    ctx.strokeStyle = 'rgba(30,60,200,.28)';
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 4]);
    ctx.beginPath();
    for (const col of G.lattice.cols) { ctx.moveTo(col.at + .5, G.main.y0); ctx.lineTo(col.at + .5, G.main.y1); }
    for (const row of G.lattice.rows) { ctx.moveTo(G.main.x0, row.at + .5); ctx.lineTo(G.main.x1, row.at + .5); }
    ctx.stroke();
    ctx.setLineDash([]);
  }
  return c;
}

function junctionCanvas(a, reach, sel) {
  const { w, h, ink } = a;
  const j = findJunctions(a, reach);
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const ctx = c.getContext('2d');
  const im = ctx.createImageData(w, h), d = im.data;
  // the page in pale grey, so the junctions read against the drawing
  for (let i = 0, k = 0; i < w * h; i++, k += 4) {
    const v = ink[i] ? 205 : 255;
    d[k] = d[k + 1] = d[k + 2] = v; d[k + 3] = 255;
  }
  ctx.putImageData(im, 0, 0);

  // findJunctions runs fresh on every render, so the objects it returns are new
  // each time and an identity test against a stored selection never matches —
  // which dimmed every point and highlighted none. Match on position instead.
  const same = (p, q) => q && p.x === q.x && p.y === q.y;
  const r = Math.max(3, Math.round(Math.min(w, h) / 160));
  let chosen = null;
  for (const p of j.list) {
    if (sel && same(p, sel.pt)) { chosen = p; continue; }   // drawn last, on top
    ctx.globalAlpha = sel ? 0.18 : 1;
    ctx.strokeStyle = (JUNCTION_KINDS[p.kind] || JUNCTION_KINDS.end)[0];
    ctx.lineWidth = Math.max(1.5, r / 3);
    ctx.beginPath(); ctx.arc(p.x, p.y, r, 0, Math.PI * 2); ctx.stroke();
  }
  ctx.globalAlpha = 1;

  if (chosen) {
    const p = chosen;
    const col = (JUNCTION_KINDS[p.kind] || JUNCTION_KINDS.end)[0];
    // crosshairs across the whole canvas, so a single point is findable at any
    // zoom without hunting for it
    ctx.strokeStyle = 'rgba(0,0,0,.28)'; ctx.lineWidth = 1;
    ctx.setLineDash([5, 5]);
    ctx.beginPath();
    ctx.moveTo(0, p.y + .5); ctx.lineTo(w, p.y + .5);
    ctx.moveTo(p.x + .5, 0); ctx.lineTo(p.x + .5, h);
    ctx.stroke();
    ctx.setLineDash([]);
    // the arms that qualified, drawn thick
    ctx.strokeStyle = col; ctx.lineWidth = Math.max(2, r / 2);
    ctx.beginPath();
    ctx.moveTo(p.x - p.armL, p.y); ctx.lineTo(p.x + p.armR, p.y);
    ctx.moveTo(p.x, p.y - p.armU); ctx.lineTo(p.x, p.y + p.armD);
    ctx.stroke();
    // a filled dot inside a heavy ring, on a white halo so it reads on ink
    ctx.fillStyle = '#fff';
    ctx.beginPath(); ctx.arc(p.x, p.y, r * 2.4, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = col; ctx.lineWidth = Math.max(2, r / 1.6);
    ctx.beginPath(); ctx.arc(p.x, p.y, r * 2, 0, Math.PI * 2); ctx.stroke();
    ctx.fillStyle = col;
    ctx.beginPath(); ctx.arc(p.x, p.y, r * 0.8, 0, Math.PI * 2); ctx.fill();
  }
  return c;
}

function dirRows(a, horiz) {
  return DIR_VARIANTS.map(m => ({
    key: m.key,
    colour: m.key === 'none' ? '#8a8f99'
          : m.pct ? '#1a9850' : m.erode ? '#66bd63' : '#fdae61',
    label: m.label.replace(/ \(.*\)/, ''),
    get note() { return `${dirOf(a, m.key, horiz).runs.toLocaleString()} runs`; },
    get dims() {
      const v = dirOf(a, m.key, horiz);
      const b = dirOf(a, 'none', horiz);
      const pc = (x, y) => y ? `${x > y ? '+' : ''}${(100 * (x - y) / y).toFixed(0)}%` : '—';
      const same = m.key === 'none';
      return [
        ['variant', m.label],
        ['what it does', m.note],
        ['axis tested', horiz ? 'x — continuity along the row' : 'y — continuity down the column'],
        ['the test', m.neighbour
          ? (m.neighbour === 'both'
              ? (horiz ? 'ink at BOTH left and right' : 'ink BOTH above and below')
              : (horiz ? 'ink at left OR right' : 'ink above OR below'))
          : (m.key === 'none' ? 'hl ≥ vl — runs further this way than the other'
                              : 'run length along this axis')],
        ['ownership', (m.shared || m.neighbour)
          ? 'SHARED — a junction pixel is in both masks, so crossings leave no holes'
          : 'exclusive — each pixel goes to one mask only, so the losing direction ' +
            'is punched through at every crossing'],
        ...(m.pct ? [['that is', `${((m.pct / 100) * (horiz ? a.w : a.h)).toFixed(0)} px on this crop`]] : []),
        ...(m.shared ? [['junction pixels', (() => {
          // pixels this variant puts in BOTH masks — the crossings that the
          // exclusive rule would have punched out of one of them
          const other = dirOf(a, m.key, !horiz).mask, mine = v.mask;
          let n = 0;
          for (let i = 0; i < mine.length; i++) if (mine[i] && other[i]) n++;
          return `${n.toLocaleString()} px in both masks — the crossings that ` +
                 `exclusive ownership would punch out`;
        })()]] : []),
        ['—— what the pipeline would see ——', ''],
        ['ink kept', `${v.px.toLocaleString()} px` + (same ? '' : `   ${pc(v.px, b.px)}`)],
        ['raw runs', `${v.runs.toLocaleString()}` + (same ? '' : `   ${pc(v.runs, b.runs)}`)],
        ['merged lines', `${v.lines.length.toLocaleString()}` + (same ? '' : `   ${pc(v.lines.length, b.lines.length)}`)],
        ['rule-length lines', `${v.long}` + (same ? '' : `   was ${b.long}`) +
          (v.long < b.long ? '   ← LOST RULES' : v.long === b.long ? '   ← all kept' : '   ← found more')],
        ['worst fusion', `${v.worst} runs in one group` + (same ? '' : `   was ${b.worst}`)],
        ['—— reading it ——', ''],
        ...(same
          ? [['the picture', 'the original on its own — pick any row below to see it ' +
                             'beside that variant']]
          : [['left panel', 'ORIGINAL — the pipeline as it works today'],
             ['right panel', 'this variant'],
             ['pale grey', 'ink the variant dropped, shown in place']]),
        ['colour', 'flat black — a pixel is either detected or it is not'],
        ['what matters', 'rule-length lines must not fall. Everything else can.'],
      ];
    },
  }));
}

// run lengths for an arbitrary mask (the analyse() version reads a.ink)
function lengthsOf(ink, w, h) {
  const hl = new Int32Array(w * h), vl = new Int32Array(w * h);
  for (let y = 0; y < h; y++) {
    let x = 0;
    while (x < w) {
      if (ink[y * w + x]) {
        const s = x;
        while (x < w && ink[y * w + x]) x++;
        for (let q = s; q < x; q++) hl[y * w + q] = x - s;
      } else x++;
    }
  }
  for (let x = 0; x < w; x++) {
    let y = 0;
    while (y < h) {
      if (ink[y * w + x]) {
        const s = y;
        while (y < h && ink[y * w + x]) y++;
        for (let q = s; q < y; q++) vl[q * w + x] = y - s;
      } else y++;
    }
  }
  return { hl, vl };
}

// cached per variant: the morphology and the run-length pass are not free
const variantCache = new Map();
function variantOf(a, key) {
  const hit = variantCache.get(key);
  if (hit && hit.stamp === a.stamp) return hit;
  const v = MASK_VARIANTS.find(m => m.key === key) || MASK_VARIANTS[0];
  const { w, h } = a;
  const ink = v.fn(a.ink, w, h);
  const { hl, vl } = lengthsOf(ink, w, h);
  let px = 0, hRuns = 0, vRuns = 0;
  for (let i = 0; i < w * h; i++) if (ink[i]) px++;
  for (let y = 0; y < h; y++) {
    let x = 0;
    while (x < w) { if (ink[y * w + x]) { hRuns++; while (x < w && ink[y * w + x]) x++; } else x++; }
  }
  for (let x = 0; x < w; x++) {
    let y = 0;
    while (y < h) { if (ink[y * w + x]) { vRuns++; while (y < h && ink[y * w + x]) y++; } else y++; }
  }
  // what the merge stage would make of it
  const hDomM = new Uint8Array(w * h), vDomM = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) {
    if (!ink[i]) continue;
    if (hl[i] >= vl[i]) hDomM[i] = 1; else vDomM[i] = 1;
  }
  const hL = mergeLines(hDomM, w, h, true), vL = mergeLines(vDomM, w, h, false);
  const longH = hL.filter(l => l.len > 0.2 * w).length;
  const longV = vL.filter(l => l.len > 0.2 * h).length;
  const worst = [...hL, ...vL].reduce((m, l) => Math.max(m, l.parts.length), 0);
  const rec = { stamp: a.stamp, key, ink, hl, vl, px, hRuns, vRuns,
                hL, vL, longH, longV, worst, meta: v };
  variantCache.set(key, rec);
  return rec;
}

function variantCanvas(a, key) {
  const { w, h } = a;
  const v = variantOf(a, key || 'none');
  const base = variantOf(a, 'none');
  // as with the directional cards: nothing picked shows the original alone,
  // a variant shows the original beside it
  const pair = !!key && key !== 'none';
  const gap = pair ? Math.max(12, Math.round(w * 0.03)) : 0;
  const c = document.createElement('canvas');
  c.width = pair ? w * 2 + gap : w;
  c.height = h;
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);

  if (pair) {
    const im0 = ctx.createImageData(w, h), d0 = im0.data;
    for (let i = 0, j = 0; i < w * h; i++, j += 4) {
      const col = base.ink[i]
        ? (base.hl[i] >= base.vl[i] ? [200, 30, 30] : [30, 90, 210])
        : [255, 255, 255];
      d0[j] = col[0]; d0[j + 1] = col[1]; d0[j + 2] = col[2]; d0[j + 3] = 255;
    }
    ctx.putImageData(im0, 0, 0);
    ctx.fillStyle = '#e9ebef'; ctx.fillRect(w, 0, gap, h);
  }

  const im = ctx.createImageData(w, h), d = im.data;
  for (let i = 0, j = 0; i < w * h; i++, j += 4) {
    let col = [255, 255, 255];
    if (v.ink[i]) col = v.hl[i] >= v.vl[i] ? [200, 30, 30] : [30, 90, 210];
    // what this variant removed, in pale grey, so the loss is visible too
    else if (a.ink[i]) col = [222, 224, 228];
    d[j] = col[0]; d[j + 1] = col[1]; d[j + 2] = col[2]; d[j + 3] = 255;
  }
  ctx.putImageData(im, pair ? w + gap : 0, 0);
  return c;
}

// ---------------------------------------------------------------------------
// joinCollinear, before and after.
//
// Unlike mergeLines, this step can MOVE a line: it averages the two pieces'
// positions across the rule, weighted by length, so the result sits in a band
// neither input occupied. Drawing the inputs against the output is the only way
// to see that shift, and whether the new band is honest.
// ---------------------------------------------------------------------------
function joinCompareCanvas(a, sel) {
  const { w, h } = a;
  const gap = Math.max(12, Math.round(w * 0.03));
  const c = document.createElement('canvas');
  c.width = w * 2 + gap; c.height = h;
  // tell the viewer this canvas is two panels, so the hover readout reports a
  // coordinate within a panel rather than the raw canvas offset
  c.panelW = w; c.panelH = h; c.panelGap = gap;
  c.panelPlaces = [{ panel: 0, cx: 0, cy: 0 }, { panel: 2, cx: 1, cy: 0 }];
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
  ctx.fillStyle = '#e9ebef'; ctx.fillRect(w, 0, gap, h);

  const before = [...a.hMerged, ...a.vMerged];
  const after = [...a.hLines, ...a.vLines];
  const box = (l, dx) => ctx.fillRect(l.x0 + dx, l.y0,
    Math.max(1, l.x1 - l.x0), Math.max(1, l.y1 - l.y0));

  // LEFT: what went in
  for (const l of before) {
    if (sel && sel.line.src && sel.line.src.includes(l)) continue;
    ctx.globalAlpha = sel ? 0.12 : 0.7;
    ctx.fillStyle = l.horiz ? 'rgb(200,30,30)' : 'rgb(30,60,200)';
    box(l, 0);
  }
  // RIGHT: what came out — joined lines tinted, untouched ones plain
  for (const l of after) {
    if (sel && l === sel.line) continue;
    const joined = l.src && l.src.length > 1;
    ctx.globalAlpha = sel ? 0.12 : (joined ? 0.95 : 0.55);
    ctx.fillStyle = joined ? '#7b1fa2' : (l.horiz ? 'rgb(200,30,30)' : 'rgb(30,60,200)');
    box(l, w + gap);
  }
  ctx.globalAlpha = 1;
  if (!sel) return c;

  // the chosen join: its source pieces left, the straightened result right
  const l = sel.line;
  const mark = Math.max(2, Math.round(Math.min(w, h) / 300));
  (l.src || [l]).forEach((p, i) => {
    ctx.fillStyle = i === 0 ? '#0a7d2c' : '#d84315';
    ctx.fillRect(p.x0 - 1, p.y0 - 1, Math.max(3, p.x1 - p.x0 + 2), Math.max(3, p.y1 - p.y0 + 2));
  });
  ctx.fillStyle = '#7b1fa2';
  box(l, w + gap);
  ctx.strokeStyle = '#000'; ctx.lineWidth = mark;
  ctx.strokeRect(l.x0 - mark + w + gap, l.y0 - mark,
                 Math.max(2, l.x1 - l.x0) + mark * 2, Math.max(2, l.y1 - l.y0) + mark * 2);

  // Where the source pieces sat, drawn again over the RESULT, so the vertical
  // shift the averaging introduced is visible as an offset.
  ctx.globalAlpha = 0.5;
  for (const p of (l.src || [])) {
    ctx.fillStyle = '#d84315';
    ctx.fillRect(p.x0 + w + gap, p.y0, Math.max(1, p.x1 - p.x0), Math.max(1, p.y1 - p.y0));
  }
  ctx.globalAlpha = 1;
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

// Ticked means twice the AREA — whatever the crop. Twice the area is √2 per
// side, not 2, so the pixel count doubles rather than quadrupling.
//
// This used to aim at a 1000px target and only for crops under 40% of the page,
// which meant a 1050px crop reported "not enlarged" despite being well under
// that 40%: the area test decided whether it was eligible and the width test
// decided by how much, and at 1050px there was nothing to add. Two rules
// disagreeing is worse than one you can predict.
const ENLARGE_AREA = 2;                       // times the pixel count
function enlargeFactor(bw, bh) {
  return $('upscale').checked ? Math.sqrt(ENLARGE_AREA) : 1;
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
// 128-190 midtone). Two stages act on that:
//
//   darken  — a gamma curve, and nothing else. Every pixel moves toward black,
//             none toward white, so a faint rule can only ever strengthen. This
//             runs BEFORE the threshold, which is the whole point: a pencil
//             stroke at grey 150 sits above a cut of 120 and is lost, but
//             darkened to 88 it clears the same cut and survives.
//   binary  — one threshold on the darkened grey, every pixel pure black or
//             pure white. This is what the whole line pipeline reads.
//
// An earlier version split at the cut and pushed everything above it toward
// WHITE. That erased exactly the faint structural rules the pipeline is looking
// for — a stroke at grey 90 came out at 206 — so the split is gone. `cut` now
// means the ink/paper threshold and nothing else.
const darkenGamma = () => +$('dark').value;

// ---------------------------------------------------------------------------
// Remove a printed ground: a guilloche mesh, a watermark, a tinted crest.
//
// OFF by default. A plain scan has no ground to remove, and dividing by an
// estimate that is uniformly paper changes nothing while costing a full blur —
// so this is an opt-in for the documents that need it, not a pipeline stage.
//
// Ink is multiplicative, not additive: two layers over each other transmit
// t1*t2, so a rule at 35 over a mesh at 208 reads 35*208/255 = 29. That means a
// ground can be DIVIDED out rather than classified:
//
//   corrected = 255 * observed / ground
//
// which sends every ground pixel to 255 (pure paper) and returns a rule to the
// same tone whether or not a mesh ran beneath it. No pixel is ever labelled
// "background" — the question is never asked, so none of the properties that
// fail to generalise (colour, darkness, shape) are relied on.
//
// The ground is found in the TONE HISTOGRAM, not with a local filter.
//
// A local estimate cannot work here, and it is worth saying why: a mesh line and
// a printed rule are locally identical — both are thin dark strokes. They differ
// only at page scale, in that the mesh line has a parallel partner a few pixels
// away EVERYWHERE while the rule is alone. Two things were tried and measured:
//
//   local max over r    finds the paper BETWEEN mesh lines, so the estimate is
//                       255 everywhere and the division is a no-op (a mesh at
//                       175 came back 179)
//   local closing       finds the darkest locally-ubiquitous tone, which is the
//                       RULE, so rules get divided away and the mesh survives —
//                       exactly backwards
//
// But a ground has a histogram signature that content never has: it is a LARGE
// population at a SINGLE tone, sitting between paper and the real ink. It has to
// be, because it is one ink laid down in one pass across the whole sheet. Rules
// and text are a small population spread across many tones.
//
// So: find the largest tone cluster that is neither the lightest (paper) nor
// small, treat everything at or above it as ground, and lift that to paper. One
// pass to build the histogram, one to apply it — no radius, nothing to tune per
// document, and it is blind to hue, darkness and shape.
// ---------------------------------------------------------------------------
function removeGround(d, w, h, minShare) {
  const n = w * h;
  // One channel is enough: the server renders csGRAY (store.py), so the PNG is
  // literally greyscale and R == G == B. Nothing here can key off hue — a cyan
  // guilloche reaches this code as grey, which is exactly why the test below is
  // about POPULATION SIZE and not about colour.
  const lum = new Uint8Array(n);
  const hist = new Uint32Array(256);
  for (let i = 0, j = 0; i < n; i++, j += 4) {
    const v = d[j];
    lum[i] = v; hist[v]++;
  }

  // Paper is not one tone. On a real scan it is a broad shoulder — measured on a
  // 1205x1718 certificate, tones 244-254 each hold 2-28% and together 84% of the
  // page. So walk DOWN from white accumulating until the mass stops growing
  // quickly; where the shoulder ends is the bottom of paper.
  const cut = +$('cut').value;
  let paper = 255, acc = 0;
  for (let v = 255; v > cut; v--) {
    acc += hist[v];
    if (hist[v] < n * 0.005 && acc > n * 0.3) { paper = v; break; }
    paper = v;
  }

  // A ground only MATTERS if it would otherwise become ink, so look strictly
  // BELOW the threshold — that is the region that reaches the mask. A ground
  // lighter than `cut` is already excluded and removing it would change nothing.
  // (That is the common case: on a real certificate the guilloche sat at 191-243
  // with cut at 190, so it never entered the mask at all. The honest answer
  // there is to do nothing, not to lift 84% of the page to white.)
  const need = n * minShare;
  let best = -1, bestCount = 0;
  for (let v = cut - 1; v >= 24; v--) {
    let c = 0;
    for (let k = v - 6; k <= v + 6; k++) if (k >= 24 && k < cut) c += hist[k];
    if (c > bestCount) { bestCount = c; best = v; }
  }
  if (best < 0 || bestCount < need) return false;   // no ground worth removing

  // Everything from the band's dark edge upward is ground: lift it out. Content
  // DARKER than the band keeps its exact tone, so real rules are untouched —
  // which is why this only ever works when the ground is lighter than the ink.
  const edge = best - 6;
  for (let i = 0, j = 0; i < n; i++, j += 4)
    if (lum[i] >= edge) { d[j] = d[j + 1] = d[j + 2] = 255; }
  return true;
}

// How much of the crop a tone band must cover before it counts as a ground
// rather than as content. A guilloche covers tens of percent; rules cover a few.
const groundShare = () => +$('ground').value / 100;
const groundOn = () => $('groundOn').checked;

// v/255 in [0,1], raised to gamma > 1, back to 0-255. Monotonic: no value ever
// gets lighter, black stays black, white stays white.
function darkenValue(v, g) {
  return g <= 1 ? v : Math.round(255 * Math.pow(v / 255, g));
}

function applyTone(ctx, w, h, mode) {
  if (!mode || mode === 'off' || !w || !h) return;
  const cut = +$('cut').value;
  const g = darkenGamma();
  const im = ctx.getImageData(0, 0, w, h), d = im.data;

  // same order as analyse(), so the cards show what the pipeline actually reads
  if (groundOn()) removeGround(d, w, h, groundShare());
  for (let i = 0; i < d.length; i += 4) {
    const v = darkenValue(d[i], g);
    const out = mode === 'binary' ? (v < cut ? 0 : 255) : v;
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
    // Sample the INK box where the cell has one: the grid box is straightened
    // onto an idealised lattice and can sit a few px off the real ink, which
    // with a small inset is enough to clip a glyph or pull in a neighbouring
    // rule. Cells from the line-based buildTable have no ink box, so fall back
    // to the grid box and that path is unchanged.
    const bx0 = c.ix0 !== undefined ? c.ix0 : c.x0;
    const bx1 = c.ix1 !== undefined ? c.ix1 : c.x1;
    const by0 = c.iy0 !== undefined ? c.iy0 : c.y0;
    const by1 = c.iy1 !== undefined ? c.iy1 : c.y1;
    const cw = bx1 - bx0, ch = by1 - by0;
    const m = Math.max(3, Math.round(Math.min(cw, ch) * CELL_INSET));
    const x0 = Math.max(0, bx0 + m), x1 = Math.min(w, bx1 - m);
    const y0 = Math.max(0, by0 + m), y1 = Math.min(h, by1 - m);
    const sw = x1 - x0, sh = y1 - y0;
    c.ink = 0; c.blobs = 0; c.filled = false;
    if (sw <= 0 || sh <= 0) continue;

    // flood each blob once, tracking its area and bounding box
    const seen = new Uint8Array(sw * sh);
    // Pre-mark anything inside a contained cell as already visited, so its
    // content counts for that cell and not for this one. Without it a region
    // enclosing other cells reports their ink as its own.
    let holeArea = 0;
    for (const o of (c.holes || [])) {
      const hx0 = Math.max(0, (o.ix0 !== undefined ? o.ix0 : o.x0) - x0);
      const hx1 = Math.min(sw, (o.ix1 !== undefined ? o.ix1 : o.x1) - x0);
      const hy0 = Math.max(0, (o.iy0 !== undefined ? o.iy0 : o.y0) - y0);
      const hy1 = Math.min(sh, (o.iy1 !== undefined ? o.iy1 : o.y1) - y0);
      for (let y = hy0; y < hy1; y++)
        for (let x = hx0; x < hx1; x++)
          if (!seen[y * sw + x]) { seen[y * sw + x] = 1; holeArea++; }
    }
    const area = Math.max(1, sw * sh - holeArea);
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

// ---------------------------------------------------------------------------
// A card with a list under it. Clicking a row re-renders the picture with that
// item singled out — the thumbnail, and the full-size view if it is open — so a
// merge can be inspected rather than described.
// ---------------------------------------------------------------------------
function listCard(label, make, dims, zoomTitle, rows) {
  let active = null;

  // Build one picker; it is cloned into whichever surface needs it. The card
  // gets one, and the full-size viewer gets its own — the detail is only really
  // legible at full size, so the list has to be reachable from there too.
  const buildList = onPick => {
    const list = document.createElement('div');
    list.className = 'picklist';
    for (const r of rows) {
      const b = document.createElement('button');
      b.className = 'pick';
      b._item = r;
      if (r === active) b.classList.add('on');
      b.innerHTML = `<span class="sw" style="background:${r.colour}"></span>`
                  + `<span class="pl">${r.label}</span>`
                  + `<span class="pn">${r.note}</span>`;
      b.addEventListener('click', () => onPick(active === r ? null : r));
      list.appendChild(b);
    }
    return list;
  };

  const el = card(label, () => make(active), dims, zoomTitle);
  const th = el.querySelector('.thumb');
  const cardList = buildList(item => paint(item));

  // `card` binds its own click handler with the unselected view and the card's
  // dims; replace it so the viewer opens on whatever row is highlighted.
  const th2 = th.cloneNode(false);
  th.parentNode.replaceChild(th2, th);
  th2.appendChild(make(null));
  th2.addEventListener('click', () => openViewer());

  const openViewer = () => {
    // openZoom wipes the rail, so the picker is rebuilt each time; carry the
    // scroll position across or a pick 30 rows down would jump back to the top
    const prev = $('zstats').querySelector('.picklist');
    const at = prev ? prev.scrollTop : 0;
    openZoom(make(active), zoomTitle, active ? active.dims : dims, openViewer);
    const rail = $('zstats');

    // every raw run of the selected group, with the numbers its join turned on
    if (active && active.table) {
      const h2 = document.createElement('div');
      h2.className = 'zsec';
      h2.textContent = `all ${active.table.body.length} raw runs`;
      rail.appendChild(h2);

      const wrap = document.createElement('div');
      wrap.className = 'ztabwrap';
      const t = document.createElement('table');
      t.className = 'ztab';
      const thead = document.createElement('thead');
      const hr = document.createElement('tr');
      for (const c of active.table.head) {
        const th = document.createElement('th'); th.textContent = c; hr.appendChild(th);
      }
      thead.appendChild(hr); t.appendChild(thead);
      const tb = document.createElement('tbody');
      for (const r of active.table.body) {
        const tr = document.createElement('tr');
        if (r[0] === 'seed') tr.className = 'seed';
        r.forEach((cell, ci) => {
          const td = document.createElement('td');
          td.textContent = cell;
          // flag a join that only just passed — the loose ones are the bug
          if (ci === 7 && cell !== '—' && parseFloat(cell) < 5) td.className = 'tight';
          tr.appendChild(td);
        });
        tb.appendChild(tr);
      }
      t.appendChild(tb); wrap.appendChild(t); rail.appendChild(wrap);
    }

    const head = document.createElement('div');
    head.className = 'zpickhead';
    head.textContent = `all ${rows.length} merges, biggest first — click to isolate`;
    rail.appendChild(head);
    const fresh = buildList(item => paint(item));
    rail.appendChild(fresh);
    fresh.scrollTop = at;
  };

  function paint(item) {
    active = item;
    th2.innerHTML = '';
    th2.appendChild(make(item));
    for (const b of cardList.children) b.classList.toggle('on', b._item === item);
    if (!$('zoom').hidden && zCanvas) {
      // The viewer is open — redraw it, holding the zoom AND the scroll
      // position. Without the scroll the viewport snapped back on every pick
      // and the cell had to be found again by hand.
      const keep = zScale;
      const body = $('zbody');
      const sl = body.scrollLeft, st = body.scrollTop;
      openViewer();
      setZoom(keep);
      body.scrollLeft = sl; body.scrollTop = st;
      // then bring the new selection into view if it is off screen, so picking
      // a row is enough to see it
      if (item && item.cell) revealCell(item.cell);
    }
  }

  el.insertBefore(cardList, el.querySelector('.hintline'));
  el.querySelector('.hintline').textContent =
    'click a row to isolate it · the list is in the full-size view too';
  return el;
}

// ---------- full-size viewer ----------
let zCanvas = null, zScale = 1;
// how to rebuild the open view, so the panel toggles can re-render it
let zRedraw = null;

function openZoom(canvas, title, dims, redraw) {
  zCanvas = canvas;
  // a panelled canvas offers the panel toggles; anything else hides them
  zRedraw = redraw || null;
  $('zpanels').hidden = !canvas.panelToggles;
  // only the three-panel comparison offers the toggles
  if (canvas.panelPlaces && canvas.panelPlaces.length >= 2 && canvas.panelToggles)
    for (const btn of $('zpanels').children)
      btn.classList.toggle('on', PANELS[+btn.dataset.panel]);
  // The title keeps the short summary; the numbers go in their own panel, where
  // a length histogram has room to be read rather than being crushed into one
  // dot-separated line.
  $('ztitle').textContent = title;
  const st = $('zstats');
  st.innerHTML = '';
  for (const [k, v] of dims) {
    // a key with no value is a section heading, spanning both columns
    if (v === '') {
      const hd = document.createElement('div');
      hd.className = 'zsec'; hd.textContent = k.replace(/—/g, '').trim();
      st.appendChild(hd);
      continue;
    }
    const dt = document.createElement('dt'); dt.textContent = k;
    const dd = document.createElement('dd'); dd.textContent = v;
    st.appendChild(dt); st.appendChild(dd);
  }
  const body = $('zbody');
  body.innerHTML = '';
  // an inline-block pad, so a canvas narrower than the box still centres while
  // a wider one overflows to the right where it can be scrolled to
  const pad = document.createElement('div');
  pad.id = 'zpad';
  pad.appendChild(canvas);
  body.appendChild(pad);
  $('zoom').hidden = false;
  zoomFit();
}

// Zoom about a point of the IMAGE rather than the top-left corner, so whatever
// is under the cursor — or in the middle of the view — stays put as the canvas
// grows. Without this, zooming in on a detail throws it off screen and there is
// no way to find it again.
function applyZoom(anchor) {
  if (!zCanvas) return;
  const body = $('zbody');
  const prev = zCanvas.clientWidth || (zCanvas.width * zScale);
  // where the anchor sits in image space, before the resize
  const ox = anchor ? anchor.ox : body.clientWidth / 2;
  const oy = anchor ? anchor.oy : body.clientHeight / 2;
  const ix = (body.scrollLeft + ox) / prev;
  const iy = (body.scrollTop + oy) / Math.max(1, zCanvas.clientHeight);

  zCanvas.style.width = Math.round(zCanvas.width * zScale) + 'px';
  zCanvas.style.height = 'auto';
  $('zpct').textContent = Math.round(zScale * 100) + '%';

  const now = zCanvas.clientWidth || (zCanvas.width * zScale);
  body.scrollLeft = ix * now - ox;
  body.scrollTop = iy * Math.max(1, zCanvas.clientHeight) - oy;
}
function setZoom(z, anchor) {
  zScale = Math.max(0.05, Math.min(8, z));
  applyZoom(anchor);
}
// ---------------------------------------------------------------------------
// Hovering a tiled canvas.
//
// A tiled view repeats the same crop in two or three panels. Pointing at a spot
// in one should say where that spot is in the others, so the crop, the graph
// and the cells can be read against each other without counting rows.
// ---------------------------------------------------------------------------
let zHover = null;                 // {x, y} in crop coordinates, or null
let hoverPending = false;

// canvas point -> which panel, and where inside it
function canvasToPanel(canvas, x, y) {
  const pw = canvas.panelW, ph = canvas.panelH, g = canvas.panelGap;
  if (!pw || !canvas.panelPlaces) return null;
  for (const pl of canvas.panelPlaces) {
    const ox = pl.cx * (pw + g), oy = pl.cy * (ph + g);
    if (x >= ox && x < ox + pw && y >= oy && y < oy + ph)
      return { panel: pl.panel, x: x - ox, y: y - oy,
               name: ['crop', 'graph', 'cells'][pl.panel] };
  }
  return null;                     // in a gutter
}

// Redraw the open view at most once per frame, holding the zoom and scroll.
// Used by hovering, which fires on every pointer move, and by a window resize,
// which changes which tiling fits best — the canvas is rebuilt from scratch
// each time, so without the throttle it would rebuild far more often than the
// screen refreshes.
function scheduleViewDraw() {
  if (hoverPending) return;
  hoverPending = true;
  requestAnimationFrame(() => {
    hoverPending = false;
    if (!zRedraw || $('zoom').hidden) return;
    const body = $('zbody');
    const keep = zScale, sl = body.scrollLeft, st = body.scrollTop;
    zRedraw();
    setZoom(keep);
    body.scrollLeft = sl; body.scrollTop = st;
  });
}

// Scroll the viewer so a cell is on screen, if it is not already. Called when a
// row is picked, so choosing from the list is enough to see the thing chosen —
// before this the viewport stayed where it was and the cell had to be hunted.
//
// On a stacked canvas the same cell appears in all three panels; aim at the one
// nearest the current view, so picking a row does not drag you between panels.
function revealCell(cell) {
  if (!zCanvas) return;
  const body = $('zbody');
  const k = (zCanvas.clientWidth || zCanvas.width) / zCanvas.width;
  const pw = zCanvas.panelW, ph = zCanvas.panelH, g = zCanvas.panelGap;
  const places = zCanvas.panelPlaces || [{ cx: 0, cy: 0 }];
  const cx = (cell.x0 + cell.x1) / 2;
  const cyBase = (cell.y0 + cell.y1) / 2;
  // the tile whose copy of this cell is closest to what is on screen now, so a
  // pick does not drag you from one panel to another
  const midX = body.scrollLeft + body.clientWidth / 2;
  const midY = body.scrollTop + body.clientHeight / 2;
  let bx = 0, by = 0, bestD = Infinity;
  for (const pl of places) {
    const ox = pl.cx * (pw + g), oy = pl.cy * (ph + g);
    const d = Math.hypot((cx + ox) * k - midX, (cyBase + oy) * k - midY);
    if (d < bestD) { bestD = d; bx = ox; by = oy; }
  }
  const px = (cx + bx) * k, py = (cyBase + by) * k;
  const m = 40;                                  // keep a margin off the edge
  const x0 = (cell.x0 + bx) * k - m, x1 = (cell.x1 + bx) * k + m;
  const y0 = (cell.y0 + by) * k - m, y1 = (cell.y1 + by) * k + m;
  // only move if the cell is not comfortably inside the viewport already
  if (x0 < body.scrollLeft || x1 > body.scrollLeft + body.clientWidth)
    body.scrollLeft = px - body.clientWidth / 2;
  if (y0 < body.scrollTop || y1 > body.scrollTop + body.clientHeight)
    body.scrollTop = py - body.clientHeight / 2;
}

function zoomFit() {
  if (!zCanvas) return;
  const body = $('zbody');
  setZoom(Math.min(
    (body.clientWidth - 40) / zCanvas.width,
    (body.clientHeight - 40) / zCanvas.height,
  ));
}
function closeZoom() {
  $('zoom').hidden = true; zCanvas = null; zRedraw = null; zHover = null;
  $('zpanels').hidden = true;
}

$('zin').addEventListener('click', () => setZoom(zScale * 1.25));
$('zout').addEventListener('click', () => setZoom(zScale / 1.25));
$('zfit').addEventListener('click', zoomFit);
$('z100').addEventListener('click', () => setZoom(1));
$('zclose').addEventListener('click', closeZoom);
$('zoom').addEventListener('click', e => { if (e.target.id === 'zoom') closeZoom(); });

// ---- panel toggles ----
// A stacked view can show any one, two or all three of its panels: one to study
// closely, two to compare, three for the overview. Toggling holds the zoom and
// the scroll, so the view does not jump while you switch what is beside what.
// the best tiling depends on the window, so re-evaluate it on a resize
window.addEventListener('resize', () => {
  if (!$('zoom').hidden && zRedraw) scheduleViewDraw();
});

$('zpanels').addEventListener('click', e => {
  const b = e.target.closest('.pn');
  if (!b || !zRedraw) return;
  const i = +b.dataset.panel;
  // never turn the last one off — an empty canvas says nothing
  if (PANELS[i] && PANELS.filter(Boolean).length === 1) return;
  PANELS[i] = !PANELS[i];
  for (const btn of $('zpanels').children)
    btn.classList.toggle('on', PANELS[+btn.dataset.panel]);
  const body = $('zbody');
  const keep = zScale, sl = body.scrollLeft, st = body.scrollTop;
  zRedraw();
  setZoom(keep);
  body.scrollLeft = sl; body.scrollTop = st;
});

// ---- drag to pan ----
// Scrollbars alone are awkward on a deep zoom; dragging the image is how every
// map and viewer does it. Pointer events cover mouse, trackpad and touch, and
// capture keeps the drag alive when the cursor leaves the panel.
(() => {
  const body = $('zbody');
  let from = null;
  body.addEventListener('pointerdown', e => {
    if (e.button !== 0 || !zCanvas) return;
    from = { x: e.clientX, y: e.clientY, l: body.scrollLeft, t: body.scrollTop };
    body.setPointerCapture(e.pointerId);
    body.classList.add('drag');
  });
  body.addEventListener('pointermove', e => {
    // the coordinate under the cursor, in the canvas's own pixels — which are
    // the crop pixels every number in the panel is quoted in
    if (zCanvas) {
      const r = zCanvas.getBoundingClientRect();
      const k = zCanvas.width / r.width;
      const x = Math.floor((e.clientX - r.left) * k);
      const y = Math.floor((e.clientY - r.top) * k);
      const inside = x >= 0 && y >= 0 && x < zCanvas.width && y < zCanvas.height;
      if (!inside) { $('zat').textContent = ''; return; }
      // A panelled canvas repeats the same crop, side by side or stacked;
      // report the coordinate within whichever panel the cursor is over rather
      // than the raw canvas offset.
      // Which tile is the cursor over, and where inside it. `panelPlaces` maps
      // each shown panel to its grid cell, so this works for any arrangement.
      const hit = canvasToPanel(zCanvas, x, y);
      if (hit) {
        $('zat').textContent = `${hit.x}, ${hit.y}  ${hit.name}`;
        // the same point in crop coordinates, highlighted on EVERY panel — so
        // pointing at a cell on one shows you where it is on the others
        if (zHover === null || zHover.x !== hit.x || zHover.y !== hit.y) {
          zHover = { x: hit.x, y: hit.y };
          if (zRedraw) scheduleViewDraw();
        }
      } else {
        $('zat').textContent = '';
        if (zHover) { zHover = null; if (zRedraw) scheduleViewDraw(); }
      }
    }
    if (!from) return;
    e.preventDefault();
    body.scrollLeft = from.l - (e.clientX - from.x);
    body.scrollTop = from.t - (e.clientY - from.y);
  });
  body.addEventListener('pointerleave', () => {
    $('zat').textContent = '';
    if (zHover) { zHover = null; if (zRedraw) scheduleViewDraw(); }
  });
  const end = () => { from = null; body.classList.remove('drag'); };
  body.addEventListener('pointerup', end);
  body.addEventListener('pointercancel', end);

  // wheel zoom, anchored on the pixel under the cursor. Plain wheel still
  // scrolls, which is what a trackpad two-finger swipe should do.
  body.addEventListener('wheel', e => {
    if (!zCanvas || (!e.ctrlKey && !e.metaKey)) return;
    e.preventDefault();
    const r = body.getBoundingClientRect();
    setZoom(zScale * Math.exp(-e.deltaY * 0.0015),
            { ox: e.clientX - r.left, oy: e.clientY - r.top });
  }, { passive: false });
})();

document.addEventListener('keydown', e => {
  if ($('zoom').hidden) return;
  if (e.key === 'Escape') { closeZoom(); return; }
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;
  if (e.key === '+' || e.key === '=') setZoom(zScale * 1.25);
  if (e.key === '-' || e.key === '_') setZoom(zScale / 1.25);
  if (e.key === '0') zoomFit();
  if (e.key === '1') setZoom(1);
  // arrows pan, so the keyboard can reach a detail too
  const step = e.shiftKey ? 240 : 60;
  const body = $('zbody');
  if (e.key === 'ArrowLeft') { e.preventDefault(); body.scrollLeft -= step; }
  if (e.key === 'ArrowRight') { e.preventDefault(); body.scrollLeft += step; }
  if (e.key === 'ArrowUp') { e.preventDefault(); body.scrollTop -= step; }
  if (e.key === 'ArrowDown') { e.preventDefault(); body.scrollTop += step; }
});

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------
$('docSel').addEventListener('change', e => openDoc(e.target.value));
$('pageSel').addEventListener('change', e => showPage(+e.target.value));
$('unit').addEventListener('change', () => { if (BOX) runBox(); else hint(); });
$('upscale').addEventListener('change', () => { if (BOX) runBox(); });
$('allStages').addEventListener('change', e => {
  SHORT_VIEW = !e.target.checked;
  if (BOX) runBox();
});

for (const id of ['dark', 'cut', 'mend', 'crossN', 'ground']) {
  $(id).addEventListener('input', () => {
    $('darkOut').textContent = darkenGamma() > 1 ? `×${(+$('dark').value).toFixed(1)}` : 'off';
    $('cutOut').textContent = $('cut').value;
    $('mendOut').textContent = +$('mend').value ? $('mend').value + '%' : 'off';
    $('crossNOut').textContent = $('crossN').value;
    $('groundOut').textContent = $('ground').value + '%';
  });
  $(id).addEventListener('change', () => { if (BOX) runBox(); });
}

// The radius slider only bites while removal is on, so grey it out otherwise —
// a control that silently does nothing is worse than a disabled one.
$('groundOn').addEventListener('change', () => {
  $('ground').disabled = !$('groundOn').checked;
  if (BOX) runBox();
});
$('ground').disabled = !$('groundOn').checked;

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
  // The upload is the longest wait in the app: the server opens the PDF and
  // counts its pages before answering, so name the file being worked on.
  showBusy(`uploading ${pdfs[0].name}…`);
  let last = null;
  try {
    for (let i = 0; i < pdfs.length; i++) {
      setBusyMsg(pdfs.length > 1
        ? `uploading ${i + 1} of ${pdfs.length}: ${pdfs[i].name}…`
        : `uploading ${pdfs[i].name}…`);
      await painted();
      const r = await api.upload(pdfs[i]);
      if (r.error) { setStatus(r.error); return; }
      last = r.id;
    }
    setBusyMsg('opening…');
    await refreshDocs(last);
  } finally {
    hideBusy();
  }
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
