import * as THREE from 'three';
import './style.css';
import { Engine, PLANE } from './engine.js';
import { FlightController } from './flight.js';
import { HeightField, HAZARD_STOPS, SLOPE_DEG_CLASSES } from './heightfield.js';
import { Minimap, ProfileChart, drawHistogram, renderLegend } from './hud.js';

const API = (import.meta.env.VITE_API_URL || '').replace(/\/$/, '');
const BASE = import.meta.env.BASE_URL;
const $ = (id) => document.getElementById(id);

// ---------------------------------------------------------------------- state
const state = {
  tile: null,
  layer: 'optical',
  contours: false,
  tool: null,          // 'anchor' | 'anchor2' | 'profA' | 'profB'
  anchor: { a: null, b: null, applied: false },
  profile: { a: null, b: null },
  layerCache: new Map(),
  apiOnline: false,
};

const engine = new Engine($('scene'));
const flight = new FlightController(engine, {
  onModeChange: (m) => {
    document.querySelectorAll('#camSeg button').forEach((b) => b.classList.toggle('on', b.dataset.cam === m));
    $('droneHud').classList.toggle('on', m === 'drone');
    if (m === 'drone') toast('Drone mode — WASD to fly, drag or click-lock the mouse to look.', 'ok');
    if (m === 'cinematic') toast('Cinematic flythrough — click the view to take back control.');
  },
  onTelemetry: (t) => {
    $('dAlt').textContent = altitudeLabel(t.agl);
    $('dSpd').textContent = `${t.speed.toFixed(1)}`;
    $('dHdg').textContent = `${String(Math.round(t.heading)).padStart(3, '0')}°`;
  },
});
const minimap = new Minimap($('minimap'), (u, v) => {
  const p = engine.uvToWorld(u, v);
  const target = new THREE.Vector3(p.x, engine.heightAtUV(u, v), p.z);
  const off = engine.camera.position.clone().sub(engine.controls.target);
  if (off.length() > 70) off.setLength(70);
  flight.flyTo(target.clone().add(off), target);
});
const profileChart = new ProfileChart($('profile'));

// -------------------------------------------------------------------- helpers
function toast(msg, kind = '') {
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.textContent = msg;
  $('toasts').appendChild(el);
  setTimeout(() => { el.style.transition = 'opacity .4s'; el.style.opacity = '0'; }, 3800);
  setTimeout(() => el.remove(), 4300);
}

function loadImage(src) {
  return new Promise((res, rej) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => res(img);
    img.onerror = () => rej(new Error(`Could not load ${src}`));
    img.src = src;
  });
}

const fmtPct = (f) => `${(f * 100).toFixed(1)}%`;
function fmtArea(m2) {
  if (m2 >= 1e6) return `${(m2 / 1e6).toFixed(2)} km²`;
  if (m2 >= 1e4) return `${(m2 / 1e4).toFixed(1)} ha`;
  return `${m2.toFixed(0)} m²`;
}
function fmtVol(m3) {
  if (m3 >= 1e9) return `${(m3 / 1e9).toFixed(2)} km³`;
  if (m3 >= 1e6) return `${(m3 / 1e6).toFixed(2)} Mm³`;
  return `${m3.toFixed(0)} m³`;
}

function setRangeFill(input) {
  const p = ((input.value - input.min) / (input.max - input.min)) * 100;
  input.style.setProperty('--p', `${p}%`);
}

/** Metric grounding, or null when fail-closed (rDSM). */
function metric() {
  const an = state.anchor;
  if (!an.applied || !an.a) return null;
  const Za = parseFloat($('zAnchor').value), S = parseFloat($('sScale').value), gsd = parseFloat($('gsd').value);
  if (!Number.isFinite(Za) || !Number.isFinite(S)) return null;
  const dA = an.a.d;
  return { Za, S, gsd: gsd > 0 ? gsd : null, dA, toElev: (rel) => Za + (rel - dA) * S };
}

function gsd() { const g = parseFloat($('gsd').value); return g > 0 ? g : null; }

function relLabel(rel) {
  const m = metric();
  return m ? `${m.toElev(rel).toFixed(1)} m ASL` : `${rel.toFixed(1)} rel`;
}

function altitudeLabel(aglWorld) {
  const rel = (aglWorld / engine.dispScale) * 100;
  const m = metric();
  return m ? `${(rel * m.S).toFixed(0)} m` : `${rel.toFixed(0)} u`;
}

function slopeClassRel(g) {
  const t = g / state.tile.field.gradP99;
  let lbl = HAZARD_STOPS[0].label;
  for (const s of HAZARD_STOPS) if (t >= s.t) lbl = s.label;
  return lbl;
}

// ---------------------------------------------------------------- layers
function layerCanvas() {
  const t = state.tile, f = t.field;
  const m = metric();
  const key = `${state.layer}|${state.contours}|${state.layer === 'slope' && m ? `${m.S}|${m.gsd}` : ''}`;
  if (state.layerCache.has(key)) return state.layerCache.get(key);
  let base;
  if (state.layer === 'optical') base = t.texture;
  else if (state.layer === 'hypso') base = f.hypsoCanvas();
  else if (state.layer === 'slope') base = f.slopeCanvas(m && m.gsd ? { S: m.S, gsd: m.gsd } : null);
  else base = f.depthCanvas();
  const outW = Math.min(2048, Math.max(1024, t.texture.width || 1024));
  const c = state.layer === 'optical' && !state.contours && t.texture instanceof HTMLCanvasElement
    ? t.texture : f.composite(base, { contours: state.contours, step: 5, outW });
  state.layerCache.set(key, c);
  return c;
}

function applyLayer() {
  if (!state.tile) return;
  const c = layerCanvas();
  engine.setColor(c);
  minimap.setLayer(c, state.tile.field, engine.floodLevel);
  const m = metric();
  renderLegend($('legend'), state.layer, state.layer === 'slope' ? (m && m.gsd ? m : null) : m);
  document.querySelectorAll('#layerSeg button').forEach((b) => b.classList.toggle('on', b.dataset.layer === state.layer));
}

function setLayer(l) { state.layer = l; applyLayer(); }

// ---------------------------------------------------------------- install tile
function install(tile) {
  state.tile = tile;
  state.layerCache.clear();
  const f = tile.field;
  engine.setTile(f, f.depthCanvas(), tile.texture);
  clearAnchor(true);
  clearProfile();
  ['tPix', 'tRel', 'tSlope', 'tWet'].forEach((id) => { $(id).textContent = '—'; $(id).style.color = ''; });
  $('tMet').textContent = 'unanchored'; $('tMet').className = 'muted';
  $('gsd').value = tile.gsd ?? 1;
  const hint = tile.anchorHint;
  $('anchorHint').innerHTML = hint
    ? `<button id="useHint">↳ Scenario reference: ${hint.label} = ${hint.elevation_m} m · S ≈ ${hint.meters_per_unit} m/unit</button>`
    : '';
  if (hint) $('useHint').onclick = () => {
    $('zAnchor').value = hint.elevation_m;
    $('sScale').value = hint.meters_per_unit;
    startTool('anchor');
  };
  applyLayer();
  setFlood(0);
  updateRibbon();
  drawHistogram($('histo'), f, 0, null);
  document.querySelectorAll('.sample').forEach((el) => el.classList.toggle('on', el.dataset.id === tile.id));
  flight.preset('iso');
}

function updateRibbon() {
  const t = state.tile;
  if (!t) return;
  const f = t.field;
  $('rbEngine').textContent = t.engine;
  $('rbSource').textContent = t.name;
  $('rbRes').textContent = `${f.w}×${f.h} → ${engine.terrain.geometry.parameters.widthSegments}² mesh`;
  $('rbInf').textContent = t.inferenceMs != null ? `${t.inferenceMs.toFixed(0)} ms` : 'cached';
  $('rbDyn').textContent = `${f.stats.dynamicRange.toFixed(1)} / 100`;
  $('rbSteep').textContent = fmtPct(f.stats.steepFraction);
  const m = metric();
  $('rbRange').textContent = m
    ? `${m.toElev(f.stats.p05).toFixed(0)} – ${m.toElev(f.stats.p95).toFixed(0)} m ASL (P5–P95)`
    : `${f.stats.p05.toFixed(1)} – ${f.stats.p95.toFixed(1)} rel (P5–P95) · metres withheld`;
  const rb = $('rbMode');
  rb.classList.toggle('ok', !!m);
  rb.querySelector('b').textContent = m ? 'Anchored Metric DSM (mDSM)' : 'Relative DSM (rDSM)';
}

// ---------------------------------------------------------------- samples
async function loadSamples() {
  let manifest = [];
  try { manifest = await (await fetch(`${BASE}samples/manifest.json`)).json(); } catch { toast('Sample cache missing', 'err'); }
  const wrap = $('samples');
  wrap.innerHTML = '';
  for (const s of manifest) {
    const el = document.createElement('button');
    el.className = 'sample';
    el.dataset.id = s.id;
    el.innerHTML = `<img src="${BASE}${s.thumb}" alt="" loading="lazy" /><div><div class="s-name">${s.name}</div>
      <div class="s-reg">${s.region}</div><div class="s-scn">▸ ${s.scenario}</div></div>`;
    el.onclick = () => openSample(s);
    wrap.appendChild(el);
  }
  return manifest;
}

async function openSample(s) {
  closeSidebarMobile();
  const [tex, dep] = await Promise.all([loadImage(`${BASE}${s.texture}`), loadImage(`${BASE}${s.depth}`)]);
  install({
    id: s.id, name: s.name, texture: tex, engine: 'pre-baked cache', inferenceMs: null,
    field: HeightField.fromImage(dep, tex.width), gsd: s.gsd_m, anchorHint: s.anchor_hint, stats: s.stats,
  });
  toast(`${s.name} loaded from offline cache`, 'ok');
}

// ---------------------------------------------------------------- upload/API
async function checkHealth() {
  const pill = $('enginePill');
  try {
    const ctl = new AbortController();
    setTimeout(() => ctl.abort(), 4000);
    const r = await fetch(`${API}/api/health`, { signal: ctl.signal });
    const j = await r.json();
    state.apiOnline = true;
    pill.className = `engine-pill ${j.mock ? 'mock' : 'ok'}`;
    pill.querySelector('span').textContent = j.mock
      ? `API online · mock engine (${j.note ? 'no torch' : 'forced'})`
      : `API online · ${j.engine} · ${j.device.toUpperCase()}`;
    pill.title = j.note || '';
  } catch {
    state.apiOnline = false;
    pill.className = 'engine-pill off';
    pill.querySelector('span').textContent = 'API offline · cache + browser fallback';
  }
}

function loaderStep(i) {
  $('loaderSteps').querySelectorAll('li').forEach((li, k) => {
    li.className = k < i ? 'done' : k === i ? 'active' : '';
  });
}

async function handleFile(file) {
  if (!file) return;
  closeSidebarMobile();
  const isTiff = /\.tiff?$/i.test(file.name);
  $('loader').classList.add('on');
  $('loaderTitle').textContent = 'Running Depth Anything V2';
  loaderStep(0);
  engine.startScan();
  const url = URL.createObjectURL(file);
  try {
    let tile;
    try {
      const fd = new FormData();
      fd.append('file', file);
      loaderStep(1);
      const r = await fetch(`${API}/api/generate-depth`, { method: 'POST', body: fd });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).detail || `HTTP ${r.status}`);
      const j = await r.json();
      loaderStep(2);
      const depthImg = await loadImage(`data:image/png;base64,${j.depth_image}`);
      const texture = await loadImage(j.texture_image ? `data:image/png;base64,${j.texture_image}` : url);
      loaderStep(3);
      tile = {
        id: 'upload', name: file.name, texture, engine: j.mock ? 'mock-procedural (API)' : j.engine,
        inferenceMs: j.inference_ms, field: HeightField.fromImage(depthImg, j.original_size?.[0] ?? texture.width),
        gsd: j.geo?.pixel_size?.[0] ?? 1, anchorHint: null,
      };
      if (j.mock) toast('Backend is in mock mode — heights are procedural, not ML.', 'warn');
    } catch (err) {
      if (isTiff) throw new Error(`GeoTIFF needs the backend (${err.message})`);
      $('loaderTitle').textContent = 'API unreachable · browser fallback';
      const texture = await loadImage(url);
      tile = {
        id: 'upload', name: file.name, texture, engine: 'browser luminance heuristic', inferenceMs: null,
        field: HeightField.heuristicFromImage(texture), gsd: 1, anchorHint: null,
      };
      toast(`Inference API unavailable (${err.message}). Using a browser heuristic — not ML depth.`, 'warn');
    }
    install(tile);
    toast(`Terrain reconstructed from ${file.name}`, 'ok');
  } catch (err) {
    toast(err.message, 'err');
  } finally {
    engine.stopScan();
    $('loader').classList.remove('on');
  }
}

// ---------------------------------------------------------------- flood
let surgeAnim = null;
function setFlood(level) {
  level = Math.max(0, Math.min(100, level));
  engine.setFloodLevel(level);
  const inp = $('flood');
  inp.value = level;
  setRangeFill(inp);
  const t = state.tile;
  $('floodVal').textContent = level <= 0.05 ? 'OFF' : relLabel(level);
  if (!t) return;
  const f = t.field;
  const frac = f.floodFraction(level);
  $('fsPct').textContent = fmtPct(level <= 0.05 ? 0 : frac);
  const g = gsd();
  const px = f.groundPerPixel(g || 1);
  $('fsArea').textContent = g && level > 0.05 ? fmtArea(frac * f.w * f.h * px * px) : '—';
  const m = metric();
  $('fsVol').textContent = level <= 0.05 ? '—' : m && g ? fmtVol(f.floodVolumeUnits(level) * m.S * px * px) : 'anchor req.';
  $('fsVol').title = m ? '' : 'Volume needs a metric anchor (fail-closed).';
  drawHistogram($('histo'), f, level, state.anchor.a ? state.anchor.a.d : null);
  clearTimeout(setFlood._t);
  setFlood._t = setTimeout(() => minimap.setFlood(level), 50);
  if (state.profile.b) updateProfileChart();
}

function toggleSurge() {
  const btn = $('surgeBtn');
  if (surgeAnim) { cancelAnimationFrame(surgeAnim); surgeAnim = null; btn.textContent = '▶ Simulate surge'; btn.classList.remove('active'); return; }
  const f = state.tile?.field;
  if (!f) return;
  const start = engine.floodLevel >= f.stats.p50 ? 0 : engine.floodLevel;
  const end = Math.min(100, f.stats.p50 + 8);
  const t0 = performance.now(), dur = 7000;
  btn.textContent = '■ Stop surge'; btn.classList.add('active');
  const step = (now) => {
    const k = Math.min((now - t0) / dur, 1);
    setFlood(start + (end - start) * (1 - Math.pow(1 - k, 2)));
    if (k < 1) surgeAnim = requestAnimationFrame(step);
    else { surgeAnim = null; btn.textContent = '▶ Simulate surge'; btn.classList.remove('active'); }
  };
  surgeAnim = requestAnimationFrame(step);
}

// ---------------------------------------------------------------- 3D markers
const markerGroup = new THREE.Group();
engine.scene.add(markerGroup);
const labels = [];

function makePin(color) {
  const g = new THREE.Group();
  const stem = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.12, 6, 8), new THREE.MeshBasicMaterial({ color }));
  stem.position.y = 3;
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.7, 20, 14), new THREE.MeshBasicMaterial({ color }));
  head.position.y = 6.4;
  const ring = new THREE.Mesh(new THREE.RingGeometry(0.9, 1.4, 32), new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.7, side: THREE.DoubleSide }));
  ring.rotation.x = -Math.PI / 2;
  ring.position.y = 0.08;
  g.add(stem, head, ring);
  g.userData.ring = ring;
  return g;
}

function placePin(uv, color, text, cls = '') {
  const pin = makePin(color);
  pin.userData.uv = uv;
  markerGroup.add(pin);
  const el = document.createElement('div');
  el.className = `marker ${cls}`;
  el.textContent = text;
  $('markers').appendChild(el);
  const entry = { pin, el, uv };
  labels.push(entry);
  return entry;
}

function removeMarker(entry) {
  if (!entry) return;
  markerGroup.remove(entry.pin);
  entry.el.remove();
  labels.splice(labels.indexOf(entry), 1);
}

let profileLine = null;
function rebuildProfileLine() {
  if (profileLine) { engine.scene.remove(profileLine); profileLine.geometry.dispose(); profileLine = null; }
  const { a, b } = state.profile;
  if (!a || !b) return;
  const pts = [];
  for (let i = 0; i <= 200; i++) {
    const u = a.u + (b.u - a.u) * (i / 200), v = a.v + (b.v - a.v) * (i / 200);
    const w = engine.uvToWorld(u, v);
    pts.push(new THREE.Vector3(w.x, engine.heightAtUV(u, v) + 0.35, w.z));
  }
  profileLine = new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts),
    new THREE.LineBasicMaterial({ color: 0xfbbf24, depthTest: false, transparent: true }));
  profileLine.renderOrder = 5;
  engine.scene.add(profileLine);
}

function syncMarkers() {
  const cam = engine.camera;
  const rect = engine.canvas.getBoundingClientRect();
  const t = engine.clock.elapsedTime;
  for (const m of labels) {
    const w = engine.uvToWorld(m.uv.u, m.uv.v);
    const y = engine.heightAtUV(m.uv.u, m.uv.v);
    m.pin.position.set(w.x, y, w.z);
    m.pin.userData.ring.scale.setScalar(1 + 0.25 * Math.sin(t * 4));
    const p = new THREE.Vector3(w.x, y + 7.4, w.z).project(cam);
    const vis = p.z < 1 && Math.abs(p.x) < 1.1 && Math.abs(p.y) < 1.1;
    m.el.style.display = vis ? 'block' : 'none';
    m.el.style.left = `${((p.x + 1) / 2) * rect.width}px`;
    m.el.style.top = `${((1 - p.y) / 2) * rect.height}px`;
  }
}

// ---------------------------------------------------------------- tools
const TOOL_HINTS = {
  anchor: '◎ Click the terrain at a point whose real elevation you know (e.g. runway, gauge station, coastline)',
  anchor2: '◎₂ Click a second known point to solve the scale S',
  profA: '⟋ Click the start point A of the cross-section',
  profB: '⟋ Click the end point B of the cross-section',
};

function startTool(tool) {
  if (!state.tile) return;
  if (flight.mode !== 'orbit') flight.setMode('orbit');
  state.tool = tool;
  $('toolHint').textContent = TOOL_HINTS[tool] + '  ·  Esc to cancel';
  $('toolHint').classList.add('on');
  $('viewport').classList.add('picking');
  $('pickAnchor').classList.toggle('active', tool === 'anchor');
  $('pickAnchor2').classList.toggle('active', tool === 'anchor2');
  $('profileBtn').classList.toggle('active', tool === 'profA' || tool === 'profB');
}

function endTool() {
  state.tool = null;
  $('toolHint').classList.remove('on');
  $('viewport').classList.remove('picking');
  ['pickAnchor', 'pickAnchor2', 'profileBtn'].forEach((id) => $(id).classList.remove('active'));
}

function handlePick(hit) {
  const d = state.tile.field.sample(hit.u, hit.v) / 2.55;
  const px = [Math.round(hit.u * (state.tile.field.w - 1)), Math.round(hit.v * (state.tile.field.h - 1))];
  const tool = state.tool;
  if (tool === 'anchor') {
    removeMarker(state.anchor.a?.marker);
    state.anchor.a = { u: hit.u, v: hit.v, d, px, marker: placePin({ u: hit.u, v: hit.v }, 0xff9933, `ANCHOR · d=${d.toFixed(1)}`) };
    $('applyAnchor').disabled = false;
    endTool();
    renderAnchorRead();
    drawHistogram($('histo'), state.tile.field, engine.floodLevel, d);
    toast('Anchor placed — enter its known elevation, then Apply.', 'ok');
  } else if (tool === 'anchor2') {
    removeMarker(state.anchor.b?.marker);
    state.anchor.b = { u: hit.u, v: hit.v, d, px, marker: placePin({ u: hit.u, v: hit.v }, 0x22d3ee, `REF₂ · d=${d.toFixed(1)}`, 'b') };
    endTool();
    solveScale();
    renderAnchorRead();
  } else if (tool === 'profA') {
    clearProfile();
    state.profile.a = { u: hit.u, v: hit.v, marker: placePin({ u: hit.u, v: hit.v }, 0xfbbf24, 'A') };
    startTool('profB');
  } else if (tool === 'profB') {
    state.profile.b = { u: hit.u, v: hit.v, marker: placePin({ u: hit.u, v: hit.v }, 0xfbbf24, 'B') };
    endTool();
    rebuildProfileLine();
    $('profilePanel').classList.add('on');
    updateProfileChart();
  }
}

function solveScale({ reapply = true } = {}) {
  const { a, b } = state.anchor;
  const z2 = parseFloat($('z2').value), za = parseFloat($('zAnchor').value);
  if (!a || !b || !Number.isFinite(z2) || !Number.isFinite(za)) return false;
  if (Math.abs(b.d - a.d) < 1) { toast('Points are at nearly the same relative height — pick a second point with more relief.', 'warn'); return false; }
  const S = (z2 - za) / (b.d - a.d);
  if (S <= 0) { toast('Solved S is negative — the two elevations contradict the depth ordering. Check inputs.', 'err'); return false; }
  $('sScale').value = S.toFixed(3);
  toast(`Scale solved from 2 points: S = ${S.toFixed(3)} m / relative unit`, 'ok');
  if (reapply && state.anchor.applied) applyAnchor();
  return true;
}

function renderAnchorRead() {
  const { a, b, applied } = state.anchor;
  if (!a) { $('anchorRead').innerHTML = 'No anchor · click “Pick anchor point”, then a spot on the terrain.'; return; }
  let s = `Anchor px (${a.px[0]}, ${a.px[1]}) · d<sub>a</sub> = <b>${a.d.toFixed(2)}</b> rel`;
  if (b) s += `<br>Ref₂ px (${b.px[0]}, ${b.px[1]}) · d₂ = <b>${b.d.toFixed(2)}</b> rel`;
  const m = metric();
  if (applied && m) {
    const f = state.tile.field;
    s += `<br>Grounded range: <b>${m.toElev(0).toFixed(0)} → ${m.toElev(100).toFixed(0)} m</b> ASL`;
    s += `<br>Tile relief ≈ ${(f.stats.dynamicRange * m.S).toFixed(1)} m (P5–P95)`;
  }
  $('anchorRead').innerHTML = s;
}

function applyAnchor() {
  if (!state.anchor.a) return;
  if (state.anchor.b && $('z2').value !== '') solveScale({ reapply: false });
  state.anchor.applied = true;
  const m = metric();
  if (!m) { state.anchor.applied = false; toast('Enter numeric Zₐ and S first.', 'err'); return; }
  state.layerCache.clear();
  applyLayer();
  updateBanner();
  updateRibbon();
  renderAnchorRead();
  setFlood(engine.floodLevel);
  toast('mDSM grounding applied — metric readouts unlocked.', 'ok');
}

function clearAnchor(silent) {
  removeMarker(state.anchor.a?.marker);
  removeMarker(state.anchor.b?.marker);
  state.anchor = { a: null, b: null, applied: false };
  $('applyAnchor').disabled = true;
  state.layerCache.clear();
  updateBanner();
  renderAnchorRead();
  if (!silent) { applyLayer(); updateRibbon(); setFlood(engine.floodLevel); }
}

function updateBanner() {
  const m = metric();
  const b = $('banner');
  b.className = `banner ${m ? 'mdsm' : 'rdsm'}`;
  b.querySelector('.banner-icon').textContent = m ? '⚓' : '⚠';
  $('anchorState').className = `pill-mini ${m ? 'ok' : ''}`;
  $('anchorState').textContent = m ? 'mDSM' : 'rDSM';
  if (m) {
    $('bannerTitle').textContent = 'Mode B · Anchored Metric DSM (mDSM)';
    $('bannerSub').textContent = `Grounded at d=${m.dA.toFixed(1)} → ${m.Za} m ASL · S = ${m.S} m/unit${state.anchor.b ? ' (2-point solve)' : ' (user-asserted)'} · accuracy bounded by anchor quality.`;
  } else {
    $('bannerTitle').textContent = 'Mode A · Unanchored Relative Depth (rDSM)';
    $('bannerSub').textContent = '0–100 normalized scale — suitable for topographic shape analysis & flood-flow triage. Not metric.';
  }
}

function clearProfile() {
  removeMarker(state.profile.a?.marker);
  removeMarker(state.profile.b?.marker);
  state.profile = { a: null, b: null };
  rebuildProfileLine();
  $('profilePanel').classList.remove('on');
}

function updateProfileChart() {
  const { a, b } = state.profile;
  const f = state.tile.field;
  const n = 300, samples = [];
  for (let i = 0; i < n; i++) samples.push(f.sample(a.u + (b.u - a.u) * (i / (n - 1)), a.v + (b.v - a.v) * (i / (n - 1))) / 2.55);
  const pxDist = Math.hypot((b.u - a.u) * f.w, (b.v - a.v) * f.h);
  const g = gsd();
  const m = metric();
  const ground = g ? pxDist * f.groundPerPixel(g) : pxDist;
  const dist = ground >= 2000 ? ground / 1000 : ground;
  const distUnit = g ? (ground >= 2000 ? 'km' : 'm') : 'px';
  profileChart.set({
    samples, dist, distUnit,
    toElev: m ? m.toElev : (r) => r,
    elevUnit: m ? 'm ASL' : 'rel',
    level: engine.floodLevel > 0.05 ? engine.floodLevel : 0,
  });
  const rise = Math.max(...samples) - Math.min(...samples);
  $('profMeta').textContent = `${dist.toFixed(dist < 10 ? 2 : 0)} ${distUnit} · relief ${m ? `${(rise * m.S).toFixed(1)} m` : `${rise.toFixed(1)} rel`}`;
}

// ---------------------------------------------------------------- pointer
const vp = $('viewport');
let down = null, pending = null;
function ndc(ev) {
  const r = engine.canvas.getBoundingClientRect();
  return [((ev.clientX - r.left) / r.width) * 2 - 1, -((ev.clientY - r.top) / r.height) * 2 + 1];
}
engine.canvas.addEventListener('pointerdown', (ev) => { down = [ev.clientX, ev.clientY]; });
engine.canvas.addEventListener('pointerup', (ev) => {
  if (!down || Math.hypot(ev.clientX - down[0], ev.clientY - down[1]) > 5) return;
  down = null;
  if (!state.tool || !state.tile) return;
  const hit = engine.pick(...ndc(ev));
  if (hit) handlePick(hit); else toast('Missed the terrain — click on the tile.', 'warn');
});
engine.canvas.addEventListener('pointermove', (ev) => { pending = ev; });

function updateTelemetry() {
  if (!pending || !state.tile || flight.mode === 'drone') return;
  const hit = engine.pick(...ndc(pending));
  pending = null;
  if (!hit) return;
  const f = state.tile.field;
  const rel = f.sample(hit.u, hit.v) / 2.55;
  $('tPix').textContent = `${Math.round(hit.u * (f.w - 1))}, ${Math.round(hit.v * (f.h - 1))}`;
  $('tRel').textContent = `${rel.toFixed(1)} / 100`;
  const m = metric();
  $('tMet').textContent = m ? `${m.toElev(rel).toFixed(1)} m ASL` : 'unanchored';
  $('tMet').className = m ? '' : 'muted';
  if (m && m.gsd) {
    const deg = f.slopeDegrees(hit.u, hit.v, m.S, m.gsd);
    const cls = SLOPE_DEG_CLASSES.find((k) => deg < k.max) || SLOPE_DEG_CLASSES[4];
    $('tSlope').textContent = `${deg.toFixed(1)}° · ${cls.label}`;
  } else {
    $('tSlope').textContent = `${slopeClassRel(f.slopeAt(hit.u, hit.v))} (rel)`;
  }
  const lvl = engine.floodLevel;
  const wet = lvl > 0.05 && rel <= lvl;
  $('tWet').textContent = wet ? `SUBMERGED · ${m ? `${((lvl - rel) * m.S).toFixed(1)} m` : `${(lvl - rel).toFixed(1)} rel`} deep` : 'Dry';
  $('tWet').style.color = wet ? '#38bdf8' : '';
}

// ---------------------------------------------------------------- frame loop
let fpsN = 0, fpsT = performance.now();
engine.onFrame.push(() => {
  updateTelemetry();
  syncMarkers();
  const cam = engine.camera;
  const dir = new THREE.Vector3(); cam.getWorldDirection(dir);
  const uv = engine.worldToUV(cam.position.x, cam.position.z);
  const marks = [];
  if (state.anchor.a) marks.push({ u: state.anchor.a.u, v: state.anchor.a.v, color: '#ff9933' });
  if (state.anchor.b) marks.push({ u: state.anchor.b.u, v: state.anchor.b.v, color: '#22d3ee' });
  if (state.profile.a && state.profile.b) marks.push({ type: 'line', a: state.profile.a, b: state.profile.b });
  minimap.draw(uv, Math.atan2(-dir.x, -dir.z), marks);
  fpsN++;
  const now = performance.now();
  if (now - fpsT > 1000) { $('rbFps').textContent = Math.round((fpsN * 1000) / (now - fpsT)); fpsN = 0; fpsT = now; }
});

// ---------------------------------------------------------------- UI wiring
function download(name, href) {
  const a = document.createElement('a');
  a.href = href; a.download = name; a.click();
}
const baseName = () => (state.tile?.name || 'tile').replace(/\.[^.]+$/, '').replace(/\s+/g, '-').toLowerCase();

function screenshot() { download(`depthwizard-${baseName()}.png`, engine.screenshot()); toast('Screenshot saved', 'ok'); }

function exportReport() {
  const t = state.tile; if (!t) return;
  const f = t.field, m = metric(), lvl = engine.floodLevel, g = gsd();
  const px = f.groundPerPixel(g || 1);
  const report = {
    tool: 'DepthWizard · SIH26175', generated: new Date().toISOString(),
    source: t.name, engine: t.engine, inference_ms: t.inferenceMs,
    mode: m ? 'mDSM (anchored)' : 'rDSM (relative, unanchored)',
    grid: { width: f.w, height: f.h, gsd_m_per_px_original: g },
    relative_stats: {
      p05: +f.stats.p05.toFixed(2), median: +f.stats.p50.toFixed(2), p95: +f.stats.p95.toFixed(2),
      dynamic_range: +f.stats.dynamicRange.toFixed(2), steep_fraction: +f.stats.steepFraction.toFixed(4),
    },
    anchor: m ? {
      Z_anchor_m: m.Za, d_anchor: +m.dA.toFixed(3), S_m_per_unit: m.S,
      two_point_solve: !!state.anchor.b, formula: 'Z_metric = Z_anchor + (d - d_anchor) * S',
      elevation_range_m: [+m.toElev(0).toFixed(1), +m.toElev(100).toFixed(1)],
    } : null,
    flood_simulation: lvl > 0.05 ? {
      level_rel: +lvl.toFixed(2), level_m_asl: m ? +m.toElev(lvl).toFixed(2) : null,
      inundated_fraction: +f.floodFraction(lvl).toFixed(4),
      inundated_area_m2: g ? Math.round(f.floodFraction(lvl) * f.w * f.h * px * px) : null,
      stored_volume_m3: m && g ? Math.round(f.floodVolumeUnits(lvl) * m.S * px * px) : null,
    } : null,
    caveat: 'Single-view monocular depth is scale-ambiguous. Metric values are valid only relative to the user-supplied anchor.',
  };
  download(`depthwizard-${baseName()}-report.json`, URL.createObjectURL(new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' })));
  toast('Triage report exported', 'ok');
}

function closeSidebarMobile() { $('sidebar').classList.remove('open'); }

function wire() {
  $('menuBtn').onclick = () => $('sidebar').classList.toggle('open');
  $('fileInput').onchange = (e) => { handleFile(e.target.files[0]); e.target.value = ''; };
  const dz = $('dropzone');
  ['dragenter', 'dragover'].forEach((t) => document.addEventListener(t, (e) => { e.preventDefault(); dz.classList.add('drag'); }));
  ['dragleave', 'drop'].forEach((t) => document.addEventListener(t, (e) => { e.preventDefault(); if (t === 'drop' || e.target === document.documentElement) dz.classList.remove('drag'); }));
  document.addEventListener('drop', (e) => { dz.classList.remove('drag'); handleFile(e.dataTransfer?.files?.[0]); });

  document.querySelectorAll('#layerSeg button').forEach((b) => (b.onclick = () => setLayer(b.dataset.layer)));
  $('contourTgl').onchange = (e) => { state.contours = e.target.checked; applyLayer(); };
  $('wireTgl').onchange = (e) => engine.setWireframe(e.target.checked);
  $('skirtTgl').onchange = (e) => { engine.skirt.visible = engine.frame.visible = engine.grid.visible = e.target.checked; };
  document.querySelectorAll('#segSeg button').forEach((b) => (b.onclick = () => {
    const n = +b.dataset.seg;
    engine.setSegments(n);
    $('segVal').textContent = `${n} × ${n}`;
    document.querySelectorAll('#segSeg button').forEach((x) => x.classList.toggle('on', x === b));
    updateRibbon();
  }));

  const exag = $('exag');
  exag.oninput = () => {
    const v = +exag.value;
    engine.setExaggeration(v);
    $('exagVal').textContent = `${v.toFixed(1)}×`;
    setRangeFill(exag);
    rebuildProfileLine();
  };
  $('flood').oninput = (e) => setFlood(+e.target.value);
  $('surgeBtn').onclick = toggleSurge;
  $('floodReset').onclick = () => { if (surgeAnim) toggleSurge(); setFlood(0); };
  const sun = () => {
    engine.setSun(+$('sunAz').value, +$('sunEl').value);
    $('sunVal').textContent = `${$('sunAz').value}° · ${$('sunEl').value}°`;
    setRangeFill($('sunAz')); setRangeFill($('sunEl'));
  };
  $('sunAz').oninput = sun; $('sunEl').oninput = sun;

  $('pickAnchor').onclick = () => (state.tool === 'anchor' ? endTool() : startTool('anchor'));
  $('pickAnchor2').onclick = () => {
    if (!state.anchor.a) { toast('Place the primary anchor first.', 'warn'); return; }
    if ($('z2').value === '') { $('z2').focus(); toast('Enter the known elevation Z₂ of the second point first.', 'warn'); return; }
    state.tool === 'anchor2' ? endTool() : startTool('anchor2');
  };
  $('applyAnchor').onclick = applyAnchor;
  $('clearAnchor').onclick = () => { clearAnchor(false); toast('Anchor cleared — back to fail-closed rDSM.'); };
  ['zAnchor', 'sScale', 'gsd'].forEach((id) => $(id).addEventListener('change', () => {
    if (state.anchor.applied) applyAnchor();
    else setFlood(engine.floodLevel);
  }));

  $('profileBtn').onclick = () => (state.tool?.startsWith('prof') ? endTool() : startTool('profA'));
  $('profClose').onclick = clearProfile;
  $('exportShot').onclick = screenshot;
  $('shotBtn').onclick = screenshot;
  $('exportDepth').onclick = () => state.tile && download(`depthwizard-${baseName()}-heightmap.png`, state.tile.field.depthCanvas().toDataURL('image/png'));
  $('exportReport').onclick = exportReport;

  document.querySelectorAll('#camSeg button').forEach((b) => (b.onclick = () => flight.setMode(b.dataset.cam)));
  document.querySelectorAll('#presetSeg button').forEach((b) => (b.onclick = () => flight.preset(b.dataset.preset)));

  const help = $('help');
  $('helpBtn').onclick = () => { help.hidden = false; };
  help.addEventListener('click', (e) => { if (e.target === help || e.target.closest('[data-close]')) help.hidden = true; });

  window.addEventListener('keydown', (e) => {
    if (e.target.closest('input, textarea')) return;
    const k = e.key;
    if (k === 'Escape') {
      if (!help.hidden) help.hidden = true;
      else if (state.tool) endTool();
      else if (flight.mode !== 'orbit') flight.setMode('orbit');
      return;
    }
    if (flight.mode === 'drone' && 'wasdcqeWASDCQE '.includes(k)) return;
    const layers = { 1: 'optical', 2: 'hypso', 3: 'slope', 4: 'depth' };
    if (layers[k]) setLayer(layers[k]);
    else if (k === 'o' || k === 'O') flight.setMode('orbit');
    else if (k === 'f' || k === 'F') flight.setMode('drone');
    else if (k === 'c' || k === 'C') flight.setMode('cinematic');
    else if (k === 'r' || k === 'R') flight.preset('iso');
    else if (k === 't' || k === 'T') flight.preset('top');
    else if (k === '[') setFlood(engine.floodLevel - 1);
    else if (k === ']') setFlood(engine.floodLevel + 1);
    else if (k === '+' || k === '=') { exag.value = Math.min(20, +exag.value + 0.5); exag.oninput(); }
    else if (k === '-' || k === '_') { exag.value = Math.max(0.1, +exag.value - 0.5); exag.oninput(); }
    else if (k === 'k' || k === 'K') { $('contourTgl').checked = !$('contourTgl').checked; $('contourTgl').onchange({ target: $('contourTgl') }); }
    else if (k === 'p' || k === 'P') screenshot();
    else if (k === 'h' || k === 'H' || k === '?') help.hidden = !help.hidden;
  });
  document.querySelectorAll('input[type=range]').forEach(setRangeFill);
}

// ---------------------------------------------------------------- boot
async function boot() {
  wire();
  checkHealth();
  setInterval(checkHealth, 30000);
  const manifest = await loadSamples();
  const first = manifest.find((s) => s.id === 'mountain-ridge') || manifest[0];
  if (first) await openSample(first).catch((e) => toast(e.message, 'err'));
  setTimeout(() => $('splash').classList.add('gone'), 350);
}
boot();

// Expose for debugging / demo scripting from the console.
window.depthwizard = { engine, flight, state, PLANE };
