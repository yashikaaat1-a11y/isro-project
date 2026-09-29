// CPU-side model of the relative depth map: sampling, derivatives, stats and
// every texture layer the renderer needs (hypsometric, slope risk, normals,
// contours). Heights are stored as 0-255 and exposed as 0-100 "relative units".

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const lerp = (a, b, t) => a + (b - a) * t;

export const HAZARD_STOPS = [
  { t: 0.0, c: [22, 163, 74], label: 'Stable' },
  { t: 0.27, c: [132, 204, 22], label: 'Gentle' },
  { t: 0.55, c: [250, 204, 21], label: 'Moderate' },
  { t: 0.78, c: [249, 115, 22], label: 'Steep' },
  { t: 1.0, c: [220, 38, 38], label: 'Critical' },
];

export const HYPSO_STOPS = [
  { t: 0.0, c: [20, 83, 107] },
  { t: 0.12, c: [38, 128, 94] },
  { t: 0.3, c: [110, 170, 80] },
  { t: 0.5, c: [214, 200, 110] },
  { t: 0.68, c: [190, 130, 70] },
  { t: 0.85, c: [140, 96, 80] },
  { t: 1.0, c: [248, 248, 252] },
];

export function rampColor(stops, t) {
  t = clamp(t, 0, 1);
  for (let i = 1; i < stops.length; i++) {
    if (t <= stops[i].t) {
      const a = stops[i - 1], b = stops[i];
      const k = (t - a.t) / (b.t - a.t || 1);
      return [lerp(a.c[0], b.c[0], k), lerp(a.c[1], b.c[1], k), lerp(a.c[2], b.c[2], k)];
    }
  }
  return stops[stops.length - 1].c;
}

// Slope thresholds (degrees) used for landslide susceptibility once the map is
// metrically anchored. Loosely follows common GSI/NDMA susceptibility classes.
export const SLOPE_DEG_CLASSES = [
  { max: 15, label: 'Stable', t: 0.0 },
  { max: 25, label: 'Gentle', t: 0.27 },
  { max: 35, label: 'Moderate', t: 0.55 },
  { max: 45, label: 'Steep', t: 0.78 },
  { max: 90, label: 'Critical', t: 1.0 },
];

export class HeightField {
  /** @param {Uint8ClampedArray|Uint8Array} data single channel 0-255 */
  constructor(data, width, height, origWidth = width) {
    this.w = width;
    this.h = height;
    this.data = data;
    this.origWidth = origWidth;
    this._computeSlope();
    this._computeStats();
  }

  static fromImage(img, origWidth) {
    const maxSide = 768;
    const s = Math.min(1, maxSide / Math.max(img.width, img.height));
    const w = Math.max(2, Math.round(img.width * s));
    const h = Math.max(2, Math.round(img.height * s));
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    const ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(img, 0, 0, w, h);
    const rgba = ctx.getImageData(0, 0, w, h).data;
    const d = new Uint8Array(w * h);
    for (let i = 0; i < w * h; i++) d[i] = rgba[i * 4];
    return new HeightField(d, w, h, origWidth ?? img.width);
  }

  /** Browser-side fallback when the API is unreachable: blurred luminance. */
  static heuristicFromImage(img) {
    const w = 256, h = Math.max(2, Math.round(256 * img.height / img.width));
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    const ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.filter = 'blur(3px)';
    ctx.drawImage(img, 0, 0, w, h);
    const rgba = ctx.getImageData(0, 0, w, h).data;
    const lum = new Float32Array(w * h);
    let lo = 1e9, hi = -1e9;
    for (let i = 0; i < w * h; i++) {
      const v = 0.3 * rgba[i * 4] + 0.59 * rgba[i * 4 + 1] + 0.11 * rgba[i * 4 + 2];
      lum[i] = v; lo = Math.min(lo, v); hi = Math.max(hi, v);
    }
    const d = new Uint8Array(w * h);
    for (let i = 0; i < w * h; i++) d[i] = Math.round(((lum[i] - lo) / (hi - lo || 1)) * 255);
    return new HeightField(d, w, h, img.width);
  }

  at(x, y) {
    x = clamp(x | 0, 0, this.w - 1);
    y = clamp(y | 0, 0, this.h - 1);
    return this.data[y * this.w + x];
  }

  /** Bilinear sample, u/v in [0,1] with v=0 at the top row. Returns 0-255. */
  sample(u, v) {
    const x = clamp(u, 0, 1) * (this.w - 1);
    const y = clamp(v, 0, 1) * (this.h - 1);
    const x0 = Math.floor(x), y0 = Math.floor(y);
    const x1 = Math.min(x0 + 1, this.w - 1), y1 = Math.min(y0 + 1, this.h - 1);
    const fx = x - x0, fy = y - y0;
    const d = this.data, w = this.w;
    const a = lerp(d[y0 * w + x0], d[y0 * w + x1], fx);
    const b = lerp(d[y1 * w + x0], d[y1 * w + x1], fx);
    return lerp(a, b, fy);
  }

  slopeAt(u, v) {
    const x = clamp(Math.round(u * (this.w - 1)), 0, this.w - 1);
    const y = clamp(Math.round(v * (this.h - 1)), 0, this.h - 1);
    return this.grad[y * this.w + x];
  }

  _computeSlope() {
    const { w, h, data } = this;
    const g = new Float32Array(w * h);
    const px = (x, y) => data[clamp(y, 0, h - 1) * w + clamp(x, 0, w - 1)];
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const gx = (px(x + 1, y - 1) + 2 * px(x + 1, y) + px(x + 1, y + 1)
          - px(x - 1, y - 1) - 2 * px(x - 1, y) - px(x - 1, y + 1)) / 8;
        const gy = (px(x - 1, y + 1) + 2 * px(x, y + 1) + px(x + 1, y + 1)
          - px(x - 1, y - 1) - 2 * px(x, y - 1) - px(x + 1, y - 1)) / 8;
        g[y * w + x] = Math.hypot(gx, gy); // 0-255 height units per depth pixel
      }
    }
    this.grad = g;
    const sorted = Float32Array.from(g).sort();
    this.gradP99 = sorted[Math.floor(sorted.length * 0.99)] || 1;
  }

  _computeStats() {
    const hist = new Uint32Array(256);
    let sum = 0;
    for (let i = 0; i < this.data.length; i++) { hist[this.data[i]]++; sum += this.data[i]; }
    this.hist = hist;
    this.cdf = new Float64Array(256);
    let acc = 0;
    for (let i = 0; i < 256; i++) { acc += hist[i]; this.cdf[i] = acc / this.data.length; }
    const pct = (p) => { for (let i = 0; i < 256; i++) if (this.cdf[i] >= p) return i; return 255; };
    let steep = 0;
    for (let i = 0; i < this.grad.length; i++) if (this.grad[i] / this.gradP99 >= 0.78) steep++;
    this.stats = {
      mean: (sum / this.data.length) / 2.55,
      p05: pct(0.05) / 2.55,
      p50: pct(0.5) / 2.55,
      p95: pct(0.95) / 2.55,
      dynamicRange: (pct(0.95) - pct(0.05)) / 2.55,
      steepFraction: steep / this.grad.length,
    };
  }

  /** Fraction of the tile at or below a relative level (0-100). */
  floodFraction(level100) {
    const i = clamp(Math.floor(level100 * 2.55), -1, 255);
    return i < 0 ? 0 : this.cdf[i];
  }

  /** Stored-water volume in (relative-unit x pixel) for a level, used for m^3 when anchored. */
  floodVolumeUnits(level100) {
    const L = level100 * 2.55;
    let v = 0;
    for (let i = 0; i < 256 && i < L; i++) v += this.hist[i] * (L - i);
    return v / 2.55;
  }

  /** Ground distance covered by one depth pixel (m), given original-image GSD. */
  groundPerPixel(gsd) {
    return gsd * (this.origWidth / this.w);
  }

  /** Slope in degrees when metric calibration (S m/unit) and GSD are known. */
  slopeDegrees(u, v, S, gsd) {
    const riseM = (this.slopeAt(u, v) / 2.55) * S;
    return (Math.atan2(riseM, this.groundPerPixel(gsd)) * 180) / Math.PI;
  }

  // ------------------------------------------------------------------ layers

  _canvas(w = this.w, h = this.h) {
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    return c;
  }

  depthCanvas() {
    const c = this._canvas();
    const ctx = c.getContext('2d');
    const img = ctx.createImageData(this.w, this.h);
    for (let i = 0; i < this.data.length; i++) {
      const v = this.data[i];
      img.data[i * 4] = img.data[i * 4 + 1] = img.data[i * 4 + 2] = v;
      img.data[i * 4 + 3] = 255;
    }
    ctx.putImageData(img, 0, 0);
    return c;
  }

  _hillshade(i, x, y) {
    const { w, h, data } = this;
    const l = data[y * w + Math.max(x - 1, 0)], r = data[y * w + Math.min(x + 1, w - 1)];
    const t = data[Math.max(y - 1, 0) * w + x], b = data[Math.min(y + 1, h - 1) * w + x];
    const k = 2.2 * (w / 256);
    const nx = (l - r) * k / 255, ny = (t - b) * k / 255;
    const inv = 1 / Math.hypot(nx, ny, 1);
    return clamp((nx * -0.6 + ny * -0.6 + 0.55) * inv + 0.35, 0.25, 1.25);
  }

  hypsoCanvas() {
    const c = this._canvas();
    const ctx = c.getContext('2d');
    const img = ctx.createImageData(this.w, this.h);
    for (let y = 0; y < this.h; y++) {
      for (let x = 0; x < this.w; x++) {
        const i = y * this.w + x;
        const col = rampColor(HYPSO_STOPS, this.data[i] / 255);
        const s = this._hillshade(i, x, y);
        img.data[i * 4] = col[0] * s;
        img.data[i * 4 + 1] = col[1] * s;
        img.data[i * 4 + 2] = col[2] * s;
        img.data[i * 4 + 3] = 255;
      }
    }
    ctx.putImageData(img, 0, 0);
    return c;
  }

  /**
   * Landslide-risk false colour. Relative mode ranks by the 99th-percentile
   * gradient; metric mode uses real slope-angle classes.
   */
  slopeCanvas(metric = null) {
    const c = this._canvas();
    const ctx = c.getContext('2d');
    const img = ctx.createImageData(this.w, this.h);
    const gpp = metric ? this.groundPerPixel(metric.gsd) : 1;
    for (let y = 0; y < this.h; y++) {
      for (let x = 0; x < this.w; x++) {
        const i = y * this.w + x;
        let t;
        if (metric) {
          const deg = Math.atan2((this.grad[i] / 2.55) * metric.S, gpp) * 57.2958;
          const cls = SLOPE_DEG_CLASSES.findIndex((k) => deg < k.max);
          const lo = cls > 0 ? SLOPE_DEG_CLASSES[cls - 1].max : 0;
          const k = (deg - lo) / (SLOPE_DEG_CLASSES[cls].max - lo);
          const nextT = SLOPE_DEG_CLASSES[Math.min(cls + 1, 4)].t;
          t = lerp(SLOPE_DEG_CLASSES[cls].t, nextT, clamp(k, 0, 1) * 0.6);
        } else {
          t = this.grad[i] / this.gradP99;
        }
        const col = rampColor(HAZARD_STOPS, t);
        const s = 0.55 + 0.45 * this._hillshade(i, x, y);
        img.data[i * 4] = col[0] * s;
        img.data[i * 4 + 1] = col[1] * s;
        img.data[i * 4 + 2] = col[2] * s;
        img.data[i * 4 + 3] = 255;
      }
    }
    ctx.putImageData(img, 0, 0);
    return c;
  }

  /** Tangent-space normal map baked for a given world-space relief. */
  normalCanvas(worldReliefPerUnit255, planeWidth = 100) {
    const { w, h, data } = this;
    const c = this._canvas();
    const ctx = c.getContext('2d');
    const img = ctx.createImageData(w, h);
    const spacing = planeWidth / w;
    const k = worldReliefPerUnit255 / 255 / (2 * spacing);
    for (let y = 0; y < h; y++) {
      const yu = Math.max(y - 1, 0), yd = Math.min(y + 1, h - 1);
      for (let x = 0; x < w; x++) {
        const xl = Math.max(x - 1, 0), xr = Math.min(x + 1, w - 1);
        const dx = (data[y * w + xr] - data[y * w + xl]) * k;
        const dyUp = (data[yu * w + x] - data[yd * w + x]) * k; // image rows go down, +v goes up
        const inv = 1 / Math.hypot(dx, dyUp, 1);
        const i = (y * w + x) * 4;
        img.data[i] = (-dx * inv * 0.5 + 0.5) * 255;
        img.data[i + 1] = (-dyUp * inv * 0.5 + 0.5) * 255;
        img.data[i + 2] = (inv * 0.5 + 0.5) * 255;
        img.data[i + 3] = 255;
      }
    }
    ctx.putImageData(img, 0, 0);
    return c;
  }

  /**
   * Composite a base layer with optional contour lines at `outW` resolution.
   * step: contour interval in relative units (0-100).
   */
  composite(base, { contours = false, step = 5, outW = 1024 } = {}) {
    const outH = Math.round(outW * this.h / this.w);
    const c = this._canvas(outW, outH);
    const ctx = c.getContext('2d');
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(base, 0, 0, outW, outH);
    if (!contours) return c;
    const img = ctx.getImageData(0, 0, outW, outH);
    const band = new Int16Array(outW * outH);
    for (let y = 0; y < outH; y++) {
      for (let x = 0; x < outW; x++) {
        band[y * outW + x] = Math.floor(this.sample(x / (outW - 1), y / (outH - 1)) / 2.55 / step);
      }
    }
    for (let y = 0; y < outH - 1; y++) {
      for (let x = 0; x < outW - 1; x++) {
        const i = y * outW + x;
        const b = band[i];
        if (b !== band[i + 1] || b !== band[i + outW]) {
          const major = Math.max(b, band[i + 1], band[i + outW]) % 5 === 0;
          const a = major ? 0.85 : 0.45;
          const p = i * 4;
          const tone = major ? 255 : 240;
          img.data[p] = lerp(img.data[p], tone, a);
          img.data[p + 1] = lerp(img.data[p + 1], tone, a);
          img.data[p + 2] = lerp(img.data[p + 2], tone, a);
        }
      }
    }
    ctx.putImageData(img, 0, 0);
    return c;
  }
}
