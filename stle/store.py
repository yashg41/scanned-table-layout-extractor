"""Disk-backed document store.

One directory per document under `uploads/<doc_id>/`:

    source.pdf              the PDF as uploaded
    meta.json               title, page count
    pages/p000@150.png      cached grayscale rasters, keyed by render scale

The id is the SHA-256 of the PDF bytes truncated to 12 hex chars, so the same
file always lands on the same document and re-uploading it is a no-op rather
than a duplicate. Nothing here touches a database.
"""
from __future__ import annotations

import hashlib
import json
import shutil
from dataclasses import dataclass
from pathlib import Path

import pymupdf

# uploads/ sits beside the package, not inside it, so a user's documents never
# land in an importable directory.
ROOT = Path(__file__).resolve().parent
UPLOADS = ROOT.parent / "uploads"

# 150 dpi is a good default for line detection: fine enough that a 1px rule on
# the paper survives, coarse enough that a full page renders in tens of ms.
DEFAULT_DPI = 150.0


def doc_id(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()[:12]


@dataclass
class PageGeom:
    """How one page is rastered. `scale` is the dpi as a string."""

    index: int
    width: int
    height: int
    scale: str

    def as_dict(self) -> dict:
        return {"index": self.index, "w": self.width, "h": self.height, "scale": self.scale}


class Document:
    def __init__(self, path: Path):
        self.dir = path
        self.id = path.name

    # ---------- paths ----------
    @property
    def pdf(self) -> Path:
        return self.dir / "source.pdf"

    @property
    def meta_path(self) -> Path:
        return self.dir / "meta.json"

    @property
    def pages_dir(self) -> Path:
        return self.dir / "pages"

    # ---------- metadata ----------
    def meta(self) -> dict:
        return json.loads(self.meta_path.read_text())

    def write_meta(self, meta: dict) -> None:
        self.meta_path.write_text(json.dumps(meta, ensure_ascii=False, indent=2))

    # ---------- geometry ----------
    def geometry(self, dpi: float = DEFAULT_DPI) -> list[PageGeom]:
        """Per-page raster size. Resolved per page, never per document: page
        sizes differ within a document, and a landscape drawing is often a
        portrait page rotated 90°.

        `page.rect` already accounts for rotation (and `get_pixmap` applies it),
        so it is the right basis for the scale. `mediabox` is not — on a rotated
        page it reports portrait while the rendered raster is landscape.

        Sizes are ceiled, not rounded, to match what `get_pixmap` actually
        produces: an A4 page at 150 dpi renders 1755 px tall where rounding
        predicts 1754. The browser reads its dimensions off the loaded image
        rather than from here, so a mismatch could not misplace a box — but a
        geometry endpoint that disagrees with the image it describes is a trap
        for the next person.
        """
        import math

        out: list[PageGeom] = []
        with pymupdf.open(self.pdf) as doc:
            for i, page in enumerate(doc):
                r = page.rect
                out.append(
                    PageGeom(
                        i,
                        math.ceil(r.width * dpi / 72),
                        math.ceil(r.height * dpi / 72),
                        f"{dpi:g}",
                    )
                )
        return out

    def matrix(self, dpi: float) -> tuple[pymupdf.Matrix, str]:
        """The render matrix for one page, plus the cache key for that scale.

        The key must always describe the matrix beside it: they are returned
        together so a cached file can never be served at a scale other than the
        one it was rendered at.
        """
        return pymupdf.Matrix(dpi / 72, dpi / 72), f"{dpi:g}"

    def raster(self, index: int, dpi: float = DEFAULT_DPI) -> bytes:
        """Grayscale PNG for one page, rendered once and cached on disk.

        PNG rather than JPEG: the detector thresholds these pixels, and at low
        threshold settings JPEG ringing gets counted as ink (measured ~1,200
        spurious ink px on one page at a 5% threshold, individual pixels off by
        up to 32 grey levels).
        """
        self.pages_dir.mkdir(parents=True, exist_ok=True)
        mat, key = self.matrix(dpi)
        cached = self.pages_dir / f"p{index:03d}@{key}.png"
        if cached.exists():
            return cached.read_bytes()
        with pymupdf.open(self.pdf) as doc:
            pix = doc[index].get_pixmap(matrix=mat, colorspace=pymupdf.csGRAY, alpha=False)
            data = pix.tobytes("png")
        cached.write_bytes(data)
        return data

    def summary(self) -> dict:
        m = self.meta()
        return {
            "id": self.id,
            "title": m.get("title", self.id),
            "pages": m.get("pages", 0),
        }

    def delete(self) -> None:
        shutil.rmtree(self.dir)


class Store:
    def __init__(self, root: Path = UPLOADS):
        self.root = root
        self.root.mkdir(parents=True, exist_ok=True)

    def all(self) -> list[Document]:
        docs = [Document(p) for p in sorted(self.root.iterdir()) if (p / "meta.json").exists()]
        return sorted(docs, key=lambda d: d.meta().get("added", ""))

    def get(self, id_: str) -> Document | None:
        d = Document(self.root / id_)
        return d if d.meta_path.exists() else None

    def add(self, data: bytes, title: str) -> Document:
        """Register a PDF. Re-adding identical bytes returns the existing doc."""
        id_ = doc_id(data)
        doc = Document(self.root / id_)
        if doc.meta_path.exists():
            return doc

        doc.dir.mkdir(parents=True, exist_ok=True)
        doc.pdf.write_bytes(data)

        with pymupdf.open(doc.pdf) as pdf:
            pages = pdf.page_count

        from datetime import datetime, timezone

        doc.write_meta(
            {
                "title": title,
                "pages": pages,
                "added": datetime.now(timezone.utc).isoformat(timespec="seconds"),
            }
        )
        return doc
