// The snow you see and the rails and boxes: a picture of terrain.js.
// Snow is drawn in 32 m chunks: a coarse 2 m mesh everywhere on the run, swapped for a fine
// one (0.5 m, 0.33 m where there are jumps or rails) near the skier. Skirts hide LOD seams
// (the usual heightfield-chunk trick, as in Ulrich's Chunked LOD). The wide mountainside is one
// 8 m mesh. Snow shading: Poly Haven snow normal detail in world space, groomer corduroy on
// the run, rock where it is steep, and sun glints (per-cell random micro-facets, the standard
// "snow sparkle" trick, e.g. Ubisoft's Steep GDC talk on snow shading).
import * as THREE from 'three';
import { ground, groomed, runHalf, runCenter, FEATURES, RAILS, JUMPS, Z0, Z1 } from './terrain.js';

const V = (x = 0, y = 0, z = 0) => new THREE.Vector3(x, y, z);
const CH = 32, XR = 160;                 // chunk size; the run's chunked area spans x in [-XR, XR]

function snowMaterial(T, aniso, { rock = false } = {}) {
  const tl = new THREE.TextureLoader();
  const tex = (u, srgb) => { const t = tl.load(u); t.wrapS = t.wrapT = THREE.RepeatWrapping; t.anisotropy = aniso; if (srgb) t.colorSpace = THREE.SRGBColorSpace; return t; };
  const m = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.82, metalness: 0, vertexColors: true,
    normalMap: tex('./assets/tex/snow_nor.jpg'), normalScale: new THREE.Vector2(0.55, 0.55) });
  const fieldN = tex('./assets/tex/snowfield_nor.jpg'), rockD = tex('./assets/tex/rock_diff.jpg', true), rockN = tex('./assets/tex/rock_nor.jpg');
  // blue dye lines sprayed across each lip and knuckle (real parks do this so you can read the jump)
  const lines = []; for (const J of JUMPS) { lines.push(new THREE.Vector4(J.x, J.z - 0.15, J.w / 2 - 0.3, 0)); if (J.landZ0 && J.kind !== 'stepdown') lines.push(new THREE.Vector4(J.x, J.landZ0 - 0.6, J.w / 2 - 0.3, 0)); }
  while (lines.length < 24) lines.push(new THREE.Vector4(0, -1e5, 0, 0));
  const U = { uLines: { value: lines.slice(0, 24) }, uFieldN: { value: fieldN }, uRockD: { value: rockD }, uRockN: { value: rockN }, uSpark: { value: T.snowSparkle ?? 1 } };
  m.onBeforeCompile = (s) => {
    Object.assign(s.uniforms, U);
    s.vertexShader = s.vertexShader.replace('#include <common>', '#include <common>\nattribute float aGroom; attribute float aRock; varying vec3 vW; varying float vGroom; varying float vRock;')
      .replace('#include <worldpos_vertex>', '#include <worldpos_vertex>\nvW = (modelMatrix * vec4(transformed, 1.0)).xyz; vGroom = aGroom; vRock = aRock;');
    s.fragmentShader = s.fragmentShader.replace('#include <common>', `#include <common>
      uniform sampler2D uFieldN, uRockD, uRockN; uniform float uSpark; uniform vec4 uLines[24];
      varying vec3 vW; varying float vGroom; varying float vRock;
      float h21(vec2 p) { p = fract(p * vec2(233.34, 851.73)); p += dot(p, p + 23.45); return fract(p.x * p.y); }
      vec3 h33(vec3 p) { p = fract(p * vec3(.1031, .1030, .0973)); p += dot(p, p.yxz + 33.33); return fract((p.xxy + p.yxx) * p.zyx); }`)
      // world-space detail: fine snow grain (tiled every 3 m) + big wind-blown drifts (every 40 m) off the run
      .replace('#include <normal_fragment_maps>', `
        vec2 wuv = vW.xz;
        vec3 nA = texture2D(normalMap, wuv / 3.0).xyz * 2.0 - 1.0;
        vec3 nB = vGroom < 0.99 ? texture2D(uFieldN, wuv / 40.0).xyz * 2.0 - 1.0 : vec3(0.0, 0.0, 1.0);
        vec3 nR = vRock > 0.01 ? texture2D(uRockN, wuv / 6.0).xyz * 2.0 - 1.0 : vec3(0.0, 0.0, 1.0);
        float dist = length(vW - cameraPosition);
        // corduroy: groomer ridges ~2.5 cm apart along the fall line, fading out before they would shimmer
        float cord = vGroom * (1.0 - smoothstep(6.0, 22.0, dist));
        float ph = vW.x * 6.2832 / 0.026 + sin(vW.z * 0.7) * 2.0;
        cord *= 1.0 - smoothstep(0.5, 1.4, fwidth(ph));
        vec2 dN = nA.xy * normalScale * mix(0.75, 0.45, vGroom) + nB.xy * (1.0 - vGroom) * 0.7 + vec2(cos(ph) * 0.22 * cord, 0.0);
        dN = mix(dN, nR.xy * 1.2, vRock);
        vec3 mapN = normalize(vec3(dN, 1.0));
        if (any(isnan(mapN))) mapN = vec3(0.0, 0.0, 1.0);
        normal = normalize(tbnW * mapN);`)
      .replace('#include <normal_fragment_begin>', `#include <normal_fragment_begin>
        vec3 wn = normalize(cross(dFdx(vW), dFdy(vW)));
        vec3 Tw = normalize(cross(vec3(0.0, 0.0, 1.0), wn) + vec3(1e-4, 0.0, 0.0)), Bw = cross(wn, Tw);
        mat3 tbnW = mat3((viewMatrix * vec4(Tw, 0.0)).xyz, (viewMatrix * vec4(Bw, 0.0)).xyz, normal);`)
      .replace('#include <color_fragment>', `#include <color_fragment>
        if (vRock > 0.01) { vec3 rc = texture2D(uRockD, vW.xz / 6.0).rgb; rc = mix(vec3(dot(rc, vec3(0.3, 0.59, 0.11))), rc, 0.25) * vec3(0.78, 0.8, 0.84); diffuseColor.rgb = mix(diffuseColor.rgb, rc, vRock); }
        float dye = 0.0;
        for (int i = 0; i < 24; i++) { vec4 L = uLines[i]; float dz = abs(vW.z - L.y); if (dz > 0.2) continue; float dx = abs(vW.x - L.x) - L.z;
          float w = 0.09 + 0.03 * sin(vW.x * 7.0); dye = max(dye, (1.0 - smoothstep(w * 0.6, w, dz)) * (1.0 - smoothstep(-0.2, 0.15, dx + 0.12 * sin(vW.x * 3.1 + L.y)))); }
        diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.12, 0.3, 0.75), dye * 0.85);`)
      .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>
        roughnessFactor = mix(mix(0.9, 0.7, vGroom), 0.95, vRock);`)
      // sun glints: each 1.2 cm cell of snow is a tiny ice facet tipped at random; it flashes when it mirrors the sun into the lens
      .replace('#include <lights_fragment_end>', `#include <lights_fragment_end>
        #if NUM_DIR_LIGHTS > 0
        if (dist < 30.0 && vRock < 0.5) {
          vec3 cellP = floor(vW * 85.0);
          vec3 rnd = h33(cellP);
          vec3 fn = normalize(normal + (rnd - 0.5) * 1.6 + vec3(0.0, 1e-3, 0.0));
          vec3 L = directionalLights[0].direction, Vv = normalize(vViewPosition);
          float g = pow(max(dot(reflect(-L, fn), Vv), 0.0), 900.0) * step(0.55, rnd.x);
          float fade = 1.0 - smoothstep(4.0, 30.0, dist);
          reflectedLight.directSpecular += directionalLights[0].color * g * 6.0 * fade * uSpark * (1.0 - vRock);
        }
        #endif`);
  };
  m.customProgramCacheKey = () => 'snow' + (rock ? 'R' : '');
  return m;
}

// one heightfield patch: x0..x0+w, z0..z0+d at `step`, with skirts hanging `skirt` m down at the edges
function patch(x0, z0, w, d, step, skirt, sink) {
  const nx = Math.round(w / step) + 1, nz = Math.round(d / step) + 1;
  const cnt = nx * nz + 2 * (nx + nz) * 2;
  const pos = new Float32Array(cnt * 3), col = new Float32Array(cnt * 3), grm = new Float32Array(cnt), rk = new Float32Array(cnt);
  const H = new Float32Array((nx + 2) * (nz + 2));
  for (let j = -1; j <= nz; j++) for (let i = -1; i <= nx; i++) {
    const x = x0 + i * step, z = z0 + j * step;
    H[(j + 1) * (nx + 2) + (i + 1)] = ground(x, z) - (sink ? sink(x, z) : 0);
  }
  const h = (i, j) => H[(j + 1) * (nx + 2) + (i + 1)];
  let k = 0;
  const put = (i, j, dy) => {
    const x = x0 + i * step, z = z0 + j * step, y = h(i, j) + dy;
    pos[k * 3] = x; pos[k * 3 + 1] = y; pos[k * 3 + 2] = z;
    const g = groomed(x, z);
    // steepness from the neighbours: rock shows on cliffs
    const sx = (h(Math.min(i + 1, nx), j) - h(Math.max(i - 1, -1), j)) / (2 * step), sz = (h(i, Math.min(j + 1, nz)) - h(i, Math.max(j - 1, -1))) / (2 * step);
    const ny = 1 / Math.hypot(sx, 1, sz);
    rk[k] = Math.min(1, Math.max(0, (0.74 - ny) / 0.12)) * (1 - g);
    grm[k] = g;
    // off-white variation: a faint blue in the wild snow, a touch warmer and greyer where the cats packed it
    const n = Math.sin(x * 0.13 + z * 0.07) * 0.5 + Math.sin(x * 0.031 - z * 0.044) * 0.5;
    col[k * 3] = 0.93 + 0.02 * n - 0.03 * (1 - g); col[k * 3 + 1] = 0.95 + 0.015 * n - 0.01 * (1 - g); col[k * 3 + 2] = 0.97 + 0.01 * n;
    k++;
  };
  for (let j = 0; j < nz; j++) for (let i = 0; i < nx; i++) put(i, j, 0);
  const idx = [];
  for (let j = 0; j < nz - 1; j++) for (let i = 0; i < nx - 1; i++) {
    const a = j * nx + i, b = a + 1, c = a + nx, dd = c + 1;
    idx.push(a, c, b, b, c, dd);
  }
  // skirts: each edge copied `skirt` metres lower and stitched to the edge
  const edge = (list) => {
    const base = k; for (const [i, j] of list) put(i, j, -skirt);
    for (let e = 0; e < list.length - 1; e++) {
      const [i0, j0] = list[e], [i1, j1] = list[e + 1], t0 = j0 * nx + i0, t1 = j1 * nx + i1, s0 = base + e, s1 = base + e + 1;
      idx.push(t0, s0, t1, t1, s0, s1, t0, t1, s0, t1, s1, s0);   // both windings: always visible
    }
  };
  edge([...Array(nx)].map((_, i) => [i, 0])); edge([...Array(nx)].map((_, i) => [i, nz - 1]));
  edge([...Array(nz)].map((_, j) => [0, j])); edge([...Array(nz)].map((_, j) => [nx - 1, j]));
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos.subarray(0, k * 3), 3));
  g.setAttribute('color', new THREE.BufferAttribute(col.subarray(0, k * 3), 3));
  g.setAttribute('aGroom', new THREE.BufferAttribute(grm.subarray(0, k), 1));
  g.setAttribute('aRock', new THREE.BufferAttribute(rk.subarray(0, k), 1));
  g.setIndex(idx);
  // normals straight from the height function (no faceting from the mesh)
  const nrm = new Float32Array(k * 3), o = { x: 0, y: 0, z: 0 };
  for (let v = 0; v < k; v++) {
    const x = pos[v * 3], z = pos[v * 3 + 2], e = Math.max(0.12, step * 0.5);
    const hx = ground(x + e, z) - ground(x - e, z), hz = ground(x, z + e) - ground(x, z - e), l = Math.hypot(hx, 2 * e, hz);
    o.x = -hx / l; o.y = 2 * e / l; o.z = -hz / l; nrm[v * 3] = o.x; nrm[v * 3 + 1] = o.y; nrm[v * 3 + 2] = o.z;
  }
  g.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
  g.computeBoundingSphere(); g.computeBoundingBox();
  return g;
}

export function buildWorld(scene, gfx, T) {
  const mat = snowMaterial(T, gfx.aniso);
  const group = new THREE.Group(); scene.add(group);
  const chunks = [];
  // which chunks hold something sharp (lips, rails): those get the finest mesh
  const busy = (x0, z0) => FEATURES.some((f) => (f.kind === 'table' || f.kind === 'bed' || f.kind === 'stepdown' || f.kind === 'pad') && f.xMax > x0 && f.xMin < x0 + CH && f.zMax > z0 && f.zMin < z0 + CH);
  for (let z0 = Z0; z0 < Z1; z0 += CH) for (let x0 = -XR; x0 < XR; x0 += CH) {
    const isBusy = busy(x0, z0), g = patch(x0, z0, CH, CH, isBusy ? 1 : 2, 1.5);
    const m = new THREE.Mesh(g, mat); m.receiveShadow = true; m.castShadow = false; m.layers.enable(1);
    group.add(m);
    chunks.push({ x0, z0, lo: g, hi: null, mesh: m, fine: isBusy ? 1 / 3 : 0.5, cx: x0 + CH / 2, cz: z0 + CH / 2, level: 0, used: 0 });
  }
  // the mountainside round the run: one coarse mesh, sunk under the run so the chunks always win
  {
    const sink = (x) => (Math.abs(x) < XR - 4 ? 2.5 : 0);
    const ox = 1400, zA = Z0 - 700, zB = Z1 + 500;
    const g = patch(-ox, zA, ox * 2, zB - zA, 8, 0, sink);
    const m = new THREE.Mesh(g, mat); m.receiveShadow = true; m.layers.enable(1); group.add(m);
  }

  // ── rails, boxes, tubes ──
  const tl = new THREE.TextureLoader();
  const chrome = new THREE.MeshPhysicalMaterial({ color: 0xd9dde2, metalness: 1, roughness: 0.22, clearcoat: 0.2 });
  const scuffed = new THREE.MeshStandardMaterial({ color: 0xb7bcc2, metalness: 1, roughness: 0.38, map: tl.load('./assets/tex/metal_diff.jpg') });
  const legM = new THREE.MeshStandardMaterial({ color: 0x3a3e45, metalness: 0.6, roughness: 0.5 });
  const plastic = new THREE.MeshPhysicalMaterial({ color: 0xf1f1ee, roughness: 0.32, clearcoat: 0.4, clearcoatRoughness: 0.3 });
  const panelCols = [0x1d3f8f, 0xd2402a, 0x161718, 0xe3a72f, 0x20705d];
  const tubeCols = [0x1f6fd0, 0xf0b530, 0xc93b2b];
  let ci = 0;
  for (const R of RAILS) {
    const pts = R.pts.map((p) => V(p[0], p[1], p[2]));
    const parts = [];
    if (R.kind === 'rail' || R.kind === 'tube') {
      const r = R.kind === 'tube' ? 0.16 : 0.03, segs = 14;
      // tube along the polyline: a ring at each point, turned to bisect the kink
      const pos = [], nrm = [], idx = [];
      for (let i = 0; i < pts.length; i++) {
        const a = pts[Math.max(0, i - 1)], b = pts[Math.min(pts.length - 1, i + 1)], t = V().subVectors(b, a).normalize();
        const side = V(1, 0, 0), up = V().crossVectors(t, side).normalize().negate();
        for (let s = 0; s <= segs; s++) {
          const an = (s / segs) * Math.PI * 2, n = side.clone().multiplyScalar(Math.cos(an)).addScaledVector(up, Math.sin(an));
          const p = pts[i].clone().addScaledVector(V(0, 1, 0), -r).addScaledVector(n, r);   // the top of the tube is the rail line
          pos.push(p.x, p.y, p.z); nrm.push(n.x, n.y, n.z);
        }
      }
      for (let i = 0; i < pts.length - 1; i++) for (let s = 0; s < segs; s++) { const a = i * (segs + 1) + s, b = a + 1, c = a + segs + 1, d = c + 1; idx.push(a, c, b, b, c, d); }
      const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3)); g.setIndex(idx);
      const m = R.kind === 'tube' ? new THREE.MeshPhysicalMaterial({ color: tubeCols[ci++ % tubeCols.length], roughness: 0.35, metalness: 0.2, clearcoat: 0.6 }) : chrome;
      parts.push(new THREE.Mesh(g, m));
      // end caps
      for (const e of [0, pts.length - 1]) { const c = new THREE.Mesh(new THREE.SphereGeometry(r, 12, 8), m); c.position.copy(pts[e]).y -= r; parts.push(c); }
    } else {
      // box: a plastic top with steel edges and coloured side panels
      const w = R.w, hgt = 0.26, col = new THREE.MeshStandardMaterial({ color: panelCols[ci++ % panelCols.length], roughness: 0.55 });
      for (let i = 0; i < pts.length - 1; i++) {
        const a = pts[i], b = pts[i + 1], len = a.distanceTo(b), mid = V().addVectors(a, b).multiplyScalar(0.5);
        const q = new THREE.Quaternion().setFromUnitVectors(V(0, 0, 1), V().subVectors(b, a).normalize());
        const top = new THREE.Mesh(new THREE.BoxGeometry(w, 0.03, len + 0.02), plastic); top.position.copy(mid).y -= 0.015; top.quaternion.copy(q); parts.push(top);
        const body = new THREE.Mesh(new THREE.BoxGeometry(w - 0.04, hgt, len + 0.02), col); body.position.copy(mid).addScaledVector(V(0, 1, 0).applyQuaternion(q), -0.03 - hgt / 2); body.quaternion.copy(q); parts.push(body);
        for (const sx of [-1, 1]) { const ed = new THREE.Mesh(new THREE.BoxGeometry(0.025, 0.05, len + 0.02), scuffed); ed.position.copy(mid).addScaledVector(V(1, 0, 0), sx * w / 2).y -= 0.025; ed.quaternion.copy(q); parts.push(ed); }
      }
    }
    // legs down to the snow every ~2.5 m
    const total = pts.length;
    for (let i = 0; i < total; i += Math.max(1, Math.round(2.5 / 0.5))) {
      const p = pts[i], gy = ground(p.x, p.z), top = p.y - (R.kind === 'box' ? 0.3 : R.kind === 'tube' ? 0.3 : 0.06);
      const L = top - gy + 0.4; if (L < 0.1) continue;
      for (const sx of R.kind === 'box' ? [-0.18, 0.18] : [0]) {
        const leg = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.035, L, 8), legM); leg.position.set(p.x + sx, gy - 0.4 + L / 2, p.z); parts.push(leg);
      }
    }
    for (const p of parts) { p.castShadow = true; p.receiveShadow = true; p.layers.enable(1); group.add(p); }
  }

  // swap chunk detail by distance; a few rebuilds a frame at most
  const pool = [];
  function update(focus) {
    let built = 0;
    const order = chunks.map((c) => ({ c, d: Math.hypot(c.cx - focus.x, c.cz - focus.z) })).sort((a, b) => a.d - b.d);
    for (const { c, d } of order) {
      const want = d < 75 ? 1 : 0;
      if (want === c.level || (want === 0 && d < 88)) continue;
      if (want === 1) {
        if (!c.hi) { if (built >= 2 && d > 40) continue; c.hi = patch(c.x0, c.z0, CH, CH, c.fine, 1.5); built++; pool.push(c); }
        c.mesh.geometry = c.hi; c.level = 1;
      } else { c.mesh.geometry = c.lo; c.level = 0; }
    }
    // keep at most 70 fine meshes in memory
    while (pool.length > 70) { const c = pool.shift(); if (c.level === 1) { pool.push(c); if (pool.every((p) => p.level === 1)) break; continue; } c.hi.dispose(); c.hi = null; }
  }
  return { group, update, material: mat, chunks };
}
