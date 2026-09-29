# SIH26175 — DepthWizard: Single-View Height Estimation & 3D Flythrough

**Organization:** Indian Space Research Organisation (ISRO) / Department of Space
**Theme:** Disaster Management / Space Technology — Software Edition

## Core need
Traditional elevation models (DEM/DSM) need multi-view stereo pairs (e.g. Cartosat stereo) or LiDAR.
During disasters (flash floods, cloudbursts, landslides, structural collapse) responders often only get a
single optical pass (satellite tile, aerial photo, drone capture). ISRO needs a tool that turns **one 2D
optical image** into a continuous height map with an **interactive 3D flythrough**.

## Architecture
```
[Browser: Vite + Three.js]
  1. Upload 2D tile (.png / .jpg / .tif)
[FastAPI backend]
  2. Zero-shot monocular depth (Depth Anything V2-Small) -> grayscale depthmap
  3. Analytical derivatives (slope map, inundation mask)
  4. Return depthmap PNG + metadata JSON
[Browser]
  5. 3D terrain plane (map = optical tile, displacementMap = depthmap)
  6. Orbit controls + first-person WASD drone flight
  7. Sliders: vertical exaggeration + dynamic water-rise flood simulator
```

## Requirements
### Backend (`backend/app.py`)
- FastAPI + CORS. `POST /api/generate-depth` accepts PNG/JPG (and GeoTIFF).
- `depth-anything/Depth-Anything-V2-Small-hf` via HF Transformers pipeline (CPU/CUDA).
- Normalize to 8-bit single-channel heightmap (0–255).
- Sobel slope magnitude to flag steep terrain.
- Response: `depth_image` (base64 PNG), `min_val` 0, `max_val` 255, `stats`.
- `--mock` flag / automatic fallback returning procedural heightmap if torch is unavailable.

### Frontend (`frontend/`, Vite + Three.js)
- Left sidebar: upload zone, 3 cached samples ("Coastal Flood Plain", "Mountain Ridge",
  "Urban Settlement"), mission controls.
- Full-screen WebGL viewport; status ribbon ("Mode: Relative DSM (rDSM)" + metrics).
- `PlaneGeometry(100, 100, 256, 256)` rotated -90° on X; `MeshStandardMaterial`
  with `map` + `displacementMap`; directional light w/ shadows + ambient.
- OrbitControls + "WASD Drone Mode" with mouse look.
- Vertical exaggeration slider 0.1x–20x (`displacementScale`).
- Flood plane slider (color `0x0077be`, opacity 0.6) raised along Y.
- 1-Point Ground Anchor: click point, enter known elevation →
  `Z_metric(x,y) = Z_anchor + (d(x,y) - d_anchor) * S`.
- Slope Risk Map toggle: red-yellow-green false colour of gradient magnitude.
- Offline cache: 3 sample tiles + precomputed depth maps in `public/samples/`.

## Unique edge
1. **Fail-closed elevation banner** — Mode A (rDSM, "Unanchored Relative Depth (0–100 Normalized
   Scale) — Suitable for Topographic Shape Analysis and Flood Flow Triage") vs Mode B (mDSM via a
   single ground anchor). Never display metres unless anchored.
2. **Slope / landslide risk view** from √(Δx² + Δy²).

## Quality bar
Professional, highly interactive, creative, eye-catching — built to impress SIH judges.
