"""DepthWizard inference microservice.

Run:
    uvicorn app:app --reload --port 8000          # neural engine, auto-fallback to mock
    python app.py --mock                          # force procedural mock engine
    DEPTHWIZARD_MOCK=1 uvicorn app:app            # same, via environment
"""
from __future__ import annotations

import argparse
import io
import logging
import os
import time
from pathlib import Path

import numpy as np
from fastapi import FastAPI, File, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from PIL import Image

import analytics
from depth_engine import load_engine

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
log = logging.getLogger("depthwizard")

MAX_SIDE = int(os.getenv("DEPTHWIZARD_MAX_SIDE", "1024"))
MAX_UPLOAD_MB = 40
ALLOWED_EXT = {".png", ".jpg", ".jpeg", ".tif", ".tiff"}

app = FastAPI(
    title="DepthWizard API",
    description="Single-view height estimation for ISRO disaster triage (SIH26175).",
    version="1.0.0",
)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

_engine = None
_engine_note: str | None = None


def get_engine():
    global _engine, _engine_note
    if _engine is None:
        force = os.getenv("DEPTHWIZARD_MOCK", "").lower() in {"1", "true", "yes"}
        _engine, _engine_note = load_engine(force_mock=force)
    return _engine


# --------------------------------------------------------------------------- IO

def _stretch_band(b: np.ndarray) -> np.ndarray:
    b = b.astype(np.float64)
    lo, hi = np.nanpercentile(b, [2, 98])
    if hi - lo < 1e-9:
        return np.zeros(b.shape, np.uint8)
    return (np.clip((b - lo) / (hi - lo), 0, 1) * 255).astype(np.uint8)


def _read_geotiff(data: bytes) -> tuple[Image.Image, dict | None]:
    """Read (possibly 16-bit, multi-band, georeferenced) TIFFs into RGB."""
    geo = None
    try:
        import tifffile
    except ImportError:
        return Image.open(io.BytesIO(data)).convert("RGB"), None

    with tifffile.TiffFile(io.BytesIO(data)) as tif:
        page = tif.pages[0]
        arr = page.asarray()
        tags = {t.name: t.value for t in page.tags.values()}
        scale = tags.get("ModelPixelScaleTag")
        tie = tags.get("ModelTiepointTag")
        if scale and tie and len(tie) >= 6:
            h, w = arr.shape[:2]
            x0, y0 = float(tie[3]), float(tie[4])
            px, py = float(scale[0]), float(scale[1])
            geographic = px < 0.01 and abs(x0) <= 180 and abs(y0) <= 90
            if geographic:
                # Degrees -> approximate metres at the tile's latitude.
                lat = np.radians(y0 - h * py / 2)
                px, py = px * 111_320 * np.cos(lat), py * 110_574
            geo = {
                "georeferenced": True,
                "crs_units": "degrees" if geographic else "projected",
                "pixel_size": [round(px, 4), round(py, 4)],  # metres
                "bounds": [x0, y0 - h * float(scale[1]), x0 + w * float(scale[0]), y0],
            }

    if arr.ndim == 3 and arr.shape[0] in (3, 4) and arr.shape[-1] not in (3, 4):
        arr = np.moveaxis(arr, 0, -1)  # band-first -> band-last
    if arr.ndim == 2:
        rgb = np.repeat(_stretch_band(arr)[..., None], 3, axis=-1)
    else:
        rgb = np.stack([_stretch_band(arr[..., i]) for i in range(min(3, arr.shape[-1]))], -1)
        if rgb.shape[-1] < 3:
            rgb = np.repeat(rgb[..., :1], 3, axis=-1)
    return Image.fromarray(rgb, "RGB"), geo


def _load_image(filename: str, data: bytes) -> tuple[Image.Image, dict | None]:
    ext = Path(filename or "").suffix.lower()
    if ext and ext not in ALLOWED_EXT:
        raise HTTPException(415, f"Unsupported file type '{ext}'. Use PNG, JPEG or GeoTIFF.")
    try:
        if ext in {".tif", ".tiff"}:
            return _read_geotiff(data)
        return Image.open(io.BytesIO(data)).convert("RGB"), None
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(400, f"Could not decode image: {exc}") from exc


def _fit(image: Image.Image, max_side: int) -> Image.Image:
    w, h = image.size
    s = max_side / max(w, h)
    if s >= 1:
        return image
    return image.resize((max(1, round(w * s)), max(1, round(h * s))), Image.LANCZOS)


# ---------------------------------------------------------------------- routes

@app.get("/api/health")
def health():
    eng = get_engine()
    return {
        "status": "ok",
        "engine": eng.name,
        "device": eng.device,
        "mock": eng.name.startswith("mock"),
        "note": _engine_note,
    }


@app.post("/api/generate-depth")
async def generate_depth(file: UploadFile = File(...)):
    data = await file.read()
    if not data:
        raise HTTPException(400, "Empty upload.")
    if len(data) > MAX_UPLOAD_MB * 1024 * 1024:
        raise HTTPException(413, f"File larger than {MAX_UPLOAD_MB} MB.")

    image, geo = _load_image(file.filename, data)
    orig_size = image.size
    image = _fit(image, MAX_SIDE)

    eng = get_engine()
    t0 = time.perf_counter()
    raw = eng.predict(image)
    infer_ms = (time.perf_counter() - t0) * 1000

    height = analytics.normalize_to_uint8(raw)
    slope = analytics.slope_to_uint8(analytics.slope_magnitude(height))
    stats = analytics.compute_stats(height, slope, raw)
    flood_level = int(np.percentile(height, 20))

    return {
        "depth_image": analytics.png_b64(height),
        "slope_image": analytics.png_b64(analytics.hazard_colorize(slope)),
        "inundation_mask": analytics.png_b64(analytics.inundation_mask(height, flood_level)),
        "inundation_level": flood_level,
        # Browsers cannot display TIFF, so always echo back a PNG texture.
        "texture_image": analytics.png_b64(np.asarray(image)) if geo is not None or
        Path(file.filename or "").suffix.lower() in {".tif", ".tiff"} else None,
        "min_val": 0,
        "max_val": 255,
        "width": image.width,
        "height": image.height,
        "original_size": list(orig_size),
        "engine": eng.name,
        "device": eng.device,
        "mock": eng.name.startswith("mock"),
        "inference_ms": round(infer_ms, 1),
        "mode": "rDSM",
        "geo": geo,
        "stats": stats,
    }


# Serve the built frontend (frontend/dist) at / when present, so a single
# `uvicorn app:app` can host the whole workstation.
_dist = Path(__file__).resolve().parent.parent / "frontend" / "dist"
if _dist.is_dir():
    app.mount("/", StaticFiles(directory=_dist, html=True), name="frontend")


if __name__ == "__main__":
    import uvicorn

    ap = argparse.ArgumentParser(description="DepthWizard inference service")
    ap.add_argument("--mock", action="store_true", help="force procedural mock depth engine")
    ap.add_argument("--host", default="0.0.0.0")
    ap.add_argument("--port", type=int, default=8000)
    args = ap.parse_args()
    if args.mock:
        os.environ["DEPTHWIZARD_MOCK"] = "1"
    uvicorn.run(app, host=args.host, port=args.port)
