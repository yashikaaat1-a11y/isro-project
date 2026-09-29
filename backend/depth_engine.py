"""Depth inference engines.

``NeuralDepthEngine`` wraps Depth Anything V2-Small (zero-shot relative
depth). ``MockDepthEngine`` is a dependency-free fallback so demos never die
because PyTorch failed to install or the model could not be downloaded.
"""
from __future__ import annotations

import logging
import time

import numpy as np
from PIL import Image

log = logging.getLogger("depthwizard.engine")

MODEL_ID = "depth-anything/Depth-Anything-V2-Small-hf"


class MockDepthEngine:
    """Procedural heightmap: a radial dome modulated by blurred luminance.

    It is clearly labelled as ``mock`` in every API response. It exists for
    offline demos and CI, not for analysis.
    """

    name = "mock-procedural"
    device = "cpu"

    def predict(self, image: Image.Image) -> np.ndarray:
        w, h = image.size
        yy, xx = np.mgrid[0:h, 0:w].astype(np.float64)
        cx, cy = w / 2, h / 2
        r = np.hypot((xx - cx) / w, (yy - cy) / h)
        radial = np.clip(1.0 - r * 1.6, 0, 1) ** 1.5
        lum = np.asarray(image.convert("L").resize((max(w // 16, 1), max(h // 16, 1)), Image.BILINEAR)
                         .resize((w, h), Image.BICUBIC), dtype=np.float64) / 255.0
        return 0.7 * radial + 0.3 * lum


class NeuralDepthEngine:
    name = "depth-anything-v2-small"

    def __init__(self) -> None:
        import torch  # noqa: F401  (import errors trigger the mock fallback)
        from transformers import pipeline

        self.device = "cuda" if torch.cuda.is_available() else "cpu"
        t0 = time.perf_counter()
        self._pipe = pipeline(
            task="depth-estimation",
            model=MODEL_ID,
            device=0 if self.device == "cuda" else -1,
        )
        log.info("Loaded %s on %s in %.1fs", MODEL_ID, self.device, time.perf_counter() - t0)

    def predict(self, image: Image.Image) -> np.ndarray:
        out = self._pipe(image.convert("RGB"))
        # predicted_depth is relative inverse depth (disparity): larger = closer
        # to the sensor. For nadir imagery, closer to the sensor = higher terrain.
        pred = out["predicted_depth"]
        arr = pred.squeeze().detach().cpu().numpy().astype(np.float64)
        if arr.shape != (image.height, image.width):
            arr = np.asarray(
                Image.fromarray(arr.astype(np.float32), mode="F").resize(image.size, Image.BICUBIC),
                dtype=np.float64,
            )
        return arr


def load_engine(force_mock: bool = False):
    if force_mock:
        log.warning("Mock mode requested - using procedural depth engine")
        return MockDepthEngine(), "forced by --mock / DEPTHWIZARD_MOCK"
    try:
        return NeuralDepthEngine(), None
    except Exception as exc:  # ImportError, download failure, CUDA issues...
        log.warning("Neural engine unavailable (%s) - falling back to mock engine", exc)
        return MockDepthEngine(), f"{type(exc).__name__}: {exc}"
