"""Scanned table layout extractor — FastAPI backend.

The server does one job: turn a PDF page into a grayscale PNG and cache it.
Every part of the actual detection — thresholding, line finding, cell recovery —
runs in the browser, in `static/app.js`. That split is deliberate: it keeps the
Python dependency list to four packages and makes the algorithm readable as one
file rather than spread across a client/server boundary.

Run either way:
    python -m stle.server
    uvicorn stle.server:app --reload --port 8010

Options when run directly: --port N, --host H, --reload.
"""
from __future__ import annotations

import logging
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, File, HTTPException, Query, UploadFile
from fastapi.responses import FileResponse, JSONResponse, Response
from fastapi.staticfiles import StaticFiles

from .store import DEFAULT_DPI, Store

logger = logging.getLogger("stle")

HERE = Path(__file__).resolve().parent
STATIC = HERE / "static"

store = Store()


@asynccontextmanager
async def lifespan(_app: FastAPI):
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(name)s: %(message)s")
    logger.info("%d document(s) in the library", len(store.all()))
    yield


# `redoc_url=None` and the moved openapi path keep FastAPI's own /docs page from
# sitting confusingly next to the /api/docs library endpoint.
app = FastAPI(
    title="Scanned table layout extractor",
    version="1.0",
    docs_url="/api-docs",
    redoc_url=None,
    lifespan=lifespan,
)


def _doc_or_404(doc_id: str):
    doc = store.get(doc_id)
    if doc is None:
        raise HTTPException(404, "no such document")
    return doc


@app.get("/api/docs")
def list_docs() -> list[dict]:
    return [d.summary() for d in store.all()]


@app.post("/api/docs")
async def upload(file: UploadFile = File(...)) -> dict:
    data = await file.read()
    if not data[:5].startswith(b"%PDF"):
        raise HTTPException(400, "not a PDF")
    title = Path(file.filename or "upload.pdf").stem
    try:
        doc = store.add(data, title=title)
    except Exception as e:
        raise HTTPException(400, f"could not open PDF: {e}") from e
    return doc.summary()


@app.get("/api/docs/{doc_id}")
def doc_detail(doc_id: str, dpi: float = Query(DEFAULT_DPI, ge=36, le=400)) -> dict:
    doc = _doc_or_404(doc_id)
    geo = [g.as_dict() for g in doc.geometry(dpi)]
    # the source page in points, so the UI can state the real document size.
    # A page is defined in points (1/72 in); the pixel count only exists once
    # it is rendered, and changes with dpi. Physical size does not.
    import pymupdf

    with pymupdf.open(doc.pdf) as pdf:
        pts = [{"w": round(pg.rect.width, 1), "h": round(pg.rect.height, 1)} for pg in pdf]
    return {**doc.summary(), "dpi": dpi, "geometry": geo, "points": pts}


@app.delete("/api/docs/{doc_id}")
def delete_doc(doc_id: str) -> dict:
    _doc_or_404(doc_id).delete()
    return {"deleted": doc_id}


@app.get("/api/docs/{doc_id}/page/{index}.png")
def page_png(
    doc_id: str,
    index: int,
    dpi: float = Query(DEFAULT_DPI, ge=36, le=400),
) -> Response:
    doc = _doc_or_404(doc_id)
    if not 0 <= index < doc.meta().get("pages", 0):
        raise HTTPException(404, "page out of range")
    return Response(
        doc.raster(index, dpi),
        media_type="image/png",
        headers={"Cache-Control": "no-cache"},
    )


@app.get("/health")
def health() -> dict:
    return {"status": "ok", "docs": len(store.all())}


@app.get("/")
def index() -> FileResponse:
    return FileResponse(STATIC / "index.html")


app.mount("/static", StaticFiles(directory=STATIC), name="static")


@app.exception_handler(HTTPException)
async def http_error(_request, exc: HTTPException) -> JSONResponse:
    return JSONResponse({"error": exc.detail}, status_code=exc.status_code)


def main() -> None:
    import argparse

    import uvicorn

    ap = argparse.ArgumentParser(description="Scanned table layout extractor")
    ap.add_argument("--port", type=int, default=8010)
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--reload", action="store_true", help="restart on code changes")
    args = ap.parse_args()

    print(f"\n  table layout extractor -> http://{args.host}:{args.port}\n")
    # --reload needs an import string rather than the app object
    uvicorn.run(
        "stle.server:app" if args.reload else app,
        host=args.host,
        port=args.port,
        reload=args.reload,
    )


if __name__ == "__main__":
    main()
