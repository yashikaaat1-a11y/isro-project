"""Analytical derivatives computed from a relative depth map.

Everything here is pure NumPy so it runs identically with the neural engine
and the mock engine, and has no heavy dependencies.
"""
from __future__ import annotations

import base64
import io

import numpy as np
from PIL import Image


def normalize_to_uint8(depth: np.ndarray, lo_pct: float = 0.5, hi_pct: float = 99.5) -> np.ndarray:
    """Robustly stretch an arbitrary float depth map to 0-255.

    Percentile clipping stops a handful of outlier pixels (sensor glints,
    clouds) from compressing the useful dynamic range.
    """
    d = np.asarray(depth, dtype=np.float64)
    d = np.nan_to_num(d, nan=float(np.nanmedian(d)) if np.isfinite(d).any() else 0.0)
    lo, hi = np.percentile(d, [lo_pct, hi_pct])
    if hi - lo < 1e-9:
        return np.zeros(d.shape, dtype=np.uint8)
    out = (np.clip(d, lo, hi) - lo) / (hi - lo)
    return (out * 255.0 + 0.5).astype(np.uint8)


def _convolve3x3(a: np.ndarray, k: np.ndarray) -> np.ndarray:
    p = np.pad(a, 1, mode="edge")
    h, w = a.shape
    out = np.zeros_like(a, dtype=np.float64)
    for dy in range(3):
        for dx in range(3):
            if k[dy, dx]:
                out += k[dy, dx] * p[dy:dy + h, dx:dx + w]
    return out


SOBEL_X = np.array([[-1, 0, 1], [-2, 0, 2], [-1, 0, 1]], dtype=np.float64) / 8.0
SOBEL_Y = SOBEL_X.T


def slope_magnitude(height_u8: np.ndarray) -> np.ndarray:
    """Sobel gradient magnitude sqrt(dx^2 + dy^2) in height-units per pixel."""
    h = height_u8.astype(np.float64)
    gx = _convolve3x3(h, SOBEL_X)
    gy = _convolve3x3(h, SOBEL_Y)
    return np.hypot(gx, gy)


def slope_to_uint8(slope: np.ndarray) -> np.ndarray:
    """Scale slope so the 99th percentile maps to 255 (keeps ramps comparable)."""
    ref = float(np.percentile(slope, 99)) or 1.0
    return (np.clip(slope / ref, 0, 1) * 255 + 0.5).astype(np.uint8)


def hazard_colorize(slope_u8: np.ndarray) -> np.ndarray:
    """Green -> yellow -> orange -> red landslide-risk ramp (RGB uint8)."""
    stops = np.array([0, 70, 140, 200, 255], dtype=np.float64)
    colors = np.array([
        [22, 163, 74],    # stable (green)
        [132, 204, 22],   # gentle
        [250, 204, 21],   # moderate (yellow)
        [249, 115, 22],   # steep (orange)
        [220, 38, 38],    # critical (red)
    ], dtype=np.float64)
    s = slope_u8.astype(np.float64)
    rgb = np.stack([np.interp(s, stops, colors[:, c]) for c in range(3)], axis=-1)
    return rgb.astype(np.uint8)


def compute_stats(height_u8: np.ndarray, slope_u8: np.ndarray, raw: np.ndarray | None = None) -> dict:
    h = height_u8.astype(np.float64)
    p = np.percentile(h, [5, 25, 50, 75, 95])
    hist, _ = np.histogram(height_u8, bins=32, range=(0, 256))
    stats = {
        "mean": round(float(h.mean()), 2),
        "std": round(float(h.std()), 2),
        "p05": round(float(p[0]), 1),
        "p25": round(float(p[1]), 1),
        "median": round(float(p[2]), 1),
        "p75": round(float(p[3]), 1),
        "p95": round(float(p[4]), 1),
        # Relative dynamic range on the 0-100 normalized scale (p95 - p05).
        "relative_dynamic_range": round(float((p[4] - p[0]) / 255 * 100), 1),
        "steep_fraction": round(float((slope_u8 >= 200).mean()), 4),
        "moderate_fraction": round(float(((slope_u8 >= 140) & (slope_u8 < 200)).mean()), 4),
        # Pixels in the lowest quintile of relative height: first to flood.
        "low_lying_fraction": round(float((h <= np.percentile(h, 20)).mean()), 4),
        "histogram": hist.tolist(),
    }
    if raw is not None:
        stats["raw_min"] = float(np.nanmin(raw))
        stats["raw_max"] = float(np.nanmax(raw))
    return stats


def inundation_mask(height_u8: np.ndarray, level: int) -> np.ndarray:
    return (height_u8 <= level).astype(np.uint8) * 255


def png_b64(arr: np.ndarray) -> str:
    buf = io.BytesIO()
    Image.fromarray(arr).save(buf, format="PNG", optimize=True)
    return base64.b64encode(buf.getvalue()).decode("ascii")
