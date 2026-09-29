"""Generate the three offline demo tiles + pre-baked depth maps.

The tiles are synthetic "satellite-style" renders of procedurally generated
terrain, so the depth maps are *exact* ground truth for the texture. That makes
the offline demo fully deterministic and doubles as a validation set: run the
real Depth Anything V2 engine on the JPG and compare it against *_depth.png.

    python scripts/generate_samples.py
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))
import analytics  # noqa: E402

OUT = ROOT / "frontend" / "public" / "samples"
TEX = 1024   # texture resolution
DEP = 512    # depth-map resolution


# ------------------------------------------------------------------ primitives

def fbm(n: int, rng: np.random.Generator, octaves: int = 7, base: int = 4,
        persistence: float = 0.5, ridged: bool = False) -> np.ndarray:
    out = np.zeros((n, n))
    amp, total = 1.0, 0.0
    for o in range(octaves):
        cells = base * 2 ** o
        if cells > n:
            break
        g = rng.standard_normal((cells, cells)).astype(np.float32)
        layer = np.asarray(Image.fromarray(g, "F").resize((n, n), Image.BICUBIC), dtype=np.float64)
        if ridged and o < 4:
            layer = 1.0 - np.abs(np.tanh(layer * 0.8))
            layer = layer ** 3
        out += amp * layer
        total += amp
        amp *= persistence
    out /= total
    return (out - out.min()) / (np.ptp(out) + 1e-9)


def _box(a: np.ndarray, k: int, axis: int) -> np.ndarray:
    pad = [(0, 0), (0, 0)]
    pad[axis] = (k + 1, k)
    c = np.cumsum(np.pad(a, pad, mode="edge"), axis=axis)
    hi = np.take(c, range(2 * k + 1, c.shape[axis]), axis=axis)
    lo = np.take(c, range(0, c.shape[axis] - 2 * k - 1), axis=axis)
    return (hi - lo) / (2 * k + 1)


def blur(a: np.ndarray, r: float) -> np.ndarray:
    """Approximate Gaussian blur (three box passes per axis)."""
    k = max(1, int(round(r * 0.8)))
    out = a.astype(np.float64)
    for _ in range(3):
        out = _box(_box(out, k, 0), k, 1)
    return out


def hillshade(h: np.ndarray, z: float = 6.0, az: float = 315, alt: float = 40) -> np.ndarray:
    # z = vertical relief expressed as a fraction of the tile width
    gy, gx = np.gradient(h * z * h.shape[0] / 10)
    slope = np.pi / 2 - np.arctan(np.hypot(gx, gy))
    aspect = np.arctan2(-gx, gy)
    azr, altr = np.radians(360 - az + 90), np.radians(alt)
    s = np.sin(altr) * np.sin(slope) + np.cos(altr) * np.cos(slope) * np.cos(azr - aspect)
    return np.clip(s, 0, 1)


def ramp(v: np.ndarray, stops, colors) -> np.ndarray:
    colors = np.asarray(colors, dtype=np.float64)
    return np.stack([np.interp(v, stops, colors[:, c]) for c in range(3)], -1)


def meander(rng, n, start, end, wiggle=0.08, steps=400):
    t = np.linspace(0, 1, steps)
    x = start[0] + (end[0] - start[0]) * t
    y = start[1] + (end[1] - start[1]) * t
    nx, ny = -(end[1] - start[1]), end[0] - start[0]
    ln = np.hypot(nx, ny) or 1
    off = np.zeros(steps)
    for k in range(1, 5):
        off += rng.uniform(-1, 1) / k * np.sin(np.pi * k * t * rng.uniform(1.5, 3) + rng.uniform(0, 6))
    off *= wiggle * n * np.sin(np.pi * t) ** 0.5
    return list(zip(x + nx / ln * off, y + ny / ln * off))


def draw_lines(n, lines, widths, blur_r=0.0) -> np.ndarray:
    im = Image.new("F", (n, n), 0.0)
    d = ImageDraw.Draw(im)
    for pts, w in zip(lines, widths):
        d.line(pts, fill=1.0, width=int(w), joint="curve")
    a = np.asarray(im, dtype=np.float64)
    return blur(a, blur_r) if blur_r else a


def finish(rgb: np.ndarray, rng, grain: float = 6.0) -> Image.Image:
    rgb = rgb + rng.normal(0, grain, rgb.shape)
    return Image.fromarray(np.clip(rgb, 0, 255).astype(np.uint8), "RGB")


# --------------------------------------------------------------------- scenes

def mountain_ridge(rng):
    n = TEX
    h = 0.6 * fbm(n, rng, octaves=8, base=3, ridged=True, persistence=0.52) + 0.4 * fbm(n, rng, octaves=7, base=2)
    h = h ** 1.6
    yy, xx = np.mgrid[0:n, 0:n] / n
    h = h * (0.55 + 0.6 * np.exp(-((xx - 0.55) ** 2 + (yy - 0.4) ** 2) / 0.12))   # massif
    course = meander(rng, n, (-20, n * 0.85), (n + 20, n * 0.7), 0.06)
    river = draw_lines(n, [course], [22], 18)
    h = h * (1 - 0.75 * np.clip(river * 2.5, 0, 1))                                  # carved valley
    h = (h - h.min()) / np.ptp(h)
    shade = hillshade(h, z=9)
    gy, gx = np.gradient(h)
    slope = np.hypot(gx, gy) * n
    tex = ramp(h, [0, 0.22, 0.42, 0.62, 0.78, 0.86, 1.0],
               [[46, 74, 44], [58, 92, 50], [92, 102, 64], [120, 108, 92], [150, 146, 140],
                [226, 232, 240], [250, 252, 255]])
    rock = np.clip((slope - 2.2) / 3, 0, 1)[..., None]
    tex = tex * (1 - rock * 0.6) + np.array([112, 100, 90]) * rock * 0.6
    snow = np.clip((h - 0.8) / 0.08, 0, 1)[..., None] * (1 - rock * 0.5)
    tex = tex * (1 - snow) + np.array([240, 244, 250]) * snow
    tex = tex * (shade[..., None] * 0.85 + 0.25)
    water = np.clip(draw_lines(n, [course], [6], 1.0), 0, 1)[..., None]
    tex = tex * (1 - water) + np.array([70, 110, 118]) * water
    return h, tex


def coastal_delta(rng):
    n = TEX
    yy, xx = np.mgrid[0:n, 0:n] / n
    base = 0.55 - 0.55 * yy + 0.08 * fbm(n, rng, octaves=6, base=3)          # gentle seaward slope
    coast = 0.78 + 0.05 * np.sin(xx * 9 + 1.3) + 0.03 * fbm(n, rng, 5, 2)
    sea = yy > coast
    lines, widths = [], []
    for i in range(6):
        x_end = n * (0.08 + 0.17 * i + rng.uniform(-0.04, 0.04))
        lines.append(meander(rng, n, (n * 0.5, -10), (x_end, n * 0.95), 0.05))
        widths.append(rng.integers(6, 14) if i else 20)
    chan = np.clip(draw_lines(n, lines, widths, 2.0), 0, 1)
    fields = fbm(n, rng, octaves=2, base=24)
    h = base - 0.18 * chan
    levee = np.clip(blur(chan, 7) - chan, 0, 1)
    h = h + 0.12 * levee
    h[sea] = np.minimum(h[sea], 0.02) - 0.02 * (yy[sea] - coast[sea])
    h = blur(h, 1.2)
    h = (h - h.min()) / np.ptp(h)

    # agricultural parcels
    parcels = np.zeros((n, n))
    cell = 36
    for j in range(0, n, cell):
        for i in range(0, n, cell):
            parcels[j:j + cell, i:i + cell] = rng.uniform()
    parcels = np.asarray(Image.fromarray(parcels.astype(np.float32), "F").rotate(14, Image.NEAREST, fillcolor=0.5),
                         dtype=np.float64)
    field_col = ramp(parcels, [0, 0.35, 0.6, 0.8, 1],
                     [[74, 112, 52], [104, 140, 60], [150, 160, 88], [178, 164, 110], [96, 128, 70]])
    tex = field_col * (0.85 + 0.25 * fields[..., None])
    silt = np.array([150, 132, 96])
    c = chan[..., None]
    tex = tex * (1 - c) + (np.array([88, 106, 102]) * 0.7 + silt * 0.3) * c
    depth_sea = np.clip((yy - coast) * 6, 0, 1)[..., None]
    sea_col = np.array([56, 118, 142]) * (1 - depth_sea) + np.array([20, 58, 96]) * depth_sea
    surf = np.clip(1 - np.abs(yy - coast) * 120, 0, 1)[..., None]
    tex = np.where(sea[..., None], sea_col + surf * 60, tex)
    tex = tex * (hillshade(h, z=4)[..., None] * 0.35 + 0.72)
    return h, tex


def urban_settlement(rng):
    n = TEX
    yy, xx = np.mgrid[0:n, 0:n] / n
    ground = 0.12 * fbm(n, rng, octaves=4, base=2) + 0.05 * xx
    river = np.clip(draw_lines(n, [meander(rng, n, (n * 0.15, -10), (n * 0.35, n + 10), 0.05)], [34], 3), 0, 1)
    ground = ground - 0.08 * blur(river, 10)
    h = ground.copy()
    tex = np.zeros((n, n, 3)) + np.array([118, 122, 112])
    tex = tex * (0.9 + 0.2 * fbm(n, rng, 5, 8)[..., None])

    block, road = 88, 16
    roof_h = np.zeros((n, n))
    roof = Image.new("RGB", (n, n))
    dr = ImageDraw.Draw(roof)
    hm = Image.new("F", (n, n), 0.0)
    dh = ImageDraw.Draw(hm)
    palette = [(176, 170, 160), (150, 146, 140), (190, 110, 84), (120, 128, 136), (210, 206, 196),
               (96, 110, 118), (170, 150, 120)]
    cx, cy = n * 0.62, n * 0.45
    for by in range(0, n, block):
        for bx in range(0, n, block):
            x0, y0 = bx + road, by + road
            x1, y1 = bx + block, by + block
            mx, my = (x0 + x1) / 2, (y0 + y1) / 2
            if river[int(min(my, n - 1)), int(min(mx, n - 1))] > 0.05:
                continue
            dist = np.hypot(mx - cx, my - cy) / n
            if rng.uniform() < 0.1:   # park
                dr.rectangle([x0, y0, x1, y1], fill=(70, 118, 60))
                continue
            k = int(rng.integers(1, 4))
            sub = (x1 - x0) / k
            for s in range(k):
                for t in range(k):
                    bx0 = x0 + s * sub + 3
                    by0 = y0 + t * sub + 3
                    bx1 = bx0 + sub - 6
                    by1 = by0 + sub - 6
                    tall = max(0.05, rng.gamma(2.0, 0.08) * np.exp(-dist * 4.5) * 3.2)
                    col = palette[int(rng.integers(len(palette)))]
                    dr.rectangle([bx0, by0, bx1, by1], fill=col)
                    dh.rectangle([bx0, by0, bx1, by1], fill=float(tall))
    roof_arr = np.asarray(roof, dtype=np.float64)
    roof_h = np.asarray(hm, dtype=np.float64)
    is_b = roof_h > 0
    is_park = (roof_arr.sum(-1) > 0) & ~is_b
    tex = np.where(is_b[..., None] | is_park[..., None], roof_arr, tex)

    # Cast shadows toward south-east proportional to building height.
    shadow = np.zeros((n, n), bool)
    for step in range(1, 26):
        shifted = np.zeros_like(roof_h)
        shifted[step:, step:] = roof_h[:-step, :-step]
        shadow |= (shifted * 60 > step) & ~is_b
    tex = np.where(shadow[..., None], tex * 0.45, tex)
    road_mask = ~is_b & ~is_park & (river < 0.3)
    tex = np.where(road_mask[..., None] & ~shadow[..., None], tex * 0.75, tex)
    tex = np.where((river > 0.3)[..., None], np.array([54, 84, 92]), tex)
    h = h + roof_h
    h = (h - h.min()) / np.ptp(h)
    return h, tex


SCENES = [
    {
        "id": "mountain-ridge",
        "name": "Mountain Ridge",
        "region": "Himalayan terrain · Uttarakhand-type relief",
        "scenario": "Cloudburst-triggered landslide triage",
        "fn": mountain_ridge,
        "seed": 7,
        "anchor_hint": {"label": "Valley floor gauge station", "elevation_m": 1850, "meters_per_unit": 32},
    },
    {
        "id": "coastal-flood-plain",
        "name": "Coastal Flood Plain",
        "region": "River delta · Godavari/Mahanadi-type distributaries",
        "scenario": "Cyclone storm-surge & riverine inundation",
        "fn": coastal_delta,
        "seed": 21,
        "anchor_hint": {"label": "Mean sea level (coastline)", "elevation_m": 0, "meters_per_unit": 0.12},
    },
    {
        "id": "urban-settlement",
        "name": "Urban Settlement",
        "region": "Dense urban grid · riverside city",
        "scenario": "Structural collapse & urban flash-flood mapping",
        "fn": urban_settlement,
        "seed": 42,
        "anchor_hint": {"label": "Airport runway", "elevation_m": 550, "meters_per_unit": 0.35},
    },
]


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    manifest = []
    for sc in SCENES:
        rng = np.random.default_rng(sc["seed"])
        h, tex = sc["fn"](rng)
        img = finish(tex, rng)
        img.save(OUT / f"{sc['id']}.jpg", quality=88)
        img.resize((256, 256), Image.LANCZOS).save(OUT / f"{sc['id']}_thumb.jpg", quality=82)
        depth = analytics.normalize_to_uint8(
            np.asarray(Image.fromarray(h.astype(np.float32), "F").resize((DEP, DEP), Image.LANCZOS)), 0, 100)
        Image.fromarray(depth).save(OUT / f"{sc['id']}_depth.png", optimize=True)
        slope = analytics.slope_to_uint8(analytics.slope_magnitude(depth))
        stats = analytics.compute_stats(depth, slope)
        entry = {k: v for k, v in sc.items() if k not in {"fn", "seed"}}
        entry.update({
            "texture": f"samples/{sc['id']}.jpg",
            "thumb": f"samples/{sc['id']}_thumb.jpg",
            "depth": f"samples/{sc['id']}_depth.png",
            "engine": "pre-baked cache",
            "stats": stats,
        })
        manifest.append(entry)
        print(f"  {sc['id']:22s} dyn-range {stats['relative_dynamic_range']:5.1f}  steep {stats['steep_fraction']:.3f}")
    (OUT / "manifest.json").write_text(json.dumps(manifest, indent=2))
    print(f"wrote {len(manifest)} samples -> {OUT}")


if __name__ == "__main__":
    main()
