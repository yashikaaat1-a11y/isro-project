import { HAZARD_STOPS, HYPSO_STOPS, SLOPE_DEG_CLASSES, rampColor } from './heightfield.js';

const css = (c) => `rgb(${c.map((v) => Math.round(v)).join(',')})`;

function fitCanvas(canvas) {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const w = canvas.clientWidth, h = canvas.clientHeight;
  if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
  }
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { ctx, w, h };
}

// ------------------------------------------------------------------ histogram

export function drawHistogram(canvas, field, level100, anchorD) {
  const { ctx, w, h } = fitCanvas(canvas);
  ctx.clearRect(0, 0, w, h);
  if (!field) return;
  const bins = 64, hist = new Float64Array(bins);
  for (let i = 0; i < 256; i++) hist[Math.floor(i / 4)] += field.hist[i];
  const max = Math.max(...hist) || 1;
  const bw = w / bins;
  for (let i = 0; i < bins; i++) {
    const v = Math.sqrt(hist[i] / max);
    const x = i * bw, bh = v * (h - 12);
    const under = (i + 0.5) / bins * 100 <= level100;
    const col = rampColor(HYPSO_STOPS, i / bins);
    ctx.fillStyle = under ? 'rgba(14,165,233,.95)' : `rgba(${col.map(Math.round).join(',')},.75)`;
    ctx.fillRect(x + 0.5, h - 12 - bh, Math.max(bw - 1, 1), bh);
  }
  if (level100 > 0) {
    const x = (level100 / 100) * w;
    ctx.fillStyle = 'rgba(14,165,233,.12)';
    ctx.fillRect(0, 0, x, h - 12);
    ctx.strokeStyle = '#38bdf8'; ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, h - 12); ctx.stroke();
  }
  if (anchorD != null) {
    const x = (anchorD / 100) * w;
    ctx.fillStyle = '#ff9933';
    ctx.beginPath(); ctx.moveTo(x, h - 12); ctx.lineTo(x - 4, h - 4); ctx.lineTo(x + 4, h - 4); ctx.fill();
  }
  ctx.fillStyle = '#64748b'; ctx.font = '9px JetBrains Mono, monospace';
  ctx.fillText('0', 1, h - 1);
  ctx.textAlign = 'right'; ctx.fillText('100', w - 1, h - 1);
  ctx.textAlign = 'center'; ctx.fillText('relative height', w / 2, h - 1);
  ctx.textAlign = 'left';
}

// -------------------------------------------------------------------- minimap

export class Minimap {
  constructor(canvas, onJump) {
    this.canvas = canvas;
    this.onJump = onJump;
    this.base = null;
    canvas.addEventListener('click', (ev) => {
      if (!this.rect) return;
      const r = canvas.getBoundingClientRect();
      const x = ev.clientX - r.left, y = ev.clientY - r.top;
      const u = (x - this.rect.x) / this.rect.w, v = (y - this.rect.y) / this.rect.h;
      if (u >= 0 && u <= 1 && v >= 0 && v <= 1) this.onJump(u, v);
    });
  }

  setLayer(src, field, level100) {
    this.src = src;
    this.field = field;
    this._mask(level100);
  }

  _mask(level100) {
    if (!this.field || level100 <= 0) { this.mask = null; return; }
    const f = this.field, n = 128;
    const mh = Math.max(2, Math.round(n * f.h / f.w));
    const c = document.createElement('canvas');
    c.width = n; c.height = mh;
    const ctx = c.getContext('2d');
    const img = ctx.createImageData(n, mh);
    const L = level100 * 2.55;
    for (let y = 0; y < mh; y++) for (let x = 0; x < n; x++) {
      const i = (y * n + x) * 4;
      if (f.sample(x / (n - 1), y / (mh - 1)) <= L) {
        img.data[i] = 14; img.data[i + 1] = 140; img.data[i + 2] = 233; img.data[i + 3] = 170;
      }
    }
    ctx.putImageData(img, 0, 0);
    this.mask = c;
  }

  setFlood(level100) { this._mask(level100); }

  draw(camUV, camYaw, marks = []) {
    const { ctx, w, h } = fitCanvas(this.canvas);
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = '#020617'; ctx.fillRect(0, 0, w, h);
    if (!this.src || !this.field) return;
    const a = this.field.h / this.field.w;
    const rw = a > 1 ? w / a : w, rh = a > 1 ? h : h * a;
    const rect = { x: (w - rw) / 2, y: (h - rh) / 2, w: rw, h: rh };
    this.rect = rect;
    ctx.drawImage(this.src, rect.x, rect.y, rect.w, rect.h);
    if (this.mask) { ctx.imageSmoothingEnabled = true; ctx.drawImage(this.mask, rect.x, rect.y, rect.w, rect.h); }
    ctx.strokeStyle = 'rgba(34,211,238,.6)'; ctx.lineWidth = 1;
    ctx.strokeRect(rect.x + 0.5, rect.y + 0.5, rect.w - 1, rect.h - 1);

    const P = (u, v) => [rect.x + u * rect.w, rect.y + v * rect.h];
    for (const m of marks) {
      if (m.type === 'line') {
        ctx.strokeStyle = '#22d3ee'; ctx.lineWidth = 2; ctx.setLineDash([4, 3]);
        ctx.beginPath(); ctx.moveTo(...P(m.a.u, m.a.v)); ctx.lineTo(...P(m.b.u, m.b.v)); ctx.stroke();
        ctx.setLineDash([]);
      } else {
        const [x, y] = P(m.u, m.v);
        ctx.fillStyle = m.color || '#ff9933';
        ctx.beginPath(); ctx.arc(x, y, 4, 0, Math.PI * 2); ctx.fill();
        ctx.strokeStyle = '#fff'; ctx.lineWidth = 1; ctx.stroke();
      }
    }
    if (camUV) {
      const [x, y] = P(Math.min(Math.max(camUV.u, -0.1), 1.1), Math.min(Math.max(camUV.v, -0.1), 1.1));
      ctx.save();
      ctx.translate(x, y);
      ctx.rotate(-camYaw);
      const g = ctx.createRadialGradient(0, 0, 0, 0, 0, 38);
      g.addColorStop(0, 'rgba(255,153,51,.45)'); g.addColorStop(1, 'rgba(255,153,51,0)');
      ctx.fillStyle = g;
      ctx.beginPath(); ctx.moveTo(0, 0); ctx.arc(0, 0, 38, -Math.PI / 2 - 0.45, -Math.PI / 2 + 0.45); ctx.closePath(); ctx.fill();
      ctx.fillStyle = '#ff9933';
      ctx.beginPath(); ctx.moveTo(0, -7); ctx.lineTo(5, 5); ctx.lineTo(0, 2.5); ctx.lineTo(-5, 5); ctx.closePath(); ctx.fill();
      ctx.restore();
    }
    ctx.fillStyle = 'rgba(226,232,240,.8)'; ctx.font = '600 10px Space Grotesk, sans-serif';
    ctx.fillText('N', w - 12, 14);
  }
}

// -------------------------------------------------------------------- profile

export class ProfileChart {
  constructor(canvas) {
    this.canvas = canvas;
    this.hover = null;
    canvas.addEventListener('mousemove', (ev) => {
      const r = canvas.getBoundingClientRect();
      this.hover = (ev.clientX - r.left) / r.width;
      this.draw();
    });
    canvas.addEventListener('mouseleave', () => { this.hover = null; this.draw(); });
  }

  /**
   * data: { samples: [rel 0-100], dist: total ground distance (m or px),
   *         distUnit, toElev: fn(rel)->display value, elevUnit, level: rel }
   */
  set(data) { this.data = data; this.draw(); }

  draw() {
    const { ctx, w, h } = fitCanvas(this.canvas);
    ctx.clearRect(0, 0, w, h);
    const d = this.data;
    if (!d) return;
    const pad = { l: 52, r: 12, t: 8, b: 20 };
    const iw = w - pad.l - pad.r, ih = h - pad.t - pad.b;
    const vals = d.samples.map(d.toElev);
    let lo = Math.min(...vals), hi = Math.max(...vals);
    const lvl = d.level > 0 ? d.toElev(d.level) : null;
    if (lvl != null) { lo = Math.min(lo, lvl); hi = Math.max(hi, lvl); }
    const span = hi - lo || 1;
    lo -= span * 0.08; hi += span * 0.12;
    const X = (i) => pad.l + (i / (vals.length - 1)) * iw;
    const Y = (v) => pad.t + (1 - (v - lo) / (hi - lo)) * ih;

    ctx.strokeStyle = 'rgba(148,163,184,.12)'; ctx.lineWidth = 1;
    ctx.fillStyle = '#64748b'; ctx.font = '10px JetBrains Mono, monospace'; ctx.textAlign = 'right';
    for (let k = 0; k <= 4; k++) {
      const v = lo + ((hi - lo) * k) / 4, y = Y(v);
      ctx.beginPath(); ctx.moveTo(pad.l, y); ctx.lineTo(w - pad.r, y); ctx.stroke();
      ctx.fillText(`${v.toFixed(Math.abs(hi - lo) < 10 ? 1 : 0)}`, pad.l - 6, y + 3);
    }
    ctx.save(); ctx.translate(10, pad.t + ih / 2); ctx.rotate(-Math.PI / 2); ctx.textAlign = 'center';
    ctx.fillText(d.elevUnit, 0, 0); ctx.restore();
    ctx.textAlign = 'left'; ctx.fillText('A', pad.l, h - 5);
    ctx.textAlign = 'right'; ctx.fillText(`B · ${d.dist.toFixed(d.dist < 10 ? 2 : 0)} ${d.distUnit}`, w - pad.r, h - 5);

    const grad = ctx.createLinearGradient(0, pad.t, 0, pad.t + ih);
    grad.addColorStop(0, 'rgba(255,153,51,.55)');
    grad.addColorStop(0.5, 'rgba(132,204,22,.3)');
    grad.addColorStop(1, 'rgba(22,163,74,.05)');
    ctx.beginPath(); ctx.moveTo(X(0), Y(lo));
    vals.forEach((v, i) => ctx.lineTo(X(i), Y(v)));
    ctx.lineTo(X(vals.length - 1), Y(lo)); ctx.closePath();
    ctx.fillStyle = grad; ctx.fill();

    if (lvl != null) {
      // Water body = region between the level line and terrain clipped to it.
      ctx.beginPath(); ctx.moveTo(X(0), Y(lvl));
      vals.forEach((v, i) => ctx.lineTo(X(i), Y(Math.min(v, lvl))));
      ctx.lineTo(X(vals.length - 1), Y(lvl)); ctx.closePath();
      ctx.fillStyle = 'rgba(0,119,190,.6)'; ctx.fill();
      ctx.strokeStyle = '#38bdf8'; ctx.setLineDash([5, 4]);
      ctx.beginPath(); ctx.moveTo(pad.l, Y(lvl)); ctx.lineTo(w - pad.r, Y(lvl)); ctx.stroke(); ctx.setLineDash([]);
    }

    ctx.beginPath();
    vals.forEach((v, i) => (i ? ctx.lineTo(X(i), Y(v)) : ctx.moveTo(X(i), Y(v))));
    ctx.strokeStyle = '#fbbf24'; ctx.lineWidth = 2; ctx.stroke();

    if (this.hover != null) {
      const px = this.hover * w;
      const i = Math.round(((px - pad.l) / iw) * (vals.length - 1));
      if (i >= 0 && i < vals.length) {
        const x = X(i), y = Y(vals[i]);
        ctx.strokeStyle = 'rgba(226,232,240,.5)'; ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(x, pad.t); ctx.lineTo(x, pad.t + ih); ctx.stroke();
        ctx.fillStyle = '#fff'; ctx.beginPath(); ctx.arc(x, y, 4, 0, Math.PI * 2); ctx.fill();
        const txt = `${vals[i].toFixed(1)} ${d.elevUnit} @ ${((i / (vals.length - 1)) * d.dist).toFixed(0)} ${d.distUnit}`;
        ctx.font = '11px JetBrains Mono, monospace';
        const tw = ctx.measureText(txt).width + 12;
        const tx = Math.min(Math.max(x - tw / 2, pad.l), w - pad.r - tw);
        ctx.fillStyle = 'rgba(5,11,24,.9)'; ctx.fillRect(tx, pad.t, tw, 18);
        ctx.fillStyle = '#e2e8f0'; ctx.textAlign = 'left'; ctx.fillText(txt, tx + 6, pad.t + 13);
      }
    }
  }
}

// --------------------------------------------------------------------- legend

export function renderLegend(el, layer, metric) {
  if (layer === 'optical') { el.classList.remove('on'); el.innerHTML = ''; return; }
  el.classList.add('on');
  if (layer === 'slope') {
    const rows = metric
      ? SLOPE_DEG_CLASSES.map((k, i) => [rampColor(HAZARD_STOPS, k.t), `${k.label}`, `${i ? SLOPE_DEG_CLASSES[i - 1].max : 0}–${k.max}°`])
      : HAZARD_STOPS.map((s, i) => [s.c, s.label, ['<P27', 'P27–55', 'P55–78', 'P78–99', '>P99'][i]]);
    el.innerHTML = `<div class="lg-h">Landslide risk · ${metric ? 'slope angle' : 'relative gradient'}</div>` +
      rows.reverse().map(([c, l, r]) => `<div class="lg-row"><i class="lg-sw" style="background:${css(c)}"></i><span>${l}</span><span class="muted" style="margin-left:auto">${r}</span></div>`).join('');
    return;
  }
  const stops = layer === 'hypso' ? HYPSO_STOPS : [{ t: 0, c: [0, 0, 0] }, { t: 1, c: [255, 255, 255] }];
  const bar = `linear-gradient(90deg, ${stops.map((s) => `${css(s.c)} ${s.t * 100}%`).join(',')})`;
  const lo = metric ? `${metric.toElev(0).toFixed(0)} m` : '0';
  const hi = metric ? `${metric.toElev(100).toFixed(0)} m` : '100';
  el.innerHTML = `<div class="lg-h">${layer === 'hypso' ? 'Hypsometric tint' : 'Raw depth map'} · ${metric ? 'm ASL' : 'relative'}</div>
    <div class="lg-bar" style="background:${bar}"></div><div class="lg-ends"><span>${lo}</span><span>${hi}</span></div>`;
}
