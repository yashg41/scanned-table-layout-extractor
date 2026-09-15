# Scanned table layout extractor

Drag a rectangle around a table in a scanned PDF and get its structure back:
rows, columns, merged cells, and which cells hold content.

It reads nothing but pixels. No OCR, no text layer, no vector paths from the
PDF, no model. Every page is treated as a scan, because the documents this was
built for are scans — vendor drawings and equipment lists that went through a
photocopier before anyone thought about parsing them.

The whole detection runs in the browser. The Python server does one thing: turn
a PDF page into a PNG.

---

## Run it

```bash
git clone https://github.com/yashg41/scanned-table-layout-extractor
cd scanned-table-layout-extractor
python -m venv .venv && .venv/bin/pip install -r requirements.txt
.venv/bin/python -m stle.server
```

Open <http://127.0.0.1:8010>, drop in a PDF, pick a page, drag a box around a
table.

**No sample documents ship with this repo.** Bring your own. Uploads are stored
in `uploads/` next to the app and never leave your machine.

Options: `--port N`, `--host H`, `--reload`.

---

## How it works

Each stage below is a card on the page, in order, so you can watch the table
come apart and reassemble. Every stage exists because something specific broke
without it — that history is the useful part, so it is written down here rather
than lost in the commit log.

### 1. Crop, enlarge, threshold

The box is cropped out. If the table covers less than 40% of the page it is
enlarged first, because a small table's rules are only a pixel or two wide and
every later measurement gets coarse.

The trigger is **area, not width**: a wide thin strip and a small square can
share a width while occupying very different amounts of the page.

Then the crop is thresholded to pure black and white. Grey level 190 by default.

### 2. Mend

A printed rule rarely reaches the scan in one piece. On one title block a single
horizontal rule arrived as **five separate fragments**, split by holes one and
two pixels wide where the toner simply had not taken.

Every later stage would treat those as five short lines and discard them all.

The repair fills a run of blank pixels when ink sits on both sides and the gap
is narrower than the setting. It runs along each axis separately and unions the
result, which is what keeps text intact — a gap inside a letter is
two-dimensional and survives a purely horizontal or purely vertical pass.

```
before   ────────  ──   ─────────      one rule, five pieces
after    ───────────────────────       one rule
```

Measured on a word of body text: 577 ink pixels became 599. On the broken rule:
five fragments, longest 290 px, became one line of 776 px.

### 3. Runs, and merging them into lines

Every horizontal run of dark pixels is recorded, then every vertical run. No
length filter, no thickness filter. A glyph stroke is a run too.

Each pixel is then assigned to whichever direction it runs further in, and
adjacent overlapping runs are merged into whole lines.

**Why merging is not optional:** a 6-pixel-thick rule arrives as six one-pixel
runs, and every one of them looks short. Merge first, measure after.

```
raw runs      12,117 horizontal
merged lines   1,336
```

### 4. Crossing

A line survives only if it crosses a line of the other direction.

Plain intersection is not enough on its own — it keeps 953 of those 1,336 lines,
because inside a letter every horizontal stroke meets a vertical one. Text is
internally a grid. So the crossing partner must itself be substantial.

### 5. Spanning — both ends, different perpendiculars

This is the stage that does the real work.

A real divider runs from one perpendicular **across to another**. A glyph stroke
touches a rule and dies inside the same cell, so both of its ends land on the
same partner, or on no partner at all.

```
keeps:   │────────│     ends on two different verticals
drops:   │───             starts at a rule, dies in open space
drops:    ───              touches nothing
```

The crop border counts as an anchor, and the left border is a different anchor
from the right, so a rule spanning the full width still passes.

On a page dense with Chinese text this took 288 vertical lines down to 74. All
214 dropped were glyph stems. Every real rule survived.

**There is no distance tolerance anywhere in this test**, and that matters. An
earlier version measured from a line's end to the *centre* of its partner and
allowed a few pixels of slack. On a rule 7 pixels thick, a vertical starting
inside that rule sits 3 pixels from its centre — so a thick rule repelled the
very lines touching it, and two real columns were dropped for being "too far"
from something they physically touched.

The test now asks whether the partner's own span contains the end. The crossing
test has already established that they touch; this only asks *where*.

### 6. Connected component

Lines are nodes, crossings are edges. Keep only the component containing the
outer frame. Anything floating inside a cell with no path out is not table
structure. On one title block 27 components collapsed to 1.

### 7. Flood the lattice into cells

Every surviving rule snaps onto a shared lattice. Each lattice edge is marked
walled or open depending on whether a rule stands there. Then each open interior
is flooded.

**A flood cannot cross a rule**, so it stops exactly at the cell walls. A merged
cell comes out as one region no matter how many lattice units it spans, and
nothing has to be told in advance which cells are merged.

```
┌───┬───┬───┐
│   │   │   │     three cells
├───┴───┼───┤
│       │   │     one 1x2 cell, one 1x1 — the flood finds this,
└───────┴───┘     it is not configured anywhere
```

The frame's four sides are added as implicit rules. A table's outermost column
is bounded by the sheet border rather than a printed line, so without them a
side strip never closes and its cells are lost.

The cluster tolerance is not a tuned constant either. It is read off the data:
the thickest rule actually found. Its only job is to merge the two edges of one
thick rule into a single lattice coordinate.

### 8. Filled or empty

Each cell is inset by 6% of its shorter side so its own borders fall outside the
sample, then what remains is grouped into blobs. A blob counts as content only
if it clears two bars:

- **size** — bigger than 0.05% of the cell, which rejects scanner dirt
- **shape** — not a leftover rule. A border that outlives the inset spans nearly
  the full width or height while staying a sliver in the other direction. A
  glyph never does.

The shape test is what matters. Area alone cannot tell a 400-pixel border strip
from a 400-pixel character, and on a narrow column a 2×94 border sliver was once
the only blob present — so that cell read as full when it was empty.

---

## Controls

| Control | What it does |
|---|---|
| **dpi** | Render resolution. The box rescales with it, so the same region stays marked. |
| **enlarge** | Scale up tables covering under 40% of the page. |
| **cut** | Grey level that counts as ink. |
| **mend** | Widest gap to bridge, in pixels. 0 turns the repair off. |
| **cross ≥** | How long a crossing partner must be, as a percentage of the table. |
| **×** | How many distinct crossings a line needs. |

Almost every threshold is a **percentage of the crop**, not a pixel count, so
the same setting means the same thing at any dpi and whether or not the table
was enlarged. The two exceptions are deliberate: `mend` measures a physical
scanner defect, whose size does not scale with the table, and the lattice
tolerance is read from the data.

---

## Limitations

Stated plainly, because they are real.

- **`cross ≥` is the weak point.** It is a percentage of the crop's smaller
  side, but what it must beat is the *text size*, which does not scale with the
  crop. On a short, wide title block 5% comes to 11 px — shorter than the
  lettering — and glyph strokes start qualifying as partners. No single
  percentage works across every page tested.
- **Ruled tables only.** A table whose structure is implied by whitespace alone
  has no lines to find.
- **Wide scan fade is not repaired.** `mend` bridges gaps of a few pixels.
  Where a rule fades out over 40 pixels, the surviving fragments have to carry
  it through the later stages on their own.
- **L-shaped regions are detected but not expressible.** The flood can return a
  non-rectangular region; HTML's rowspan and colspan cannot represent one. They
  are counted and reported as `ragged` rather than silently squared off.
- **No skew correction.** A visibly rotated scan will not read cleanly.
- **No text extraction.** This recovers structure, not content. Pair it with an
  OCR engine if you need both.

---

## Architecture

```
stle/server.py        7 routes. Uploads a PDF, renders a page to PNG, caches it.
stle/store.py         One directory per document, keyed by content hash.
stle/static/app.js    The entire pipeline, plus the UI.
stle/static/index.html
```

The split is the point. The server never sees a table; it cannot, because it
only ever hands out a PNG. Everything in the "How it works" section above lives
in `app.js` and runs on a canvas in the browser.

That keeps the Python dependency list at four packages, all infrastructure:
FastAPI, Uvicorn, python-multipart, PyMuPDF.

### API

| Method | Path | Returns |
|---|---|---|
| GET | `/api/docs` | the library |
| POST | `/api/docs` | upload a PDF (multipart `file`) |
| GET | `/api/docs/{id}` | page geometry in pixels, and page size in points |
| DELETE | `/api/docs/{id}` | remove a document |
| GET | `/api/docs/{id}/page/{i}.png` | one page, grayscale, cached |
| GET | `/health` | status and document count |

Pages render as PNG rather than JPEG on purpose: the detector thresholds these
pixels, and JPEG ringing gets counted as ink — measured at roughly 1,200
spurious ink pixels on one page, with individual pixels off by up to 32 grey
levels.

---

## Licence

This project's own code is **MIT**. See [LICENSE](LICENSE).

One dependency needs a note. **PyMuPDF is AGPL-3.0**, or a commercial licence
from Artifex. Depending on it through pip does not relicense this code — the
licences stay separate and you install PyMuPDF yourself — but the AGPL's network
clause can reach you if you **host this as a public service**. Worth a look
before you deploy it.

The escape hatch is real and cheap: **the detection pipeline has no Python
dependency at all.** PyMuPDF is used solely to turn a PDF page into a PNG. Swap
in PDF.js and render client-side, and the Python server disappears entirely.
