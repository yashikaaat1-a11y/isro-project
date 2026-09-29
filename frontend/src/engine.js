import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { createWater } from './water.js';

export const PLANE = 100;          // world size of the tile (long edge)
export const BASE_RELIEF = 4;      // world units of relief at 1x exaggeration
const SLAB_DEPTH = 3;

function skyMaterial() {
  return new THREE.ShaderMaterial({
    side: THREE.BackSide,
    depthWrite: false,
    uniforms: {
      top: { value: new THREE.Color(0x020617) },
      mid: { value: new THREE.Color(0x0b2447) },
      horizon: { value: new THREE.Color(0x19376d) },
    },
    vertexShader: `varying vec3 vP; void main(){ vP = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.); }`,
    fragmentShader: `uniform vec3 top; uniform vec3 mid; uniform vec3 horizon; varying vec3 vP;
      float h(vec3 p){ return fract(sin(dot(p, vec3(12.9898,78.233,37.719)))*43758.5453); }
      void main(){
        float y = vP.y;
        vec3 c = mix(horizon, mid, smoothstep(-0.05, 0.25, y));
        c = mix(c, top, smoothstep(0.25, 0.9, y));
        vec3 q = floor(vP * 380.);
        float s = step(0.9975, h(q)) * smoothstep(0.1, 0.6, y);
        c += s * 0.8;
        gl_FragColor = vec4(c, 1.);
        #include <colorspace_fragment>
      }`,
  });
}

export class Engine {
  constructor(canvas) {
    this.canvas = canvas;
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;

    this.scene = new THREE.Scene();
    this.scene.fog = new THREE.Fog(0x0b1a33, 180, 520);
    this.camera = new THREE.PerspectiveCamera(50, 1, 0.1, 2000);
    this.camera.position.set(90, 95, 115);

    this.controls = new OrbitControls(this.camera, canvas);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.maxPolarAngle = Math.PI * 0.49;
    this.controls.minDistance = 8;
    this.controls.maxDistance = 320;

    this.clock = new THREE.Clock();
    this.onFrame = [];
    this.aspect = 1;              // tile height / width
    this.exaggeration = 3;
    this.floodLevel = 0;          // 0..100 relative units

    this._buildEnvironment();
    this._buildTerrain();
    this._resize();
    new ResizeObserver(() => this._resize()).observe(canvas.parentElement);
    this.renderer.setAnimationLoop(() => this._tick());
  }

  get dispScale() { return BASE_RELIEF * this.exaggeration; }

  _buildEnvironment() {
    const s = this.scene;
    s.add(new THREE.Mesh(new THREE.SphereGeometry(900, 32, 16), skyMaterial()));
    s.add(new THREE.HemisphereLight(0xbfd9ff, 0x2a2016, 0.55));
    s.add(new THREE.AmbientLight(0xffffff, 0.12));
    const sun = new THREE.DirectionalLight(0xfff1dc, 2.4);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    const sc = sun.shadow.camera;
    sc.left = -75; sc.right = 75; sc.top = 75; sc.bottom = -75; sc.near = 1; sc.far = 400;
    sun.shadow.bias = -0.0006;
    sun.shadow.normalBias = 0.4;
    s.add(sun, sun.target);
    this.sun = sun;
    this.setSun(135, 42);

    const grid = new THREE.GridHelper(420, 42, 0x1e3a5f, 0x10213b);
    grid.position.y = -SLAB_DEPTH - 0.05;
    grid.material.transparent = true;
    grid.material.opacity = 0.35;
    s.add(grid);
    this.grid = grid;
  }

  setSun(azimuthDeg, elevationDeg) {
    const az = THREE.MathUtils.degToRad(azimuthDeg);
    const el = THREE.MathUtils.degToRad(elevationDeg);
    const r = 160;
    this.sun.position.set(Math.sin(az) * Math.cos(el) * r, Math.sin(el) * r, Math.cos(az) * Math.cos(el) * r);
    this.sunDir = this.sun.position.clone().normalize();
    if (this.water) this.water.material.uniforms.uSunDir.value.copy(this.sunDir);
  }

  _buildTerrain(segments = 256) {
    const blank = document.createElement('canvas');
    blank.width = blank.height = 2;
    this.depthTex = new THREE.CanvasTexture(blank);
    this.material = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      roughness: 0.92,
      metalness: 0.0,
      displacementMap: this.depthTex,
      displacementScale: this.dispScale,
    });
    this.terrain = new THREE.Mesh(new THREE.PlaneGeometry(PLANE, PLANE, segments, segments), this.material);
    this.terrain.rotation.x = -Math.PI / 2;
    this.terrain.castShadow = true;
    this.terrain.receiveShadow = true;
    this.scene.add(this.terrain);

    this.water = createWater(this.depthTex);
    this.water.visible = false;
    this.scene.add(this.water);

    this.skirtMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1, side: THREE.DoubleSide });
    this.skirt = new THREE.Mesh(new THREE.BufferGeometry(), this.skirtMat);
    this.skirt.receiveShadow = true;
    this.scene.add(this.skirt);

    const frameMat = new THREE.LineBasicMaterial({ color: 0x22d3ee, transparent: true, opacity: 0.8 });
    this.frame = new THREE.LineLoop(new THREE.BufferGeometry(), frameMat);
    this.scene.add(this.frame);

    // Sweep bar shown while inference runs.
    const scanMat = new THREE.MeshBasicMaterial({
      color: 0x22d3ee, transparent: true, opacity: 0.35, side: THREE.DoubleSide,
      blending: THREE.AdditiveBlending, depthWrite: false,
    });
    this.scan = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), scanMat);
    this.scan.visible = false;
    this.scene.add(this.scan);
  }

  setSegments(n) {
    this.terrain.geometry.dispose();
    this.terrain.geometry = new THREE.PlaneGeometry(PLANE, PLANE, n, n);
  }

  /** Install a new tile. `field` is a HeightField; `colorCanvas` the visible layer. */
  setTile(field, depthCanvas, colorCanvasOrImage) {
    this.field = field;
    this.aspect = field.h / field.w;
    const sx = 1, sz = this.aspect;
    this.terrain.scale.set(sx, sz, 1);
    this.water.scale.set(sx, sz, 1);

    this.depthTex.dispose();
    this.depthTex = new THREE.CanvasTexture(depthCanvas);
    this.depthTex.colorSpace = THREE.NoColorSpace;
    this.material.displacementMap = this.depthTex;
    this.water.material.uniforms.uDepth.value = this.depthTex;
    this.setColor(colorCanvasOrImage);
    this._updateNormals();
    this._updateSkirt();
    this._updateFrame();
    this.material.needsUpdate = true;
  }

  setColor(src) {
    if (this.colorTex) this.colorTex.dispose();
    this.colorTex = src instanceof HTMLCanvasElement ? new THREE.CanvasTexture(src) : new THREE.Texture(src);
    this.colorTex.colorSpace = THREE.SRGBColorSpace;
    this.colorTex.anisotropy = this.renderer.capabilities.getMaxAnisotropy();
    this.colorTex.needsUpdate = true;
    this.material.map = this.colorTex;
    this.material.needsUpdate = true;
  }

  setWireframe(on) { this.material.wireframe = on; }

  setExaggeration(x) {
    this.exaggeration = x;
    this.material.displacementScale = this.dispScale;
    clearTimeout(this._nt);
    this._nt = setTimeout(() => this._updateNormals(), 60);
    this._updateSkirt();
    this._updateFrame();
    this.setFloodLevel(this.floodLevel);
  }

  _updateNormals() {
    if (!this.field) return;
    if (this.normalTex) this.normalTex.dispose();
    this.normalTex = new THREE.CanvasTexture(this.field.normalCanvas(this.dispScale, PLANE));
    this.normalTex.colorSpace = THREE.NoColorSpace;
    this.material.normalMap = this.normalTex;
    this.material.needsUpdate = true;
  }

  setFloodLevel(level100) {
    this.floodLevel = level100;
    const lvl = level100 / 100;
    this.water.visible = level100 > 0.05;
    this.water.position.y = lvl * this.dispScale;
    this.water.material.uniforms.uLevel.value = lvl;
  }

  /** World (x,z) -> tile uv (v=0 at top row of image). */
  worldToUV(x, z) {
    const w = PLANE, d = PLANE * this.aspect;
    return { u: x / w + 0.5, v: z / d + 0.5 };
  }

  uvToWorld(u, v) {
    return { x: (u - 0.5) * PLANE, z: (v - 0.5) * PLANE * this.aspect };
  }

  heightAtUV(u, v) {
    if (!this.field) return 0;
    return (this.field.sample(u, v) / 255) * this.dispScale;
  }

  heightAtWorld(x, z) {
    const { u, v } = this.worldToUV(x, z);
    if (u < 0 || u > 1 || v < 0 || v > 1) return -SLAB_DEPTH;
    return this.heightAtUV(u, v);
  }

  /** March a ray against the heightfield (three's raycaster ignores displacement). */
  pick(ndcX, ndcY) {
    if (!this.field) return null;
    const ray = new THREE.Raycaster();
    ray.setFromCamera({ x: ndcX, y: ndcY }, this.camera);
    const o = ray.ray.origin, dir = ray.ray.direction;
    const maxT = 1500;
    let step = 0.4, t = 0, prevT = 0;
    let above = o.y > this.heightAtWorld(o.x, o.z);
    if (!above) return null;
    for (; t < maxT; t += step) {
      const x = o.x + dir.x * t, y = o.y + dir.y * t, z = o.z + dir.z * t;
      if (y < -SLAB_DEPTH - 1) break;
      const { u, v } = this.worldToUV(x, z);
      if (u >= 0 && u <= 1 && v >= 0 && v <= 1 && y <= this.heightAtUV(u, v)) {
        let a = prevT, b = t;
        for (let i = 0; i < 18; i++) {
          const m = (a + b) / 2;
          const mx = o.x + dir.x * m, my = o.y + dir.y * m, mz = o.z + dir.z * m;
          if (my <= this.heightAtWorld(mx, mz)) b = m; else a = m;
        }
        const px = o.x + dir.x * b, pz = o.z + dir.z * b;
        const uv = this.worldToUV(px, pz);
        return { point: new THREE.Vector3(px, this.heightAtWorld(px, pz), pz), ...uv };
      }
      prevT = t;
      step = Math.min(2, 0.4 + t * 0.004);
    }
    return null;
  }

  _edgeSamples(n = 128) {
    const pts = [];
    const push = (u, v) => { const w = this.uvToWorld(u, v); pts.push([w.x, this.heightAtUV(u, v) + 0.02, w.z]); };
    for (let i = 0; i < n; i++) push(i / n, 0);
    for (let i = 0; i < n; i++) push(1, i / n);
    for (let i = 0; i < n; i++) push(1 - i / n, 1);
    for (let i = 0; i < n; i++) push(0, 1 - i / n);
    return pts;
  }

  _updateSkirt() {
    if (!this.field) return;
    const pts = this._edgeSamples(160);
    pts.push(pts[0]);
    const pos = [], col = [];
    const top = new THREE.Color(0x5b4636), bot = new THREE.Color(0x0f172a), band = new THREE.Color(0x7c5e45);
    for (let i = 0; i < pts.length - 1; i++) {
      const [x0, y0, z0] = pts[i], [x1, y1, z1] = pts[i + 1];
      const b = -SLAB_DEPTH;
      pos.push(x0, y0, z0, x0, b, z0, x1, y1, z1, x1, y1, z1, x0, b, z0, x1, b, z1);
      const cTop = i % 2 ? top : band;
      for (const c of [cTop, bot, cTop, cTop, bot, bot]) col.push(c.r, c.g, c.b);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    g.computeVertexNormals();
    this.skirt.geometry.dispose();
    this.skirt.geometry = g;
  }

  _updateFrame() {
    const w = PLANE / 2 + 0.6, d = (PLANE * this.aspect) / 2 + 0.6, y = -SLAB_DEPTH;
    this.frame.geometry.dispose();
    this.frame.geometry = new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(-w, y, -d), new THREE.Vector3(w, y, -d),
      new THREE.Vector3(w, y, d), new THREE.Vector3(-w, y, d),
    ]);
  }

  startScan() { this.scan.visible = true; this._scanT = 0; }
  stopScan() { this.scan.visible = false; }

  _resize() {
    const el = this.canvas.parentElement;
    const w = el.clientWidth, h = el.clientHeight;
    if (!w || !h) return;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  _tick() {
    const dt = Math.min(this.clock.getDelta(), 0.1);
    const t = this.clock.elapsedTime;
    this.water.material.uniforms.uTime.value = t;
    if (this.scan.visible) {
      this._scanT = (this._scanT + dt * 0.45) % 1;
      const d = PLANE * this.aspect;
      this.scan.rotation.set(0, Math.PI / 2, 0);
      this.scan.scale.set(d + 4, 36, 1);
      this.scan.position.set((this._scanT - 0.5) * PLANE, 12, 0);
    }
    for (const f of this.onFrame) f(dt, t);
    if (this.controls.enabled) this.controls.update();
    this.renderer.render(this.scene, this.camera);
  }

  screenshot() {
    this.renderer.render(this.scene, this.camera);
    return this.canvas.toDataURL('image/png');
  }
}
