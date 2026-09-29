"""
DepthWizard Backend — FastAPI Inference Microservice
Accepts single-view optical images and returns monocular depth maps
using Depth Anything V2 (Hugging Face Transformers pipeline).

Usage:
  Normal mode:   uvicorn app:app --host 0.0.0.0 --port 8000
  Mock mode:     MOCK_MODE=1 uvicorn app:app --host 0.0.0.0 --port 8000
"""

import os
import io
import sys
import base64
import logging
import time
from typing import Optional

import numpy as np
from PIL import Image, ImageFilter
from fastapi import FastAPI, UploadFile, File, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

# ─── Configuration ─────────────────────────────────────────────────────────────
MOCK_MODE = os.environ.get("MOCK_MODE", "0") == "1"
MODEL_ID = "depth-anything/Depth-Anything-V2-Small-hf"

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("depthwizard")

# ─── FastAPI App ───────────────────────────────────────────────────────────────
app = FastAPI(
    title="DepthWizard API",
    description="Single-View Monocular Depth Estimation for ISRO Disaster Management",
    version="1.0.0",
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# ─── Model Loading ─────────────────────────────────────────────────────────────
depth_pipeline = None


def load_model():
    """Lazy-load the Depth Anything V2 model."""
    global depth_pipeline
    if depth_pipeline is not None:
        return depth_pipeline

    if MOCK_MODE:
        logger.info("[WARN] Running in MOCK MODE - no model loaded")
        return None

    try:
        from transformers import pipeline
        import torch

        device = "cuda" if torch.cuda.is_available() else "cpu"
        logger.info(f"Loading {MODEL_ID} on {device}...")
        depth_pipeline = pipeline(
            task="depth-estimation",
            model=MODEL_ID,
            device=device,
        )
        logger.info("[OK] Model loaded successfully")
        return depth_pipeline
    except Exception as e:
        logger.warning(f"[WARN] Could not load model ({e}), falling back to MOCK mode")
        return None


# ─── Utility Functions ─────────────────────────────────────────────────────────


def generate_mock_depth(width: int, height: int) -> np.ndarray:
    """
    Generate a procedural mock depth map with realistic terrain features.
    Uses multiple octaves of noise-like patterns to simulate elevation.
    """
    y_grid, x_grid = np.mgrid[0:height, 0:width].astype(np.float32)
    cx, cy = width / 2, height / 2

    # Base radial gradient (mountain peak in center)
    dist = np.sqrt((x_grid - cx) ** 2 + (y_grid - cy) ** 2)
    max_dist = np.sqrt(cx**2 + cy**2)
    base = 1.0 - (dist / max_dist)

    # Add ridge features
    ridge1 = np.sin(x_grid * 0.05 + y_grid * 0.03) * 0.3
    ridge2 = np.cos(x_grid * 0.08 - y_grid * 0.06) * 0.15
    ridge3 = np.sin((x_grid + y_grid) * 0.04) * 0.2

    # Combine
    depth = base + ridge1 + ridge2 + ridge3

    # Add a river valley
    valley_x = cx + 30 * np.sin(y_grid * 0.02)
    valley_mask = np.exp(-((x_grid - valley_x) ** 2) / (2 * 20**2))
    depth -= valley_mask * 0.4

    # Normalize to 0-255
    depth = (depth - depth.min()) / (depth.max() - depth.min() + 1e-8)
    return (depth * 255).astype(np.uint8)


def compute_slope_map(depth_array: np.ndarray) -> np.ndarray:
    """
    Compute gradient magnitude (slope) from the depth map using Sobel filters.
    Returns a normalized 0-255 slope magnitude array.
    """
    from scipy.ndimage import sobel

    dx = sobel(depth_array.astype(np.float32), axis=1)
    dy = sobel(depth_array.astype(np.float32), axis=0)
    magnitude = np.sqrt(dx**2 + dy**2)
    magnitude = (magnitude - magnitude.min()) / (magnitude.max() - magnitude.min() + 1e-8)
    return (magnitude * 255).astype(np.uint8)


def compute_inundation_mask(depth_array: np.ndarray, threshold_pct: float = 20.0) -> np.ndarray:
    """
    Compute a binary inundation mask — areas below a given percentile
    of the depth values (low-lying flood-prone zones).
    """
    threshold = np.percentile(depth_array, threshold_pct)
    mask = (depth_array <= threshold).astype(np.uint8) * 255
    return mask


def array_to_base64_png(arr: np.ndarray) -> str:
    """Convert a numpy array to a base64-encoded PNG string."""
    img = Image.fromarray(arr)
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    return base64.b64encode(buf.getvalue()).decode("utf-8")


# ─── API Endpoints ─────────────────────────────────────────────────────────────


@app.get("/")
async def root():
    return {
        "service": "DepthWizard API",
        "version": "1.0.0",
        "status": "online",
        "mock_mode": MOCK_MODE,
        "model": MODEL_ID,
    }


@app.get("/health")
async def health():
    return {"status": "healthy", "mock_mode": MOCK_MODE}


@app.post("/api/generate-depth")
async def generate_depth(
    file: UploadFile = File(...),
    compute_slope: bool = Query(True, description="Also compute slope map"),
    compute_flood: bool = Query(True, description="Also compute flood-risk mask"),
    flood_threshold: float = Query(20.0, description="Flood risk threshold percentile"),
):
    """
    Accept a single-view optical image and return:
    - Grayscale depth map (base64 PNG)
    - Slope map (base64 PNG, optional)
    - Inundation/flood mask (base64 PNG, optional)
    - Statistical metadata
    """
    start_time = time.time()

    # ── 1. Read & validate image ───────────────────────────────────────────
    try:
        contents = await file.read()
        image = Image.open(io.BytesIO(contents)).convert("RGB")
        orig_w, orig_h = image.size
        logger.info(f"Received image: {file.filename} ({orig_w}x{orig_h})")
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"Invalid image file: {str(e)}")

    # ── 2. Run depth estimation ────────────────────────────────────────────
    pipe = load_model()

    if pipe is None:
        # Mock mode: generate procedural depth
        logger.info("Generating MOCK depth map...")
        depth_array = generate_mock_depth(orig_w, orig_h)
    else:
        # Real inference
        logger.info("Running Depth Anything V2 inference...")
        try:
            result = pipe(image)
            depth_pil = result["depth"]
            # Resize to match original
            depth_pil = depth_pil.resize((orig_w, orig_h), Image.BILINEAR)
            depth_array = np.array(depth_pil)

            # Normalize to 0-255 if not already
            if depth_array.dtype != np.uint8:
                d_min, d_max = depth_array.min(), depth_array.max()
                depth_array = ((depth_array - d_min) / (d_max - d_min + 1e-8) * 255).astype(
                    np.uint8
                )
        except Exception as e:
            logger.error(f"Inference failed: {e}, falling back to mock")
            depth_array = generate_mock_depth(orig_w, orig_h)

    # ── 3. Compute derived products ────────────────────────────────────────
    depth_b64 = array_to_base64_png(depth_array)

    response_data = {
        "depth_image": depth_b64,
        "width": orig_w,
        "height": orig_h,
        "min_val": int(depth_array.min()),
        "max_val": int(depth_array.max()),
        "mean_val": float(depth_array.mean()),
        "std_val": float(depth_array.std()),
        "mode": "mock" if pipe is None else "model",
        "model": MODEL_ID,
    }

    if compute_slope:
        slope_array = compute_slope_map(depth_array)
        response_data["slope_image"] = array_to_base64_png(slope_array)
        response_data["slope_mean"] = float(slope_array.mean())
        response_data["slope_max"] = float(slope_array.max())

    if compute_flood:
        flood_array = compute_inundation_mask(depth_array, flood_threshold)
        response_data["flood_mask"] = array_to_base64_png(flood_array)
        flood_area_pct = float(np.sum(flood_array > 0) / flood_array.size * 100)
        response_data["flood_area_pct"] = round(flood_area_pct, 2)

    elapsed = time.time() - start_time
    response_data["inference_time_ms"] = round(elapsed * 1000, 1)
    logger.info(f"[OK] Depth generation complete in {elapsed:.2f}s")

    return JSONResponse(content=response_data)


# ─── Startup ───────────────────────────────────────────────────────────────────
@app.on_event("startup")
async def startup():
    logger.info("=" * 60)
    logger.info("  DepthWizard API — Starting Up")
    logger.info(f"  Mock Mode: {MOCK_MODE}")
    logger.info(f"  Model: {MODEL_ID}")
    logger.info("=" * 60)
    if not MOCK_MODE:
        load_model()
