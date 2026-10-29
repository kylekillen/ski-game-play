// Everything on the mountain that is not snow, rails or the rider: forest, the chairlift, the start
// area, the base village, park dressing, rock outcrops and the ring of distant peaks.
//
// Prior art this follows:
//  - conifers as instanced "frond cards" round a trunk (alpha-cut needle sprays in whorls, the way
//    SpeedTree / most open-world games build spruce), a coarser card tree for the distance and a
//    dithered cross-fade between them (the usual screen-door LOD fade, e.g. Unity's LOD cross-fade).
//    Anti-aliased alpha test after Ben Golus, "Anti-aliased Alpha Test: The Esoteric Alpha To
//    Coverage" (alpha sharpened by fwidth, mip-scaled so far cards don't thin out).
//  - snow on branches / roofs / rocks from the world-space up-facing normal plus noise (the standard
//    "snow accumulation by normal" shader trick).
//  - tree and building shadows on the snow far from the skater as cheap projected "shadow decals"
//    (cone/box shadows projected along the sun onto the height field, multiplied into the snow),
//    faded out wherever gfx's real shadow cascades already cover - the classic blob/projected shadow.
//  - distant mountains: ridged multifractal noise (Musgrave, "Texturing & Modeling"), domain-warped,
//    snow by slope and height, its own aerial perspective (the lens haze thins out at altitude).
//  - fixed-grip quad chairlift proportions from typical fixed-grip quads: towers ~55-70 m apart,
//    ~5.2 m line gauge, chairs every ~25 m at ~2.5 m/s.
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { ground, runHalf, runCenter, baseY, fbm, FEATURES, RAILS, JUMPS, Z0, Z1 } from './terrain.js';

const V = (x = 0, y = 0, z = 0) => new THREE.Vector3(x, y, z);
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const sstep = (a, b, v) => { const t = clamp((v - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
const lerp = (a, b, t) => a + (b - a) * t;
function mulberry(seed) { return () => { seed |= 0; seed = seed + 0x6D2B79F5 | 0; let t = Math.imul(seed ^ seed >>> 15, 1 | seed); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }

// ── where the world is drawn (world.js): fine chunks |x|<160, then one 8 m mountainside mesh ──
const MS = 8, MX = 1400, MZ0 = Z0 - 700, MZ1 = Z1 + 500;
// the height of the snow as DRAWN: on the 8 m mesh a flat triangle sits a little off ground()
export function surfY(x, z) {
  if (Math.abs(x) < 156) return ground(x, z);
  const fx = (x + MX) / MS, fz = (z - MZ0) / MS, i = Math.floor(fx), j = Math.floor(fz), u = fx - i, v = fz - j;
  const x0 = -MX + i * MS, z0 = MZ0 + j * MS, hb = ground(x0 + MS, z0), hc = ground(x0, z0 + MS);
  if (u + v < 1) { const ha = ground(x0, z0); return ha + (hb - ha) * u + (hc - ha) * v; }
  const hd = ground(x0 + MS, z0 + MS); return hd + (hc - hd) * (1 - u) + (hb - hd) * (1 - v);
}
const slopeAt = (x, z, e = 3) => Math.hypot(ground(x + e, z, true) - ground(x - e, z, true), ground(x, z + e, true) - ground(x, z - e, true)) / (2 * e);

// ── the lift line (exported so the game can keep cameras / riders off it) ──
// x = run centre + run half-width + 18 (the half-width without the base-area widening, so the line stays straight there)
export function liftX(z) { return runCenter(z) + 62 + 10 * Math.sin(z * 0.004 + 1.2) + 18; }
export const LIFT = { zTop: -40, zBase: 1480, gauge: 5.2, speed: 2.5, spacing: 25 };

// ───────────────────────────── geometry helpers ─────────────────────────────
const _m = new THREE.Matrix4(), _q = new THREE.Quaternion(), _e = new THREE.Euler(), _s = new THREE.Vector3(), _p = new THREE.Vector3();
function M(x = 0, y = 0, z = 0, ry = 0, rx = 0, rz = 0, sx = 1, sy = 1, sz = 1) {
  return new THREE.Matrix4().compose(_p.set(x, y, z), _q.setFromEuler(_e.set(rx, ry, rz, 'YXZ')), _s.set(sx, sy, sz));
}
// matrix that takes the unit +Y cylinder onto the segment a->b, with radius r
function segM(a, b, r = 1) {
  const d = V().subVectors(b, a), len = d.length();
  _q.setFromUnitVectors(V(0, 1, 0), d.multiplyScalar(1 / len));
  return new THREE.Matrix4().compose(V().addVectors(a, b).multiplyScalar(0.5), _q, _s.set(r, len, r));
}
const unitCyl = (seg = 8, open = false) => new THREE.CylinderGeometry(1, 1, 1, seg, 1, open);

// A Builder collects pieces per material and merges them (one draw call per material per builder).
// Each piece gets a vertex colour; `wuv` = metres per texture repeat for world-space box UVs.
class Builder {
  constructor() { this.parts = new Map(); }
  add(key, geo, m4, color = 0xffffff, { wuv = 0, uvRect = null, fl = null } = {}) {
    const g = geo.clone();
    if (!g.index) { const n = g.attributes.position.count, ix = new Uint32Array(n); for (let i = 0; i < n; i++) ix[i] = i; g.setIndex(new THREE.BufferAttribute(ix, 1)); }
    if (m4) g.applyMatrix4(m4);
    for (const k of Object.keys(g.attributes)) if (!['position', 'normal', 'uv'].includes(k)) g.deleteAttribute(k);
    g.morphAttributes = {};
    if (!g.attributes.normal) g.computeVertexNormals();
    const n = g.attributes.position.count;
    if (!g.attributes.uv) g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(n * 2), 2));
    if (wuv) worldUV(g, wuv);
    if (uvRect) { const uv = g.attributes.uv; for (let i = 0; i < n; i++) uv.setXY(i, lerp(uvRect[0], uvRect[2], uv.getX(i)), lerp(uvRect[1], uvRect[3], uv.getY(i))); }
    const c = new THREE.Color(color), col = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) { col[i * 3] = c.r; col[i * 3 + 1] = c.g; col[i * 3 + 2] = c.b; }
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    // flutter: (amplitude, phase, along 0..1, speed) + the direction "along" the cloth in world space
    const fa = new Float32Array(n * 4), ta = new Float32Array(n * 3);
    if (fl) {
      const pos = g.attributes.position, o = fl.origin, t = fl.dir;
      for (let i = 0; i < n; i++) {
        const along = clamp(((pos.getX(i) - o.x) * t.x + (pos.getY(i) - o.y) * t.y + (pos.getZ(i) - o.z) * t.z) / fl.len, 0, 1);
        fa[i * 4] = fl.amp; fa[i * 4 + 1] = fl.phase; fa[i * 4 + 2] = along; fa[i * 4 + 3] = fl.freq || 1;
        ta[i * 3] = t.x; ta[i * 3 + 1] = t.y; ta[i * 3 + 2] = t.z;
      }
    }
    g.setAttribute('aFl', new THREE.BufferAttribute(fa, 4)); g.setAttribute('aT', new THREE.BufferAttribute(ta, 3));
    if (!this.parts.has(key)) this.parts.set(key, []);
    this.parts.get(key).push(g);
    return g;
  }
  build(group, mats, { layer1 = false } = {}) {
    const out = [];
    for (const [key, list] of this.parts) {
      const g = mergeGeometries(list, false); if (!g) { console.error('scenery: merge failed', key); continue; }
      g.computeBoundingSphere();
      const mesh = new THREE.Mesh(g, mats[key]);
      mesh.castShadow = key !== 'glass'; mesh.receiveShadow = true; mesh.matrixAutoUpdate = false; mesh.updateMatrix();
      if (layer1) mesh.layers.enable(1);
      mesh.name = 'scenery:' + key; group.add(mesh); out.push(mesh);
    }
    this.parts.clear();
    return out;
  }
}
// box-projected UVs in world metres (texture repeats every `s` m)
function worldUV(g, s) {
  const p = g.attributes.position, n = g.attributes.normal, uv = g.attributes.uv;
  for (let i = 0; i < p.count; i++) {
    const ax = Math.abs(n.getX(i)), ay = Math.abs(n.getY(i)), az = Math.abs(n.getZ(i));
    let u, v;
    if (ay >= ax && ay >= az) { u = p.getX(i); v = p.getZ(i); } else if (ax >= az) { u = p.getZ(i); v = p.getY(i); } else { u = p.getX(i); v = p.getY(i); }
    uv.setXY(i, u / s, v / s);
  }
}

// ───────────────────────────── textures ─────────────────────────────
function texLoader(gfx) {
  const tl = new THREE.TextureLoader(), cache = new Map();
  return (name, srgb = false) => {
    if (cache.has(name)) return cache.get(name);
    const t = tl.load('./assets/tex/' + name); t.wrapS = t.wrapT = THREE.RepeatWrapping; t.anisotropy = gfx.aniso || 8;
    if (srgb) t.colorSpace = THREE.SRGBColorSpace;
    cache.set(name, t); return t;
  };
}
const FONT = '"Futura", "Avenir Next Condensed", "Avenir Next", "Helvetica Neue", Arial, sans-serif';

// a simple shelf packer over one big canvas: every printed thing (signs, banners, flags) shares it
class Atlas {
  constructor(w, h) { this.c = document.createElement('canvas'); this.c.width = w; this.c.height = h; this.ctx = this.c.getContext('2d'); this.x = 0; this.y = 0; this.rowH = 0; this.W = w; this.H = h; }
  alloc(w, h) {
    if (this.x + w > this.W) { this.x = 0; this.y += this.rowH + 4; this.rowH = 0; }
    const r = { x: this.x, y: this.y, w, h }; this.x += w + 4; this.rowH = Math.max(this.rowH, h);
    if (this.y + h > this.H) console.error('scenery: atlas full');
    r.uv = [(r.x + 1) / this.W, 1 - (r.y + h - 1) / this.H, (r.x + w - 1) / this.W, 1 - (r.y + 1) / this.H];   // [u0,v0,u1,v1], flipY
    return r;
  }
}
function fitText(ctx, text, maxW, size, weight = '800') { let s = size; do { ctx.font = `${weight} ${s}px ${FONT}`; s -= 2; } while (ctx.measureText(text).width > maxW && s > 8); return s; }
// the park's own mark: two peaks with a snow line through them
function drawLogo(ctx, cx, cy, s, col = '#fff', accent = '#ff7a1a') {
  ctx.save(); ctx.translate(cx, cy); ctx.scale(s, s);
  ctx.fillStyle = col; ctx.beginPath(); ctx.moveTo(-1, 0.62); ctx.lineTo(-0.28, -0.55); ctx.lineTo(0.05, -0.05); ctx.lineTo(0.32, -0.38); ctx.lineTo(1, 0.62); ctx.closePath(); ctx.fill();
  ctx.fillStyle = accent; ctx.beginPath(); ctx.moveTo(-1.05, 0.3); ctx.quadraticCurveTo(0, 0.05, 1.05, 0.22); ctx.lineTo(1.05, 0.34); ctx.quadraticCurveTo(0, 0.17, -1.05, 0.42); ctx.closePath(); ctx.fill();
  ctx.restore();
}
function noiseFill(ctx, x, y, w, h, base, amt, rnd, n = 900, sz = 3) {
  ctx.fillStyle = base; ctx.fillRect(x, y, w, h);
  for (let i = 0; i < n; i++) { const l = (rnd() - 0.5) * amt; ctx.fillStyle = l > 0 ? `rgba(255,255,255,${l})` : `rgba(0,0,0,${-l})`; ctx.fillRect(x + rnd() * w, y + rnd() * h, sz + rnd() * sz, sz + rnd() * sz); }
}

// ── the conifer atlas: needle spray (alpha), bark, dense inner foliage ──
function treeAtlas(loadImg) {
  const S = 1024, c = document.createElement('canvas'); c.width = c.height = S;
  const ctx = c.getContext('2d'), rnd = mulberry(77);
  const H = 512, cy = H / 2;
  const needle = (x, y, ang, len, w, col) => { ctx.strokeStyle = col; ctx.lineWidth = w; ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x + Math.cos(ang) * len, y + Math.sin(ang) * len); ctx.stroke(); };
  const greens = ['#1d3324', '#22392a', '#284330', '#1a2d22', '#2d4a35', '#31503a', '#3a5a40'];
  ctx.lineCap = 'round';
  const axisLen = S - 40;
  const twig = (x0, y0, ang, len, depth) => {
    const steps = Math.max(4, Math.round(len / 7));
    for (let i = 0; i < steps; i++) {
      const t = i / steps, x = x0 + Math.cos(ang) * len * t, y = y0 + Math.sin(ang) * len * t;
      const nl = (depth ? 15 : 22) * (1 - 0.45 * t) * (0.8 + rnd() * 0.4);
      for (const sd of [-1, 1]) for (let k = 0; k < 2; k++) needle(x, y, ang + sd * (0.75 + rnd() * 0.5), nl, depth ? 2.2 : 2.8, greens[(rnd() * greens.length) | 0]);
    }
    ctx.strokeStyle = '#3b2c20'; ctx.lineWidth = depth ? 2 : 3; ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x0 + Math.cos(ang) * len, y0 + Math.sin(ang) * len); ctx.stroke();
  };
  // side twigs along the axis, longest in the middle (narrow at the trunk, round, pointed tip)
  for (let i = 0; i < 38; i++) {
    const t = (i + 0.5) / 38, x = 20 + axisLen * t;
    const env = Math.sin(Math.PI * Math.min(1, t * 1.05)) ** 0.7 * (t < 0.1 ? t / 0.1 : 1);
    for (const sd of [-1, 1]) {
      const len = (cy - 18) * env * (0.75 + rnd() * 0.3) / Math.sin(0.95);
      if (len > 12) twig(x, cy + (rnd() - 0.5) * 6, sd * (0.9 + rnd() * 0.25), len, 0);
    }
  }
  twig(20, cy, 0, axisLen, 1);
  // darker toward the trunk, lighter new growth at the tips
  ctx.globalCompositeOperation = 'source-atop';
  const gr = ctx.createLinearGradient(0, 0, S, 0); gr.addColorStop(0, 'rgba(0,0,0,0.35)'); gr.addColorStop(0.55, 'rgba(0,0,0,0)'); gr.addColorStop(1, 'rgba(120,150,120,0.18)');
  ctx.fillStyle = gr; ctx.fillRect(0, 0, S, H);
  ctx.globalCompositeOperation = 'source-over';
  // dense inner foliage (opaque), bottom-right quarter
  noiseFill(ctx, 512, 512, 512, 512, '#1b2e22', 0.25, rnd, 6000, 4);
  for (let i = 0; i < 2500; i++) needle(512 + rnd() * 512, 512 + rnd() * 512, rnd() * 6.28, 10 + rnd() * 10, 2.4, greens[(rnd() * greens.length) | 0]);
  // bark, bottom-left quarter (the photo when it loads)
  noiseFill(ctx, 0, 512, 512, 512, '#4a3b30', 0.3, rnd, 3000, 3);
  const tex = new THREE.CanvasTexture(c); tex.colorSpace = THREE.SRGBColorSpace; tex.anisotropy = 8;
  loadImg('./assets/tex/bark_diff.jpg', (img) => { ctx.drawImage(img, 0, 512, 512, 512); tex.needsUpdate = true; });
  return { tex, frond: [0.02, 0.5, 0.99, 1.0], bark: [0, 0, 0.5, 0.5], core: [0.52, 0.02, 0.98, 0.48] };
}

// orange snow-fence mesh: diamond holes (alpha)
function fenceTexture() {
  const c = document.createElement('canvas'); c.width = 256; c.height = 256; const ctx = c.getContext('2d');
  ctx.fillStyle = '#ff6a14';
  ctx.fillRect(0, 0, 256, 18); ctx.fillRect(0, 238, 256, 18);
  ctx.save(); ctx.beginPath(); ctx.rect(0, 18, 256, 220); ctx.clip();
  ctx.strokeStyle = '#ff6a14'; ctx.lineWidth = 9;
  for (let i = -8; i < 16; i++) { ctx.beginPath(); ctx.moveTo(i * 32, 0); ctx.lineTo(i * 32 + 256, 256); ctx.stroke(); ctx.beginPath(); ctx.moveTo(i * 32 + 256, 0); ctx.lineTo(i * 32, 256); ctx.stroke(); }
  ctx.restore();
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.wrapS = THREE.RepeatWrapping; t.anisotropy = 8; return t;
}

// ───────────────────────────── shader snippets ─────────────────────────────
const NOISE_GLSL = /* glsl */`
  float scH13(vec3 p) { p = fract(p * 0.1031); p += dot(p, p.zyx + 31.32); return fract((p.x + p.y) * p.z); }
  float scNoise(vec3 x) { vec3 i = floor(x), f = fract(x); f = f * f * (3.0 - 2.0 * f);
    return mix(mix(mix(scH13(i), scH13(i + vec3(1,0,0)), f.x), mix(scH13(i + vec3(0,1,0)), scH13(i + vec3(1,1,0)), f.x), f.y),
               mix(mix(scH13(i + vec3(0,0,1)), scH13(i + vec3(1,0,1)), f.x), mix(scH13(i + vec3(0,1,1)), scH13(i + vec3(1,1,1)), f.x), f.y), f.z); }
  float scIgn(vec2 p) { return fract(52.9829189 * fract(dot(p, vec2(0.06711056, 0.00583715)))); }`;

// snow resting on up-facing surfaces (trees, roofs, rocks): world normal + noise
function addSnow(s, { amount = '1.0', scale = '1.6', lo = '0.25', hi = '0.62', rough = '0.78' } = {}) {
  s.fragmentShader = s.fragmentShader.replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>
    {
      vec3 nW = normalize((vec4(normal, 0.0) * viewMatrix).xyz);
      float nz = scNoise(vScW * ${scale}) * 0.65 + scNoise(vScW * ${scale} * 4.1) * 0.35;
      float sn = smoothstep(${lo}, ${hi}, nW.y + (nz - 0.5) * 0.7) * (${amount});
      diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.86, 0.89, 0.93), sn);
      vScSnow = sn;
    }`).replace('#include <lights_fragment_begin>', `material.roughness = mix(material.roughness, ${rough}, vScSnow);\n#include <lights_fragment_begin>`);
}
function worldVarying(s) {
  s.vertexShader = s.vertexShader.replace('#include <common>', '#include <common>\nvarying vec3 vScW;')
    .replace('#include <project_vertex>', `#include <project_vertex>
      #ifdef USE_INSTANCING
        vScW = (modelMatrix * instanceMatrix * vec4(transformed, 1.0)).xyz;
      #else
        vScW = (modelMatrix * vec4(transformed, 1.0)).xyz;
      #endif`);
  s.fragmentShader = s.fragmentShader.replace('#include <common>', '#include <common>\nvarying vec3 vScW;\nfloat vScSnow = 0.0;\n' + NOISE_GLSL);
}

// ═══════════════════════════════════════════════════════════════════════════
export function buildScenery(scene, gfx, T = {}) {
  const t0 = performance.now();
  const group = new THREE.Group(); group.name = 'scenery'; scene.add(group);
  const Q = gfx.quality?.name || T.graphicsQuality || 'high';
  const tex = texLoader(gfx);
  const loadImg = (url, cb) => { const im = new Image(); im.onload = () => cb(im); im.src = url; };
  const timeU = { value: 0 }, camU = { value: new THREE.Vector3(0, 400, 0) };
  const sunDir = gfx.sunDir || V(0.5, 0.8, 0.3);
  const rnd = mulberry(20261028);

  // ── shared materials ──
  const std = (o) => new THREE.MeshStandardMaterial(o);
  const mats = {
    timber: std({ map: tex('planks_diff.jpg', true), normalMap: tex('planks_nor.jpg'), roughnessMap: tex('planks_arm.jpg'), vertexColors: true, roughness: 1, metalness: 0, normalScale: new THREE.Vector2(0.8, 0.8) }),
    steel: std({ vertexColors: true, metalness: 0.75, roughness: 0.42, normalMap: tex('metal_nor.jpg'), normalScale: new THREE.Vector2(0.25, 0.25) }),
    paint: std({ vertexColors: true, metalness: 0.0, roughness: 0.55 }),
    rubber: std({ vertexColors: true, metalness: 0.0, roughness: 0.85 }),
    stone: std({ map: tex('rock_diff.jpg', true), normalMap: tex('rock_nor.jpg'), vertexColors: true, roughness: 0.9 }),
    glass: new THREE.MeshPhysicalMaterial({ color: 0x141c24, roughness: 0.03, metalness: 0.0, ior: 2.0, specularIntensity: 1, envMapIntensity: 2.4 }),   // coated glazing: reflects the sky and snow
    roofSnow: std({ color: 0xf4f7fb, roughness: 0.8, normalMap: tex('snow_nor.jpg'), normalScale: new THREE.Vector2(0.6, 0.6), vertexColors: true }),
    metalRoof: std({ vertexColors: true, metalness: 0.6, roughness: 0.48, map: tex('metal_diff.jpg', true) }),
    cable: std({ vertexColors: true, metalness: 0.9, roughness: 0.35 }),
  };
  // printed things share one atlas and one material; cloth flutters in the vertex shader
  const atlas = new Atlas(2048, 4096);
  const printTex = new THREE.CanvasTexture(atlas.c); printTex.colorSpace = THREE.SRGBColorSpace; printTex.anisotropy = gfx.aniso || 8;
  mats.print = std({ map: printTex, vertexColors: true, roughness: 0.62, side: THREE.DoubleSide, alphaTest: 0.5 });
  mats.fence = std({ map: fenceTexture(), color: 0xffffff, roughness: 0.6, side: THREE.DoubleSide, alphaTest: 0.5, vertexColors: true });
  for (const k of ['print', 'fence']) {
    const m = mats[k];
    m.onBeforeCompile = (s) => {
      s.uniforms.uTime = timeU;
      s.vertexShader = s.vertexShader.replace('#include <common>', '#include <common>\nuniform float uTime; attribute vec4 aFl; attribute vec3 aT;')
        .replace('#include <beginnormal_vertex>', `#include <beginnormal_vertex>
          float flA = aFl.x * pow(aFl.z, 1.25), flPh = uTime * 7.0 * aFl.w - aFl.z * 6.0 + aFl.y;
          float flW = sin(flPh) + 0.35 * sin(flPh * 2.3 + 1.7);
          objectNormal = normalize(objectNormal - aT * aFl.x * pow(aFl.z, 0.25) * 4.0 * cos(flPh));`)
        .replace('#include <begin_vertex>', `#include <begin_vertex>
          transformed += normal * flA * flW;`);
    };
    m.customProgramCacheKey = () => 'scenery-cloth-' + k;
  }
  mats.roofSnow.onBeforeCompile = (s) => { worldVarying(s); s.fragmentShader = s.fragmentShader.replace('#include <normal_fragment_maps>', `
      { vec3 nm = texture2D(normalMap, vScW.xz / 3.0).xyz * 2.0 - 1.0; normal = normalize(normal + (viewMatrix * vec4(nm.x, 0.0, nm.y, 0.0)).xyz * 0.25); }`); };
  mats.roofSnow.customProgramCacheKey = () => 'scenery-roofsnow';
  // snow settles on flat-ish tops of roofs, stone and timber
  for (const k of ['metalRoof', 'stone', 'timber']) {
    const m = mats[k], amt = k === 'timber' ? '0.55' : k === 'stone' ? '0.8' : '0.9';
    m.onBeforeCompile = (s) => { worldVarying(s); addSnow(s, { amount: amt, lo: k === 'timber' ? '0.82' : '0.55', hi: '0.95', scale: '2.0' }); };
    m.customProgramCacheKey = () => 'scenery-snowy-' + k;
  }

  // ── keep-outs: features, rails, buildings, the lift corridor ──
  const KEEP = [];
  const keep = (x0, x1, z0, z1) => KEEP.push({ x0: Math.min(x0, x1), x1: Math.max(x0, x1), z0: Math.min(z0, z1), z1: Math.max(z0, z1) });
  for (const f of FEATURES) keep(f.xMin - 3, f.xMax + 3, f.zMin - 3, f.zMax + 3);
  for (const r of RAILS) { const a = r.pts[0], b = r.pts[r.pts.length - 1]; keep(a[0] - 6, a[0] + 6, a[2] - 10, b[2] + 8); }
  const inKeep = (x, z, m = 0) => { for (const k of KEEP) if (x > k.x0 - m && x < k.x1 + m && z > k.z0 - m && z < k.z1 + m) return true; return false; };
  // anything placed ON the run keeps >m metres in x from every feature/rail line (or is outside its z range)
  const lineClear = (x, z, m = 4) => {
    for (const f of FEATURES) if (z > f.zMin - 4 && z < f.zMax + 4 && Math.abs(x - f.x) < f.w / 2 + m) return false;
    for (const r of RAILS) { const a = r.pts[0], b = r.pts[r.pts.length - 1]; if (z > a[2] - 8 && z < b[2] + 6 && Math.abs(x - a[0]) < 1.5 + m) return false; }
    return true;
  };

  const B = { top: new Builder(), base: new Builder(), lift: new Builder(), run: new Builder() };
  const shadowCasters = [];      // for the projected shadows: {kind:'tree'|'seg'|'box', ...}

  // ═══════════ printed graphics ═══════════
  const P = {};
  {
    const ctx = atlas.ctx;
    // banner: SNOWLINE PARK (front and back are separate cells so both read the right way round)
    for (const side of ['bannerF', 'bannerB']) {
      const r = P[side] = atlas.alloc(2048, 220);
      const g = ctx.createLinearGradient(0, r.y, 0, r.y + r.h); g.addColorStop(0, '#163a6b'); g.addColorStop(1, '#0d2244');
      ctx.fillStyle = g; ctx.fillRect(r.x, r.y, r.w, r.h);
      ctx.fillStyle = '#ff7a1a'; ctx.fillRect(r.x, r.y + r.h - 22, r.w, 10); ctx.fillRect(r.x, r.y + 12, r.w, 4);
      ctx.fillStyle = '#ffffff'; fitText(ctx, 'SNOWLINE PARK', 1500, 150, '800');
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      if ('letterSpacing' in ctx) ctx.letterSpacing = '14px';
      ctx.fillText('SNOWLINE PARK', r.x + r.w / 2 + 7, r.y + r.h / 2 + 4);
      if ('letterSpacing' in ctx) ctx.letterSpacing = '0px';
      drawLogo(ctx, r.x + 150, r.y + r.h / 2, 85); drawLogo(ctx, r.x + r.w - 150, r.y + r.h / 2, 85);
    }
    // feather flags (shape cut by alpha): 4 colourways
    const feather = [['#ff6a14', '#ffffff', 'SNOWLINE'], ['#123a6e', '#ff8a2a', 'PARK'], ['#ffffff', '#123a6e', 'SNOWLINE'], ['#1f8a8a', '#ffffff', 'FREESTYLE']];
    feather.forEach(([bg, fg, word], i) => {
      const r = P['feather' + i] = atlas.alloc(200, 800);
      ctx.save(); ctx.beginPath();
      ctx.moveTo(r.x + 2, r.y + 790); ctx.lineTo(r.x + 2, r.y + 60);
      ctx.quadraticCurveTo(r.x + 2, r.y + 2, r.x + 90, r.y + 6); ctx.quadraticCurveTo(r.x + 196, r.y + 20, r.x + 192, r.y + 150);
      ctx.lineTo(r.x + 170, r.y + 700); ctx.lineTo(r.x + 2, r.y + 790); ctx.closePath(); ctx.clip();
      ctx.fillStyle = bg; ctx.fillRect(r.x, r.y, r.w, r.h);
      ctx.fillStyle = fg; ctx.globalAlpha = 0.9; ctx.fillRect(r.x, r.y + 620, r.w, 26); ctx.globalAlpha = 1;
      ctx.translate(r.x + 100, r.y + 380); ctx.rotate(-Math.PI / 2);
      ctx.fillStyle = fg; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; fitText(ctx, word, 480, 110, '800'); ctx.fillText(word, 0, 0);
      ctx.restore();
      drawLogo(ctx, r.x + 96, r.y + 700, 34, fg, bg === '#ff6a14' ? '#123a6e' : '#ff7a1a');
    });
    // rectangular flags for the tall poles
    [['#123a6e', '#ff7a1a'], ['#ff6a14', '#123a6e'], ['#f4f4f0', '#123a6e'], ['#1f8a8a', '#ffffff']].forEach(([bg, fg], i) => {
      const r = P['flag' + i] = atlas.alloc(360, 240);
      ctx.fillStyle = bg; ctx.fillRect(r.x, r.y, r.w, r.h);
      ctx.fillStyle = fg; ctx.fillRect(r.x, r.y + r.h * 0.78, r.w, r.h * 0.08);
      drawLogo(ctx, r.x + r.w / 2, r.y + r.h * 0.42, 70, bg === '#f4f4f0' ? '#123a6e' : '#fff', fg === '#ffffff' ? '#ff7a1a' : fg);
    });
    // small marker flags for the bamboo poles, plain cells
    for (const [k, col] of [['mOrange', '#ff5a0a'], ['mBlue', '#1e4fd0'], ['plain', '#b9bcc0'], ['white', '#f2f2ee']]) {
      const r = P[k] = atlas.alloc(48, 32); ctx.fillStyle = col; ctx.fillRect(r.x, r.y, r.w, r.h);
    }
    // park signs: a white board, coloured header, size badge (orange oval: the freestyle-terrain size mark)
    const sizeOf = (gap) => (gap <= 8 ? 'S' : gap <= 14 ? 'M' : gap <= 20 ? 'L' : 'XL');
    P.sign = (key, title, sub, badge, head = '#123a6e') => {
      const r = P[key] = atlas.alloc(512, 300);
      ctx.fillStyle = '#f3f3ef'; ctx.fillRect(r.x, r.y, r.w, r.h);
      ctx.fillStyle = head; ctx.fillRect(r.x, r.y, r.w, 64);
      ctx.fillStyle = '#ffffff'; ctx.textAlign = 'left'; ctx.textBaseline = 'middle'; ctx.font = `700 34px ${FONT}`;
      drawLogo(ctx, r.x + 40, r.y + 32, 22, '#fff', '#ff7a1a');
      ctx.fillText('SNOWLINE PARK', r.x + 74, r.y + 34);
      ctx.fillStyle = '#16181b'; fitText(ctx, title, badge ? 330 : 470, 74, '800'); ctx.fillText(title, r.x + 22, r.y + 132);
      ctx.fillStyle = '#4b5057'; fitText(ctx, sub, 470, 30, '600'); ctx.fillText(sub, r.x + 22, r.y + 206);
      if (badge) {
        ctx.fillStyle = '#ff6a14'; ctx.beginPath(); ctx.ellipse(r.x + 432, r.y + 134, 64, 46, 0, 0, 7); ctx.fill();
        ctx.fillStyle = '#fff'; ctx.textAlign = 'center'; fitText(ctx, badge, 100, 56, '800'); ctx.fillText(badge, r.x + 432, r.y + 137);
      }
      ctx.fillStyle = '#ff6a14'; ctx.fillRect(r.x, r.y + r.h - 46, r.w, 46);
      ctx.fillStyle = '#fff'; ctx.textAlign = 'center'; ctx.font = `700 24px ${FONT}`; ctx.fillText('INSPECT FIRST  ·  CALL YOUR DROP', r.x + r.w / 2, r.y + r.h - 22);
      return r;
    };
    for (const j of JUMPS) P.sign('J:' + j.name, j.name.toUpperCase(), j.landZ1 ? `TABLE  ·  GAP ${Math.round(j.gap)} M  ·  LIP ${Math.round(j.lip)}°` : `STEP-DOWN  ·  LIP ${Math.round(j.lip)}°`, j.name.startsWith('Step') ? 'M' : sizeOf(j.gap), j.gap > 14 ? '#0d1c33' : '#123a6e');
    P.sign('S:jib', 'JIB GARDEN', 'BOXES  ·  RAILS  ·  TUBES', null, '#1f6f8a');
    P.sign('S:jumps', 'JUMP LINES', 'SMALL LEFT  ·  MEDIUM RIGHT', null, '#123a6e');
    P.sign('S:big', 'BIG AIR', 'EXPERTS ONLY  ·  XL FEATURES', 'XL', '#0d1c33');
    P.sign('S:jib2', 'JIB GARDEN 2', 'ROLLERS LEFT  ·  JIBS RIGHT', null, '#1f6f8a');
    P.sign('S:slow', 'SLOW ZONE', 'BASE AREA  ·  FAMILY SKIING', null, '#c0392b');
    P.sign('S:start', 'START', 'DROP IN ONE AT A TIME', null, '#ff6a14');
    // lane signs: what's in each lane (lanes = rails sharing an x, grouped by section)
    P.lanes = [];
    const lanes = new Map();
    for (const r of RAILS) { const k = r.pts[0][0] + ':' + (r.pts[0][2] < 600 ? 1 : 2); if (!lanes.has(k)) lanes.set(k, []); lanes.get(k).push(r); }
    for (const [key, rs] of lanes) {
      const kinds = new Set(rs.map((r) => r.kind)), name = kinds.size === 1 ? (kinds.has('box') ? 'BOX LANE' : kinds.has('rail') ? 'RAIL LANE' : 'TUBE LANE') : 'MIXED LANE';
      P.sign('L:' + key, name, rs.slice(0, 3).map((r) => r.name).join(' · ').toUpperCase(), rs.length > 2 ? 'M' : 'S', '#1f6f8a');
      P.lanes.push({ key: 'L:' + key, x: rs[0].pts[0][0], z: Math.min(...rs.map((r) => r.pts[0][2])) });
    }
    // building signs
    const board = (key, text, w, h, bg, fg, size) => { const r = P[key] = atlas.alloc(w, h); ctx.fillStyle = bg; ctx.fillRect(r.x, r.y, w, h); ctx.fillStyle = fg; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; fitText(ctx, text, w - 40, size, '800'); ctx.fillText(text, r.x + w / 2, r.y + h / 2 + 3); return r; };
    board('lodge', 'SNOWLINE LODGE', 1024, 150, '#2b2119', '#f1e6d2', 104);
    board('tickets', 'TICKETS', 512, 110, '#123a6e', '#ffffff', 70);
    board('rentals', 'RENTALS · REPAIR', 640, 110, '#2b2119', '#f1e6d2', 64);
    board('patrol', 'SKI PATROL', 512, 110, '#b3261e', '#ffffff', 66);
    board('lift', 'SUMMIT QUAD', 768, 130, '#0d2244', '#ffffff', 84);
    board('judges', 'JUDGES', 512, 110, '#ff6a14', '#ffffff', 72);
    board('summit', 'SUMMIT  2,140 M', 640, 110, '#0d2244', '#ffffff', 64);
    printTex.needsUpdate = true;
  }
  // a printed panel: a plane w x h facing +z (local), uv from an atlas rect; optional flutter
  const panel = (b, rect, m4, w, h, { color = 0xffffff, fl = null } = {}) => b.add('print', new THREE.PlaneGeometry(w, h, fl ? 10 : 1, fl ? 4 : 1), m4, color, { uvRect: rect.uv, fl });

  // ═══════════ 1. the forest ═══════════
  const forest = buildForest();
  function buildForest() {
    const TA = treeAtlas(loadImg);
    const VARIANTS = [
      { R: 0.2, hb: 0.1, whorls: 16, m: 7, mFar: 6, shape: 0.95, droop: 0.55, wr: 0.62, cup: 0.18, tipUp: 0.25 },   // spruce, full
      { R: 0.16, hb: 0.16, whorls: 15, m: 6, mFar: 5, shape: 1.05, droop: 0.8, wr: 0.58, cup: 0.15, tipUp: 0.1 },    // heavier, droopier spruce
      { R: 0.115, hb: 0.08, whorls: 17, m: 6, mFar: 5, shape: 0.85, droop: 0.42, wr: 0.6, cup: 0.2, tipUp: 0.35 },  // subalpine fir: a narrow spire
    ];
    // one tree (height 1, base at y=0); lod 0 = near, 1 = far
    function treeGeo(Pv, lod, seed) {
      const r = mulberry(seed), pos = [], nrm = [], uv = [], col = [], idx = [];
      const vert = (p, n, u, v, c) => { pos.push(p.x, p.y, p.z); nrm.push(n.x, n.y, n.z); uv.push(u, v); col.push(c, c, c); return pos.length / 3 - 1; };
      const env = (h) => Pv.R * Math.pow(clamp((1 - h) / (1 - Pv.hb), 0, 1), Pv.shape) * (h < Pv.hb + 0.06 ? 0.75 + 0.25 * (h - Pv.hb) / 0.06 : 1);
      // trunk: tapers, flares at the root
      const ts = lod ? 4 : 8, rings = lod ? [-0.03, 0.06, 0.4] : [-0.03, 0.02, 0.08, 0.2, 0.45, 0.97];
      const [bu0, bv0, bu1, bv1] = TA.bark;
      for (let k = 0; k < rings.length; k++) {
        const h = rings[k], rr = 0.0135 * (1 - h * 0.9) + 0.012 * Math.exp(-Math.max(0, h) * 45);
        for (let i = 0; i <= ts; i++) {
          const a = (i / ts) * Math.PI * 2, n = V(Math.cos(a), 0.15, Math.sin(a)).normalize();
          const vv = (h * 9 + 2) % 2, vm = vv > 1 ? 2 - vv : vv;
          vert(V(Math.cos(a) * rr, h, Math.sin(a) * rr), n, lerp(bu0, bu1, i / ts), lerp(bv0, bv1, vm), 0.85);
        }
        if (k) for (let i = 0; i < ts; i++) { const a = (k - 1) * (ts + 1) + i, b = a + ts + 1; idx.push(a, b, a + 1, a + 1, b, b + 1); }
      }
      // dense dark core so the crown doesn't read as see-through
      {
        const [cu0, cv0, cu1, cv1] = TA.core, cs = lod ? 5 : 9, hs = lod ? [Pv.hb + 0.02, 0.45, 0.97] : [Pv.hb + 0.02, 0.3, 0.55, 0.78, 0.98], base = pos.length / 3;
        for (const h of hs) for (let i = 0; i <= cs; i++) {
          const a = (i / cs) * Math.PI * 2, rr = env(h) * 0.42;
          vert(V(Math.cos(a) * rr, h, Math.sin(a) * rr), V(Math.cos(a), 0.15, Math.sin(a)).normalize(), lerp(cu0, cu1, i / cs), lerp(cv0, cv1, h), 0.5);
        }
        for (let k = 1; k < hs.length; k++) for (let i = 0; i < cs; i++) { const a = base + (k - 1) * (cs + 1) + i, b = a + cs + 1; idx.push(a, b, a + 1, a + 1, b, b + 1); }
      }
      // branch fronds in whorls, plus an in-between ring of shorter ones
      const [fu0, fv0, fu1, fv1] = TA.frond;
      const segs = lod ? 1 : 4, across = lod ? [-1, 1] : [-1, 0, 1];
      const frond = (h, ang, L, a0, droop, W, ao) => {
        const dir = V(Math.cos(ang), 0, Math.sin(ang)), side = V(-Math.sin(ang), 0, Math.cos(ang)), base = pos.length / 3;
        for (let si = 0; si <= segs; si++) {
          const t = si / segs, along = L * t;
          const ctr = V(0, h, 0).addScaledVector(dir, along * Math.cos(a0)).add(V(0, along * Math.sin(a0) - droop * L * t * t + Pv.tipUp * L * Math.max(0, t - 0.7) ** 2 * 3, 0));
          const wt = 0.55 + 0.45 * Math.min(1, t * 2.5);
          for (const s of across) {
            const p = ctr.clone().addScaledVector(side, s * W * 0.5 * wt).add(V(0, Pv.cup * W * (1 - Math.abs(s)) * (lod ? 0 : 1) - Math.abs(s) * W * 0.05, 0));
            const n = V(0, 1, 0).multiplyScalar(0.85).addScaledVector(dir, 0.45 + 0.2 * t).addScaledVector(side, s * 0.3).normalize();
            vert(p, n, lerp(fu0, fu1, t), lerp(fv0, fv1, (s + 1) / 2), ao * (0.6 + 0.4 * t));
          }
        }
        const A = across.length;
        for (let si = 0; si < segs; si++) for (let k = 0; k < A - 1; k++) {
          const a = base + si * A + k, b = a + A, c = a + 1, d = b + 1;
          idx.push(a, c, b, b, c, d);       // the top face is the front face
        }
      };
      const n = lod ? Math.round(Pv.whorls * 0.6) : Pv.whorls;
      for (let k = 0; k < n; k++) {
        const u = (k + r() * 0.3) / n, h = Pv.hb + (0.965 - Pv.hb) * Math.pow(u, 0.92), rel = (h - Pv.hb) / (1 - Pv.hb);
        const e = env(h), m = Math.max(3, Math.round((lod ? Pv.mFar : Pv.m) * (1 - rel * 0.45)));
        const ao = 0.62 + 0.38 * rel;
        for (let j = 0; j < m; j++) {
          const ang = k * 2.399 + (j / m) * Math.PI * 2 + (r() - 0.5) * 0.5;
          const a0 = lerp(-0.32, 0.32, rel) + (r() - 0.5) * 0.15;
          const L = Math.max(0.03, e * (0.92 + r() * 0.25) / Math.cos(a0) * 1.08);
          frond(h, ang, L, a0, Pv.droop * (1 - 0.45 * rel) * (0.8 + r() * 0.4), L * Pv.wr, ao);
        }
        if (!lod && k < n - 2) {
          const h2 = h + (0.965 - Pv.hb) / n * 0.5, e2 = env(h2) * 0.72, m2 = Math.max(3, m - 2);
          for (let j = 0; j < m2; j++) { const ang = k * 2.399 + 1.3 + (j / m2) * Math.PI * 2; frond(h2, ang, e2, lerp(-0.2, 0.35, rel), Pv.droop * 0.6, e2 * Pv.wr, ao * 0.9); }
        }
      }
      for (let j = 0; j < 4; j++) frond(0.955, j * 1.57 + 0.4, Pv.R * 0.12, 0.5, 0.0, Pv.R * 0.08, 1);   // the leader
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
      g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2)); g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
      g.setIndex(idx); g.computeBoundingSphere(); return g;
    }
    // a dead snag: grey trunk, broken stubs, snapped top
    function snagGeo() {
      const parts = [], [bu0, bv0, bu1, bv1] = TA.bark, r = mulberry(5);
      const cyl = (a, b, r0, seg = 6) => { const g = new THREE.CylinderGeometry(r0 * 0.6, r0, 1, seg, 3); g.applyMatrix4(segM(a, b)); const uv = g.attributes.uv; for (let i = 0; i < uv.count; i++) uv.setXY(i, lerp(bu0, bu1, uv.getX(i)), lerp(bv0, bv1, uv.getY(i))); parts.push(g.toNonIndexed()); };
      cyl(V(0, -0.03, 0), V(0.01, 0.82, 0.005), 0.022, 7);
      for (let i = 0; i < 9; i++) { const h = 0.2 + i * 0.07, a = i * 2.4, L = 0.05 + r() * 0.1 * (1 - h); cyl(V(0, h, 0), V(Math.cos(a) * L, h - L * 0.4, Math.sin(a) * L), 0.004, 4); }
      const g = mergeGeometries(parts);
      g.setAttribute('color', new THREE.BufferAttribute(new Float32Array(g.attributes.position.count * 3).fill(0.62), 3));
      return g;
    }

    // LOD distances: cards (near) -> coarse cards (mid) -> solid jagged cones (far), dithered cross-fades
    const LOD = Q === 'low' ? [55, 70, 170, 210] : [82, 100, 250, 290];
    const lodU = { value: new THREE.Vector4(...LOD) };
    const FADE = ['1.0 - smoothstep(uLod.x, uLod.y, dC)', 'smoothstep(uLod.x, uLod.y, dC) * (1.0 - smoothstep(uLod.z, uLod.w, dC))', '1.0', 'smoothstep(uLod.z, uLod.w, dC)'];
    const lodVertex = (s, lodMode) => {
      s.uniforms.uCam = camU; s.uniforms.uLod = lodU;
      worldVarying(s);
      s.vertexShader = s.vertexShader.replace('#include <common>', '#include <common>\nuniform vec3 uCam; uniform vec4 uLod; varying float vFade; varying float vSnowAmt;')
        .replace('#include <project_vertex>', `#include <project_vertex>
          vec3 iO = (modelMatrix * instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xyz;
          float dC = distance(iO.xz, uCam.xz);
          vFade = ${FADE[lodMode]};
          vSnowAmt = 0.35 + 0.65 * fract(sin(dot(iO.xz, vec2(12.9898, 78.233))) * 43758.5453);
          if (vFade <= 0.001) gl_Position = vec4(0.0, 0.0, -2.0, 1.0);`);
      s.fragmentShader = s.fragmentShader.replace('#include <common>', '#include <common>\nvarying float vFade; varying float vSnowAmt;')
        .replace('#include <normal_fragment_begin>', `#include <normal_fragment_begin>
          if (!gl_FrontFacing) normal = normalize(mix(normal, -normal, 0.6));   // undersides: shaded, not black (light through the needles)`);
    };
    // card trees: alpha-cut needle sprays with snow on the tops (0 near, 1 mid, 2 no LOD)
    const mk = (lodMode) => {
      const m = new THREE.MeshStandardMaterial({ map: TA.tex, vertexColors: true, roughness: 0.88, metalness: 0, side: THREE.DoubleSide, alphaTest: 0.42 });
      m.onBeforeCompile = (s) => {
        lodVertex(s, lodMode);
        // keep cut-outs from thinning with distance: scale alpha up with the mip level, then sharpen by fwidth
        s.fragmentShader = s.fragmentShader.replace('#include <alphatest_fragment>', `
            {
              vec2 tsz = vec2(1024.0) * vMapUv; vec2 dx = dFdx(tsz), dy = dFdy(tsz);
              float mip = max(0.0, 0.5 * log2(max(dot(dx, dx), dot(dy, dy))));
              diffuseColor.a *= 1.0 + mip * 0.22;
              diffuseColor.a = (diffuseColor.a - alphaTest) / max(fwidth(diffuseColor.a), 1e-4) + 0.5;
              if (diffuseColor.a < 0.5) discard;
              if (vFade < 0.999 && scIgn(gl_FragCoord.xy) > vFade) discard;
            }`);
        addSnow(s, { amount: 'vSnowAmt * step(0.5, vMapUv.y) * (gl_FrontFacing ? 1.0 : 0.0) * smoothstep(0.42, 0.62, scNoise(vScW * 2.3) * 0.6 + scNoise(vScW * 0.7) * 0.4)', scale: '1.3', lo: '0.35', hi: '0.75' });
      };
      m.customProgramCacheKey = () => 'scenery-tree-' + lodMode;
      return m;
    };
    // far trees: solid jagged tiers, no alpha
    const matCone = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.9, metalness: 0, side: THREE.DoubleSide });
    matCone.onBeforeCompile = (s) => {
      lodVertex(s, 3);
      s.fragmentShader = s.fragmentShader.replace('#include <alphatest_fragment>', '#include <alphatest_fragment>\nif (vFade < 0.999 && scIgn(gl_FragCoord.xy) > vFade) discard;');
      addSnow(s, { amount: 'vSnowAmt * 0.3 * (gl_FrontFacing ? 1.0 : 0.0) * smoothstep(0.4, 0.62, scNoise(vScW * 1.1) * 0.6 + scNoise(vScW * 0.37) * 0.4)', scale: '0.9', lo: '0.35', hi: '0.8' });
    };
    matCone.customProgramCacheKey = () => 'scenery-tree-cone';
    function coneGeo(Pv) {
      const pos = [], nrm = [], col = [], idx = [], tiers = 4, n = 6;
      const env = (h) => Pv.R * Math.pow(clamp((1 - h) / (1 - Pv.hb), 0, 1), Pv.shape);
      const g = [0.022, 0.04, 0.028];      // linear dark spruce green
      for (let t = 0; t < tiers; t++) {
        const hb = Pv.hb + (1 - Pv.hb) * t / tiers * 0.95 - 0.02, ht = Math.min(1, Pv.hb + (1 - Pv.hb) * (t + 1.6) / tiers), r = env(hb) * 1.35, base = pos.length / 3;
        pos.push(0, ht, 0); nrm.push(0, 1, 0); col.push(g[0] * 1.2, g[1] * 1.2, g[2] * 1.2);
        for (let i = 0; i <= 2 * n; i++) {
          const a = (i / (2 * n)) * Math.PI * 2 + t * 0.7, rr = i % 2 ? r * 0.7 : r, y = hb - (i % 2 ? 0 : r * 0.25);
          pos.push(Math.cos(a) * rr, y, Math.sin(a) * rr);
          const nn = V(Math.cos(a) * 0.6, 0.8, Math.sin(a) * 0.6).normalize(); nrm.push(nn.x, nn.y, nn.z);
          const ao = 0.55 + 0.45 * t / tiers; col.push(g[0] * ao, g[1] * ao, g[2] * ao);
        }
        for (let i = 0; i < 2 * n; i++) idx.push(base, base + 2 + i, base + 1 + i);
      }
      const gg = new THREE.BufferGeometry();
      gg.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); gg.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3)); gg.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
      gg.setIndex(idx); gg.computeBoundingSphere(); return gg;
    }
    const matNear = mk(0), matMid = mk(1), matSnag = mk(2);
    const geoNear = VARIANTS.map((Pv, i) => treeGeo(Pv, 0, 100 + i)), geoMid = VARIANTS.map((Pv, i) => treeGeo(Pv, 1, 100 + i)), geoCone = VARIANTS.map(coneGeo), geoSnag = snagGeo();

    // ── placement: a coarse 16 m slope grid, then jittered candidates ──
    const G = 16, gx0 = -MX + 8, gz0 = MZ0 + 8, gnx = Math.floor((2 * MX - 16) / G) + 1, gnz = Math.floor((MZ1 - MZ0 - 16) / G) + 1;
    const SL = new Float32Array(gnx * gnz);
    for (let j = 0; j < gnz; j++) for (let i = 0; i < gnx; i++) SL[j * gnx + i] = slopeAt(gx0 + i * G, gz0 + j * G, 6);
    const slopeG = (x, z) => { const fx = clamp((x - gx0) / G, 0, gnx - 1.001), fz = clamp((z - gz0) / G, 0, gnz - 1.001), i = fx | 0, j = fz | 0, u = fx - i, v = fz - j;
      return lerp(lerp(SL[j * gnx + i], SL[j * gnx + i + 1], u), lerp(SL[(j + 1) * gnx + i], SL[(j + 1) * gnx + i + 1], u), v); };
    const trees = [];
    const SP = Q === 'low' ? 5.6 : 4.3, MAXT = Q === 'low' ? 24000 : 70000;
    for (let z = MZ0 + 12; z < MZ1 - 12; z += SP) for (let x = -MX + 12; x < MX - 12; x += SP) {
      const px = x + (rnd() - 0.5) * SP * 0.95, pz = z + (rnd() - 0.5) * SP * 0.95, roll = rnd();
      const c = runCenter(pz), out = Math.abs(px - c) - runHalf(pz);
      // further from the run, thinner (seen as texture there): keeps the count in budget
      const farK = out < 250 ? 1 : lerp(1, 0.55, sstep(250, 900, out));
      if (roll > farK) continue;
      const onPiste = pz > Z0 - 30 && pz < Z1 + 30;
      const edge = 6 + (fbm(px * 0.045 + 3, pz * 0.045, 2) - 0.35) * 16;   // a ragged forest edge
      if (onPiste ? out < edge : out < 2) continue;
      let d = farK * (1 - sstep(0.62, 1.05, slopeG(px, pz)));               // ~32° full, nothing past ~46°
      if (roll > d) continue;
      const rel = ground(px, pz, true) - baseY(pz);
      d *= 1 - sstep(260, 470, rel + (fbm(px * 0.004, pz * 0.004, 2) - 0.5) * 180);   // the treeline, ragged, high on the ridges
      const clump = fbm(px * 0.011 + 7.3, pz * 0.011 - 2.1, 3);
      d *= sstep(0.3, 0.55, clump) * 0.85 + 0.15;                           // clumps and glades
      d *= lerp(0.35, 1, sstep(4, 45, out));                                // sparser at the run's edge
      if (roll > d) continue;
      if (Math.abs(px - liftX(pz)) < 11 && pz > LIFT.zTop - 30 && pz < LIFT.zBase + 30) continue;
      if (inKeep(px, pz, 2)) continue;
      trees.push({ x: px, z: pz, out, rel });
    }
    // over budget: thin evenly (not by distance, so the hillsides stay forested)
    if (trees.length > MAXT) { const keepP = MAXT / trees.length; const kept = trees.filter((t) => t.out < 60 || rnd() < keepP * 0.98); trees.length = 0; trees.push(...kept.slice(0, MAXT)); }
    // sizes, variants, snags and saplings
    const inst = [[], [], []], snags = [];
    for (const t of trees) {
      const k = rnd(), edgeK = sstep(4, 30, t.out), hi = sstep(180, 440, t.rel);
      t.y = surfY(t.x, t.z) - 0.3;
      if (k < 0.022 + hi * 0.05) { t.h = 7 + rnd() * 9; t.ws = 0.9 + rnd() * 0.4; t.snag = true; snags.push(t); continue; }
      if (k < 0.1 + (1 - edgeK) * 0.08) t.h = 1.4 + rnd() * 3;                          // saplings, mostly at the forest edge
      else t.h = lerp(6, 22, Math.pow(rnd(), 1.15)) * lerp(0.75, 1.05, edgeK) * lerp(1, 0.6, hi);
      t.ws = (0.85 + rnd() * 0.35) * (t.h < 5 ? 1.25 : 1);
      t.v = t.h > 15 && rnd() < 0.5 ? 1 : rnd() < 0.3 + hi * 0.4 ? 2 : (rnd() < 0.6 ? 0 : 1);
      t.rot = rnd() * Math.PI * 2; t.tint = 0.95 + rnd() * 0.32;
      inst[t.v].push(t);
    }
    // instance matrices + colours: the far cones hold every tree (static); near and mid are refilled from 64 m tiles
    const TILE = 64, tileKey = (x, z) => Math.floor(x / TILE) * 100003 + Math.floor(z / TILE);
    const near = [], mid = [], far = [], tiles = VARIANTS.map(() => new Map());
    const mtx = new THREE.Matrix4(), col = new THREE.Color(), up = V(0, 1, 0);
    const dyn = (geo, mat, cap, name) => {
      const m = new THREE.InstancedMesh(geo, mat, Math.max(1, cap));
      m.count = 0; m.castShadow = false; m.receiveShadow = false; m.name = name; m.frustumCulled = false;
      m.instanceMatrix.setUsage(THREE.DynamicDrawUsage); m.setColorAt(0, col); m.instanceColor.setUsage(THREE.DynamicDrawUsage);
      group.add(m); return m;
    };
    VARIANTS.forEach((Pv, v) => {
      const list = inst[v], fm = new THREE.InstancedMesh(geoCone[v], matCone, Math.max(1, list.length));
      list.forEach((t, i) => {
        mtx.compose(_p.set(t.x, t.y, t.z), _q.setFromAxisAngle(up, t.rot), _s.set(t.h * t.ws, t.h, t.h * t.ws));
        fm.setMatrixAt(i, mtx);
        col.setRGB(t.tint * 0.95, t.tint, t.tint * (v === 2 ? 1.0 : 0.92)); fm.setColorAt(i, col);
        const key = tileKey(t.x, t.z); if (!tiles[v].has(key)) tiles[v].set(key, { m: [], c: [], cx: (Math.floor(t.x / TILE) + 0.5) * TILE, cz: (Math.floor(t.z / TILE) + 0.5) * TILE });
        const tl = tiles[v].get(key); for (let e = 0; e < 16; e++) tl.m.push(mtx.elements[e]); tl.c.push(col.r, col.g, col.b);
      });
      fm.count = list.length; fm.computeBoundingSphere(); fm.castShadow = false; fm.receiveShadow = false; fm.name = 'scenery:treesFar' + v;
      group.add(fm); far.push(fm);
      for (const tl of tiles[v].values()) { tl.m = new Float32Array(tl.m); tl.c = new Float32Array(tl.c); }
      near.push(dyn(geoNear[v], matNear, list.length, 'scenery:treesNear' + v));
      mid.push(dyn(geoMid[v], matMid, list.length, 'scenery:treesMid' + v));
    });
    const sm = new THREE.InstancedMesh(geoSnag, matSnag, Math.max(1, snags.length));
    snags.forEach((t, i) => { sm.setMatrixAt(i, mtx.compose(_p.set(t.x, t.y, t.z), _q.setFromAxisAngle(up, rnd() * 6.28), _s.set(t.h * t.ws, t.h, t.h * t.ws))); sm.setColorAt(i, col.setRGB(0.95, 0.93, 0.9)); });
    sm.count = snags.length; sm.computeBoundingSphere(); sm.name = 'scenery:snags'; group.add(sm);
    for (const t of trees) shadowCasters.push({ kind: 'tree', x: t.x, y: t.y + 0.3, z: t.z, h: t.h, r: t.snag ? 0.25 : t.h * (t.v === 2 ? 0.115 : 0.19) * t.ws, k: t.snag ? 0.5 : 0.78 });

    let lastTile = null;
    const fill = (m, v, cam, R) => {
      const arr = m.instanceMatrix.array, carr = m.instanceColor.array; let n = 0;
      for (const tl of tiles[v].values()) {
        if (Math.hypot(tl.cx - cam.x, tl.cz - cam.z) > R) continue;
        const k = tl.m.length / 16; if (n + k > m.instanceMatrix.count) break;
        arr.set(tl.m, n * 16); carr.set(tl.c, n * 3); n += k;
      }
      m.count = n; m.instanceMatrix.needsUpdate = true; m.instanceColor.needsUpdate = true;
      m.instanceMatrix.clearUpdateRanges(); m.instanceMatrix.addUpdateRange(0, n * 16);
      m.instanceColor.clearUpdateRanges(); m.instanceColor.addUpdateRange(0, n * 3);
    };
    function refresh(cam) {
      const key = Math.floor(cam.x / 32) + ':' + Math.floor(cam.z / 32);
      if (key === lastTile) return; lastTile = key;
      VARIANTS.forEach((Pv, v) => { fill(near[v], v, cam, LOD[1] + TILE * 0.75); fill(mid[v], v, cam, LOD[3] + TILE * 0.75); });
    }
    return { refresh, count: trees.length, snags: snags.length, near, mid, far, perVariant: inst.map((l) => l.length) };
  }

  // ═══════════ 2. the chairlift ═══════════
  const lift = buildLift();
  function buildLift() {
    const b = B.lift, half = LIFT.gauge / 2;
    const stTop = { z: LIFT.zTop, st: true }, stBase = { z: LIFT.zBase, st: true };
    for (const st of [stTop, stBase]) { st.x = liftX(st.z); st.g = ground(st.x, st.z); st.y = st.g + 3.15; }
    // towers, evenly spaced (with a little jitter)
    const L = stBase.z - stTop.z, nSpan = Math.round(L / 62), pts = [stBase];
    for (let i = 1; i < nSpan; i++) { const z = stBase.z - L * i / nSpan + (rnd() - 0.5) * 8; const x = liftX(z), g = ground(x, z); pts.push({ x, z, g, y: g + 9 }); }
    pts.push(stTop);
    const sagK = 0.014, CLEAR = 6.2;            // the rope clears the snow by the chair's length + ~2.8 m
    const cableAt = (a, c, t) => lerp(a.y, c.y, t) - 4 * sagK * Math.hypot(c.x - a.x, c.z - a.z) * t * (1 - t);
    for (let it = 0; it < 40; it++) {
      let moved = false;
      for (let i = 0; i < pts.length - 1; i++) {
        const a = pts[i], c = pts[i + 1];
        for (let k = 1; k < 24; k++) {
          const t = k / 24, x = lerp(a.x, c.x, t), z = lerp(a.z, c.z, t);
          // near the stations the chairs come down to loading height, so ease the clearance in
          const ease = Math.min(1, 0.45 + 2.2 * Math.min(a.st ? t : 1, c.st ? 1 - t : 1));
          const need = Math.max(ground(x - half, z), ground(x + half, z)) + CLEAR * ease - cableAt(a, c, t);
          if (need > 0.01) { if (!a.st) a.y += need * (c.st ? 1 : 1 - t) + 0.01; if (!c.st) c.y += need * (a.st ? 1 : t) + 0.01; moved = true; }
        }
      }
      if (!moved) break;
    }
    for (const p of pts) if (!p.st) p.y = Math.min(p.y, p.g + 26);
    for (let i = 0; i < pts.length; i++) {
      const a = pts[Math.max(0, i - 1)], c = pts[Math.min(pts.length - 1, i + 1)];
      const d = V(c.x - a.x, 0, c.z - a.z).normalize(); pts[i].dir = d; pts[i].perp = V(d.z, 0, -d.x);
    }
    // the loop the chairs ride: up line on the run side (perp -1), down line outside (perp +1)
    const loop = [];
    const line = (sgn, rev) => {
      const seq = rev ? [...pts].reverse() : pts;
      for (let i = 0; i < seq.length - 1; i++) {
        const a = seq[i], c = seq[i + 1], span = Math.hypot(c.x - a.x, c.z - a.z), n = Math.ceil(span);
        const pa = V(a.x, 0, a.z).addScaledVector(a.perp, sgn * half), pc = V(c.x, 0, c.z).addScaledVector(c.perp, sgn * half);
        for (let k = 0; k < n; k++) { const t = k / n; loop.push(V(lerp(pa.x, pc.x, t), cableAt(a, c, t), lerp(pa.z, pc.z, t))); }
      }
    };
    const wheel = (st, fromSgn, outward) => {
      const c = V(st.x, st.y, st.z), p0 = st.perp.clone().multiplyScalar(fromSgn), n = 40;
      for (let k = 0; k <= n; k++) { const a = Math.PI * k / n, d = p0.clone().multiplyScalar(Math.cos(a)).addScaledVector(outward, Math.sin(a)); loop.push(c.clone().addScaledVector(d, half)); }
    };
    line(-1, false); wheel(stTop, -1, stTop.dir); line(1, true); wheel(stBase, 1, stBase.dir.clone().negate());
    // resample to an even 0.5 m step
    const cum = [0]; for (let i = 1; i < loop.length; i++) cum.push(cum[i - 1] + loop[i].distanceTo(loop[i - 1]));
    const total = cum[cum.length - 1] + loop[0].distanceTo(loop[loop.length - 1]), STEP = 0.5, NS = Math.floor(total / STEP);
    loop.push(loop[0].clone()); cum.push(total);
    const path = new Float32Array(NS * 4);           // x, y, z, heading
    for (let i = 0, j = 0; i < NS; i++) {
      const s = i * STEP; while (j < loop.length - 2 && cum[j + 1] < s) j++;
      const a = loop[j], c = loop[j + 1], t = clamp((s - cum[j]) / Math.max(1e-6, cum[j + 1] - cum[j]), 0, 1);
      path[i * 4] = lerp(a.x, c.x, t); path[i * 4 + 1] = lerp(a.y, c.y, t); path[i * 4 + 2] = lerp(a.z, c.z, t);
    }
    for (let i = 0; i < NS; i++) { const n = (i + 2) % NS, p = (i - 2 + NS) % NS; path[i * 4 + 3] = Math.atan2(path[n * 4] - path[p * 4], path[n * 4 + 2] - path[p * 4 + 2]); }

    // haul rope (round the wheels too)
    {
      const cpts = []; for (let i = 0; i < NS; i += 4) cpts.push(V(path[i * 4], path[i * 4 + 1] + 0.03, path[i * 4 + 2]));
      const g = new THREE.TubeGeometry(new THREE.CatmullRomCurve3(cpts, true, 'centripetal'), cpts.length * 2, 0.032, 5, true);
      b.add('cable', g, null, 0x3a3d40);
    }
    // ── towers ──
    const galv = 0x8e959c, dark = 0x34383d, blue = 0x24476e;
    for (let i = 1; i < pts.length - 1; i++) {
      const p = pts[i], H = p.y - p.g, yaw = Math.atan2(p.dir.x, p.dir.z);
      const base = new THREE.Matrix4().makeTranslation(p.x, p.g, p.z).multiply(new THREE.Matrix4().makeRotationY(yaw));
      const at = (lx, ly, lz) => V(lx, ly, lz).applyMatrix4(base);
      const T = (geo, m, c = galv, key = 'steel') => b.add(key, geo, base.clone().multiply(m), c);
      b.add('stone', new RoundedBoxGeometry(1.8, 1.4, 1.8, 2, 0.12), M(p.x, p.g - 0.35, p.z, yaw), 0x9a968e, { wuv: 2 });
      T(new THREE.CylinderGeometry(0.29, 0.4, H - 0.9, 18, 1, true), M(0, (H - 0.9) / 2 + 0.2, 0));
      T(new THREE.CylinderGeometry(0.55, 0.55, 0.06, 18), M(0, 0.25, 0));
      const armY = H - 0.75, armW = LIFT.gauge + 1.6;
      T(new THREE.BoxGeometry(armW, 0.42, 0.42), M(0, armY, 0));
      T(new THREE.CylinderGeometry(0.34, 0.29, 0.6, 18), M(0, armY - 0.3, 0));
      for (const sx of [-1, 1]) T(unitCyl(8), segM(V(0, armY - 1.6, 0), V(sx * armW * 0.42, armY - 0.2, 0), 0.07));
      // sheave trains: six rubber-lined wheels on a rocker under each rope
      for (const sx of [-1, 1]) {
        const x = sx * half;
        T(new THREE.BoxGeometry(0.16, 0.5, 0.5), M(x, armY + 0.3, 0));
        for (const side of [-0.13, 0.13]) T(new THREE.BoxGeometry(0.03, 0.34, 3.0), M(x + side, H - 0.33, 0));
        for (let k = 0; k < 6; k++) T(new THREE.CylinderGeometry(0.21, 0.21, 0.09, 14), M(x, H - 0.24, -1.25 + k * 0.5, 0, 0, Math.PI / 2), dark, 'rubber');
      }
      // catwalk and handrail, ladder, number plate
      T(new THREE.BoxGeometry(armW, 0.04, 0.9), M(0, armY + 0.24, -0.66));
      for (const sx of [-1, 1]) T(unitCyl(6), segM(V(sx * armW / 2, armY + 0.25, -1.08), V(sx * armW / 2, armY + 1.25, -1.08), 0.025));
      T(unitCyl(6), segM(V(-armW / 2, armY + 1.25, -1.08), V(armW / 2, armY + 1.25, -1.08), 0.025));
      for (const sx of [-0.2, 0.2]) T(new THREE.BoxGeometry(0.04, H - 2.5, 0.05), M(sx, (H - 2.5) / 2 + 2.2, 0.46));
      for (let y = 2.4; y < H - 0.6; y += 0.35) T(unitCyl(5), segM(V(-0.2, y, 0.46), V(0.2, y, 0.46), 0.014));
      T(new THREE.BoxGeometry(0.5, 0.35, 0.02), M(0, 3.2, 0.42), blue, 'paint');
      shadowCasters.push({ kind: 'seg', a: V(p.x, p.g, p.z), b: V(p.x, p.g + H, p.z), r: 0.38, real: true });
      shadowCasters.push({ kind: 'seg', a: at(-armW / 2, armY, 0), b: at(armW / 2, armY, 0), r: 0.3, real: true });
    }
    // ── stations: bull wheel, terminal housing, canopy roof, operator hut, ramp ──
    const wheels = [];
    const station = (st, isTop) => {
      const yaw = Math.atan2(st.dir.x, st.dir.z), W0 = new THREE.Matrix4().makeTranslation(st.x, st.g, st.z).multiply(new THREE.Matrix4().makeRotationY(yaw));
      const Mw = (m) => W0.clone().multiply(m);
      const out = isTop ? 1 : -1;                    // local +z = the line direction (uphill); the wheel end
      const yc = st.y - st.g, bb = isTop ? B.top : B.base;
      {
        const wb = new Builder(), R = half;
        wb.add('steel', new THREE.TorusGeometry(R, 0.11, 8, 48), M(0, 0, 0, 0, Math.PI / 2), 0x2f3338);
        wb.add('steel', new THREE.CylinderGeometry(0.45, 0.45, 0.5, 16), null, 0x55595e);
        for (let k = 0; k < 8; k++) { const a = k * Math.PI / 4; wb.add('steel', unitCyl(6), segM(V(0, 0, 0), V(Math.cos(a) * R, 0, Math.sin(a) * R), 0.06), 0xd0d4d8); }
        const [mesh] = wb.build(group, mats);
        mesh.matrixAutoUpdate = true; mesh.position.set(st.x, st.y, st.z); wheels.push({ mesh, dir: isTop ? -1 : 1 });
      }
      bb.add('paint', new RoundedBoxGeometry(LIFT.gauge + 1.8, 1.25, 7.2, 3, 0.25), Mw(M(0, yc + 1.05, out * 0.9)), 0xe9ecef);
      bb.add('paint', new RoundedBoxGeometry(LIFT.gauge + 1.86, 0.3, 7.26, 2, 0.1), Mw(M(0, yc + 0.6, out * 0.9)), 0x0d2244);
      bb.add('steel', new THREE.CylinderGeometry(0.42, 0.55, yc + 0.6, 16), Mw(M(0, (yc + 0.6) / 2 - 0.3, out * 0.9)), 0x8e959c);
      bb.add('steel', new THREE.BoxGeometry(1.2, yc + 0.6, 1.0), Mw(M(0, (yc + 0.6) / 2 - 0.3, out * 2.6)), 0x8e959c);
      panel(bb, P.lift, Mw(M(0, yc + 1.05, -out * 2.72, out > 0 ? Math.PI : 0)), 3.6, 0.6);
      // canopy roof over the loading/unloading area on six posts: standing seam + snow
      const rw = LIFT.gauge + 7, rl = 13, rh = yc + 3.1, rz = out * 0.5;
      for (const sx of [-1, 1]) for (const k of [-1, 0, 1]) bb.add('steel', new THREE.BoxGeometry(0.22, rh, 0.22), Mw(M(sx * rw / 2 * 0.92, rh / 2 - 0.2, rz + k * rl * 0.42)), 0x4b5158);
      for (const sx of [-1, 1]) {
        bb.add('metalRoof', new THREE.BoxGeometry(rw / 2 + 0.6, 0.12, rl), Mw(M(sx * rw / 4, rh + 0.55, rz, 0, 0, -sx * 0.22)), 0x3c434b);
        bb.add('roofSnow', new RoundedBoxGeometry(rw / 2 + 0.5, 0.32, rl - 0.2, 2, 0.14), Mw(M(sx * rw / 4, rh + 0.74, rz, 0, 0, -sx * 0.22)), 0xffffff);
      }
      for (const k of [-1, 1]) bb.add('steel', new THREE.BoxGeometry(rw + 0.4, 0.3, 0.3), Mw(M(0, rh, rz + k * rl * 0.45)), 0x4b5158);
      // operator hut beside the line
      const hx = rw / 2 + 3.2, hz = -out * 3;
      bb.add('timber', new THREE.BoxGeometry(3.2, 1.0, 3.2), Mw(M(hx, 0.5, hz)), 0xd0b08c, { wuv: 2.4 });
      for (const [w, d, x2, z2] of [[3.2, 0.12, 0, 1.54], [3.2, 0.12, 0, -1.54], [0.12, 3.2, 1.54, 0], [0.12, 3.2, -1.54, 0]]) bb.add('glass', new THREE.BoxGeometry(w, 1.5, d), Mw(M(hx + x2, 1.75, hz + z2)), 0xffffff);
      for (const [x2, z2] of [[1.55, 1.55], [-1.55, 1.55], [1.55, -1.55], [-1.55, -1.55]]) bb.add('paint', new THREE.BoxGeometry(0.14, 1.6, 0.14), Mw(M(hx + x2, 1.75, hz + z2)), 0x2a2d31);
      bb.add('timber', new THREE.BoxGeometry(3.3, 0.4, 3.3), Mw(M(hx, 2.7, hz)), 0xd0b08c, { wuv: 2.4 });
      bb.add('metalRoof', new THREE.BoxGeometry(4.0, 0.16, 4.0), Mw(M(hx, 3.0, hz)), 0x3c434b);
      bb.add('roofSnow', new RoundedBoxGeometry(3.9, 0.4, 3.9, 2, 0.18), Mw(M(hx, 3.24, hz)), 0xffffff);
      bb.add('stone', new THREE.BoxGeometry(3.6, 1.2, 3.6), Mw(M(hx, -0.5, hz)), 0x9a968e, { wuv: 2 });
      shadowCasters.push({ kind: 'box', m: Mw(M(hx, 1.7, hz)), sx: 4, sy: 3.4, sz: 4, real: true });
      shadowCasters.push({ kind: 'box', m: Mw(M(0, rh / 2 + 0.4, rz)), sx: rw, sy: rh + 0.8, sz: rl, real: true, k: 0.5 });
      // loading / unloading deck, rope-maze posts
      bb.add('timber', new THREE.BoxGeometry(LIFT.gauge + 3, 0.5, 6), Mw(M(0, -0.1, -out * 4.5)), 0xbfa07e, { wuv: 2 });
      for (const sx of [-1, 1]) for (let k = 0; k < 6; k++) bb.add('paint', new THREE.CylinderGeometry(0.05, 0.05, 1.1, 8), Mw(M(sx * (half + 2.2), 0.4, -out * (6 + k * 2.2))), 0xd9a441);
      for (const sx of [-1, 1]) bb.add('paint', unitCyl(5), Mw(segM(V(sx * (half + 2.2), 0.85, -out * 6), V(sx * (half + 2.2), 0.85, -out * 17), 0.012)), 0x1e4fd0);
      if (isTop) panel(bb, P.summit, Mw(M(hx, 3.9, hz + 2.05, 0)), 2.6, 0.45);
    };
    station(stTop, true); station(stBase, false);
    keep(stTop.x - 18, stTop.x + 18, stTop.z - 22, stTop.z + 14); keep(stBase.x - 18, stBase.x + 18, stBase.z - 14, stBase.z + 22);

    // ── chairs: instanced quad chairs, frame + seat pads share the matrices ──
    const frame = new Builder(), pad = new Builder(), seatY = -2.45;
    {
      const S = (geo, m, c = 0x8b9198) => frame.add('steel', geo, m, c);
      S(new THREE.BoxGeometry(0.28, 0.32, 0.5), M(0, -0.12, 0), 0x2f3338);                       // grip
      const hang = [V(0, -0.2, 0), V(0, -1.3, -0.05), V(0, -1.85, -0.42), V(0, seatY + 0.55, -0.5)];
      for (let i = 0; i < hang.length - 1; i++) S(unitCyl(8), segM(hang[i], hang[i + 1], 0.045));
      S(unitCyl(8), segM(V(-1.15, seatY + 0.55, -0.5), V(1.15, seatY + 0.55, -0.5), 0.035));
      S(unitCyl(8), segM(V(-1.15, seatY, -0.05), V(1.15, seatY, -0.05), 0.035));
      for (const sx of [-1.15, 1.15]) {
        S(unitCyl(8), segM(V(sx, seatY + 0.55, -0.5), V(sx, seatY - 0.02, -0.4), 0.03));
        S(unitCyl(8), segM(V(sx, seatY - 0.02, -0.4), V(sx, seatY, 0.05), 0.03));
        S(unitCyl(8), segM(V(sx, seatY, 0.05), V(sx, seatY + 0.32, 0.12), 0.025));
      }
      S(unitCyl(8), segM(V(-1.18, seatY + 0.55, -0.48), V(-1.18, seatY + 1.25, -0.2), 0.025));      // safety bar (up) + footrest
      S(unitCyl(8), segM(V(-1.18, seatY + 1.25, -0.2), V(1.18, seatY + 1.25, -0.2), 0.025));
      S(unitCyl(8), segM(V(1.18, seatY + 0.55, -0.48), V(1.18, seatY + 1.25, -0.2), 0.025));
      S(unitCyl(8), segM(V(0, seatY + 1.25, -0.2), V(0, seatY + 1.55, 0.2), 0.022));
      S(new THREE.BoxGeometry(1.4, 0.04, 0.22), M(0, seatY + 1.6, 0.28), 0x2f3338);
      pad.add('rubber', new RoundedBoxGeometry(2.26, 0.11, 0.5, 2, 0.04), M(0, seatY + 0.06, -0.2), 0x1d3354);
      pad.add('rubber', new RoundedBoxGeometry(2.26, 0.52, 0.09, 2, 0.04), M(0, seatY + 0.36, -0.48, 0, -0.22), 0x1d3354);
    }
    const fg = mergeGeometries(frame.parts.get('steel')), pg = mergeGeometries(pad.parts.get('rubber'));
    const nChairs = Math.floor(total / LIFT.spacing), spacing = total / nChairs;
    const chairF = new THREE.InstancedMesh(fg, mats.steel, nChairs), chairP = new THREE.InstancedMesh(pg, mats.rubber, nChairs);
    chairP.instanceMatrix = chairF.instanceMatrix;
    for (const c of [chairF, chairP]) { c.castShadow = true; c.receiveShadow = true; c.frustumCulled = false; group.add(c); }
    chairF.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    chairF.name = 'scenery:chairs'; chairP.name = 'scenery:chairPads';
    let s0 = 0;
    const qa = new THREE.Quaternion(), qb = new THREE.Quaternion(), ax = V(0, 0, 1), ay = V(0, 1, 0);
    function update(dt, t) {
      s0 = (s0 + LIFT.speed * dt) % total;
      const arr = chairF.instanceMatrix.array;
      for (let i = 0; i < nChairs; i++) {
        const s = (s0 + i * spacing) % total, f = s / STEP, k = Math.floor(f) % NS, k2 = (k + 1) % NS, u = f - Math.floor(f);
        qa.setFromAxisAngle(ay, path[k * 4 + 3]); qb.setFromAxisAngle(ax, Math.sin(t * 0.9 + i * 1.7) * 0.025); qa.multiply(qb);
        _m.compose(_p.set(lerp(path[k * 4], path[k2 * 4], u), lerp(path[k * 4 + 1], path[k2 * 4 + 1], u), lerp(path[k * 4 + 2], path[k2 * 4 + 2], u)), qa, _s.set(1, 1, 1));
        _m.toArray(arr, i * 16);
      }
      chairF.instanceMatrix.needsUpdate = true;
      for (const w of wheels) w.mesh.rotation.y += w.dir * dt * LIFT.speed / half;
    }
    return { update, pts, stTop, stBase, nChairs, length: total };
  }

  // a park sign on two posts; its face looks up the hill (-z) turned by `yaw`
  function signPost(b, rect, x, z, yaw = 0) {
    const g = ground(x, z), w = 1.7, h = w * rect.h / rect.w, y0 = g + 1.05;
    const m = (lx, ly, lz) => M(x + lx * Math.cos(yaw) + lz * Math.sin(yaw), ly, z - lx * Math.sin(yaw) + lz * Math.cos(yaw), yaw + Math.PI);
    panel(b, rect, m(0, y0 + h / 2, -0.035), w, h);
    b.add('print', new THREE.PlaneGeometry(w, h), m(0, y0 + h / 2, 0.035).multiply(new THREE.Matrix4().makeRotationY(Math.PI)), 0xffffff, { uvRect: P.plain.uv });
    b.add('steel', new THREE.BoxGeometry(w + 0.06, h + 0.06, 0.05), m(0, y0 + h / 2, 0), 0x9aa1a8);
    for (const sx of [-0.6, 0.6]) b.add('steel', new THREE.CylinderGeometry(0.035, 0.035, y0 - g + h + 0.4, 8), m(sx, g + (y0 + h - g) / 2 - 0.1, 0.06), 0x9aa1a8);
    shadowCasters.push({ kind: 'box', m: M(x, y0 + h / 2, z, yaw), sx: w, sy: h, sz: 0.1, real: true, k: 0.7 });
  }

  // ═══════════ 3. the start area (top deck) ═══════════
  {
    const b = B.top;
    // the start arch: two square aluminium truss towers and a truss beam carrying the banner
    const zA = -6, xL = runCenter(zA) - 13, xR = runCenter(zA) + 13, gL = ground(xL, zA), gR = ground(xR, zA), Ht = 7.2, yTop = Math.max(gL, gR) + Ht;
    const alu = 0xc9ced3;
    const truss = (a, c, w = 0.42) => {
      const d = V().subVectors(c, a), len = d.length(); d.normalize();
      const u = Math.abs(d.y) > 0.9 ? V(1, 0, 0) : V(0, 1, 0), s1 = V().crossVectors(d, u).normalize(), s2 = V().crossVectors(d, s1).normalize();
      const corners = [[1, 1], [1, -1], [-1, -1], [-1, 1]].map(([i, j]) => V().addScaledVector(s1, i * w / 2).addScaledVector(s2, j * w / 2));
      for (const cn of corners) b.add('steel', unitCyl(8), segM(a.clone().add(cn), c.clone().add(cn), 0.025), alu);
      const n = Math.max(2, Math.round(len / w));
      for (let f = 0; f < 4; f++) {
        const c0 = corners[f], c1 = corners[(f + 1) % 4];
        for (let k = 0; k < n; k++) b.add('steel', unitCyl(5), segM(a.clone().addScaledVector(d, len * k / n).add(k % 2 ? c0 : c1), a.clone().addScaledVector(d, len * (k + 1) / n).add(k % 2 ? c1 : c0), 0.011), alu);
      }
    };
    truss(V(xL, gL - 0.2, zA), V(xL, yTop + 0.25, zA)); truss(V(xR, gR - 0.2, zA), V(xR, yTop + 0.25, zA));
    truss(V(xL - 0.25, yTop, zA), V(xR + 0.25, yTop, zA));
    for (const [x, g] of [[xL, gL], [xR, gR]]) { b.add('steel', new THREE.BoxGeometry(1.0, 0.08, 1.0), M(x, g + 0.02, zA), 0x5a5f66); b.add('paint', new RoundedBoxGeometry(0.75, 0.5, 0.75, 2, 0.08), M(x, g + 0.25, zA), 0x111316); }
    const bw = xR - xL - 1.2, bh = bw * 220 / 2048;
    panel(b, P.bannerF, M((xL + xR) / 2, yTop - 0.35 - bh / 2, zA - 0.24, Math.PI), bw, bh);
    panel(b, P.bannerB, M((xL + xR) / 2, yTop - 0.35 - bh / 2, zA + 0.24), bw, bh);
    b.add('steel', new THREE.BoxGeometry(bw, bh, 0.4), M((xL + xR) / 2, yTop - 0.35 - bh / 2, zA), 0x2a2d31);
    shadowCasters.push({ kind: 'seg', a: V(xL, gL, zA), b: V(xL, yTop, zA), r: 0.3, real: true }, { kind: 'seg', a: V(xR, gR, zA), b: V(xR, yTop, zA), r: 0.3, real: true });
    shadowCasters.push({ kind: 'box', m: M((xL + xR) / 2, yTop - 0.35 - bh / 2, zA), sx: bw, sy: bh, sz: 0.4, real: true });
    keep(xL - 3, xR + 3, zA - 3, zA + 3);

    // feather flags lining the start corral, both sides
    const feather = (x, z, i, yaw) => {
      const g = ground(x, z), H = 4.6, w = 0.95;
      b.add('steel', unitCyl(6), segM(V(x, g - 0.3, z), V(x, g + H, z), 0.022), 0x2a2d31);
      b.add('steel', new THREE.ConeGeometry(0.25, 0.5, 8), M(x, g + 0.05, z), 0x2a2d31);
      const dir = V(Math.cos(yaw), 0, -Math.sin(yaw));
      panel(b, P['feather' + (i % 4)], M(x + dir.x * (w / 2 + 0.03), g + H - 3.9 / 2 - 0.1, z + dir.z * (w / 2 + 0.03), yaw), w, 3.9,
        { fl: { origin: V(x, g, z), dir, len: w, amp: 0.09, phase: x * 0.7 + z, freq: 0.9 } });
      shadowCasters.push({ kind: 'seg', a: V(x, g, z), b: V(x, g + H, z), r: 0.35, real: true, k: 0.6 });
    };
    let fi = 0;
    for (const side of [-1, 1]) for (let k = 0; k < 4; k++) { const z = -14 - k * 9, x = runCenter(z) + side * (17 + k * 2.5); feather(x, z, fi++, side > 0 ? Math.PI * 0.85 : Math.PI * 0.15); }
    const poleFlag = (x, z, i) => {
      const g = ground(x, z), H = 9;
      b.add('paint', new THREE.CylinderGeometry(0.045, 0.07, H + 0.3, 10), M(x, g + H / 2 - 0.15, z), 0xe8eaec);
      b.add('steel', new THREE.SphereGeometry(0.08, 10, 8), M(x, g + H + 0.05, z), 0xd4af37);
      const dir = V(1, 0, 0.25).normalize(), w = 2.1, h = 1.4;
      panel(b, P['flag' + (i % 4)], M(x + dir.x * (w / 2 + 0.05), g + H - h / 2 - 0.15, z + dir.z * (w / 2 + 0.05), Math.atan2(-dir.z, dir.x)), w, h,
        { fl: { origin: V(x, g, z), dir, len: w, amp: 0.16, phase: i * 1.9, freq: 1.2 } });
      shadowCasters.push({ kind: 'seg', a: V(x, g, z), b: V(x, g + H, z), r: 0.1, real: true });
    };
    // judges' / start hut on the left of the deck
    const jx = runCenter(-36) - 46, jz = -36, jg = Math.min(ground(jx - 3.5, jz - 3), ground(jx + 3.5, jz - 3), ground(jx - 3.5, jz + 3), ground(jx + 3.5, jz + 3)) - 0.2;
    {
      const W = 7, D = 6, F1 = 3.2, F2 = 2.9;
      b.add('stone', new THREE.BoxGeometry(W + 0.4, 1.2, D + 0.4), M(jx, jg - 0.2, jz), 0x8f8a84, { wuv: 2.5 });
      b.add('timber', new THREE.BoxGeometry(W, F1, D), M(jx, jg + 0.4 + F1 / 2, jz), 0xd2b48f, { wuv: 2.4 });
      b.add('paint', new THREE.BoxGeometry(1.1, 2.1, 0.08), M(jx + 1.8, jg + 0.4 + 1.05, jz + D / 2 + 0.02), 0x23394f);
      b.add('glass', new THREE.BoxGeometry(0.08, 1.1, 3.2), M(jx + W / 2 + 0.02, jg + 0.4 + 1.8, jz), 0xffffff);
      const y2 = jg + 0.4 + F1;
      b.add('timber', new THREE.BoxGeometry(W + 2.4, 0.3, D + 2.4), M(jx, y2 + 0.15, jz), 0xb29470, { wuv: 2 });
      b.add('timber', new THREE.BoxGeometry(W - 0.6, 0.9, D - 0.6), M(jx, y2 + 0.75, jz), 0xd2b48f, { wuv: 2.4 });
      for (const [w, d, ox, oz] of [[W - 0.6, 0.1, 0, (D - 0.6) / 2], [W - 0.6, 0.1, 0, -(D - 0.6) / 2], [0.1, D - 0.6, (W - 0.6) / 2, 0], [0.1, D - 0.6, -(W - 0.6) / 2, 0]])
        b.add('glass', new THREE.BoxGeometry(w, F2 - 1.0, d), M(jx + ox, y2 + 1.2 + (F2 - 1.0) / 2, jz + oz), 0xffffff);
      for (const [ox, oz] of [[1, 1], [1, -1], [-1, 1], [-1, -1]]) b.add('paint', new THREE.BoxGeometry(0.16, F2 - 0.9, 0.16), M(jx + ox * (W - 0.6) / 2, y2 + 0.9 + (F2 - 0.9) / 2, jz + oz * (D - 0.6) / 2), 0x2a2d31);
      const rw = W + 2.4, rd = D + 2.4;
      for (const [a, c] of [[V(-1, 0, -1), V(1, 0, -1)], [V(1, 0, -1), V(1, 0, 1)], [V(1, 0, 1), V(-1, 0, 1)]]) {
        const pa = V(jx + a.x * rw / 2, y2 + 1.3, jz + a.z * rd / 2), pc = V(jx + c.x * rw / 2, y2 + 1.3, jz + c.z * rd / 2);
        b.add('timber', unitCyl(6), segM(pa, pc, 0.05), 0x9c7c5c); b.add('timber', unitCyl(6), segM(pa.clone().setY(y2 + 0.75), pc.clone().setY(y2 + 0.75), 0.03), 0x9c7c5c);
        const n = Math.round(pa.distanceTo(pc) / 1.2); for (let k = 0; k <= n; k++) { const q = pa.clone().lerp(pc, k / n); b.add('timber', new THREE.BoxGeometry(0.1, 1.0, 0.1), M(q.x, y2 + 0.8, q.z), 0x9c7c5c); }
      }
      const yr = y2 + 0.3 + F2;
      b.add('timber', new THREE.BoxGeometry(W + 3.2, 0.35, D + 3.2), M(jx, yr, jz), 0x9c7c5c, { wuv: 2 });
      b.add('roofSnow', new RoundedBoxGeometry(W + 3.0, 0.55, D + 3.0, 3, 0.25), M(jx, yr + 0.38, jz), 0xffffff);
      for (let k = 0; k < 11; k++) b.add('timber', new THREE.BoxGeometry(1.1, 0.06, 0.32), M(jx - W / 2 - 0.65, jg + 0.4 + k * 0.3, jz + 2.6 - k * 0.45), 0xb29470);
      b.add('timber', unitCyl(6), segM(V(jx - W / 2 - 1.2, jg + 1.3, jz + 2.6), V(jx - W / 2 - 1.2, y2 + 1.3, jz + 2.6 - 10 * 0.45), 0.04), 0x9c7c5c);
      panel(b, P.judges, M(jx + W / 2 + 1.25, y2 - 0.3, jz, Math.PI / 2), 2.2, 0.48);
      panel(b, P.judges, M(jx, y2 - 0.3, jz + D / 2 + 1.25), 2.2, 0.48);
      shadowCasters.push({ kind: 'box', m: M(jx, jg + (yr + 0.6 - jg) / 2, jz), sx: W + 2.4, sy: yr + 0.6 - jg, sz: D + 2.4, real: true });
      keep(jx - 9, jx + 9, jz - 9, jz + 12);
      poleFlag(jx + W / 2 + 2.6, jz + D / 2 + 3, 0); poleFlag(jx + W / 2 + 2.6, jz - D / 2 - 2, 1);
    }
    signPost(b, P['S:start'], runCenter(-28) + 9, -28, 0);
  }

  // ═══════════ 4. the base area ═══════════
  {
    const b = B.base;
    // the lodge: stone plinth, timber frame, a glazed gable looking up the hill, big snowy roof, a sun deck
    const lx = -52, lz = 1655, W = 44, D = 20, g = Math.min(...[-1, 1].flatMap((i) => [-1, 1].map((j) => ground(lx + i * W / 2, lz + j * D / 2)))) - 0.2;
    const timber = 0xdcc09c, darkT = 0x8e6e50;
    const F = 4, plinth = 1.1, eave = g + plinth + 2 * F;
    b.add('stone', new THREE.BoxGeometry(W + 0.6, plinth + 1, D + 0.6), M(lx, g + (plinth - 1) / 2, lz), 0x9c968c, { wuv: 3 });
    b.add('timber', new THREE.BoxGeometry(W, F, D - 0.6), M(lx, g + plinth + F / 2, lz + 0.3), timber, { wuv: 2.6 });
    b.add('glass', new THREE.BoxGeometry(W - 1, F - 0.6, 0.1), M(lx, g + plinth + F / 2, lz - D / 2 + 0.25), 0xffffff);
    for (let k = 0; k <= 11; k++) b.add('timber', new THREE.BoxGeometry(0.22, F, 0.3), M(lx - W / 2 + 0.3 + k * (W - 0.6) / 11, g + plinth + F / 2, lz - D / 2 + 0.2), darkT, { wuv: 1.5 });
    b.add('timber', new THREE.BoxGeometry(W, F, D - 2), M(lx, g + plinth + F * 1.5, lz + 1), timber, { wuv: 2.6 });
    for (let k = 0; k < 9; k++) b.add('glass', new THREE.BoxGeometry(2.4, 2.0, 0.1), M(lx - W / 2 + 3 + k * (W - 6) / 8, g + plinth + F * 1.5 + 0.2, lz - D / 2 + 0.96), 0xffffff);
    b.add('timber', new THREE.BoxGeometry(W + 0.4, 0.25, 2.2), M(lx, g + plinth + F + 0.1, lz - D / 2 + 0.1), darkT, { wuv: 2 });
    for (let k = 0; k <= 22; k++) b.add('timber', new THREE.BoxGeometry(0.08, 1.0, 0.08), M(lx - W / 2 + k * W / 22, g + plinth + F + 0.7, lz - D / 2 - 0.9), darkT);
    b.add('timber', new THREE.BoxGeometry(W + 0.4, 0.1, 0.14), M(lx, g + plinth + F + 1.2, lz - D / 2 - 0.9), darkT);
    // the main roof: gable, ridge along x, 32° pitch, deep eaves, thick snow
    const pitch = 0.56, half = D / 2 + 2.2, rise = Math.tan(pitch) * half, slope = half / Math.cos(pitch);
    for (const s of [-1, 1]) {
      const cz = lz + s * half / 2, cy = eave + rise / 2;
      b.add('timber', new THREE.BoxGeometry(W + 4, 0.35, slope), M(lx, cy, cz, 0, s * pitch), darkT, { wuv: 2 });
      b.add('roofSnow', new RoundedBoxGeometry(W + 3.8, 0.7, slope - 0.1, 3, 0.32), M(lx, cy + 0.5 / Math.cos(pitch), cz, 0, s * pitch), 0xffffff);
    }
    for (const sx of [-1, 1]) {
      const sh = new THREE.Shape([new THREE.Vector2(-D / 2, 0), new THREE.Vector2(D / 2, 0), new THREE.Vector2(0, Math.tan(pitch) * D / 2)]);
      b.add('timber', new THREE.ExtrudeGeometry(sh, { depth: 0.3, bevelEnabled: false }), M(lx + sx * (W / 2 - 0.15) - 0.15, eave, lz, Math.PI / 2), timber, { wuv: 2.6 });
    }
    // the cross gable: a full-height glass A-frame over the entrance
    {
      const cw = 16, cd = 7, cx = lx, cz = lz - D / 2 - cd / 2 + 1, top = eave + Math.tan(pitch) * (cw / 2 + 1.5);
      const sh = new THREE.Shape([new THREE.Vector2(-cw / 2, 0), new THREE.Vector2(cw / 2, 0), new THREE.Vector2(cw / 2, 2 * F), new THREE.Vector2(0, 2 * F + Math.tan(pitch) * cw / 2), new THREE.Vector2(-cw / 2, 2 * F)]);
      b.add('glass', new THREE.ExtrudeGeometry(sh, { depth: 0.12, bevelEnabled: false }), M(cx, g + plinth, cz - cd / 2), 0xffffff);
      for (let k = 0; k <= 6; k++) { const x = -cw / 2 + k * cw / 6, hh = 2 * F + Math.tan(pitch) * (cw / 2 - Math.abs(x)); b.add('timber', new THREE.BoxGeometry(0.28, hh, 0.36), M(cx + x, g + plinth + hh / 2, cz - cd / 2), darkT, { wuv: 1.5 }); }
      for (const y of [F, F * 1.55]) b.add('timber', new THREE.BoxGeometry(cw, 0.24, 0.36), M(cx, g + plinth + y, cz - cd / 2), darkT, { wuv: 1.5 });
      for (const sx of [-1, 1]) b.add('timber', new THREE.BoxGeometry(0.4, 2 * F, cd), M(cx + sx * cw / 2, g + plinth + F, cz), timber, { wuv: 2.6 });
      const half2 = cw / 2 + 1.5, slope2 = half2 / Math.cos(pitch), r2 = Math.tan(pitch) * half2;
      for (const s of [-1, 1]) {
        b.add('timber', new THREE.BoxGeometry(slope2, 0.35, cd + 2.2), M(cx + s * half2 / 2, g + plinth + 2 * F + r2 / 2 + 0.2, cz - 1.1, 0, 0, -s * pitch), darkT, { wuv: 2 });
        b.add('roofSnow', new RoundedBoxGeometry(slope2 - 0.1, 0.65, cd + 2.0, 3, 0.3), M(cx + s * half2 / 2, g + plinth + 2 * F + r2 / 2 + 0.68, cz - 1.1, 0, 0, -s * pitch), 0xffffff);
      }
      for (const s of [-1, 1]) b.add('timber', unitCyl(6), segM(V(cx + s * cw / 2, g + plinth + F, cz - cd / 2 - 0.2), V(cx + s * (cw / 2 - 2), g + plinth + 2 * F + 1.2, cz - cd / 2 - 1.6), 0.16), darkT);
      panel(b, P.lodge, M(cx, g + plinth + 2 * F + 1.2, cz - cd / 2 - 0.25, Math.PI), 7.2, 1.05);
      shadowCasters.push({ kind: 'box', m: M(cx, g + (top - g) / 2, cz), sx: cw, sy: top - g, sz: cd, real: true });
    }
    b.add('stone', new THREE.BoxGeometry(1.6, 6, 1.6), M(lx + W / 2 - 6, eave + rise - 0.5, lz + 3), 0x8f8a84, { wuv: 2.5 });
    b.add('roofSnow', new RoundedBoxGeometry(1.9, 0.3, 1.9, 2, 0.12), M(lx + W / 2 - 6, eave + rise + 2.6, lz + 3), 0xffffff);
    // sun deck in front with railing, snowy tables and closed parasols
    const dz = lz - D / 2 - 9.5, dg = g + plinth - 0.1;
    b.add('timber', new THREE.BoxGeometry(W + 6, 0.3, 9), M(lx, dg, dz + 2), 0xbfa07e, { wuv: 2 });
    b.add('stone', new THREE.BoxGeometry(W + 6, plinth + 1, 0.6), M(lx, g + (plinth - 1) / 2, dz - 2.4), 0x9c968c, { wuv: 3 });
    for (let k = 0; k <= 25; k++) b.add('timber', new THREE.BoxGeometry(0.1, 1.0, 0.1), M(lx - (W + 6) / 2 + k * (W + 6) / 25, dg + 0.6, dz - 2.3), darkT);
    b.add('timber', new THREE.BoxGeometry(W + 6, 0.1, 0.16), M(lx, dg + 1.1, dz - 2.3), darkT);
    for (let k = 0; k < 6; k++) {
      const tx = lx - W / 2 + 4 + k * 7, tz = dz + 1.6 + (k % 2) * 2.2;
      b.add('timber', new THREE.BoxGeometry(2.2, 0.08, 0.8), M(tx, dg + 0.9, tz), 0xd0b08c);
      for (const s of [-1, 1]) { b.add('timber', new THREE.BoxGeometry(2.2, 0.06, 0.3), M(tx, dg + 0.6, tz + s * 0.65), 0xd0b08c); b.add('roofSnow', new RoundedBoxGeometry(2.1, 0.12, 0.28, 2, 0.05), M(tx, dg + 0.68, tz + s * 0.65), 0xffffff); }
      b.add('roofSnow', new RoundedBoxGeometry(2.1, 0.14, 0.75, 2, 0.06), M(tx, dg + 1.0, tz), 0xffffff);
      for (const s of [-0.8, 0.8]) b.add('timber', new THREE.BoxGeometry(0.08, 0.85, 0.7), M(tx + s, dg + 0.45, tz), 0x9c7c5c);
      b.add('paint', new THREE.CylinderGeometry(0.03, 0.03, 2.6, 6), M(tx, dg + 1.4, tz), 0xdddddd);
      b.add('paint', new THREE.ConeGeometry(0.22, 1.6, 10, 1, true), M(tx, dg + 2.1, tz, 0, Math.PI), k % 2 ? 0xa3241b : 0xe9e4d8);
    }
    shadowCasters.push({ kind: 'box', m: M(lx, g + (eave + rise - g) / 2, lz + 0.3), sx: W + 2, sy: eave + rise * 0.6 - g, sz: D + 2, real: true });
    keep(lx - W / 2 - 8, lx + W / 2 + 8, dz - 10, lz + D / 2 + 8);
    // ski racks below the deck, with skis and boards leaning in them
    const ski = [0xd23a2a, 0x1f5fd0, 0xf2b631, 0x222222, 0xf2f2f2, 0x2a9d8f, 0x8e44ad, 0xff6a14];
    for (let r = 0; r < 3; r++) {
      const rx = lx - 14 + r * 12, rz = dz - 6.5, rg = ground(rx, rz);
      for (const s of [-1, 1]) b.add('steel', unitCyl(8), segM(V(rx + s * 2.5, rg - 0.2, rz), V(rx + s * 2.5, rg + 1.0, rz), 0.035), 0x8e959c);
      b.add('steel', unitCyl(8), segM(V(rx - 2.5, rg + 1.0, rz), V(rx + 2.5, rg + 1.0, rz), 0.03), 0x8e959c);
      b.add('steel', unitCyl(8), segM(V(rx - 2.5, rg + 0.35, rz + 0.25), V(rx + 2.5, rg + 0.35, rz + 0.25), 0.03), 0x8e959c);
      for (let k = 0; k < 11; k++) {
        if (rnd() < 0.25) continue;
        const sx = rx - 2.3 + k * 0.46, board = rnd() < 0.3, len = board ? 1.55 : 1.75, c = ski[(rnd() * ski.length) | 0];
        const geo = board ? new RoundedBoxGeometry(0.27, len, 0.025, 2, 0.012) : new RoundedBoxGeometry(0.075, len, 0.02, 2, 0.008);
        for (const o of board ? [0] : [-0.05, 0.05]) b.add('paint', geo, M(sx + o, rg + len / 2 - 0.15, rz + 0.12, 0, -0.18), c);
      }
    }
    // small buildings: tickets (by the lift), rentals, ski patrol, a store shed
    const hut = (x, z, w, d, h, yaw, sign, roofCol = 0x3c434b, wallCol = 0xd0b08c) => {
      const gg = Math.min(ground(x - w / 2, z - d / 2), ground(x + w / 2, z + d / 2), ground(x - w / 2, z + d / 2), ground(x + w / 2, z - d / 2)) - 0.15;
      const R = (lx2, ly, lz2, ry = 0, rx = 0, rz = 0) => M(x + lx2 * Math.cos(yaw) + lz2 * Math.sin(yaw), gg + ly, z - lx2 * Math.sin(yaw) + lz2 * Math.cos(yaw), yaw + ry, rx, rz);
      b.add('stone', new THREE.BoxGeometry(w + 0.3, 0.8, d + 0.3), R(0, 0.1, 0), 0x9c968c, { wuv: 2.5 });
      b.add('timber', new THREE.BoxGeometry(w, h, d), R(0, 0.5 + h / 2, 0), wallCol, { wuv: 2.4 });
      for (const fx of [-w / 4, w / 4]) b.add('glass', new THREE.BoxGeometry(w * 0.3, h * 0.42, 0.1), R(fx, 0.5 + h * 0.58, -d / 2 - 0.02), 0xffffff);
      for (const fx of [-w / 4, w / 4]) b.add('timber', new THREE.BoxGeometry(w * 0.3 + 0.2, 0.12, 0.2), R(fx, 0.5 + h * 0.36, -d / 2 - 0.08), 0x9c7c5c);
      b.add('paint', new THREE.BoxGeometry(1.0, 2.1, 0.08), R(0, 0.5 + 1.05, -d / 2 - 0.02), 0x2a3440);
      const p2 = 0.62, hd = d / 2 + 1.0, sl = hd / Math.cos(p2), rr = Math.tan(p2) * hd;
      for (const s of [-1, 1]) {
        b.add('metalRoof', new THREE.BoxGeometry(w + 1.4, 0.14, sl), R(0, 0.5 + h + rr / 2, s * hd / 2, 0, s * p2), roofCol);
        b.add('roofSnow', new RoundedBoxGeometry(w + 1.3, 0.45, sl - 0.1, 2, 0.2), R(0, 0.5 + h + rr / 2 + 0.3, s * hd / 2, 0, s * p2), 0xffffff);
      }
      for (const sx of [-1, 1]) {
        const sh = new THREE.Shape([new THREE.Vector2(-d / 2, 0), new THREE.Vector2(d / 2, 0), new THREE.Vector2(0, Math.tan(p2) * d / 2)]);
        b.add('timber', new THREE.ExtrudeGeometry(sh, { depth: 0.2, bevelEnabled: false }), R(sx * (w / 2 - 0.1) - 0.1, 0.5 + h, 0, Math.PI / 2), wallCol, { wuv: 2.4 });
      }
      if (sign) { const sw = Math.min(w * 0.8, 3.6); panel(b, P[sign], R(0, 0.5 + h + 0.35, -d / 2 - 0.3, Math.PI), sw, sw * P[sign].h / P[sign].w); }
      shadowCasters.push({ kind: 'box', m: R(0, (h + rr) / 2 + 0.5, 0), sx: w + 1.4, sy: h + rr * 0.7 + 0.5, sz: d + 2, real: true });
      keep(x - w, x + w, z - d, z + d);
    };
    hut(lift.stBase.x - 22, lift.stBase.z + 16, 7, 5, 3, 0, 'tickets', 0x24476e);
    hut(14, 1688, 14, 9, 4, 0, 'rentals');
    hut(-118, 1520, 8, 6, 3.2, -0.5, 'patrol', 0x7c1e18, 0xa45b3c);
    hut(-130, 1640, 9, 7, 3.4, 0.3, null, 0x3c434b);
    // split-rail fence round the lodge yard
    const fence = (pts2, col = 0xb29470) => {
      for (let i = 0; i < pts2.length - 1; i++) {
        const a = pts2[i], c = pts2[i + 1], n = Math.max(1, Math.round(Math.hypot(c[0] - a[0], c[1] - a[1]) / 3));
        for (let k = 0; k <= n; k++) {
          const x = lerp(a[0], c[0], k / n), z = lerp(a[1], c[1], k / n), gg = ground(x, z);
          b.add('timber', new THREE.CylinderGeometry(0.08, 0.09, 1.5, 7), M(x, gg + 0.45, z), col);
          if (k < n) {
            const x2 = lerp(a[0], c[0], (k + 1) / n), z2 = lerp(a[1], c[1], (k + 1) / n), g2 = ground(x2, z2);
            for (const hh of [0.55, 1.0]) b.add('timber', unitCyl(6), segM(V(x, gg + hh, z), V(x2, g2 + hh, z2), 0.055), col);
          }
        }
      }
    };
    fence([[-110, 1700], [-110, 1610], [-80, 1600]]); fence([[25, 1625], [40, 1700]]);
    for (const [x, z] of [[-78, 1625], [-26, 1625], [6, 1650], [lift.stBase.x - 14, lift.stBase.z + 4]]) {
      const gg = ground(x, z);
      b.add('steel', new THREE.CylinderGeometry(0.06, 0.09, 4.5, 8), M(x, gg + 2.0, z), 0x2a2d31);
      b.add('steel', new THREE.CylinderGeometry(0.22, 0.12, 0.35, 8), M(x, gg + 4.4, z), 0x2a2d31);
      b.add('paint', new THREE.SphereGeometry(0.16, 10, 8), M(x, gg + 4.15, z), 0xfff2d0);
    }
    signPost(b, P['S:slow'], 30, 1445, 0);
    signPost(b, P['S:slow'], -40, 1445, 0);
  }

  // ═══════════ 5. park dressing on the run ═══════════
  {
    const b = B.run;
    // bamboo marker poles along both edges of the groomed run, with small flags
    for (let z = -50; z < 1440; z += 18) for (const s of [-1, 1]) {
      const zz = z + (s > 0 ? 9 : 0), x = runCenter(zz) + s * (runHalf(zz) - 2);
      if (!lineClear(x, zz, 6) || inKeep(x, zz, 1)) continue;
      const g = ground(x, zz), lean = (rnd() - 0.5) * 0.08, H = 2.1 + rnd() * 0.3;
      const top = V(x + lean * H, g + H, zz + (rnd() - 0.5) * 0.08);
      b.add('paint', new THREE.CylinderGeometry(0.018, 0.022, 1, 6), segM(V(x, g - 0.3, zz), top), 0xc8a96a);
      for (let k = 1; k < 5; k++) b.add('paint', new THREE.CylinderGeometry(0.024, 0.024, 0.03, 6), M(x + lean * k * 0.45, g + k * 0.45, zz), 0x9c7f45);
      const dir = V(1, 0, 0.6 * s).normalize(), w = 0.42, h = 0.28;
      panel(b, s < 0 ? P.mOrange : P.mBlue, M(top.x + dir.x * w / 2, top.y - h / 2 - 0.02, top.z + dir.z * w / 2, Math.atan2(-dir.z, dir.x)), w, h,
        { fl: { origin: top, dir, len: w, amp: 0.035, phase: zz * 0.31, freq: 1.6 } });
    }
    // orange snow fencing in places along the run edges
    const fenceRun = (z0, z1, s, off = 3.5) => {
      const pts2 = []; for (let z = z0; z <= z1; z += 2.5) pts2.push(V(runCenter(z) + s * (runHalf(z) + off), 0, z));
      const H = 1.2, pos = [], uv = [], idx = [];
      let u = 0;
      for (let i = 0; i < pts2.length; i++) {
        const p = pts2[i], g = ground(p.x, p.z);
        if (i) u += p.distanceTo(pts2[i - 1]) / 1.6;
        pos.push(p.x, g + 0.05, p.z, p.x, g + H, p.z); uv.push(u, 0, u, 1);
        if (i) { const a = (i - 1) * 2; idx.push(a, a + 2, a + 1, a + 1, a + 2, a + 3); }
        b.add('paint', new THREE.CylinderGeometry(0.025, 0.03, H + 0.6, 6), M(p.x, g + H / 2 - 0.15, p.z), 0x3b3f44);
      }
      const geo = new THREE.BufferGeometry(); geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2)); geo.setIndex(idx); geo.computeVertexNormals();
      b.add('fence', geo, null, 0xffffff);
    };
    fenceRun(470, 560, -1); fenceRun(600, 700, 1); fenceRun(820, 1000, -1); fenceRun(860, 1080, 1); fenceRun(-55, 20, -1, 2); fenceRun(1130, 1200, 1);
    // a sign before every jump, off to the side of its line (pushed outward until clear of every line)
    for (const j of JUMPS) {
      const f = FEATURES.find((ff) => ff.name === j.name) || FEATURES.find((ff) => ff.kind === 'stepdown' && Math.abs(ff.x - j.x) < 1);
      const z = (f ? f.zMin : j.z - 10) - 7, side = j.x < -10 ? -1 : 1;
      let x = j.x + side * (j.w / 2 + 6);
      for (let k = 0; k < 20 && !lineClear(x, z, 4.5); k++) x += side * 1.5;
      signPost(b, P['J:' + j.name], x, z, -side * 0.25);
    }
    // a sign before each rail lane, and section signs at the run edge
    for (const L of P.lanes) {
      const z = L.z - 22; let x = L.x - 7;
      for (let k = 0; k < 10 && !lineClear(x, z, 4.5); k++) x -= 1;
      signPost(b, P[L.key], x, z, 0);
    }
    const edgeSign = (key, z, s = -1) => signPost(b, P[key], runCenter(z) + s * (runHalf(z) - 7), z, s * 0.35);
    edgeSign('S:jib', 110); edgeSign('S:jumps', 455); edgeSign('S:big', 805); edgeSign('S:jib2', 1135); edgeSign('S:jib', 112, 1);
    // padded posts flanking the start of the down rails (rails that start high off the bare snow)
    for (const r of RAILS) {
      const p0 = r.pts[0], hBare = p0[1] - ground(p0[0], p0[2], true);
      if (hBare < 1.0) continue;
      const off = r.kind === 'box' ? 1.9 : 1.6;
      for (const s of [-1, 1]) {
        const x = p0[0] + s * off, z = p0[2] + 0.4, g = ground(x, z);
        b.add('paint', new RoundedBoxGeometry(0.5, 1.1, 0.5, 3, 0.16), M(x, g + 0.45, z), 0xff5a10);
        b.add('paint', new RoundedBoxGeometry(0.52, 0.12, 0.52, 2, 0.04), M(x, g + 0.82, z), 0x15171a);
      }
    }
  }

  // ═══════════ 6. rock outcrops ═══════════
  const rocks = buildRocks();
  function buildRocks() {
    const geos = [];
    for (let v = 0; v < 3; v++) {
      const r = mulberry(900 + v), g = new THREE.IcosahedronGeometry(1, 3), p = g.attributes.position;
      // a convex block cut by random planes (fractured faces), then weathered with noise
      const planes = []; for (let k = 0; k < 11; k++) { const n = V(r() - 0.5, (r() - 0.35) * 0.8, r() - 0.5).normalize(); planes.push([n, 0.55 + r() * 0.4]); }
      for (let i = 0; i < p.count; i++) {
        const d = V(p.getX(i), p.getY(i), p.getZ(i)).normalize();
        let rad = 1.25;
        for (const [n, dist] of planes) { const c = d.dot(n); if (c > 0.05) rad = Math.min(rad, dist / c); }
        rad *= 0.92 + 0.16 * fbm(d.x * 3 + v * 7, d.z * 3 + d.y * 2, 3);
        p.setXYZ(i, d.x * rad * 1.3, d.y * rad * 0.8, d.z * rad);
      }
      g.deleteAttribute('uv'); g.computeVertexNormals(); geos.push(g);
    }
    const mat = new THREE.MeshStandardMaterial({ map: tex('rock_diff.jpg', true), normalMap: tex('rock_nor.jpg'), roughness: 0.92, color: 0xc4c4c4 });
    // (no uv attribute: the shader samples triplanar from world position; three still needs vMapUv declared)
    mat.onBeforeCompile = (s) => {
      worldVarying(s);
      s.fragmentShader = s.fragmentShader.replace('#include <map_fragment>', `
          vec3 nWr = normalize((vec4(vNormal, 0.0) * viewMatrix).xyz);
          vec3 bw = pow(abs(nWr), vec3(4.0)); bw /= dot(bw, vec3(1.0));
          vec3 tri = texture2D(map, vScW.zy / 7.0).rgb * bw.x + texture2D(map, vScW.xz / 7.0).rgb * bw.y + texture2D(map, vScW.xy / 7.0).rgb * bw.z;
          tri = mix(vec3(dot(tri, vec3(0.3, 0.55, 0.15))), tri, 0.3) * vec3(0.92, 0.95, 1.0);
          diffuseColor.rgb *= tri;`)
        .replace('#include <normal_fragment_maps>', `
          { vec3 nm = texture2D(normalMap, (bw.x > 0.5 ? vScW.zy : bw.y > 0.5 ? vScW.xz : vScW.xy) / 7.0).xyz * 2.0 - 1.0;
            normal = normalize(normal + (viewMatrix * vec4(nm * 0.5, 0.0)).xyz); }`);
      addSnow(s, { amount: '1.0', scale: '0.6', lo: '0.42', hi: '0.75' });
    };
    mat.customProgramCacheKey = () => 'scenery-rock';
    for (const g of geos) g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(g.attributes.position.count * 2), 2));
    const list = [[], [], []];
    // outcrops: a cluster of half-buried blocks round a centre, where it is steep or high and rocky
    for (let z = MZ0 + 40; z < MZ1 - 40; z += 34) for (let x = -MX + 40; x < MX - 40; x += 34) {
      const px = x + (rnd() - 0.5) * 30, pz = z + (rnd() - 0.5) * 30, out = Math.abs(px - runCenter(pz)) - runHalf(pz);
      if (out < 30) continue;
      const sl = slopeAt(px, pz, 6), cl = fbm(px * 0.006 - 4, pz * 0.006 + 9, 3), rel = ground(px, pz, true) - baseY(pz);
      const p = (sstep(0.55, 1.0, sl) * 0.7 + sstep(320, 520, rel) * 0.5) * sstep(0.45, 0.62, cl) * (out > 600 ? 0.5 : 1);
      if (rnd() > p || inKeep(px, pz, 10) || Math.abs(px - liftX(pz)) < 25) continue;
      const big = 4 + rnd() * 7 * (0.6 + Math.min(sl, 1.4) * 0.5), n = 2 + ((rnd() * 5) | 0), ang = rnd() * 6.28;
      for (let k = 0; k < n; k++) {
        const r = k ? big * (0.6 + rnd() * 0.9) : 0, a2 = ang + (rnd() - 0.5) * 1.6 + (k % 2) * Math.PI;
        list[(rnd() * 3) | 0].push({ x: px + Math.cos(a2) * r, z: pz + Math.sin(a2) * r, s: big * (k ? 0.35 + rnd() * 0.45 : 1), r: rnd() * 6.28 });
      }
    }
    for (let i = 0; i < 260; i++) {          // boulders in the forest near the run
      const pz = MZ0 + 50 + rnd() * (MZ1 - MZ0 - 100), s = rnd() < 0.5 ? -1 : 1, px = runCenter(pz) + s * (runHalf(pz) + 8 + rnd() * 70);
      if (inKeep(px, pz, 3) || Math.abs(px - liftX(pz)) < 10) continue;
      list[i % 3].push({ x: px, z: pz, s: 0.7 + rnd() * 2.2, r: rnd() * 6.28 });
    }
    const n = new THREE.Vector3(), up = V(0, 1, 0), ms = [];
    let total = 0;
    list.forEach((Ls, v) => {
      const im = new THREE.InstancedMesh(geos[v], mat, Math.max(1, Ls.length));
      Ls.forEach((k, i) => {
        const e = 2, hx = ground(k.x + e, k.z) - ground(k.x - e, k.z), hz = ground(k.x, k.z + e) - ground(k.x, k.z - e);
        n.set(-hx, 2 * e, -hz).normalize().lerp(up, 0.5).normalize();
        _q.setFromUnitVectors(up, n).multiply(new THREE.Quaternion().setFromAxisAngle(up, k.r));
        im.setMatrixAt(i, _m.compose(_p.set(k.x, surfY(k.x, k.z) - k.s * 0.32, k.z), _q, _s.set(k.s, k.s * (0.7 + 0.5 * ((i * 7) % 5) / 5), k.s)));
        if (k.s > 1.5) shadowCasters.push({ kind: 'tree', x: k.x, y: surfY(k.x, k.z), z: k.z, h: k.s * 0.55, r: k.s * 0.9, k: 0.6 });
      });
      im.count = Ls.length; im.computeBoundingSphere(); im.castShadow = true; im.receiveShadow = true; im.layers.enable(1); im.name = 'scenery:rocks' + v;
      group.add(im); ms.push(im); total += Ls.length;
    });
    return { count: total, meshes: ms };
  }

  // ═══════════ 7. distant peaks ═══════════
  const peaks = buildPeaks();
  function buildPeaks() {
    // a skirt from just inside the drawn terrain out to ~6 km: at its inner edge it IS ground() (seamless with
    // world.js), further out it blends into ridged, domain-warped noise peaks, the valley continuing along z
    const zc = (MZ0 + MZ1) / 2, hx = MX - 30, hz = (MZ1 - MZ0) / 2 - 30, rc = 260;
    const per = [];
    {
      const corner = (cx, cz, a0) => { for (let k = 0; k < 12; k++) { const a = a0 + (k / 12) * Math.PI / 2; per.push([cx + Math.cos(a) * rc, cz + Math.sin(a) * rc, Math.cos(a), Math.sin(a)]); } };
      const edge = (x0, z0, x1, z1, nx, nz) => { const n = Math.ceil(Math.hypot(x1 - x0, z1 - z0) / 16); for (let k = 0; k < n; k++) per.push([lerp(x0, x1, k / n), lerp(z0, z1, k / n), nx, nz]); };
      const ax = hx - rc, az = hz - rc;
      // counter-clockwise seen from above, starting on the uphill (-z) side
      edge(ax, zc - hz, -ax, zc - hz, 0, -1); corner(-ax, zc - az, -Math.PI / 2 - Math.PI / 2 * 0);
      per.length -= 12; for (let k = 0; k < 12; k++) { const a = -Math.PI / 2 - (k / 12) * Math.PI / 2; per.push([-ax + Math.cos(a) * rc, zc - az + Math.sin(a) * rc, Math.cos(a), Math.sin(a)]); }
      edge(-hx, zc - az, -hx, zc + az, -1, 0);
      for (let k = 0; k < 12; k++) { const a = Math.PI - (k / 12) * Math.PI / 2; per.push([-ax + Math.cos(a) * rc, zc + az + Math.sin(a) * rc, Math.cos(a), Math.sin(a)]); }
      edge(-ax, zc + hz, ax, zc + hz, 0, 1);
      for (let k = 0; k < 12; k++) { const a = Math.PI / 2 - (k / 12) * Math.PI / 2; per.push([ax + Math.cos(a) * rc, zc + az + Math.sin(a) * rc, Math.cos(a), Math.sin(a)]); }
      edge(hx, zc + az, hx, zc - az, 1, 0);
      for (let k = 0; k < 12; k++) { const a = -(k / 12) * Math.PI / 2; per.push([ax + Math.cos(a) * rc, zc - az + Math.sin(a) * rc, Math.cos(a), Math.sin(a)]); }
    }
    const ridged = (x, z) => {
      const wx = x + (fbm(x * 0.00031, z * 0.00031, 3) - 0.5) * 2600, wz = z + (fbm(x * 0.00031 + 11, z * 0.00031 - 7, 3) - 0.5) * 2600;
      let s = 0, a = 0.55, f = 0.00042, w = 1;
      for (let o = 0; o < 7; o++) { let n = 1 - Math.abs(fbm(wx * f + o * 17.1, wz * f - o * 9.3, 1) * 2 - 1); n *= n; n *= clamp(w, 0, 1); w = n * 1.6; s += n * a; a *= 0.5; f *= 2.05; }
      return s;
    };
    const RINGS = [];
    { let d = -24, st = 8; while (d < 6000) { RINGS.push(d); d += st; st = Math.min(260, st * 1.1); } }
    const NP = per.length, NR = RINGS.length, pos = new Float32Array(NP * NR * 3);
    const H = (x, z, d) => {
      const g = Math.min(ground(x, z, true), 3600);                       // the drawn mountainside, continued
      const far = sstep(1200, 3800, d), rid = ridged(x, z);
      const massif = sstep(0.32, 0.72, fbm(x * 0.00022 + 5.3, z * 0.00022 - 3.1, 4));   // broad mountain bodies
      let peak = 260 + (450 + 2100 * massif) * (0.3 + 0.7 * rid) * (0.55 + 0.45 * far);
      // the valley carries on along z (down to the main valley, up to the head of the valley) before the far ranges close it
      const open = (1 - sstep(350, 1500, Math.abs(x))) * (1 - sstep(2600, 5000, d));
      peak = lerp(peak, Math.max(150, baseY(clamp(z, -6000, 1e5))) + 20 + rid * 160, open);
      const t = sstep(0, 1400, d);
      return lerp(g - (d < 2 ? 3 : 0), peak, t * t);
    };
    for (let i = 0; i < NP; i++) {
      const [px, pz, nx, nz] = per[i];
      const rx = px, rz = pz - zc, rl = Math.hypot(rx, rz) || 1;
      for (let k = 0; k < NR; k++) {
        const d = RINGS[k], bend = sstep(300, 3000, d);
        let dx = lerp(nx, rx / rl, bend), dz = lerp(nz, rz / rl, bend); const dl = Math.hypot(dx, dz); dx /= dl; dz /= dl;
        const x = px + dx * d, z = pz + dz * d, o = (i * NR + k) * 3;
        pos[o] = x; pos[o + 1] = H(x, z, d); pos[o + 2] = z;
      }
    }
    const idx = [];
    for (let i = 0; i < NP; i++) { const i2 = (i + 1) % NP; for (let k = 0; k < NR - 1; k++) { const a = i * NR + k, b2 = i2 * NR + k; idx.push(a, b2, a + 1, b2, b2 + 1, a + 1); } }
    const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.BufferAttribute(pos, 3)); g.setIndex(idx); g.computeVertexNormals(); g.computeBoundingSphere();
    // make every normal point up (whatever the winding came out as)
    { const nr = g.attributes.normal; let up = 0; for (let i = 0; i < nr.count; i += 97) up += nr.getY(i); if (up < 0) { idx.reverse(); g.setIndex(idx); g.computeVertexNormals(); } }
    g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(NP * NR * 2), 2));
    const mat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.9, map: tex('rock_diff.jpg', true) });
    const hazeU = { value: gfx.lens?.uniforms?.uFogCol?.value || new THREE.Color(0.62, 0.68, 0.76) };
    mat.onBeforeCompile = (s) => {
      s.uniforms.uHaze = hazeU;
      worldVarying(s);
      s.fragmentShader = s.fragmentShader.replace('#include <common>', '#include <common>\nuniform vec3 uHaze;')
        .replace('#include <map_fragment>', `
          vec3 nWp = normalize((vec4(vNormal, 0.0) * viewMatrix).xyz);
          vec3 bwp = pow(abs(nWp), vec3(3.0)); bwp /= dot(bwp, vec3(1.0));
          vec3 rk = texture2D(map, vScW.zy / 160.0).rgb * bwp.x + texture2D(map, vScW.xz / 160.0).rgb * bwp.y + texture2D(map, vScW.xy / 160.0).rgb * bwp.z;
          float rl = dot(rk, vec3(0.3, 0.55, 0.15)) * (0.75 + 0.5 * dot(texture2D(map, vScW.xz / 31.0).rgb, vec3(0.33)));
          rk = mix(vec3(rl), rk, 0.25) * vec3(0.66, 0.68, 0.74);
          float n1 = scNoise(vScW * 0.012), n2 = scNoise(vScW * 0.05);
          float snowLine = 650.0 + n1 * 400.0;
          float flatK = nWp.y + (n2 - 0.5) * 0.25;
          float steepK = mix(0.56, 0.7, smoothstep(600.0, 1400.0, vScW.y));     // high up, only the gentler faces hold snow: rock shows
          float snow = clamp(smoothstep(steepK, steepK + 0.14, flatK + (scNoise(vScW * 0.006) - 0.5) * 0.25), 0.0, 1.0);
          // dark forest speckle on the gentler lower slopes, thinning out up to the treeline
          float forest = smoothstep(0.62, 0.8, flatK) * (1.0 - smoothstep(snowLine - 150.0, snowLine + 250.0, vScW.y)) * smoothstep(0.38, 0.62, scNoise(vScW * 0.021));
          forest *= 0.55 + 0.45 * smoothstep(0.3, 0.7, scNoise(vScW * 0.09));
          vec3 c = mix(rk, vec3(0.88, 0.91, 0.95), snow);
          c = mix(c, vec3(0.05, 0.075, 0.06), forest * 0.75);
          diffuseColor.rgb = c;`)
        .replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\nroughnessFactor = mix(0.92, 0.7, snow);')
        .replace('#include <opaque_fragment>', `#include <opaque_fragment>
          {
            float dd = length(vScW - cameraPosition);
            float hz = 1.0 - exp(-max(dd - 1800.0, 0.0) / 9000.0);
            hz *= mix(1.0, 0.75, smoothstep(800.0, 2600.0, vScW.y));
            gl_FragColor.rgb = mix(gl_FragColor.rgb, uHaze * 1.05, clamp(hz, 0.0, 0.6));
          }`);
    };
    mat.customProgramCacheKey = () => 'scenery-peaks';
    const mesh = new THREE.Mesh(g, mat); mesh.name = 'scenery:peaks'; mesh.frustumCulled = false; mesh.receiveShadow = false; mesh.castShadow = false;
    group.add(mesh);
    return { mesh, tris: idx.length / 3 };
  }

  // ═══════════ merge the statics ═══════════
  B.top.build(group, mats, { layer1: true }); B.base.build(group, mats); B.lift.build(group, mats); B.run.build(group, mats, { layer1: true });

  // ═══════════ projected shadows on the snow (built once the sun is placed) ═══════════
  const shade = buildShadeDecals();
  function buildShadeDecals() {
    const mat = new THREE.ShaderMaterial({
      uniforms: { uNearM: { value: gfx.sun?.shadow?.matrix || new THREE.Matrix4() }, uFarM: { value: gfx.sunFar?.shadow?.matrix || new THREE.Matrix4() }, uTint: { value: new THREE.Color(0.27, 0.34, 0.5) } },
      vertexShader: /* glsl */`
        attribute vec4 aSeg; attribute vec4 aRad;
        varying vec4 vSeg; varying vec4 vRad; varying vec3 vW;
        void main() { vSeg = aSeg; vRad = aRad; vW = (modelMatrix * vec4(position, 1.0)).xyz; gl_Position = projectionMatrix * viewMatrix * vec4(vW, 1.0); }`,
      fragmentShader: /* glsl */`
        uniform mat4 uNearM, uFarM; uniform vec3 uTint;
        varying vec4 vSeg; varying vec4 vRad; varying vec3 vW;
        void main() {
          float a;
          if (vRad.x >= 0.0) {
            vec2 p = vW.xz, A = vSeg.xy, Bv = vSeg.zw, ba = Bv - A; float l2 = max(dot(ba, ba), 1e-4);
            float t = clamp(dot(p - A, ba) / l2, 0.0, 1.0), r = mix(vRad.x, vRad.y, t);
            float d = length(p - A - ba * t) - r, soft = 0.2 + 0.05 * sqrt(l2) * t + 0.12 * vRad.x;
            a = 1.0 - smoothstep(-soft, soft, d);
          } else a = vRad.y;                                          // polygon mode: falloff baked per vertex
          a *= vRad.z;
          // where gfx's real shadow maps already cover this spot (and the caster casts real shadows), stand down
          if (vRad.w > 0.5) {
            vec4 sn = uNearM * vec4(vW, 1.0); vec2 e0 = min(sn.xy, 1.0 - sn.xy);
            float wN = smoothstep(0.0, 0.12, min(e0.x, e0.y)) * step(sn.z, 1.0);
            vec4 sf = uFarM * vec4(vW, 1.0); float inF = step(0.0, min(min(sf.x, sf.y), min(1.0 - sf.x, 1.0 - sf.y))) * step(sf.z, 1.0);
            a *= 1.0 - max(wN, inF);
          }
          if (a < 0.004) discard;
          gl_FragColor = vec4(mix(vec3(1.0), uTint, a), 1.0);
        }`,
      transparent: true, depthWrite: false, blending: THREE.MultiplyBlending, premultipliedAlpha: true,
      polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -6,
    });
    const mesh = new THREE.Mesh(new THREE.BufferGeometry(), mat); mesh.name = 'scenery:shade'; mesh.frustumCulled = false; mesh.renderOrder = 1; mesh.visible = false;
    group.add(mesh);
    let builtFor = null, job = null;
    const proj = (p, sd) => {      // where the sun ray through p meets the snow
      let t = (p.y - surfY(p.x, p.z)) / sd.y;
      for (let it = 0; it < 3; it++) t = Math.max(0, (p.y - surfY(p.x - sd.x * t, p.z - sd.z * t)) / sd.y);
      return V(p.x - sd.x * t, 0, p.z - sd.z * t);
    };
    function* build(sd) {
      const pos = [], seg = [], rad = [], idx = [];
      const quad = (A, Bv, r0, r1, k, real, cheap = false) => {     // a draped capsule-cone from A (radius r0) to B (radius r1)
        const ax = Bv.x - A.x, az = Bv.z - A.z, l = Math.hypot(ax, az) || 1e-3, ux = ax / l, uz = az / l, vx = -uz, vz = ux;
        const rm = Math.max(r0, r1) + 0.6, nA = Math.max(2, Math.min(cheap ? 3 : 8, Math.ceil((l + 2 * rm) / 4))), nB = cheap ? 1 : 2, base = pos.length / 3;
        for (let i = 0; i <= nA; i++) for (let j = 0; j <= nB; j++) {
          const s = -rm + (l + 2 * rm) * i / nA, w = -rm + 2 * rm * j / nB, x = A.x + ux * s + vx * w, z = A.z + uz * s + vz * w;
          pos.push(x, surfY(x, z) + 0.06, z); seg.push(A.x, A.z, Bv.x, Bv.z); rad.push(r0, r1, k, real ? 1 : 0);
        }
        for (let i = 0; i < nA; i++) for (let j = 0; j < nB; j++) { const a = base + i * (nB + 1) + j, b2 = a + nB + 1; idx.push(a, a + 1, b2, b2, a + 1, b2 + 1); }
      };
      let n = 0;
      for (const c of shadowCasters) {
        if (c.kind === 'tree') {
          quad(proj(V(c.x, c.y + c.h * 0.22, c.z), sd), proj(V(c.x, c.y + c.h, c.z), sd), c.r, c.r * 0.08, Math.min(0.95, (c.k || 0.78) * 1.15) * clamp(c.h / 4, 0.4, 1), false, true);
        } else if (c.kind === 'seg') {
          quad(proj(c.a, sd), proj(c.b, sd), c.r, c.r, c.k || 0.8, c.real);
        } else {
          // a box: its 8 corners projected, convex hull, an inner polygon and a soft outer ring
          const pts2 = [];
          for (const sx of [-0.5, 0.5]) for (const sy of [-0.5, 0.5]) for (const sz of [-0.5, 0.5]) { const q = proj(V(sx * c.sx, sy * c.sy, sz * c.sz).applyMatrix4(c.m), sd); pts2.push([q.x, q.z]); }
          pts2.sort((a, b2) => a[0] - b2[0] || a[1] - b2[1]);
          const cr = (o, a, b2) => (a[0] - o[0]) * (b2[1] - o[1]) - (a[1] - o[1]) * (b2[0] - o[0]), lo = [], hi = [];
          for (const p of pts2) { while (lo.length >= 2 && cr(lo[lo.length - 2], lo[lo.length - 1], p) <= 0) lo.pop(); lo.push(p); }
          for (const p of [...pts2].reverse()) { while (hi.length >= 2 && cr(hi[hi.length - 2], hi[hi.length - 1], p) <= 0) hi.pop(); hi.push(p); }
          const hull = lo.slice(0, -1).concat(hi.slice(0, -1)), cx = hull.reduce((s, p) => s + p[0], 0) / hull.length, cz = hull.reduce((s, p) => s + p[1], 0) / hull.length;
          const base = pos.length / 3, m = hull.length, soft = 0.6, k = c.k || 0.85;
          for (const [x0, z0] of hull) {
            const dx = x0 - cx, dz = z0 - cz, dl = Math.hypot(dx, dz) || 1;
            for (const [o, a] of [[-soft, 1], [soft, 0]]) { const x = x0 + dx / dl * o, z = z0 + dz / dl * o; pos.push(x, surfY(x, z) + 0.06, z); seg.push(0, 0, 0, 0); rad.push(-1, a, k, c.real ? 1 : 0); }
          }
          pos.push(cx, surfY(cx, cz) + 0.06, cz); seg.push(0, 0, 0, 0); rad.push(-1, 1, k, c.real ? 1 : 0);
          for (let i = 0; i < m; i++) { const i2 = (i + 1) % m, a = base + i * 2, b2 = base + i2 * 2; idx.push(base + m * 2, a, b2, a, a + 1, b2, a + 1, b2 + 1, b2); }
        }
        if (++n % 40 === 0) yield;
      }
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.setAttribute('aSeg', new THREE.Float32BufferAttribute(seg, 4)); g.setAttribute('aRad', new THREE.Float32BufferAttribute(rad, 4));
      g.setIndex(idx); mesh.geometry.dispose(); mesh.geometry = g; mesh.visible = true;
    }
    function update() {
      if (gfx.ready === false) return;                 // wait until gfx has found the sun in the sky photo
      const sd = sunDir.clone().normalize();
      if (sd.y < 0.05) { mesh.visible = false; return; }
      if (!job && (!builtFor || builtFor.distanceTo(sd) > 0.01)) { builtFor = sd.clone(); job = build(sd); }
      if (job) { const tEnd = performance.now() + 1.2; while (performance.now() < tEnd) { if (job.next().done) { job = null; break; } } }
    }
    return { update, mesh, count: () => shadowCasters.length, busy: () => !!job };
  }

  // ═══════════ per-frame ═══════════
  let time = 0;
  function update(dt, camPos) {
    time += dt; timeU.value = time;
    if (camPos) { camU.value.copy(camPos); forest.refresh(camPos); }
    lift.update(dt, time);
    shade.update();
  }
  const buildMs = performance.now() - t0;
  function stats() {
    let meshes = 0, tris = 0;
    group.traverse((o) => { if (o.isMesh && o.visible) { meshes++; const g = o.geometry, n = (g.index ? g.index.count : g.attributes.position?.count || 0) / 3; tris += o.isInstancedMesh ? n * o.count : n; } });
    return { meshes, tris: Math.round(tris), trees: forest.count, perVariant: forest.perVariant, snags: forest.snags, rocks: rocks.count, chairs: lift.nChairs, towers: lift.pts.length - 2, liftLen: Math.round(lift.length), shadowCasters: shade.count(), shadeBusy: shade.busy(), buildMs: Math.round(buildMs), nearCounts: forest.near.map((m) => m.count), midCounts: forest.mid.map((m) => m.count), peakTris: peaks.tris };
  }
  return { group, update, stats, lift: { x: liftX, ...LIFT, towers: lift.pts.map((p) => ({ x: p.x, z: p.z, y: p.y })) } };
}
