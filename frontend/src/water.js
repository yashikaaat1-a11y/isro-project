import * as THREE from 'three';

// Flood plane shader. The plane is flat at the water level; per-fragment it
// compares that level with the terrain height (sampled from the same depth
// texture that drives displacement) to render depth-graded colour, shoreline
// foam and animated ripples — and discards dry fragments so no z-fighting.

const vertex = /* glsl */ `
  varying vec2 vUv;
  varying vec3 vWorld;
  void main() {
    vUv = uv;
    vec4 wp = modelMatrix * vec4(position, 1.0);
    vWorld = wp.xyz;
    gl_Position = projectionMatrix * viewMatrix * wp;
  }
`;

const fragment = /* glsl */ `
  uniform sampler2D uDepth;
  uniform float uLevel;      // water level, 0..1 of the depth range
  uniform float uTime;
  uniform vec3 uColor;
  uniform float uOpacity;
  uniform vec3 uSunDir;
  varying vec2 vUv;
  varying vec3 vWorld;

  float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
  float noise(vec2 p) {
    vec2 i = floor(p), f = fract(p);
    vec2 u = f * f * (3.0 - 2.0 * f);
    return mix(mix(hash(i), hash(i + vec2(1, 0)), u.x), mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), u.x), u.y);
  }

  void main() {
    float terrain = texture2D(uDepth, vUv).r;
    float depth = uLevel - terrain;
    if (depth <= 0.0) discard;

    vec2 p = vWorld.xz * 0.35;
    float t = uTime * 0.6;
    float h1 = noise(p + vec2(t, t * 0.7));
    float h2 = noise(p * 2.3 - vec2(t * 1.3, -t * 0.4));
    vec3 n = normalize(vec3((h1 - 0.5) * 0.5 + (h2 - 0.5) * 0.25, 1.0, (h2 - 0.5) * 0.5 - (h1 - 0.5) * 0.2));

    vec3 viewDir = normalize(cameraPosition - vWorld);
    float fresnel = pow(1.0 - max(dot(viewDir, n), 0.0), 3.0);
    vec3 halfV = normalize(normalize(uSunDir) + viewDir);
    float spec = pow(max(dot(n, halfV), 0.0), 90.0);

    float d = smoothstep(0.0, 0.22, depth);
    vec3 shallow = mix(uColor, vec3(0.35, 0.85, 0.95), 0.45);
    vec3 deep = uColor * 0.35;
    vec3 col = mix(shallow, deep, d);
    col = mix(col, vec3(0.75, 0.88, 1.0), fresnel * 0.45);
    col += spec * 0.9;

    float shore = 1.0 - smoothstep(0.0, 0.018, depth);
    float foamNoise = noise(vWorld.xz * 2.4 + t * 2.0);
    float foam = shore * smoothstep(0.35, 0.75, foamNoise + shore * 0.4);
    col = mix(col, vec3(0.95, 0.98, 1.0), foam * 0.85);

    float alpha = mix(uOpacity * 0.55, min(uOpacity + 0.3, 0.95), d);
    alpha = max(alpha, foam * 0.9);
    gl_FragColor = vec4(col, alpha);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`;

export function createWater(depthTexture) {
  const material = new THREE.ShaderMaterial({
    vertexShader: vertex,
    fragmentShader: fragment,
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    uniforms: {
      uDepth: { value: depthTexture },
      uLevel: { value: 0 },
      uTime: { value: 0 },
      uColor: { value: new THREE.Color(0x0077be) },
      uOpacity: { value: 0.6 },
      uSunDir: { value: new THREE.Vector3(0.5, 0.8, 0.3) },
    },
  });
  const geo = new THREE.PlaneGeometry(100, 100, 1, 1);
  const mesh = new THREE.Mesh(geo, material);
  mesh.rotation.x = -Math.PI / 2;
  mesh.renderOrder = 2;
  return mesh;
}
