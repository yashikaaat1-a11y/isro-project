import * as THREE from 'three';
import { PLANE } from './engine.js';

const ease = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

/**
 * Camera modes: 'orbit' (OrbitControls), 'drone' (first-person WASD with
 * mouse-look and terrain-following), 'cinematic' (scripted flythrough).
 */
export class FlightController {
  constructor(engine, { onModeChange, onTelemetry } = {}) {
    this.e = engine;
    this.mode = 'orbit';
    this.keys = new Set();
    this.yaw = 0;
    this.pitch = -0.15;
    this.speed = 0;
    this.onModeChange = onModeChange || (() => {});
    this.onTelemetry = onTelemetry || (() => {});
    this._tween = null;

    const el = engine.canvas;
    window.addEventListener('keydown', (ev) => {
      if (ev.target.closest && ev.target.closest('input, textarea, select')) return;
      this.keys.add(ev.code);
      if (this.mode === 'drone' && ['Space', 'KeyW', 'KeyA', 'KeyS', 'KeyD'].includes(ev.code)) ev.preventDefault();
    });
    window.addEventListener('keyup', (ev) => this.keys.delete(ev.code));
    window.addEventListener('blur', () => this.keys.clear());

    this._drag = null;
    el.addEventListener('pointerdown', (ev) => {
      if (this.mode === 'cinematic') this.setMode('orbit');
      if (this.mode !== 'drone') return;
      if (document.pointerLockElement !== el && el.requestPointerLock) {
        try { const p = el.requestPointerLock(); if (p && p.catch) p.catch(() => {}); } catch { /* iframe */ }
      }
      this._drag = { x: ev.clientX, y: ev.clientY };
    });
    window.addEventListener('pointerup', () => { this._drag = null; });
    window.addEventListener('pointermove', (ev) => {
      if (this.mode !== 'drone') return;
      let dx = 0, dy = 0;
      if (document.pointerLockElement === el) { dx = ev.movementX; dy = ev.movementY; }
      else if (this._drag) { dx = ev.clientX - this._drag.x; dy = ev.clientY - this._drag.y; this._drag = { x: ev.clientX, y: ev.clientY }; }
      this.yaw -= dx * 0.0022;
      this.pitch = THREE.MathUtils.clamp(this.pitch - dy * 0.0022, -1.45, 1.2);
    });
    el.addEventListener('wheel', (ev) => {
      if (this.mode !== 'drone') return;
      this.cruise = THREE.MathUtils.clamp((this.cruise || 12) * (ev.deltaY < 0 ? 1.15 : 0.87), 2, 80);
    }, { passive: true });

    engine.onFrame.push((dt, t) => this._update(dt, t));
  }

  setMode(mode) {
    if (mode === this.mode) return;
    const cam = this.e.camera;
    this._tween = null;
    if (this.mode === 'drone' && document.pointerLockElement) document.exitPointerLock();
    if (mode === 'drone') {
      const dir = new THREE.Vector3();
      cam.getWorldDirection(dir);
      this.yaw = Math.atan2(-dir.x, -dir.z);
      this.pitch = Math.max(-0.5, Math.asin(dir.y));
      const ground = this.e.heightAtWorld(cam.position.x, cam.position.z);
      if (cam.position.y - ground > 30) {
        // Drop into a low-altitude pass near the tile edge.
        cam.position.set(0, this.e.dispScale + 8, PLANE * this.e.aspect * 0.55);
        this.yaw = 0; this.pitch = -0.18;
      }
      this.cruise = this.cruise || 12;
    }
    if (mode === 'cinematic') this._buildPath();
    if (mode === 'orbit') {
      const dir = new THREE.Vector3();
      cam.getWorldDirection(dir);
      const target = cam.position.clone().addScaledVector(dir, 40);
      target.y = Math.max(0, Math.min(target.y, this.e.dispScale));
      this.e.controls.target.copy(target);
    }
    this.e.controls.enabled = mode === 'orbit';
    this.mode = mode;
    this.onModeChange(mode);
  }

  /** Smoothly move the orbit camera to a preset view. */
  flyTo(position, target, dur = 1.2) {
    if (this.mode !== 'orbit') this.setMode('orbit');
    const cam = this.e.camera, ctl = this.e.controls;
    this._tween = {
      t: 0, dur,
      p0: cam.position.clone(), p1: position.clone(),
      t0: ctl.target.clone(), t1: target.clone(),
    };
  }

  preset(name) {
    const d = this.e.dispScale, a = this.e.aspect;
    const presets = {
      iso: [new THREE.Vector3(62, 58 + d, 72 * a + 10), new THREE.Vector3(0, d * 0.3, 0)],
      top: [new THREE.Vector3(0, 125 * Math.max(1, a), 0.01), new THREE.Vector3(0, 0, 0)],
      low: [new THREE.Vector3(-58, d + 10, 55 * a), new THREE.Vector3(10, d * 0.4, -10)],
      side: [new THREE.Vector3(0, d + 14, 118 * a), new THREE.Vector3(0, d * 0.4, 0)],
    };
    const p = presets[name] || presets.iso;
    this.flyTo(p[0], p[1]);
  }

  _buildPath() {
    const e = this.e, a = e.aspect;
    const pts = [];
    const n = 9;
    for (let i = 0; i < n; i++) {
      const th = (i / n) * Math.PI * 2;
      const r = 0.34 + 0.12 * Math.sin(th * 2.0);
      const x = Math.cos(th) * PLANE * r, z = Math.sin(th) * PLANE * a * r;
      let peak = 0;
      for (let k = -3; k <= 3; k++) for (let m = -3; m <= 3; m++) peak = Math.max(peak, e.heightAtWorld(x + k * 3, z + m * 3));
      pts.push(new THREE.Vector3(x, peak + 6 + (i % 2) * 5, z));
    }
    this._path = new THREE.CatmullRomCurve3(pts, true, 'centripetal');
    this._pathT = 0;
  }

  _update(dt) {
    const cam = this.e.camera;
    if (this._tween) {
      const tw = this._tween;
      tw.t += dt / tw.dur;
      const k = ease(Math.min(tw.t, 1));
      cam.position.lerpVectors(tw.p0, tw.p1, k);
      this.e.controls.target.lerpVectors(tw.t0, tw.t1, k);
      if (tw.t >= 1) this._tween = null;
    }

    if (this.mode === 'drone') {
      const k = this.keys;
      const boost = k.has('ShiftLeft') || k.has('ShiftRight') ? 3 : 1;
      const fwd = new THREE.Vector3(-Math.sin(this.yaw), 0, -Math.cos(this.yaw));
      const right = new THREE.Vector3(-fwd.z, 0, fwd.x);
      const move = new THREE.Vector3();
      if (k.has('KeyW') || k.has('ArrowUp')) move.add(fwd);
      if (k.has('KeyS') || k.has('ArrowDown')) move.sub(fwd);
      if (k.has('KeyD') || k.has('ArrowRight')) move.add(right);
      if (k.has('KeyA') || k.has('ArrowLeft')) move.sub(right);
      if (k.has('Space') || k.has('KeyE')) move.y += 1;
      if (k.has('KeyC') || k.has('KeyQ') || k.has('ControlLeft')) move.y -= 1;
      const target = move.lengthSq() ? move.normalize().multiplyScalar(this.cruise * boost) : new THREE.Vector3();
      this._vel = (this._vel || new THREE.Vector3()).lerp(target, 1 - Math.exp(-dt * 5));
      cam.position.addScaledVector(this._vel, dt);
      const ground = this.e.heightAtWorld(cam.position.x, cam.position.z);
      const minAlt = ground + 0.8;
      if (cam.position.y < minAlt) cam.position.y = THREE.MathUtils.lerp(cam.position.y, minAlt, 0.5);
      const lim = PLANE * 1.2;
      cam.position.x = THREE.MathUtils.clamp(cam.position.x, -lim, lim);
      cam.position.z = THREE.MathUtils.clamp(cam.position.z, -lim, lim);
      cam.position.y = Math.min(cam.position.y, 220);
      const bank = THREE.MathUtils.clamp(-this._vel.dot(right) * 0.012, -0.25, 0.25);
      this._bank = THREE.MathUtils.lerp(this._bank || 0, bank, 0.08);
      cam.rotation.set(0, 0, 0);
      cam.rotation.order = 'YXZ';
      cam.rotation.y = this.yaw;
      cam.rotation.x = this.pitch;
      cam.rotation.z = this._bank;
      this.onTelemetry({
        agl: cam.position.y - Math.max(ground, 0),
        speed: this._vel.length(),
        heading: ((-this.yaw * 180) / Math.PI % 360 + 360) % 360,
        cruise: this.cruise,
      });
    }

    if (this.mode === 'cinematic' && this._path) {
      this._pathT = (this._pathT + dt * 0.022) % 1;
      const p = this._path.getPointAt(this._pathT);
      const look = this._path.getPointAt((this._pathT + 0.035) % 1);
      look.y -= 5;
      cam.position.lerp(p, 0.08);
      const m = new THREE.Matrix4().lookAt(cam.position, look, new THREE.Vector3(0, 1, 0));
      const q = new THREE.Quaternion().setFromRotationMatrix(m);
      cam.quaternion.slerp(q, 0.06);
    }
  }
}
