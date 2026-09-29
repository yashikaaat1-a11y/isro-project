# 🏔️ DepthWizard — Single-View Height Estimation & 3D Flythrough

> **SIH26175** | Indian Space Research Organisation (ISRO) | Disaster Management Triage

DepthWizard converts a single 2D optical satellite image into a continuous height map with an interactive 3D flythrough environment. Built for emergency disaster response teams who need rapid terrain analysis from sporadic, single-view captures.

---

## 📐 Architecture

```
[User Browser — Vite + Three.js]
│
├── 1. Uploads 2D Satellite Tile (.png / .jpg / .tif)
│
[FastAPI Python Backend]
│
├── 2. Runs Zero-Shot Monocular Depth (Depth Anything V2)
├── 3. Computes Analytical Derivatives (Slope Map, Flood Mask)
└── 4. Returns: Depth Map PNG + Derived Metadata JSON
│
[User Browser — Three.js WebGL]
│
├── 5. Renders 3D Terrain (Base Texture + Displacement Map)
├── 6. Interactive Flythrough (Orbit + WASD Drone Mode)
└── 7. Real-Time Sliders: Vertical Exaggeration + Flood Simulator
```

## 🚀 Quick Start

### Prerequisites
- **Python 3.10+** with pip
- **Node.js 18+** with npm
- (Optional) CUDA-capable GPU for faster inference

### 1. Backend Setup

```bash
cd backend

# Install dependencies
pip install -r requirements.txt

# Run in Mock mode (no GPU/model required — instant demo)
set MOCK_MODE=1
uvicorn app:app --host 0.0.0.0 --port 8000 --reload

# OR Run with real Depth Anything V2 model
uvicorn app:app --host 0.0.0.0 --port 8000 --reload
```

### 2. Generate Sample Data (Offline Demos)

```bash
cd backend
python generate_samples.py
```

This creates 3 pre-baked satellite tiles with depth maps in `frontend/public/samples/`.

### 3. Frontend Setup

```bash
cd frontend

# Install dependencies
npm install

# Start dev server
npm run dev
```

Open **http://localhost:5173** in your browser.

---

## 🎮 Features

### Core Capabilities
| Feature | Description |
|---------|-------------|
| **Monocular Depth Estimation** | Zero-shot depth prediction using Depth Anything V2-Small (Vision Transformer) |
| **3D Terrain Rendering** | Real-time WebGL terrain with displacement mapping on a 256×256 segment plane |
| **Dual Camera Modes** | Orbit mode (inspection) + WASD Drone mode (first-person flythrough) |
| **Flood Simulator** | Dynamic water plane with adjustable level to visualize flood zones |
| **Slope Risk Analysis** | Sobel gradient-based slope map with landslide risk color ramp |
| **1-Point Ground Anchor** | Calibrate relative depth to metric elevation with a single known reference point |
| **Offline Demo** | 3 pre-cached sample datasets for demo without backend |

### Mission Controls
- **Vertical Exaggeration Slider** (0.1× – 20×): Amplifies terrain relief for analysis
- **Flood Water Level** (0% – 100%): Raises a semi-transparent water plane to simulate inundation
- **Terrain Visualization Toggle**: Switch between Satellite / Depth Map / Slope Risk views
- **Wireframe Mode**: Toggle solid/wireframe rendering
- **Screenshot Export**: Capture the current viewport as PNG

### Elevation Modes
- **rDSM (Relative DSM)**: Default uncalibrated mode — normalized 0–100 scale
- **mDSM (Metric DSM)**: After anchoring with a known elevation point, heights are estimated in meters ASL

### WASD Drone Flythrough
- `W/A/S/D` — Forward/Left/Back/Right
- `Q/E` — Descend/Ascend
- `Mouse` — Look direction
- `Shift` — Speed boost
- `Escape` — Exit drone mode

---

## 📁 Project Structure

```
depthwizard/
├── backend/
│   ├── app.py                    # FastAPI microservice
│   ├── generate_samples.py       # Sample data generator
│   └── requirements.txt          # Python dependencies
├── frontend/
│   ├── index.html                # Main HTML
│   ├── vite.config.js            # Vite config with API proxy
│   ├── package.json              # Node dependencies
│   ├── public/
│   │   ├── favicon.svg
│   │   └── samples/              # Pre-cached offline demos
│   │       ├── mountain_ridge.jpg
│   │       ├── mountain_ridge_depth.png
│   │       ├── coastal_flood_plain.jpg
│   │       ├── coastal_flood_plain_depth.png
│   │       ├── urban_settlement.jpg
│   │       └── urban_settlement_depth.png
│   └── src/
│       ├── main.js               # Three.js terrain engine
│       └── style.css             # Design system
└── README.md
```

---

## 🏗️ Technical Details

### Depth Estimation Pipeline
1. Input image is sent to FastAPI backend via `POST /api/generate-depth`
2. Image is processed through Depth Anything V2-Small (86M params, ViT-S backbone)
3. Raw depth predictions are normalized to 8-bit grayscale (0–255)
4. Sobel gradient computes slope magnitude for hazard analysis
5. Inundation mask identifies low-elevation flood-prone zones

### Metric Grounding Formula
When a user anchors a known elevation point:
```
Z_metric(x, y) = Z_anchor + (d(x,y) - d_anchor) × S
```
Where `S` is the scale factor derived from the reference point.

### API Endpoints
| Endpoint | Method | Description |
|----------|--------|-------------|
| `/` | GET | Service info |
| `/health` | GET | Health check |
| `/api/generate-depth` | POST | Depth estimation + analytics |

---

## 📜 License

Built for Smart India Hackathon 2026 — Problem Statement SIH26175
Indian Space Research Organisation (ISRO) / Department of Space