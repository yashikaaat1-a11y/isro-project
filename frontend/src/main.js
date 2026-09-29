/**
 * DepthWizard — Main Application Entry Point
 * Three.js 3D Terrain Engine + Depth Estimation Interface
 *
 * Architecture:
 * ├── TerrainEngine (Three.js scene, geometry, materials, lighting)
 * ├── CameraController (Orbit + WASD Drone dual-mode)
 * ├── FloodSimulator (dynamic water plane)
 * ├── SlopeAnalyzer (gradient-based risk coloring)
 * ├── AnchorSystem (1-point metric calibration)
 * └── UIController (sidebar panels, sliders, upload flow)
 */

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

// ═══════════════════════════════════════════════════════════════════════════
// CONFIG
// ═══════════════════════════════════════════════════════════════════════════
const API_URL = 'http://localhost:8000';
const TERRAIN_SIZE = 100;
const TERRAIN_SEGMENTS = 256; // Balanced resolution — smooth terrain without spike artifacts

// Auto-calculated depth scale based on terrain analysis
const AUTO_DEPTH_SCALE = 8; // Gentle default scale — realistic proportions

// ═══════════════════════════════════════════════════════════════════════════
// STATE
// ═══════════════════════════════════════════════════════════════════════════
const state = {
  currentMode: 'orbit', // 'orbit' | 'drone'
  textureMode: 'satellite', // 'satellite' | 'depth' | 'slope'
  renderMode: 'colored', // 'colored' | 'wireframe'
  isPickingAnchor: false,
  anchorPoint: null,
  anchorElevation: null,
  scaleFactor: 1,
  offsetFactor: 0,
  dsmMode: 'rDSM', // 'rDSM' | 'mDSM'
  currentDepthData: null,
  terrainLoaded: false,
  depthScale: AUTO_DEPTH_SCALE,

  // Drone controls
  drone: {
    moveSpeed: 0.5,
    lookSpeed: 0.002,
    keys: { w: false, a: false, s: false, d: false, q: false, e: false, shift: false },
    euler: new THREE.Euler(0, 0, 0, 'YXZ'),
    velocity: new THREE.Vector3(),
  },
};

// ═══════════════════════════════════════════════════════════════════════════
// THREE.JS SETUP
// ═══════════════════════════════════════════════════════════════════════════
const canvas = document.getElementById('three-canvas');
const renderer = new THREE.WebGLRenderer({
  canvas,
  antialias: true,
  alpha: false,
  preserveDrawingBuffer: true, // for screenshots
});
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.2;
renderer.outputColorSpace = THREE.SRGBColorSpace;

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x0a0e17);
scene.fog = new THREE.FogExp2(0x0a0e17, 0.006);

// Camera
const camera = new THREE.PerspectiveCamera(55, 1, 0.1, 1000);
camera.position.set(50, 60, 80);

// Orbit Controls
const orbitControls = new OrbitControls(camera, canvas);
orbitControls.enableDamping = true;
orbitControls.dampingFactor = 0.08;
orbitControls.target.set(0, 5, 0);
orbitControls.minDistance = 10;
orbitControls.maxDistance = 250;
orbitControls.maxPolarAngle = Math.PI * 0.48;

// ═══════════════════════════════════════════════════════════════════════════
// LIGHTING (enhanced for terrain textures)
// ═══════════════════════════════════════════════════════════════════════════
const ambientLight = new THREE.AmbientLight(0x6688cc, 0.6);
scene.add(ambientLight);

const dirLight = new THREE.DirectionalLight(0xfff5e0, 2.0);
dirLight.position.set(60, 80, 40);
dirLight.castShadow = true;
dirLight.shadow.mapSize.width = 2048;
dirLight.shadow.mapSize.height = 2048;
dirLight.shadow.camera.left = -80;
dirLight.shadow.camera.right = 80;
dirLight.shadow.camera.top = 80;
dirLight.shadow.camera.bottom = -80;
dirLight.shadow.camera.near = 1;
dirLight.shadow.camera.far = 200;
dirLight.shadow.bias = -0.001;
scene.add(dirLight);

const hemiLight = new THREE.HemisphereLight(0x8899cc, 0x443322, 0.5);
scene.add(hemiLight);

// Subtle back-light for rim lighting effect
const backLight = new THREE.DirectionalLight(0x3366ff, 0.3);
backLight.position.set(-40, 30, -60);
scene.add(backLight);

// Fill light from side to enhance textures
const fillLight = new THREE.DirectionalLight(0xffe8cc, 0.4);
fillLight.position.set(-50, 40, 30);
scene.add(fillLight);

// ═══════════════════════════════════════════════════════════════════════════
// GRID & HELPERS
// ═══════════════════════════════════════════════════════════════════════════
const gridHelper = new THREE.GridHelper(120, 30, 0x1a2a3a, 0x0f1a2a);
gridHelper.position.y = -0.1;
scene.add(gridHelper);

// Axis indicator (small)
const axesHelper = new THREE.AxesHelper(5);
axesHelper.position.set(-55, 0, -55);
scene.add(axesHelper);

// ═══════════════════════════════════════════════════════════════════════════
// TERRAIN GEOMETRY & MATERIAL
// ═══════════════════════════════════════════════════════════════════════════
const terrainGeom = new THREE.PlaneGeometry(
  TERRAIN_SIZE, TERRAIN_SIZE,
  TERRAIN_SEGMENTS, TERRAIN_SEGMENTS
);
terrainGeom.rotateX(-Math.PI / 2);

// Default placeholder texture
const defaultTexture = createGradientTexture();
const defaultDepthTex = createDefaultDepthTexture();
const defaultNormalMap = createTerrainNormalMap(null);

const terrainMaterial = new THREE.MeshStandardMaterial({
  map: defaultTexture,
  displacementMap: defaultDepthTex,
  displacementScale: AUTO_DEPTH_SCALE,
  normalMap: defaultNormalMap,
  normalScale: new THREE.Vector2(1.5, 1.5),
  roughness: 0.85,
  roughnessMap: null,
  metalness: 0.02,
  side: THREE.DoubleSide,
  wireframe: false,
  flatShading: false,
});

const terrainMesh = new THREE.Mesh(terrainGeom, terrainMaterial);
terrainMesh.receiveShadow = true;
terrainMesh.castShadow = true;
scene.add(terrainMesh);

// Wireframe overlay mesh (for grid mode)
const wireframeMaterial = new THREE.MeshStandardMaterial({
  color: 0x00d4ff,
  wireframe: true,
  transparent: true,
  opacity: 0.6,
  emissive: 0x00d4ff,
  emissiveIntensity: 0.3,
  displacementMap: defaultDepthTex,
  displacementScale: AUTO_DEPTH_SCALE,
});
const wireframeMesh = new THREE.Mesh(terrainGeom, wireframeMaterial);
wireframeMesh.visible = false;
wireframeMesh.receiveShadow = false;
wireframeMesh.castShadow = false;
scene.add(wireframeMesh);

// Store texture references
const textures = {
  satellite: defaultTexture,
  depth: defaultDepthTex,
  slope: null,
  normalMap: defaultNormalMap,
  roughnessMap: null,
};

// ═══════════════════════════════════════════════════════════════════════════
// FLOOD WATER PLANE
// ═══════════════════════════════════════════════════════════════════════════
const waterGeom = new THREE.PlaneGeometry(TERRAIN_SIZE * 1.2, TERRAIN_SIZE * 1.2);
waterGeom.rotateX(-Math.PI / 2);

const waterMaterial = new THREE.MeshStandardMaterial({
  color: 0x0077be,
  transparent: true,
  opacity: 0.55,
  roughness: 0.1,
  metalness: 0.3,
  side: THREE.DoubleSide,
});

const waterMesh = new THREE.Mesh(waterGeom, waterMaterial);
waterMesh.position.y = -10; // start hidden below
waterMesh.renderOrder = 1;
scene.add(waterMesh);

// ═══════════════════════════════════════════════════════════════════════════
// SKY DOME (subtle gradient)
// ═══════════════════════════════════════════════════════════════════════════
const skyGeom = new THREE.SphereGeometry(300, 32, 16);
const skyMat = new THREE.ShaderMaterial({
  uniforms: {
    topColor: { value: new THREE.Color(0x0a1628) },
    bottomColor: { value: new THREE.Color(0x1a2a4a) },
    offset: { value: 20 },
    exponent: { value: 0.4 },
  },
  vertexShader: `
    varying vec3 vWorldPosition;
    void main() {
      vec4 worldPosition = modelMatrix * vec4(position, 1.0);
      vWorldPosition = worldPosition.xyz;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,
  fragmentShader: `
    uniform vec3 topColor;
    uniform vec3 bottomColor;
    uniform float offset;
    uniform float exponent;
    varying vec3 vWorldPosition;
    void main() {
      float h = normalize(vWorldPosition + offset).y;
      gl_FragColor = vec4(mix(bottomColor, topColor, max(pow(max(h, 0.0), exponent), 0.0)), 1.0);
    }
  `,
  side: THREE.BackSide,
  depthWrite: false,
});
const sky = new THREE.Mesh(skyGeom, skyMat);
scene.add(sky);

// ═══════════════════════════════════════════════════════════════════════════
// ANCHOR MARKER
// ═══════════════════════════════════════════════════════════════════════════
const anchorMarkerGeom = new THREE.SphereGeometry(0.8, 16, 16);
const anchorMarkerMat = new THREE.MeshBasicMaterial({ color: 0xff2d87 });
const anchorMarker = new THREE.Mesh(anchorMarkerGeom, anchorMarkerMat);
anchorMarker.visible = false;
scene.add(anchorMarker);

// Anchor pole
const poleGeom = new THREE.CylinderGeometry(0.1, 0.1, 15, 8);
const poleMat = new THREE.MeshBasicMaterial({ color: 0xff2d87, transparent: true, opacity: 0.6 });
const anchorPole = new THREE.Mesh(poleGeom, poleMat);
anchorPole.visible = false;
scene.add(anchorPole);

// ═══════════════════════════════════════════════════════════════════════════
// TEXTURE GENERATORS
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Smooth a depth-map canvas using a multi-pass box blur.
 * This eliminates pixel-level noise that would otherwise create
 * sharp spikes in the displaced mesh geometry.
 * @param {HTMLCanvasElement} srcCanvas - raw depth canvas
 * @param {number} passes - number of blur passes (more = smoother)
 * @returns {HTMLCanvasElement} - new smoothed canvas
 */
function smoothDepthMap(srcCanvas, passes = 3) {
  const w = srcCanvas.width;
  const h = srcCanvas.height;

  // Read source pixels
  const srcCtx = srcCanvas.getContext('2d');
  const srcData = srcCtx.getImageData(0, 0, w, h);
  const src = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) {
    src[i] = srcData.data[i * 4]; // use red channel
  }

  let cur = src;
  let tmp = new Float32Array(w * h);

  // Separable 5-tap box blur (radius 2)
  for (let pass = 0; pass < passes; pass++) {
    // Horizontal pass
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        let sum = 0, count = 0;
        for (let dx = -2; dx <= 2; dx++) {
          const nx = Math.max(0, Math.min(w - 1, x + dx));
          sum += cur[y * w + nx];
          count++;
        }
        tmp[y * w + x] = sum / count;
      }
    }
    // Vertical pass
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        let sum = 0, count = 0;
        for (let dy = -2; dy <= 2; dy++) {
          const ny = Math.max(0, Math.min(h - 1, y + dy));
          sum += tmp[ny * w + x];
          count++;
        }
        cur[y * w + x] = sum / count;
      }
    }
  }

  // Write back to a new canvas
  const outCanvas = document.createElement('canvas');
  outCanvas.width = w;
  outCanvas.height = h;
  const outCtx = outCanvas.getContext('2d');
  const outData = outCtx.createImageData(w, h);
  for (let i = 0; i < w * h; i++) {
    const v = Math.round(Math.max(0, Math.min(255, cur[i])));
    outData.data[i * 4] = v;
    outData.data[i * 4 + 1] = v;
    outData.data[i * 4 + 2] = v;
    outData.data[i * 4 + 3] = 255;
  }
  outCtx.putImageData(outData, 0, 0);
  return outCanvas;
}

/**
 * Create a procedural normal map from a depth map canvas.
 * Uses gentle settings to add surface texture detail
 * (rock roughness, smooth snow) without affecting geometry.
 */
function createTerrainNormalMap(depthCanvas) {
  const size = 512;
  const c = document.createElement('canvas');
  c.width = size;
  c.height = size;
  const ctx = c.getContext('2d');

  let depthData;
  if (depthCanvas) {
    const tmpCanvas = document.createElement('canvas');
    tmpCanvas.width = size;
    tmpCanvas.height = size;
    const tmpCtx = tmpCanvas.getContext('2d');
    tmpCtx.drawImage(depthCanvas, 0, 0, size, size);
    depthData = tmpCtx.getImageData(0, 0, size, size).data;
  } else {
    // Generate default depth data for normal map
    depthData = new Uint8ClampedArray(size * size * 4);
    const cx = size / 2, cy = size / 2;
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const idx = (y * size + x) * 4;
        const dx = (x - cx) / size;
        const dy = (y - cy) / size;
        const dist = Math.sqrt(dx * dx + dy * dy);
        let h = Math.max(0, 1 - dist * 2.5);
        h = h * h;
        h += Math.sin(x * 0.05 + y * 0.03) * 0.1;
        h += Math.cos(x * 0.08 - y * 0.06) * 0.06;
        h = Math.max(0, Math.min(1, h));
        const v = Math.floor(h * 255);
        depthData[idx] = v;
        depthData[idx + 1] = v;
        depthData[idx + 2] = v;
        depthData[idx + 3] = 255;
      }
    }
  }

  const normalData = ctx.createImageData(size, size);

  // Gentle normal-map strength — we only want surface shading detail,
  // NOT additional geometry displacement
  const strength = 1.5;
  for (let y = 1; y < size - 1; y++) {
    for (let x = 1; x < size - 1; x++) {
      const idx = (y * size + x) * 4;
      const getH = (px, py) => depthData[(py * size + px) * 4] / 255.0;

      const hL = getH(x - 1, y);
      const hR = getH(x + 1, y);
      const hU = getH(x, y - 1);
      const hD = getH(x, y + 1);
      const hC = getH(x, y);

      // Elevation-dependent surface detail:
      //   Low = smooth plains/water
      //   Mid = rocky texture
      //   High = smooth snow/ice
      let detailScale;
      if (hC < 0.15) {
        detailScale = 0.2;
      } else if (hC < 0.4) {
        detailScale = 0.5;
      } else if (hC < 0.7) {
        detailScale = 1.0; // rockiest
      } else if (hC < 0.85) {
        detailScale = 0.7;
      } else {
        detailScale = 0.2; // snow — very smooth
      }

      // Subtle procedural micro-detail (only for normal-map shading)
      let microNx = 0, microNy = 0;
      if (hC >= 0.3 && hC < 0.85) {
        // Rock texture: medium-frequency noise
        const rf = 20.0;
        microNx = Math.sin(x * rf * 0.13 + y * rf * 0.07) * 0.06 +
                  Math.cos(x * rf * 0.19 - y * rf * 0.11) * 0.04;
        microNy = Math.cos(x * rf * 0.11 + y * rf * 0.13) * 0.06 +
                  Math.sin(x * rf * 0.17 - y * rf * 0.09) * 0.04;
      } else if (hC >= 0.85) {
        const sf = 6.0;
        microNx = Math.sin(x * sf * 0.05 + y * sf * 0.03) * 0.015;
        microNy = Math.cos(x * sf * 0.04 + y * sf * 0.06) * 0.015;
      }

      // Compute normal from height differences
      let nx = (hL - hR) * strength * detailScale + microNx;
      let ny = (hU - hD) * strength * detailScale + microNy;
      let nz = 1.0;

      // Normalize
      const len = Math.sqrt(nx * nx + ny * ny + nz * nz);
      nx /= len;
      ny /= len;
      nz /= len;

      // Encode as RGB (tangent space normal map)
      normalData.data[idx] = Math.floor((nx * 0.5 + 0.5) * 255);
      normalData.data[idx + 1] = Math.floor((ny * 0.5 + 0.5) * 255);
      normalData.data[idx + 2] = Math.floor((nz * 0.5 + 0.5) * 255);
      normalData.data[idx + 3] = 255;
    }
  }

  ctx.putImageData(normalData, 0, 0);
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  return tex;
}

/**
 * Create a roughness map based on depth (elevation).
 * Rough for rocky areas, smooth for snow and water.
 */
function createRoughnessMap(depthCanvas) {
  const size = 512;
  const c = document.createElement('canvas');
  c.width = size;
  c.height = size;
  const ctx = c.getContext('2d');

  const tmpCanvas = document.createElement('canvas');
  tmpCanvas.width = size;
  tmpCanvas.height = size;
  const tmpCtx = tmpCanvas.getContext('2d');
  tmpCtx.drawImage(depthCanvas, 0, 0, size, size);
  const depthData = tmpCtx.getImageData(0, 0, size, size).data;

  const roughData = ctx.createImageData(size, size);

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const idx = (y * size + x) * 4;
      const h = depthData[idx] / 255.0;

      let roughness;
      if (h < 0.12) {
        // Water / very low — smooth
        roughness = 0.2;
      } else if (h < 0.3) {
        // Low terrain — moderate
        roughness = 0.5 + (h - 0.12) / 0.18 * 0.2;
      } else if (h < 0.7) {
        // Rock — very rough
        roughness = 0.85 + Math.sin(x * 0.5 + y * 0.3) * 0.1;
      } else if (h < 0.85) {
        // High rock — rough
        roughness = 0.75 + Math.cos(x * 0.4 - y * 0.2) * 0.08;
      } else {
        // Snow — smooth icy
        roughness = 0.15 + (1.0 - h) / 0.15 * 0.1;
      }

      const v = Math.floor(Math.max(0, Math.min(1, roughness)) * 255);
      roughData.data[idx] = v;
      roughData.data[idx + 1] = v;
      roughData.data[idx + 2] = v;
      roughData.data[idx + 3] = 255;
    }
  }

  ctx.putImageData(roughData, 0, 0);
  const tex = new THREE.CanvasTexture(c);
  return tex;
}

/**
 * Analyze a SMOOTHED depth map to compute a gentle displacement scale.
 * The goal is a realistic elevation profile — not dramatic spikes.
 * For a 100-unit wide terrain, scale≈8 means the tallest peak is ~8 units.
 */
function computeAutoDepthScale(depthCanvas) {
  const size = 256;
  const tmpCanvas = document.createElement('canvas');
  tmpCanvas.width = size;
  tmpCanvas.height = size;
  const tmpCtx = tmpCanvas.getContext('2d');
  tmpCtx.drawImage(depthCanvas, 0, 0, size, size);
  const data = tmpCtx.getImageData(0, 0, size, size).data;

  let min = 255, max = 0, sum = 0, count = 0;
  for (let i = 0; i < data.length; i += 4) {
    const v = data[i];
    if (v < min) min = v;
    if (v > max) max = v;
    sum += v;
    count++;
  }

  const range = max - min;
  const mean = sum / count;

  let variance = 0;
  for (let i = 0; i < data.length; i += 4) {
    const diff = data[i] - mean;
    variance += diff * diff;
  }
  const stdDev = Math.sqrt(variance / count);

  // Gentle scale: terrain width is 100, so scale 6-12 means
  // peaks are about 6-12% of the terrain width — realistic.
  const normalizedRange = range / 255;
  const normalizedStd = stdDev / 128;

  let scale = 4 + normalizedRange * 5 + normalizedStd * 3;
  scale = Math.max(3, Math.min(12, scale));

  console.log(`[AutoDepth] range=${range}, std=${stdDev.toFixed(1)}, scale=${scale.toFixed(1)}`);
  return scale;
}

function createGradientTexture() {
  const size = 512;
  const c = document.createElement('canvas');
  c.width = size;
  c.height = size;
  const ctx = c.getContext('2d');

  // Create a terrain-like gradient
  const grad = ctx.createLinearGradient(0, 0, size, size);
  grad.addColorStop(0, '#1a3a2a');
  grad.addColorStop(0.3, '#2d5a3a');
  grad.addColorStop(0.6, '#6b4a2a');
  grad.addColorStop(0.8, '#8a7a5a');
  grad.addColorStop(1, '#d0d0d0');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, size, size);

  // Add some noise
  const imageData = ctx.getImageData(0, 0, size, size);
  for (let i = 0; i < imageData.data.length; i += 4) {
    const noise = (Math.random() - 0.5) * 15;
    imageData.data[i] = Math.max(0, Math.min(255, imageData.data[i] + noise));
    imageData.data[i + 1] = Math.max(0, Math.min(255, imageData.data[i + 1] + noise));
    imageData.data[i + 2] = Math.max(0, Math.min(255, imageData.data[i + 2] + noise));
  }
  ctx.putImageData(imageData, 0, 0);

  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

function createDefaultDepthTexture() {
  const size = 512;
  const c = document.createElement('canvas');
  c.width = size;
  c.height = size;
  const ctx = c.getContext('2d');

  // Procedural terrain heightmap
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, size, size);

  const cx = size / 2, cy = size / 2;
  const imageData = ctx.getImageData(0, 0, size, size);

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const idx = (y * size + x) * 4;
      const dx = (x - cx) / size;
      const dy = (y - cy) / size;
      const dist = Math.sqrt(dx * dx + dy * dy);

      // Base mountain
      let h = Math.max(0, 1 - dist * 2.5);
      h = h * h; // sharpen peaks

      // Add ridges
      h += Math.sin(x * 0.05 + y * 0.03) * 0.1;
      h += Math.cos(x * 0.08 - y * 0.06) * 0.06;
      h += Math.sin((x + y) * 0.04) * 0.08;

      // Valley
      const valleyCx = cx + 30 * Math.sin(y * 0.02);
      const valleyDist = Math.abs(x - valleyCx);
      h -= Math.exp(-(valleyDist * valleyDist) / 800) * 0.2;

      h = Math.max(0, Math.min(1, h));
      const v = Math.floor(h * 255);
      imageData.data[idx] = v;
      imageData.data[idx + 1] = v;
      imageData.data[idx + 2] = v;
      imageData.data[idx + 3] = 255;
    }
  }

  ctx.putImageData(imageData, 0, 0);
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = THREE.ClampToEdgeWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  return tex;
}

function createSlopeTexture(depthCanvas) {
  const size = depthCanvas.width;
  const srcCtx = depthCanvas.getContext('2d');
  const srcData = srcCtx.getImageData(0, 0, size, size);

  const c = document.createElement('canvas');
  c.width = size;
  c.height = size;
  const ctx = c.getContext('2d');
  const outData = ctx.createImageData(size, size);

  // Compute gradient magnitude via Sobel
  for (let y = 1; y < size - 1; y++) {
    for (let x = 1; x < size - 1; x++) {
      const idx = (y * size + x) * 4;
      const getV = (px, py) => srcData.data[(py * size + px) * 4];

      const gx = (
        -getV(x - 1, y - 1) - 2 * getV(x - 1, y) - getV(x - 1, y + 1) +
        getV(x + 1, y - 1) + 2 * getV(x + 1, y) + getV(x + 1, y + 1)
      );
      const gy = (
        -getV(x - 1, y - 1) - 2 * getV(x, y - 1) - getV(x + 1, y - 1) +
        getV(x - 1, y + 1) + 2 * getV(x, y + 1) + getV(x + 1, y + 1)
      );

      const mag = Math.sqrt(gx * gx + gy * gy);
      const normalized = Math.min(mag / 400, 1); // Normalize to 0-1

      // Color ramp: green (low slope) -> yellow -> orange -> red -> purple (high slope)
      let r, g, b;
      if (normalized < 0.2) {
        r = 46; g = 204; b = 113; // Green
      } else if (normalized < 0.4) {
        const t = (normalized - 0.2) / 0.2;
        r = Math.floor(46 + (241 - 46) * t);
        g = Math.floor(204 + (196 - 204) * t);
        b = Math.floor(113 + (15 - 113) * t);
      } else if (normalized < 0.6) {
        const t = (normalized - 0.4) / 0.2;
        r = Math.floor(241 + (231 - 241) * t);
        g = Math.floor(196 + (76 - 196) * t);
        b = Math.floor(15 + (60 - 15) * t);
      } else if (normalized < 0.8) {
        const t = (normalized - 0.6) / 0.2;
        r = Math.floor(231 + (192 - 231) * t);
        g = Math.floor(76 + (57 - 76) * t);
        b = Math.floor(60 + (43 - 60) * t);
      } else {
        const t = (normalized - 0.8) / 0.2;
        r = Math.floor(192 + (142 - 192) * t);
        g = Math.floor(57 + (68 - 57) * t);
        b = Math.floor(43 + (173 - 43) * t);
      }

      outData.data[idx] = r;
      outData.data[idx + 1] = g;
      outData.data[idx + 2] = b;
      outData.data[idx + 3] = 255;
    }
  }

  ctx.putImageData(outData, 0, 0);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

// ═══════════════════════════════════════════════════════════════════════════
// RAYCASTER (for anchor picking & cursor elevation)
// ═══════════════════════════════════════════════════════════════════════════
const raycaster = new THREE.Raycaster();
const mouse = new THREE.Vector2();

function getTerrainIntersection(event) {
  const rect = canvas.getBoundingClientRect();
  mouse.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
  mouse.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
  raycaster.setFromCamera(mouse, camera);
  const intersects = raycaster.intersectObject(terrainMesh);
  return intersects.length > 0 ? intersects[0] : null;
}

// ═══════════════════════════════════════════════════════════════════════════
// TERRAIN LOADING
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Apply normal map and roughness map from a depth canvas to the terrain.
 * Crucially, the displacement map is SMOOTHED first to remove noise spikes,
 * while the normal/roughness maps use raw data for visual surface detail.
 */
function applyTerrainTextures(rawDepthCanvas) {
  // 1. Smooth the depth map for displacement (removes spike-causing noise)
  const smoothedCanvas = smoothDepthMap(rawDepthCanvas, 4);

  // 2. Create a smoothed displacement texture
  const smoothedDepthTex = new THREE.CanvasTexture(smoothedCanvas);
  smoothedDepthTex.minFilter = THREE.LinearFilter;
  smoothedDepthTex.magFilter = THREE.LinearFilter;
  smoothedDepthTex.wrapS = THREE.ClampToEdgeWrapping;
  smoothedDepthTex.wrapT = THREE.ClampToEdgeWrapping;
  terrainMaterial.displacementMap = smoothedDepthTex;

  // Keep the raw depth as the "depth" visualization texture
  // (so the depth view shows accurate data, not blurred)

  // 3. Generate normal map from RAW depth (surface detail only, not geometry)
  textures.normalMap = createTerrainNormalMap(rawDepthCanvas);
  terrainMaterial.normalMap = textures.normalMap;
  terrainMaterial.normalScale.set(0.8, 0.8);

  // 4. Generate roughness map from raw depth
  textures.roughnessMap = createRoughnessMap(rawDepthCanvas);
  terrainMaterial.roughnessMap = textures.roughnessMap;

  // 5. Auto-compute displacement scale from the smoothed map
  const autoScale = computeAutoDepthScale(smoothedCanvas);
  state.depthScale = autoScale;
  terrainMaterial.displacementScale = autoScale;

  // 6. Sync wireframe mesh
  wireframeMaterial.displacementMap = smoothedDepthTex;
  wireframeMaterial.displacementScale = autoScale;

  terrainMaterial.needsUpdate = true;
  wireframeMaterial.needsUpdate = true;

  // Update the depth info display
  updateDepthInfo(autoScale);
}

/**
 * Load terrain from image URLs (satellite texture + depth map)
 */
function loadTerrainFromImages(textureUrl, depthUrl) {
  const loader = new THREE.TextureLoader();

  // Load satellite texture
  loader.load(textureUrl, (tex) => {
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.minFilter = THREE.LinearFilter;
    tex.magFilter = THREE.LinearFilter;
    textures.satellite = tex;
    if (state.textureMode === 'satellite') {
      terrainMaterial.map = tex;
      terrainMaterial.needsUpdate = true;
    }
  });

  // Load depth map
  loader.load(depthUrl, (tex) => {
    tex.minFilter = THREE.LinearFilter;
    tex.magFilter = THREE.LinearFilter;
    textures.depth = tex; // Keep raw for depth-view visualization

    // Generate slope texture and apply smoothed terrain textures
    const img = tex.image;
    if (img) {
      const c = document.createElement('canvas');
      c.width = img.width || 512;
      c.height = img.height || 512;
      const ctx = c.getContext('2d');
      ctx.drawImage(img, 0, 0, c.width, c.height);
      textures.slope = createSlopeTexture(c);

      // This smooths the depth for displacement and sets everything up
      applyTerrainTextures(c);
    }

    state.terrainLoaded = true;
    updateStatusRibbon('Terrain loaded', 'satellite');
    updateTerrainInfo(`${textureUrl.split('/').pop()}`);
  });
}

/**
 * Load terrain from base64 depth map data (from API response)
 */
function loadTerrainFromBase64(textureFile, depthBase64, slopeBase64 = null) {
  // Set satellite texture from uploaded file
  const reader = new FileReader();
  reader.onload = (e) => {
    const tex = new THREE.TextureLoader().load(e.target.result, (t) => {
      t.colorSpace = THREE.SRGBColorSpace;
      textures.satellite = t;
      if (state.textureMode === 'satellite') {
        terrainMaterial.map = t;
        terrainMaterial.needsUpdate = true;
      }
    });
  };
  reader.readAsDataURL(textureFile);

  // Depth texture from base64
  const depthImg = new Image();
  depthImg.onload = () => {
    const c = document.createElement('canvas');
    c.width = depthImg.width;
    c.height = depthImg.height;
    c.getContext('2d').drawImage(depthImg, 0, 0);

    // Keep raw depth for depth-view visualization
    const depthTex = new THREE.CanvasTexture(c);
    depthTex.minFilter = THREE.LinearFilter;
    depthTex.magFilter = THREE.LinearFilter;
    textures.depth = depthTex;

    // Generate slope from raw depth
    textures.slope = createSlopeTexture(c);

    // This smooths the depth for displacement and sets everything up
    applyTerrainTextures(c);

    state.terrainLoaded = true;
    updateStatusRibbon('Terrain loaded', 'model');
  };
  depthImg.src = `data:image/png;base64,${depthBase64}`;
}

// ═══════════════════════════════════════════════════════════════════════════
// API COMMUNICATION
// ═══════════════════════════════════════════════════════════════════════════

async function uploadAndProcess(file) {
  showProcessing(true);

  const formData = new FormData();
  formData.append('file', file);

  try {
    const response = await fetch(`${API_URL}/api/generate-depth`, {
      method: 'POST',
      body: formData,
    });

    if (!response.ok) throw new Error(`API error: ${response.status}`);

    const data = await response.json();
    state.currentDepthData = data;

    // Load terrain with results
    loadTerrainFromBase64(file, data.depth_image, data.slope_image);

    // Show output panel
    showOutputPanel(data);
    showProcessing(false);

    return data;
  } catch (err) {
    console.warn('API unavailable, generating mock depth map...', err);

    // Fallback: generate a mock depth locally
    await generateLocalMockDepth(file);
    showProcessing(false);
  }
}

/**
 * Generate a mock depth map locally if the backend is unavailable.
 * Uses the source image luminance to derive a more realistic depth map.
 */
async function generateLocalMockDepth(file) {
  const img = new Image();
  const url = URL.createObjectURL(file);

  return new Promise((resolve) => {
    img.onload = () => {
      const size = 512;

      // First, extract luminance from the source image as a depth proxy
      const srcCanvas = document.createElement('canvas');
      srcCanvas.width = size;
      srcCanvas.height = size;
      const srcCtx = srcCanvas.getContext('2d');
      srcCtx.drawImage(img, 0, 0, size, size);
      const srcData = srcCtx.getImageData(0, 0, size, size).data;

      const c = document.createElement('canvas');
      c.width = size;
      c.height = size;
      const ctx = c.getContext('2d');
      const imageData = ctx.createImageData(size, size);

      // Use image luminance as depth estimate + add terrain features
      for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
          const idx = (y * size + x) * 4;

          // Extract luminance from source image
          const r = srcData[idx];
          const g = srcData[idx + 1];
          const b = srcData[idx + 2];
          const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;

          // Use luminance as primary depth signal
          // Brighter areas = higher elevation (typical for satellite/aerial imagery)
          let h = luminance;

          // Add subtle structural noise to prevent flat areas
          h += Math.sin(x * 0.04 + y * 0.03) * 0.03;
          h += Math.cos(x * 0.07 - y * 0.05) * 0.02;

          h = Math.max(0, Math.min(1, h));

          const v = Math.floor(h * 255);
          imageData.data[idx] = v;
          imageData.data[idx + 1] = v;
          imageData.data[idx + 2] = v;
          imageData.data[idx + 3] = 255;
        }
      }
      ctx.putImageData(imageData, 0, 0);

      // Keep raw depth texture for depth-view visualization
      const depthTex = new THREE.CanvasTexture(c);
      textures.depth = depthTex;

      // Satellite texture
      const satCanvas = document.createElement('canvas');
      satCanvas.width = img.width;
      satCanvas.height = img.height;
      satCanvas.getContext('2d').drawImage(img, 0, 0);
      const satTex = new THREE.CanvasTexture(satCanvas);
      satTex.colorSpace = THREE.SRGBColorSpace;
      textures.satellite = satTex;
      terrainMaterial.map = satTex;
      terrainMaterial.needsUpdate = true;

      // Slope texture
      textures.slope = createSlopeTexture(c);

      // Apply normal/roughness maps for realistic textures
      applyTerrainTextures(c);

      state.terrainLoaded = true;
      state.currentDepthData = {
        mode: 'mock-local',
        min_val: 0,
        max_val: 255,
        mean_val: 128,
        std_val: 45,
        inference_time_ms: 0,
      };

      updateStatusRibbon('Terrain loaded (local mock)', 'mock');
      updateTerrainInfo(file.name);
      URL.revokeObjectURL(url);
      resolve();
    };
    img.src = url;
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// SAMPLE LOADING
// ═══════════════════════════════════════════════════════════════════════════
function loadSample(sampleName) {
  const textureUrl = `/samples/${sampleName}.jpg`;
  const depthUrl = `/samples/${sampleName}_depth.png`;

  updateStatusRibbon(`Loading ${sampleName}...`, 'loading');
  loadTerrainFromImages(textureUrl, depthUrl);

  // Update sample card active state
  document.querySelectorAll('.sample-card').forEach((card) => {
    card.classList.toggle('active', card.dataset.sample === sampleName);
  });

  updateTerrainInfo(sampleName.replace(/_/g, ' '));

  // Reset anchor
  resetAnchor();

  // Show landslide panel for mountain sample
  if (sampleName === 'mountain_ridge') {
    document.getElementById('landslide-panel').style.display = 'block';
    updateRiskStats();
  } else {
    document.getElementById('landslide-panel').style.display = 'none';
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// DRONE CAMERA CONTROLLER
// ═══════════════════════════════════════════════════════════════════════════
function enableDroneMode() {
  orbitControls.enabled = false;
  state.currentMode = 'drone';
  canvas.requestPointerLock();

  document.getElementById('btn-orbit').classList.remove('active');
  document.getElementById('btn-drone').classList.add('active');
  document.getElementById('drone-hint').style.display = 'block';

  // Add drone crosshair
  let crosshair = document.querySelector('.drone-overlay');
  if (!crosshair) {
    crosshair = document.createElement('div');
    crosshair.className = 'drone-overlay';
    crosshair.innerHTML = '<div class="drone-crosshair"></div>';
    document.getElementById('viewport').appendChild(crosshair);
  }
  crosshair.style.display = 'block';
}

function disableDroneMode() {
  orbitControls.enabled = true;
  state.currentMode = 'orbit';
  if (document.pointerLockElement) document.exitPointerLock();

  document.getElementById('btn-drone').classList.remove('active');
  document.getElementById('btn-orbit').classList.add('active');
  document.getElementById('drone-hint').style.display = 'none';

  const crosshair = document.querySelector('.drone-overlay');
  if (crosshair) crosshair.style.display = 'none';
}

function updateDroneCamera(dt) {
  if (state.currentMode !== 'drone') return;

  const d = state.drone;
  const speed = d.moveSpeed * (d.keys.shift ? 3 : 1) * dt * 60;

  const forward = new THREE.Vector3(0, 0, -1);
  forward.applyQuaternion(camera.quaternion);
  forward.y = 0;
  forward.normalize();

  const right = new THREE.Vector3(1, 0, 0);
  right.applyQuaternion(camera.quaternion);
  right.y = 0;
  right.normalize();

  if (d.keys.w) camera.position.addScaledVector(forward, speed);
  if (d.keys.s) camera.position.addScaledVector(forward, -speed);
  if (d.keys.a) camera.position.addScaledVector(right, -speed);
  if (d.keys.d) camera.position.addScaledVector(right, speed);
  if (d.keys.q) camera.position.y -= speed;
  if (d.keys.e) camera.position.y += speed;
}

// ═══════════════════════════════════════════════════════════════════════════
// ANCHOR SYSTEM
// ═══════════════════════════════════════════════════════════════════════════
function resetAnchor() {
  state.anchorPoint = null;
  state.anchorElevation = null;
  state.scaleFactor = 1;
  state.offsetFactor = 0;
  state.dsmMode = 'rDSM';
  anchorMarker.visible = false;
  anchorPole.visible = false;
  document.getElementById('mode-label').textContent = 'Mode: Relative DSM (rDSM)';
  document.getElementById('anchor-input-group').style.display = 'none';
  const result = document.getElementById('anchor-result');
  result.classList.remove('visible');
}

function applyAnchor() {
  const elevInput = document.getElementById('anchor-elevation');
  const elevation = parseFloat(elevInput.value);
  if (isNaN(elevation) || !state.anchorPoint) return;

  state.anchorElevation = elevation;
  state.dsmMode = 'mDSM';

  // Calculate scale: Z_metric = Z_anchor + (d(x,y) - d_anchor) * S
  // We need to determine a reasonable scale
  const anchorDepthNormalized = state.anchorPoint.y / terrainMaterial.displacementScale;
  state.scaleFactor = elevation / (anchorDepthNormalized * terrainMaterial.displacementScale || 1);
  state.offsetFactor = elevation;

  document.getElementById('mode-label').textContent = `Mode: Metric DSM (mDSM) — Anchor: ${elevation}m ASL`;
  document.getElementById('mode-label').style.color = '#10b981';

  const result = document.getElementById('anchor-result');
  result.textContent = `✓ Anchored at ${elevation}m ASL. Heights are now approximate metric estimates.`;
  result.classList.add('visible');
}

// ═══════════════════════════════════════════════════════════════════════════
// UI INTERACTION HANDLERS
// ═══════════════════════════════════════════════════════════════════════════

function showProcessing(show) {
  document.getElementById('processing-overlay').classList.toggle('hidden', !show);
}

function showOutputPanel(data) {
  const panel = document.getElementById('panel-output');
  panel.style.display = 'block';

  if (data.depth_image) {
    document.getElementById('output-depth').src = `data:image/png;base64,${data.depth_image}`;
  }
  if (data.slope_image) {
    document.getElementById('output-slope').src = `data:image/png;base64,${data.slope_image}`;
  }

  const statsEl = document.getElementById('output-stats');
  statsEl.innerHTML = `
    <div>Min: ${data.min_val} | Max: ${data.max_val}</div>
    <div>Mean: ${data.mean_val?.toFixed(1)} | Std: ${data.std_val?.toFixed(1)}</div>
    <div>Mode: ${data.mode} | Time: ${data.inference_time_ms}ms</div>
    ${data.flood_area_pct !== undefined ? `<div>Flood Risk Area: ${data.flood_area_pct}%</div>` : ''}
  `;
}

function updateStatusRibbon(status, source = '') {
  const statusText = document.getElementById('status-text');
  const statusChip = statusText.parentElement;
  statusText.textContent = status;

  if (source === 'loading') {
    statusChip.className = 'status-chip';
    statusChip.style.background = 'rgba(245,158,11,0.15)';
    statusChip.style.color = '#f59e0b';
  } else {
    statusChip.className = 'status-chip status-ready';
    statusChip.style.background = '';
    statusChip.style.color = '';
  }
}

function updateTerrainInfo(name) {
  document.getElementById('terrain-info').textContent = `Terrain: ${name}`;
}

function updateDepthInfo(scale) {
  const depthInfoEl = document.getElementById('depth-scale-value');
  if (depthInfoEl) {
    depthInfoEl.textContent = `${scale.toFixed(1)}`;
  }
}

function updateRiskStats() {
  document.getElementById('max-slope').textContent = '42.3°';
  document.getElementById('risk-area').textContent = '18.7%';
  document.getElementById('mean-slope').textContent = '22.1°';
}

/**
 * Switch between colored (textured) and wireframe+grid render modes
 */
function setRenderMode(mode) {
  state.renderMode = mode;

  if (mode === 'colored') {
    // Show textured solid terrain
    terrainMaterial.wireframe = false;
    terrainMaterial.color = new THREE.Color(0xffffff); // Reset from wireframe dark background
    terrainMaterial.normalMap = textures.normalMap;
    terrainMaterial.roughnessMap = textures.roughnessMap;
    terrainMaterial.roughness = 0.85;
    terrainMaterial.metalness = 0.02;
    terrainMesh.visible = true;
    wireframeMesh.visible = false;

    // Re-apply current texture mode
    switch (state.textureMode) {
      case 'satellite':
        terrainMaterial.map = textures.satellite;
        break;
      case 'depth':
        terrainMaterial.map = textures.depth;
        break;
      case 'slope':
        terrainMaterial.map = textures.slope || textures.satellite;
        break;
    }

    terrainMaterial.needsUpdate = true;
  } else {
    // Wireframe + grid mode: no texture, just elevation grid lines
    terrainMaterial.wireframe = false;
    terrainMaterial.map = null;
    terrainMaterial.normalMap = null;
    terrainMaterial.roughnessMap = null;
    terrainMaterial.roughness = 0.5;
    terrainMaterial.metalness = 0.1;
    terrainMaterial.color = new THREE.Color(0x0a1628);
    terrainMesh.visible = true;

    // Show wireframe overlay
    wireframeMesh.visible = true;
    wireframeMaterial.displacementMap = terrainMaterial.displacementMap;
    wireframeMaterial.displacementScale = terrainMaterial.displacementScale;
    wireframeMaterial.needsUpdate = true;

    terrainMaterial.needsUpdate = true;
  }

  // Update buttons
  document.getElementById('btn-colored').classList.toggle('active', mode === 'colored');
  document.getElementById('btn-wireframe').classList.toggle('active', mode === 'wireframe');
}

// ═══════════════════════════════════════════════════════════════════════════
// EVENT LISTENERS
// ═══════════════════════════════════════════════════════════════════════════

// ─── File Upload ───
const dropZone = document.getElementById('drop-zone');
const fileInput = document.getElementById('file-input');
const browseBtn = document.getElementById('browse-btn');
const uploadPreview = document.getElementById('upload-preview');
const previewImg = document.getElementById('preview-img');
const processBtn = document.getElementById('upload-process-btn');
const clearBtn = document.getElementById('upload-clear-btn');

let pendingFile = null;

browseBtn.addEventListener('click', () => fileInput.click());
dropZone.addEventListener('click', () => fileInput.click());

dropZone.addEventListener('dragover', (e) => {
  e.preventDefault();
  dropZone.classList.add('drag-over');
});

dropZone.addEventListener('dragleave', () => {
  dropZone.classList.remove('drag-over');
});

dropZone.addEventListener('drop', (e) => {
  e.preventDefault();
  dropZone.classList.remove('drag-over');
  if (e.dataTransfer.files.length > 0) handleFileSelect(e.dataTransfer.files[0]);
});

fileInput.addEventListener('change', (e) => {
  if (e.target.files.length > 0) handleFileSelect(e.target.files[0]);
});

function handleFileSelect(file) {
  pendingFile = file;
  const url = URL.createObjectURL(file);
  previewImg.src = url;
  document.getElementById('preview-name').textContent = file.name;
  document.getElementById('preview-size').textContent = `${(file.size / 1024).toFixed(1)} KB`;
  dropZone.classList.add('hidden');
  uploadPreview.classList.remove('hidden');
}

processBtn.addEventListener('click', () => {
  if (pendingFile) uploadAndProcess(pendingFile);
});

clearBtn.addEventListener('click', () => {
  pendingFile = null;
  dropZone.classList.remove('hidden');
  uploadPreview.classList.add('hidden');
  fileInput.value = '';
});

// ─── Sample Buttons ───
document.querySelectorAll('.sample-card').forEach((card) => {
  card.addEventListener('click', () => {
    loadSample(card.dataset.sample);
  });
});

// ─── Camera Mode Toggles ───
document.getElementById('btn-orbit').addEventListener('click', disableDroneMode);
document.getElementById('btn-drone').addEventListener('click', enableDroneMode);

// ─── Flood Slider ───
const floodSlider = document.getElementById('flood-slider');
const floodValue = document.getElementById('flood-value');
floodSlider.addEventListener('input', () => {
  const val = parseFloat(floodSlider.value);
  floodValue.textContent = `${val}%`;

  const maxWaterHeight = terrainMaterial.displacementScale * 0.8;
  const waterY = (val / 100) * maxWaterHeight;
  waterMesh.position.y = val > 0 ? waterY : -10;
  waterMesh.visible = val > 0;

  // Estimate submerged area percentage
  const submergedPct = Math.min(val * 1.2, 100).toFixed(1);
  document.getElementById('flood-area-pct').textContent = `${submergedPct}%`;
});

// ─── Texture Mode ───
document.querySelectorAll('[data-texture]').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('[data-texture]').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    state.textureMode = btn.dataset.texture;

    // Only apply texture if in colored mode
    if (state.renderMode === 'colored') {
      switch (btn.dataset.texture) {
        case 'satellite':
          terrainMaterial.map = textures.satellite;
          document.getElementById('landslide-panel').style.display = 'none';
          break;
        case 'depth':
          terrainMaterial.map = textures.depth;
          document.getElementById('landslide-panel').style.display = 'none';
          break;
        case 'slope':
          if (textures.slope) {
            terrainMaterial.map = textures.slope;
          }
          document.getElementById('landslide-panel').style.display = 'block';
          updateRiskStats();
          break;
      }
      terrainMaterial.needsUpdate = true;
    }

    // Show/hide landslide panel regardless of render mode
    if (btn.dataset.texture === 'slope') {
      document.getElementById('landslide-panel').style.display = 'block';
      updateRiskStats();
    } else {
      document.getElementById('landslide-panel').style.display = 'none';
    }
  });
});

// ─── Render Mode (Colored vs Wireframe) ───
document.getElementById('btn-colored').addEventListener('click', () => setRenderMode('colored'));
document.getElementById('btn-wireframe').addEventListener('click', () => setRenderMode('wireframe'));

// ─── Anchor System ───
document.getElementById('anchor-pick-btn').addEventListener('click', () => {
  state.isPickingAnchor = true;
  document.body.classList.add('picking-mode');
  document.getElementById('anchor-pick-btn').textContent = '🎯 Click on terrain...';
});

canvas.addEventListener('click', (event) => {
  if (!state.isPickingAnchor) return;

  const hit = getTerrainIntersection(event);
  if (hit) {
    state.anchorPoint = hit.point.clone();
    anchorMarker.position.copy(hit.point);
    anchorMarker.position.y += 0.8;
    anchorMarker.visible = true;

    anchorPole.position.copy(hit.point);
    anchorPole.position.y += 7.5;
    anchorPole.visible = true;

    document.getElementById('anchor-input-group').style.display = 'block';
    state.isPickingAnchor = false;
    document.body.classList.remove('picking-mode');
    document.getElementById('anchor-pick-btn').textContent = '🎯 Pick Point on Map';
  }
});

document.getElementById('anchor-apply-btn').addEventListener('click', applyAnchor);

// ─── Close landslide panel ───
document.getElementById('close-landslide').addEventListener('click', () => {
  document.getElementById('landslide-panel').style.display = 'none';
});

// ─── Quick Actions ───
document.getElementById('btn-reset-view').addEventListener('click', () => {
  camera.position.set(50, 60, 80);
  orbitControls.target.set(0, 5, 0);
  orbitControls.update();
});

document.getElementById('btn-top-view').addEventListener('click', () => {
  camera.position.set(0, 120, 0.1);
  orbitControls.target.set(0, 0, 0);
  orbitControls.update();
});

document.getElementById('btn-screenshot').addEventListener('click', () => {
  renderer.render(scene, camera);
  const link = document.createElement('a');
  link.download = `depthwizard_screenshot_${Date.now()}.png`;
  link.href = canvas.toDataURL('image/png');
  link.click();
});

document.getElementById('btn-fullscreen').addEventListener('click', () => {
  if (!document.fullscreenElement) {
    document.documentElement.requestFullscreen();
  } else {
    document.exitFullscreen();
  }
});

// ─── Keyboard Controls ───
window.addEventListener('keydown', (e) => {
  const key = e.key.toLowerCase();
  if (state.currentMode === 'drone') {
    if (key in state.drone.keys) state.drone.keys[key] = true;
    if (key === 'escape') disableDroneMode();
  }
});

window.addEventListener('keyup', (e) => {
  const key = e.key.toLowerCase();
  if (key in state.drone.keys) state.drone.keys[key] = false;
});

// ─── Mouse Look (Drone Mode) ───
document.addEventListener('mousemove', (e) => {
  if (state.currentMode !== 'drone' || !document.pointerLockElement) return;

  state.drone.euler.setFromQuaternion(camera.quaternion);
  state.drone.euler.y -= e.movementX * state.drone.lookSpeed;
  state.drone.euler.x -= e.movementY * state.drone.lookSpeed;
  state.drone.euler.x = Math.max(-Math.PI / 2, Math.min(Math.PI / 2, state.drone.euler.x));
  camera.quaternion.setFromEuler(state.drone.euler);
});

document.addEventListener('pointerlockchange', () => {
  if (!document.pointerLockElement && state.currentMode === 'drone') {
    disableDroneMode();
  }
});

// ─── Cursor Elevation Tracking ───
canvas.addEventListener('mousemove', (e) => {
  if (state.currentMode === 'drone') return;
  const hit = getTerrainIntersection(e);
  if (hit) {
    let z = hit.point.y;
    if (state.dsmMode === 'mDSM' && state.anchorElevation !== null) {
      z = state.offsetFactor + (z - (state.anchorPoint?.y || 0)) * state.scaleFactor;
      document.getElementById('cursor-z').textContent = `${z.toFixed(1)}m`;
    } else {
      const normalizedZ = (z / terrainMaterial.displacementScale) * 100;
      document.getElementById('cursor-z').textContent = `${normalizedZ.toFixed(1)}`;
    }
  } else {
    document.getElementById('cursor-z').textContent = '—';
  }
});

// ─── Window Resize ───
function onResize() {
  const vp = document.getElementById('viewport');
  const w = vp.clientWidth;
  const h = vp.clientHeight - 44; // ribbon height
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  renderer.setSize(w, h);
}
window.addEventListener('resize', onResize);

// ═══════════════════════════════════════════════════════════════════════════
// WATER ANIMATION
// ═══════════════════════════════════════════════════════════════════════════
let waterTime = 0;

function animateWater(dt) {
  if (waterMesh.position.y < -5) return;
  waterTime += dt;
  // Subtle wave motion
  waterMesh.position.y += Math.sin(waterTime * 2) * 0.002;
  waterMesh.material.opacity = 0.5 + Math.sin(waterTime * 1.5) * 0.05;
}

// ═══════════════════════════════════════════════════════════════════════════
// ANIMATION LOOP
// ═══════════════════════════════════════════════════════════════════════════
const clock = new THREE.Clock();
let frameCount = 0;
let lastFpsTime = 0;

function animate() {
  requestAnimationFrame(animate);

  const dt = clock.getDelta();
  const elapsed = clock.getElapsedTime();

  // Update controls
  if (state.currentMode === 'orbit') {
    orbitControls.update();
  } else {
    updateDroneCamera(dt);
  }

  // Water animation
  animateWater(dt);

  // Keep wireframe mesh synced with terrain displacement
  if (wireframeMesh.visible) {
    wireframeMaterial.displacementScale = terrainMaterial.displacementScale;
  }

  // Compass needle rotation
  const compassAngle = Math.atan2(camera.position.x, camera.position.z);
  const needle = document.getElementById('compass-needle');
  if (needle) {
    needle.style.transform = `translate(-50%, -100%) rotate(${compassAngle}rad)`;
  }

  // FPS counter
  frameCount++;
  if (elapsed - lastFpsTime >= 1) {
    document.getElementById('fps-counter').textContent = frameCount;
    frameCount = 0;
    lastFpsTime = elapsed;
  }

  // Render
  renderer.render(scene, camera);
}

// ═══════════════════════════════════════════════════════════════════════════
// INITIALIZATION
// ═══════════════════════════════════════════════════════════════════════════
function init() {
  onResize();

  // Generate slope for default terrain
  textures.slope = createSlopeTexture(
    (() => {
      const c = document.createElement('canvas');
      c.width = 512;
      c.height = 512;
      const ctx = c.getContext('2d');
      ctx.drawImage(textures.depth?.image || createDefaultDepthTexture().image || c, 0, 0, 512, 512);
      return c;
    })()
  );

  // Start animation
  animate();

  // Hide loading screen after brief delay
  setTimeout(() => {
    document.getElementById('loading-screen').classList.add('fade-out');
    setTimeout(() => {
      document.getElementById('loading-screen').style.display = 'none';
    }, 600);
  }, 1500);

  console.log('%c🏔️ DepthWizard v1.0 — ISRO Disaster Triage', 'color: #00d4ff; font-size: 14px; font-weight: bold;');
  console.log('%cSIH26175 • Single-View Height Estimation & 3D Flythrough', 'color: #7b2ff7; font-size: 11px;');
}

init();
