"""
Generate pre-baked sample datasets for offline demo mode.
Uses vectorized numpy operations for fast generation.

Creates 3 sample tiles with corresponding depth maps:
1. Mountain Ridge (Himalayan terrain simulation)
2. Coastal Flood Plain (River delta simulation)
3. Urban Settlement (City grid simulation)
"""

import os
import numpy as np
from PIL import Image, ImageFilter

OUTPUT_DIR = os.path.join(os.path.dirname(__file__), "..", "frontend", "public", "samples")
os.makedirs(OUTPUT_DIR, exist_ok=True)

SIZE = 512


def colorize_terrain(values):
    """Vectorized terrain colorization from normalized 0-1 values."""
    h, w = values.shape
    rgb = np.zeros((h, w, 3), dtype=np.float32)

    # Define elevation bands
    masks = [
        values < 0.12,
        (values >= 0.12) & (values < 0.3),
        (values >= 0.3) & (values < 0.55),
        (values >= 0.55) & (values < 0.78),
        values >= 0.78,
    ]

    # Valley green
    rgb[masks[0]] = [40, 100, 45]
    # Low green
    frac = (values[masks[1]] - 0.12) / 0.18
    rgb[masks[1], 0] = 70 + 80 * frac
    rgb[masks[1], 1] = 120 + 30 * frac
    rgb[masks[1], 2] = 50 + 20 * frac
    # Mid brown
    frac = (values[masks[2]] - 0.3) / 0.25
    rgb[masks[2], 0] = 110 + 70 * frac
    rgb[masks[2], 1] = 100 + 20 * frac
    rgb[masks[2], 2] = 60 + 30 * frac
    # High brown
    frac = (values[masks[3]] - 0.55) / 0.23
    rgb[masks[3], 0] = 160 + 40 * frac
    rgb[masks[3], 1] = 110 - 10 * frac
    rgb[masks[3], 2] = 80 + 10 * frac
    # Snow
    frac = (values[masks[4]] - 0.78) / 0.22
    rgb[masks[4], 0] = 200 + 55 * frac
    rgb[masks[4], 1] = 200 + 55 * frac
    rgb[masks[4], 2] = 210 + 45 * frac

    return np.clip(rgb, 0, 255).astype(np.uint8)


def add_rock_texture(rgb, values, y_grid, x_grid):
    """Add realistic rock texture to mid-elevation areas."""
    # Rock texture noise at different frequencies
    noise1 = np.sin(x_grid * 47 + y_grid * 31) * np.cos(x_grid * 23 - y_grid * 41)
    noise2 = np.sin(x_grid * 79 + y_grid * 53) * 0.5
    noise3 = np.cos(x_grid * 37 - y_grid * 67) * 0.3
    rock_noise = (noise1 + noise2 + noise3) * 12

    # Apply rock texture to mid-elevation bands (0.3 to 0.78)
    rock_mask = (values >= 0.3) & (values < 0.78)
    rock_strength = np.zeros_like(values)
    mid_mask = (values >= 0.3) & (values < 0.55)
    high_mask = (values >= 0.55) & (values < 0.78)
    rock_strength[mid_mask] = 0.8
    rock_strength[high_mask] = 1.0

    for c in range(3):
        rgb[:, :, c] = np.clip(
            rgb[:, :, c].astype(np.float32) + rock_noise * rock_strength,
            0, 255
        ).astype(np.uint8)

    return rgb


def add_snow_texture(rgb, values):
    """Add smooth, icy appearance to snow-covered peaks."""
    snow_mask = values >= 0.78
    if not np.any(snow_mask):
        return rgb

    # Make snow areas very bright and slightly blue-tinted
    frac = np.clip((values[snow_mask] - 0.78) / 0.22, 0, 1)
    rgb[snow_mask, 0] = np.clip(210 + 45 * frac, 0, 255).astype(np.uint8)
    rgb[snow_mask, 1] = np.clip(215 + 40 * frac, 0, 255).astype(np.uint8)
    rgb[snow_mask, 2] = np.clip(225 + 30 * frac, 0, 255).astype(np.uint8)

    return rgb


def generate_mountain_ridge():
    """Generate a Himalayan-style mountain ridge terrain with strong elevation contrast."""
    print("Generating Mountain Ridge...")
    y, x = np.mgrid[0:SIZE, 0:SIZE].astype(np.float32) / SIZE

    # Primary mountain peaks — more prominent and varied
    ridge = np.exp(-((x - 0.5) ** 2 + (y - 0.4) ** 2) / 0.06) * 1.0
    ridge += np.exp(-((x - 0.3) ** 2 + (y - 0.6) ** 2) / 0.04) * 0.85
    ridge += np.exp(-((x - 0.7) ** 2 + (y - 0.3) ** 2) / 0.035) * 0.9
    ridge += np.exp(-((x - 0.6) ** 2 + (y - 0.7) ** 2) / 0.03) * 0.7
    ridge += np.exp(-((x - 0.2) ** 2 + (y - 0.2) ** 2) / 0.025) * 0.6
    ridge += np.exp(-((x - 0.8) ** 2 + (y - 0.8) ** 2) / 0.05) * 0.5

    # Ridge lines (tectonic fold patterns)
    ridge += np.sin(x * 15 + y * 10) * 0.08
    ridge += np.cos(x * 25 - y * 15) * 0.05
    ridge += np.sin(x * 35 + y * 20) * 0.03  # Higher frequency detail

    # Valley / river — deeper
    valley_center = 0.5 + 0.15 * np.sin(y * 8)
    valley = np.exp(-((x - valley_center) ** 2) / 0.003) * 0.4
    ridge -= valley

    # Secondary river
    valley2_center = 0.25 + 0.1 * np.cos(y * 6)
    valley2 = np.exp(-((x - valley2_center) ** 2) / 0.004) * 0.2
    ridge -= valley2

    # Normalize to full 0-1 range for maximum depth contrast
    ridge = np.clip(ridge, 0, None)
    ridge = (ridge - ridge.min()) / (ridge.max() - ridge.min() + 1e-8)

    # Enhance contrast — steeper mountains, deeper valleys
    ridge = np.power(ridge, 0.8)

    # Colorize with rock textures
    noise = np.sin(np.arange(SIZE).reshape(1, -1) * 0.3) * np.cos(np.arange(SIZE).reshape(-1, 1) * 0.4) * 0.03
    terrain_colored = np.clip(ridge + noise, 0, 1)
    terrain_rgb = colorize_terrain(terrain_colored)

    # Add rock texture to mid-elevation
    y_px, x_px = np.mgrid[0:SIZE, 0:SIZE].astype(np.float32)
    terrain_rgb = add_rock_texture(terrain_rgb, terrain_colored, y_px, x_px)
    terrain_rgb = add_snow_texture(terrain_rgb, terrain_colored)

    texture_img = Image.fromarray(terrain_rgb).filter(ImageFilter.GaussianBlur(radius=0.8))
    depth_img = Image.fromarray((ridge * 255).astype(np.uint8))

    texture_img.save(os.path.join(OUTPUT_DIR, "mountain_ridge.jpg"), quality=95)
    depth_img.save(os.path.join(OUTPUT_DIR, "mountain_ridge_depth.png"))
    print("  [OK] mountain_ridge saved")


def generate_coastal_flood_plain():
    """Generate a coastal river delta / flood plain with clear depth gradients."""
    print("Generating Coastal Flood Plain...")
    y, x = np.mgrid[0:SIZE, 0:SIZE].astype(np.float32) / SIZE

    # Gradual slope toward coast — stronger gradient
    base = 1.0 - y * 0.9

    # Higher inland terrain features
    base += np.exp(-((x - 0.3) ** 2 + (y - 0.15) ** 2) / 0.08) * 0.3
    base += np.exp(-((x - 0.7) ** 2 + (y - 0.1) ** 2) / 0.06) * 0.2

    # River channels — deeper and more defined
    main_river_x = 0.45 + 0.1 * np.sin(y * 12) + 0.05 * np.cos(y * 20)
    main_channel = np.exp(-((x - main_river_x) ** 2) / 0.002) * 0.6
    branch1_x = main_river_x + 0.15 * (y - 0.5)
    branch1 = np.exp(-((x - branch1_x) ** 2) / 0.0015) * 0.35 * np.clip(y - 0.4, 0, 1)
    branch2_x = main_river_x - 0.12 * (y - 0.6)
    branch2 = np.exp(-((x - branch2_x) ** 2) / 0.0015) * 0.3 * np.clip(y - 0.5, 0, 1)

    terrain = base - main_channel - branch1 - branch2
    terrain += np.sin(x * 30) * np.cos(y * 25) * 0.02

    # Sand bars near coast
    for i in range(3):
        bar_y = 0.8 + 0.05 * i
        terrain += np.exp(-((y - bar_y) ** 2) / 0.001) * 0.08

    terrain = np.clip(terrain, 0, 1)
    terrain = (terrain - terrain.min()) / (terrain.max() - terrain.min() + 1e-8)

    # Colorize
    h, w = terrain.shape
    rgb = np.zeros((h, w, 3), dtype=np.float32)
    m0 = terrain < 0.08
    m1 = (terrain >= 0.08) & (terrain < 0.15)
    m2 = (terrain >= 0.15) & (terrain < 0.25)
    m3 = (terrain >= 0.25) & (terrain < 0.5)
    m4 = (terrain >= 0.5) & (terrain < 0.75)
    m5 = terrain >= 0.75

    rgb[m0] = [20, 60, 130]
    rgb[m1] = [40, 90, 140]
    rgb[m2] = [140, 160, 120]

    f3 = (terrain[m3] - 0.25) / 0.25
    rgb[m3, 0] = 80 + 60 * f3
    rgb[m3, 1] = 130 + 30 * f3
    rgb[m3, 2] = 60 + 20 * f3

    f4 = (terrain[m4] - 0.5) / 0.25
    rgb[m4, 0] = 100 + 50 * f4
    rgb[m4, 1] = 140 - 20 * f4
    rgb[m4, 2] = 70 - 10 * f4

    f5 = (terrain[m5] - 0.75) / 0.25
    rgb[m5, 0] = 130 + 40 * f5
    rgb[m5, 1] = 110 + 20 * f5
    rgb[m5, 2] = 60 + 40 * f5

    # Sand near coast
    coast_blend = np.clip((np.arange(SIZE).reshape(-1, 1) / SIZE - 0.75) / 0.25, 0, 1)
    rgb[:, :, 0] = rgb[:, :, 0] * (1 - coast_blend * 0.3) + 190 * coast_blend * 0.3
    rgb[:, :, 1] = rgb[:, :, 1] * (1 - coast_blend * 0.25) + 180 * coast_blend * 0.25
    rgb[:, :, 2] = rgb[:, :, 2] * (1 - coast_blend * 0.2) + 150 * coast_blend * 0.2

    texture_img = Image.fromarray(np.clip(rgb, 0, 255).astype(np.uint8)).filter(ImageFilter.GaussianBlur(radius=0.8))
    depth_img = Image.fromarray((terrain * 255).astype(np.uint8))

    texture_img.save(os.path.join(OUTPUT_DIR, "coastal_flood_plain.jpg"), quality=95)
    depth_img.save(os.path.join(OUTPUT_DIR, "coastal_flood_plain_depth.png"))
    print("  [OK] coastal_flood_plain saved")


def generate_urban_settlement():
    """Generate an urban settlement grid pattern with clear building heights."""
    print("Generating Urban Settlement...")
    y_arr, x_arr = np.mgrid[0:SIZE, 0:SIZE].astype(np.float32) / SIZE

    # Base terrain — slight slope
    terrain = np.ones((SIZE, SIZE), dtype=np.float32) * 0.15
    terrain += y_arr * 0.08

    # Building blocks — taller buildings for more depth contrast
    block_size = 40
    street_width = 8
    np.random.seed(42)

    buildings = np.zeros((SIZE, SIZE), dtype=np.float32)
    for by in range(0, SIZE, block_size + street_width):
        for bx in range(0, SIZE, block_size + street_width):
            if np.random.random() > 0.15:
                height = 0.3 + np.random.random() * 0.55
                margin = np.random.randint(2, 8)
                y1 = by + margin
                y2 = min(by + block_size - margin, SIZE)
                x1 = bx + margin
                x2 = min(bx + block_size - margin, SIZE)
                if y2 > y1 and x2 > x1:
                    buildings[y1:y2, x1:x2] = height

    # Park
    cy, cx = int(SIZE * 0.4), int(SIZE * 0.5)
    yy, xx = np.ogrid[0:SIZE, 0:SIZE]
    park_mask = ((xx - cx) ** 2 + (yy - cy) ** 2) < 35 ** 2
    buildings[park_mask] = 0
    terrain[park_mask] = 0.12

    terrain += buildings
    terrain = np.clip(terrain, 0, 1)
    terrain = (terrain - terrain.min()) / (terrain.max() - terrain.min() + 1e-8)

    # Colorize
    rgb = np.zeros((SIZE, SIZE, 3), dtype=np.float32)
    bld_mask = buildings > 0.01
    street_mask = (~bld_mask) & (terrain >= 0.14)
    green_mask = (~bld_mask) & (terrain < 0.14)

    # Buildings: gray tones based on height
    brightness = 100 + buildings[bld_mask] * 200
    noise = np.random.randint(-10, 10, size=brightness.shape)
    rgb[bld_mask, 0] = brightness + noise
    rgb[bld_mask, 1] = brightness + noise - 5
    rgb[bld_mask, 2] = brightness + noise + 5

    # Green spaces
    rgb[green_mask, 0] = 60 + np.random.randint(-10, 10, size=np.sum(green_mask))
    rgb[green_mask, 1] = 120 + np.random.randint(-10, 10, size=np.sum(green_mask))
    rgb[green_mask, 2] = 50

    # Streets
    rgb[street_mask, 0] = 70 + np.random.randint(-5, 5, size=np.sum(street_mask))
    rgb[street_mask, 1] = 72 + np.random.randint(-5, 5, size=np.sum(street_mask))
    rgb[street_mask, 2] = 75 + np.random.randint(-5, 5, size=np.sum(street_mask))

    texture_img = Image.fromarray(np.clip(rgb, 0, 255).astype(np.uint8)).filter(ImageFilter.GaussianBlur(radius=0.6))
    depth_img = Image.fromarray((terrain * 255).astype(np.uint8))

    texture_img.save(os.path.join(OUTPUT_DIR, "urban_settlement.jpg"), quality=95)
    depth_img.save(os.path.join(OUTPUT_DIR, "urban_settlement_depth.png"))
    print("  [OK] urban_settlement saved")


if __name__ == "__main__":
    print("=" * 50)
    print("  DepthWizard — Sample Data Generator (Enhanced)")
    print("=" * 50)
    generate_mountain_ridge()
    generate_coastal_flood_plain()
    generate_urban_settlement()
    print(f"\n[OK] All samples saved to: {os.path.abspath(OUTPUT_DIR)}")
