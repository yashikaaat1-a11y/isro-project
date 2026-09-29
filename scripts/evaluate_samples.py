"""Score the depth engine against the ground-truth sample heightmaps.

Because monocular depth is only defined up to scale and shift, predictions are
first aligned to ground truth with least squares (d_gt ~ a * d_pred + b), the
same protocol used for relative-depth benchmarks. Reported metrics:

  pearson   linear correlation of heights
  spearman  rank correlation (shape agreement, scale-free)
  rmse_rel  RMSE after alignment, on the 0-100 relative scale
  slope_iou IoU of "steep" pixels (top 10% gradient) between prediction and truth

    python scripts/evaluate_samples.py            # neural engine (falls back to mock)
    python scripts/evaluate_samples.py --mock
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import numpy as np
from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))
import analytics  # noqa: E402
from depth_engine import load_engine  # noqa: E402

SAMPLES = ROOT / "frontend" / "public" / "samples"


def rank(a: np.ndarray) -> np.ndarray:
    r = np.empty(a.size)
    r[np.argsort(a, kind="stable")] = np.arange(a.size)
    return r


def evaluate(pred: np.ndarray, gt: np.ndarray) -> dict:
    p, g = pred.ravel().astype(np.float64), gt.ravel().astype(np.float64)
    A = np.stack([p, np.ones_like(p)], 1)
    (a, b), *_ = np.linalg.lstsq(A, g, rcond=None)
    aligned = a * p + b
    sp = analytics.slope_magnitude(pred.astype(np.uint8))
    sg = analytics.slope_magnitude(gt.astype(np.uint8))
    tp, tg = sp >= np.percentile(sp, 90), sg >= np.percentile(sg, 90)
    return {
        "pearson": round(float(np.corrcoef(p, g)[0, 1]), 4),
        "spearman": round(float(np.corrcoef(rank(p), rank(g))[0, 1]), 4),
        "rmse_rel": round(float(np.sqrt(np.mean((aligned - g) ** 2)) / 2.55), 2),
        "slope_iou": round(float((tp & tg).sum() / max((tp | tg).sum(), 1)), 4),
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--mock", action="store_true")
    args = ap.parse_args()
    engine, note = load_engine(force_mock=args.mock)
    print(f"engine: {engine.name}" + (f"  ({note})" if note else ""))
    manifest = json.loads((SAMPLES / "manifest.json").read_text())
    results = {}
    print(f"{'sample':22s} {'pearson':>8s} {'spearman':>9s} {'rmse_rel':>9s} {'slope_iou':>10s}")
    for s in manifest:
        img = Image.open(ROOT / "frontend" / "public" / s["texture"]).convert("RGB")
        gt = np.asarray(Image.open(ROOT / "frontend" / "public" / s["depth"]).convert("L"))
        pred = analytics.normalize_to_uint8(engine.predict(img))
        pred = np.asarray(Image.fromarray(pred).resize(gt.shape[::-1], Image.BILINEAR))
        m = evaluate(pred, gt)
        results[s["id"]] = m
        print(f"{s['id']:22s} {m['pearson']:8.3f} {m['spearman']:9.3f} {m['rmse_rel']:9.2f} {m['slope_iou']:10.3f}")
    out = ROOT / "docs" / f"evaluation_{engine.name}.json"
    out.write_text(json.dumps({"engine": engine.name, "results": results}, indent=2))
    print(f"saved {out.relative_to(ROOT)}")


if __name__ == "__main__":
    main()
