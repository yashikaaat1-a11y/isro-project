import io
import os

import numpy as np
import pytest
from PIL import Image

os.environ["DEPTHWIZARD_MOCK"] = "1"

from fastapi.testclient import TestClient  # noqa: E402

import analytics  # noqa: E402
import app as app_module  # noqa: E402

client = TestClient(app_module.app)


def _png(w=320, h=240):
    buf = io.BytesIO()
    Image.fromarray((np.random.default_rng(0).random((h, w, 3)) * 255).astype(np.uint8)).save(buf, "PNG")
    return buf.getvalue()


def test_health_reports_mock_engine():
    j = client.get("/api/health").json()
    assert j["status"] == "ok" and j["mock"] is True


def test_generate_depth_contract():
    r = client.post("/api/generate-depth", files={"file": ("tile.png", _png(), "image/png")})
    assert r.status_code == 200
    j = r.json()
    assert j["min_val"] == 0 and j["max_val"] == 255 and j["mode"] == "rDSM"
    depth = np.asarray(Image.open(io.BytesIO(__import__("base64").b64decode(j["depth_image"]))))
    assert depth.shape == (240, 320) and depth.dtype == np.uint8
    assert depth.min() == 0 and depth.max() == 255
    for k in ("relative_dynamic_range", "steep_fraction", "low_lying_fraction", "histogram"):
        assert k in j["stats"]


def test_geotiff_16bit_multiband():
    tifffile = pytest.importorskip("tifffile")
    buf = io.BytesIO()
    tifffile.imwrite(buf, (np.random.default_rng(1).random((4, 64, 80)) * 4000).astype(np.uint16))
    r = client.post("/api/generate-depth", files={"file": ("scene.tif", buf.getvalue(), "image/tiff")})
    assert r.status_code == 200
    assert r.json()["texture_image"]


def test_rejects_unsupported_and_empty():
    assert client.post("/api/generate-depth", files={"file": ("x.gif", b"GIF89a", "image/gif")}).status_code == 415
    assert client.post("/api/generate-depth", files={"file": ("x.png", b"", "image/png")}).status_code == 400


def test_slope_detects_cliff():
    h = np.zeros((32, 32), np.uint8)
    h[:, 16:] = 255
    s = analytics.slope_magnitude(h)
    assert s[:, 15:17].min() > 50 and s[:, :10].max() == 0


def test_normalize_is_robust_to_outliers():
    d = np.linspace(0, 1, 10000).reshape(100, 100)
    d[0, 0] = 1e6
    out = analytics.normalize_to_uint8(d)
    assert out[50, 50] in range(120, 136)
