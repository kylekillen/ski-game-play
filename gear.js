// The skier's equipment and outfit on top of the rigged human (rider.js): skis, bindings, boots, poles, goggles,
// gloves, a neck gaiter, and the cut of the clothes (an oversized shell jacket, baggy pants over the boots).
// skier.js poses it; this file only builds it. Everything is made here in code: original designs, no outside assets.
//
//  fitSkiClothes(parts)  rider.js calls it at load (before the materials are made) for the outfits with fit: 'shell':
//                        reshapes the hoodie into a long, roomy shell jacket and the cargo pants into baggy ski pants
//                        whose hems flare over the boots. Same idea as narrowShoulders: bind-space edits, skin weights kept.
//  dressSkier(view)      called once the model has loaded; returns { skis:[2], boots:[2], poles:[0|2], gog, mitts, gaiter }.
//
// Draw calls: ski + binding (2 per ski), boot shell + cuff (2 per boot), 1 per pole, goggles 2, gloves 2, gaiter 1.
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { TWEAKS as T } from './tweaks.js';

const V = (x = 0, y = 0, z = 0) => new THREE.Vector3(x, y, z);
const clamp = (v, a, b) => Math.min(b, Math.max(a, v)), lerp = (a, b, t) => a + (b - a) * t;
const smooth = (t) => { t = clamp(t, 0, 1); return t * t * (3 - 2 * t); };
export const SKI_L = 1.78, PLATE = 0.042;     // ski length; ski + binding under the boot sole
const N_ST = 41;                               // stations along a ski (for flex)
const BOOT_L = 0.31;                           // boot sole length (the boot origin is its middle)

// ── bind-space helpers (every skinned part of the model shares one bind space and one skeleton) ──
const boneIdx = (sk, n) => sk.bones.findIndex((b) => b.name === n);
const bindAt = (sk, n) => V().setFromMatrixPosition(sk.boneInverses[boneIdx(sk, n)].clone().invert());
function boneSet(sk, root) { const s = new Set(); const b = sk.bones[boneIdx(sk, root)]; if (b) b.traverse((o) => { const i = sk.bones.indexOf(o); if (i >= 0) s.add(i); }); return s; }
function weightIn(SI, SW, i, set) { let w = 0; for (let k = 0; k < 4; k++) if (set.has(SI.getComponent(i, k))) w += SW.getComponent(i, k); return w; }
// give vertex i an extra influence w on bone b (the others scaled down to make room)
function addInfluence(SI, SW, i, b, w) {
  const ws = [0, 1, 2, 3].map((k) => SW.getComponent(i, k) * (1 - w)), is = [0, 1, 2, 3].map((k) => SI.getComponent(i, k));
  let slot = is.findIndex((x, k) => x === b && ws[k] > 0);
  if (slot < 0) { slot = ws.indexOf(Math.min(...ws)); ws[slot] = 0; is[slot] = b; }
  ws[slot] += w; const s = ws.reduce((a, c) => a + c, 0) || 1;
  for (let k = 0; k < 4; k++) { SI.setComponent(i, k, is[k]); SW.setComponent(i, k, ws[k] / s); }
}
const closestOnSeg = (p, a, b, out) => { const ab = V().subVectors(b, a), t = clamp(V().subVectors(p, a).dot(ab) / ab.lengthSq(), 0, 1); out.copy(a).addScaledVector(ab, t); return t; };
function legsOf(sk) {
  const L = {};
  for (const sfx of ['_l', '_r']) { const hip = bindAt(sk, 'thigh' + sfx); L[Math.sign(hip.x)] = { sfx, hip, knee: bindAt(sk, 'calf' + sfx), ank: bindAt(sk, 'foot' + sfx), ball: bindAt(sk, 'ball' + sfx) }; }
  return L;
}
// the axis of the leg at height y: the point on hip-knee-ankle, and how far below the knee (metres, < 0 above)
function legAxis(L, y, out) {
  if (y >= L.knee.y) out.lerpVectors(L.knee, L.hip, clamp((y - L.knee.y) / (L.hip.y - L.knee.y), 0, 1));
  else out.lerpVectors(L.ank, L.knee, clamp((y - L.ank.y) / (L.knee.y - L.ank.y), 0, 1));
  out.y = y; return L.knee.y - y;
}

// ── the clothes: a shell jacket and baggy pants, cut from the hoodie and cargo pants at load ──
export const JACKET_HEM = -0.13;               // the jacket's new hem (bind space y; the hip joints are at ~0.05, the sole at -0.835)
export function fitSkiClothes(parts) {
  const sk = parts.Human && parts.Human.skeleton; if (!sk) return;
  const legs = legsOf(sk);
  // pants first (the jacket is cut to hang clear of them)
  if (parts.pants) baggyPants(parts.pants, legs);
  if (parts.sweater) shellJacket(parts, sk, legs);
  if (parts.beanie) slouchBeanie(parts.beanie, sk);
}
// the beanie: a thicker knit and a little slouch at the back of the crown
function slouchBeanie(o, sk) {
  const g = o.geometry, P = g.attributes.position, v = V(), hd = bindAt(sk, 'head'), c = V(0, hd.y + 0.075, hd.z + 0.005);
  for (let i = 0; i < P.count; i++) {
    v.fromBufferAttribute(P, i); const d = V().subVectors(v, c), r = d.length(); if (r < 1e-4) continue; d.divideScalar(r);
    const crown = smooth((v.y - (hd.y + 0.1)) / 0.07), back = smooth((c.z - v.z) / 0.08);
    v.addScaledVector(d, 0.006 + 0.012 * crown * (0.4 + 0.6 * back)); v.z -= 0.014 * crown * back; v.y += 0.006 * crown * back;
    P.setXYZ(i, v.x, v.y, v.z);
  }
  P.needsUpdate = true; g.computeVertexNormals(); g.computeBoundingBox(); g.computeBoundingSphere();
}
function baggyPants(pa, legs) {
  const g = pa.geometry, P = g.attributes.position, v = V(), c = V();
  const hem0 = { 1: 9, '-1': 9 }; for (let i = 0; i < P.count; i++) { const s = P.getX(i) >= 0 ? 1 : -1; hem0[s] = Math.min(hem0[s], P.getY(i)); }
  for (let i = 0; i < P.count; i++) {
    v.fromBufferAttribute(P, i); const sd = v.x >= 0 ? 1 : -1, L = legs[sd];
    const s = legAxis(L, v.y, c), shin = L.knee.y - L.ank.y;
    let dx = v.x - c.x, dz = v.z - c.z; const rl = Math.hypot(dx, dz); if (rl < 1e-5) continue; dx /= rl; dz /= rl;
    // thighs and seat: a couple of centimetres of room (less at the waistband and between the legs)
    const waist = smooth((v.y - (L.hip.y - 0.1)) / 0.12), inner = Math.max(0, -dx * sd);
    let r = rl + lerp(0.034, 0.01, waist) * (1 - 0.5 * inner);
    // below the knee: a straight, roomy tube that flares at the hem, wide enough to swallow the boot cuff
    const tb = smooth((s + 0.03) / 0.12);
    if (tb > 0) {
      const u = clamp(s / shin, 0, 1.2), rt = 0.088 + 0.012 * smooth(u) + 0.012 * smooth((v.y - (L.ank.y + 0.06)) / -0.1);
      const a = rt, b = rt * 1.1, re = 1 / Math.sqrt((dx / a) ** 2 + (dz / b) ** 2);
      r = lerp(r, re, tb);
    }
    let y = v.y;
    // the hem: low at the heel, riding up over the instep at the front
    const yTop = L.ank.y + 0.11;
    if (y < yTop) { const fr = Math.pow((1 + dz) / 2, 1.4), H = L.ank.y + lerp(-0.048, 0.05, fr); y = yTop - (yTop - y) * (yTop - H) / (yTop - hem0[sd]); }
    P.setXYZ(i, c.x + dx * r, y, c.z + dz * r);
  }
  P.needsUpdate = true; g.computeVertexNormals(); g.computeBoundingBox(); g.computeBoundingSphere();
}
function shellJacket(parts, sk, legs) {
  const arms = ['_l', '_r'].map((sfx) => ({ sh: bindAt(sk, 'upperarm' + sfx), el: bindAt(sk, 'lowerarm' + sfx), wr: bindAt(sk, 'hand' + sfx), set: boneSet(sk, 'upperarm' + sfx) }));
  const armOf = (x) => (Math.sign(x) === Math.sign(arms[0].sh.x) ? arms[0] : arms[1]);
  const ZC = 0.025, YB = 0.24, NS = 48;
  const thighs = { 1: boneIdx(sk, 'thigh' + legs[1].sfx), '-1': boneIdx(sk, 'thigh' + legs[-1].sfx) };
  const sector = (x, z) => ((Math.round((Math.atan2(x, z - ZC) / (2 * Math.PI)) * NS) % NS) + NS) % NS;
  // the pants' outline round the torso axis, by height band: the jacket's lower half must hang outside it
  const pantsR = new Map();
  if (parts.pants) { const P = parts.pants.geometry.attributes.position, v = V();
    for (let i = 0; i < P.count; i++) { v.fromBufferAttribute(P, i); if (v.y < JACKET_HEM - 0.04 || v.y > 0.2) continue; const k = sector(v.x, v.z) + NS * Math.round(v.y / 0.02), r = Math.hypot(v.x, v.z - ZC); pantsR.set(k, Math.max(pantsR.get(k) || 0, r)); } }
  const pr = (x, z, y) => { let m = 0; const s0 = sector(x, z); for (let ds = -1; ds <= 1; ds++) for (let dy = -1; dy <= 1; dy++) m = Math.max(m, pantsR.get(((s0 + ds + NS) % NS) + NS * (Math.round(y / 0.02) + dy)) || 0); return m; };
  const roomy = (o, dT, dA, isHood) => {
    const g = o.geometry, P = g.attributes.position, SI = g.attributes.skinIndex, SW = g.attributes.skinWeight, v = V(), q = V(), q2 = V();
    const aws = new Float32Array(P.count);
    for (let i = 0; i < P.count; i++) {
      v.fromBufferAttribute(P, i); const A = armOf(v.x), aw = isHood ? 0 : clamp(weightIn(SI, SW, i, A.set), 0, 1); aws[i] = aw;
      const dirT = V(v.x, 0, v.z - ZC).normalize();
      // the arm: radial from the bone (upper arm or forearm, whichever is closer), roomier toward the cuff
      const t1 = closestOnSeg(v, A.sh, A.el, q), t2 = closestOnSeg(v, A.el, A.wr, q2), up = v.distanceTo(q) < v.distanceTo(q2);
      const dirA = V().subVectors(v, up ? q : q2).normalize(), ta = up ? t1 * 0.5 : 0.5 + t2 * 0.5;
      const collar = smooth((v.y - 0.545) / 0.06);
      const d = lerp(dT * lerp(1, 0.35, collar), dA * (0.75 + 0.5 * ta), aw);
      const dir = dirT.multiplyScalar(1 - aw).addScaledVector(dirA, aw).normalize();
      v.addScaledVector(dir, d); P.setXYZ(i, v.x, v.y, v.z);
    }
    return aws;
  };
  // 1. room everywhere: the body 2.5 cm off the hoodie, the sleeves 2-3 cm
  const sw = parts.sweater, aws = roomy(sw, 0.026, 0.022, false);
  if (parts.hood) roomy(parts.hood, 0.034, 0, true);
  // 2. longer (hip to upper thigh) and boxy: below the chest it hangs straight down from the chest's outline, flaring a little
  const g = sw.geometry, P = g.attributes.position, SI = g.attributes.skinIndex, SW = g.attributes.skinWeight, v = V();
  let hem0 = 9; for (let i = 0; i < P.count; i++) if (aws[i] < 0.5) hem0 = Math.min(hem0, P.getY(i));
  const chest = new Float32Array(NS);
  for (let i = 0; i < P.count; i++) { v.fromBufferAttribute(P, i); if (aws[i] > 0.15 || v.y < 0.3 || v.y > 0.43) continue; const k = sector(v.x, v.z); chest[k] = Math.max(chest[k], Math.hypot(v.x, v.z - ZC)); }
  for (let pass = 0; pass < 2; pass++) for (let k = 0; k < NS; k++) { const a = chest[(k + NS - 1) % NS], b = chest[(k + 1) % NS]; if (!chest[k]) chest[k] = Math.max(a, b); }
  const sc = (YB - JACKET_HEM) / (YB - hem0);
  for (let i = 0; i < P.count; i++) {
    v.fromBufferAttribute(P, i); const tw = (1 - aws[i]) ** 2; if (tw < 1e-3) continue;
    let y = v.y; if (y < YB) y = lerp(y, YB - (YB - y) * sc, tw);
    let dx = v.x, dz = v.z - ZC; const r = Math.hypot(dx, dz); if (r < 1e-5) continue; dx /= r; dz /= r;
    const k = sector(v.x, v.z), box = smooth((0.3 - y) / 0.14) * tw;
    let rn = Math.max(r, lerp(r, chest[k], box)) + 0.032 * smooth((0.08 - y) / 0.2) * tw;
    const need = pr(v.x, v.z, y); if (need > 0) rn = Math.max(rn, lerp(rn, need + 0.022, tw));
    P.setXYZ(i, dx * rn, y, ZC + dz * rn);
    // the hem rides up on the thighs as they lift (a crouch, a grab): the low front of the jacket partly follows them
    if (y < 0.05) { const fr = smooth((v.z - ZC + 0.02) / 0.1), w = 0.55 * smooth((0.05 - y) / 0.15) * lerp(0.25, 1, fr) * smooth(Math.abs(v.x) / 0.06) * tw;
      if (w > 0.01) addInfluence(SI, SW, i, thighs[v.x >= 0 ? 1 : -1], w); }
  }
  P.needsUpdate = true; SI.needsUpdate = true; SW.needsUpdate = true;
  for (const o of [sw, parts.hood]) if (o) { o.geometry.computeVertexNormals(); o.geometry.computeBoundingBox(); o.geometry.computeBoundingSphere(); }
}

// ── small geometry kit ──
const tint = (geo, col) => { const c = new THREE.Color(col), n = geo.attributes.position.count, a = new Float32Array(n * 3); for (let i = 0; i < n; i++) a.set([c.r, c.g, c.b], i * 3); geo.setAttribute('color', new THREE.BufferAttribute(a, 3)); return geo; };
const bake = (list) => mergeGeometries(list.map(([geo, col]) => { let g = geo.index ? geo.toNonIndexed() : geo; for (const k of Object.keys(g.attributes)) if (k !== 'position' && k !== 'normal') g.deleteAttribute(k); if (!g.attributes.normal) g.computeVertexNormals(); return tint(g, col); }), false);
function roundBox(w, h, d, r) {
  const s = new THREE.Shape(), x = -w / 2, y = -h / 2;
  s.moveTo(x + r, y); s.lineTo(x + w - r, y); s.quadraticCurveTo(x + w, y, x + w, y + r); s.lineTo(x + w, y + h - r); s.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  s.lineTo(x + r, y + h); s.quadraticCurveTo(x, y + h, x, y + h - r); s.lineTo(x, y + r); s.quadraticCurveTo(x, y, x + r, y);
  const b = Math.min(r, d / 2) * 0.6;
  const geo = new THREE.ExtrudeGeometry(s, { depth: Math.max(0.001, d - 2 * b), bevelEnabled: true, bevelThickness: b, bevelSize: b * 0.8, bevelSegments: 2, curveSegments: 3 });
  geo.translate(0, 0, -(d - 2 * b) / 2); return geo;
}
// a tube through rings of points (each ring closed); faces end up pointing outward whatever the rings' winding
function tube(rings, cols) {
  const M = rings[0].length, pos = [], col = [], idx = [];
  rings.forEach((ring, i) => ring.forEach((p, j) => { pos.push(p.x, p.y, p.z); const c = new THREE.Color(cols ? cols(i, j) : 0xffffff); col.push(c.r, c.g, c.b); }));
  for (let i = 0; i < rings.length - 1; i++) for (let j = 0; j < M; j++) { const a = i * M + j, b = i * M + (j + 1) % M, c = a + M, d = b + M; idx.push(a, b, c, b, d, c); }
  const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3)); g.setIndex(idx); g.computeVertexNormals();
  // outward? compare normals with the direction from each ring's centre
  let s = 0; const n = g.attributes.normal, P = g.attributes.position, cen = V(), p = V(), nn = V();
  rings.forEach((ring, i) => { cen.set(0, 0, 0); ring.forEach((q) => cen.add(q)); cen.multiplyScalar(1 / M); for (let j = 0; j < M; j++) { const k = i * M + j; p.fromBufferAttribute(P, k).sub(cen); nn.fromBufferAttribute(n, k); s += p.dot(nn); } });
  if (s < 0) { for (let k = 0; k < idx.length; k += 3) { const t = idx[k]; idx[k] = idx[k + 1]; idx[k + 1] = t; } g.setIndex(idx); g.computeVertexNormals(); }
  return g;
}
const superRing = (cx, cy, z, a, h, n, M, x0 = 1, y0 = 1) => { const r = []; for (let j = 0; j < M; j++) { const t = (j / M) * Math.PI * 2, c = Math.cos(t), s = Math.sin(t);
  r.push(V(cx + a * Math.sign(c) * Math.abs(c) ** (2 / n) * x0, cy + h * Math.sign(s) * Math.abs(s) ** (2 / n) * y0, z)); } return r; };

// ── skis: a park twin tip. One mesh (topsheet, base and sidewalls share an atlas texture) + one for the binding ──
function skiAtlas() {
  const W = 512, H = 1024, c = document.createElement('canvas'); c.width = W; c.height = H; const g = c.getContext('2d');
  const orm = document.createElement('canvas'); orm.width = 64; orm.height = H; const o = orm.getContext('2d');
  const c1 = T.skiColor || '#e8452c', c2 = T.skiColor2 || '#1b1d22', cream = '#efe8d8';
  // topsheet (u 0..0.5): dark, a bold off-centre slash of colour through the binding zone, cream tips, the name along it
  g.fillStyle = c2; g.fillRect(0, 0, 256, H);
  g.fillStyle = c1; g.beginPath(); g.moveTo(0, 330); g.lineTo(256, 250); g.lineTo(256, 640); g.lineTo(0, 720); g.fill();
  g.fillStyle = cream; g.beginPath(); g.moveTo(0, 735); g.lineTo(256, 655); g.lineTo(256, 668); g.lineTo(0, 748); g.fill();
  g.beginPath(); g.moveTo(0, 302); g.lineTo(256, 222); g.lineTo(256, 230); g.lineTo(0, 310); g.fill();
  for (const [y0, y1] of [[0, 70], [H - 70, H]]) { g.fillStyle = cream; g.fillRect(0, y0, 256, y1 - y0); }
  g.fillStyle = c1; g.fillRect(0, 66, 256, 6); g.fillRect(0, H - 72, 256, 6);
  for (let i = 0; i < 9; i++) { g.fillStyle = 'rgba(239,232,216,0.75)'; g.fillRect(40 + i * 22, 130, 8, 8 + (i % 3) * 8); g.fillRect(40 + i * 22, H - 150, 8, 8 + ((8 - i) % 3) * 8); }
  const word = (txt, x, y, rot, size, col) => { g.save(); g.translate(x, y); g.rotate(rot); g.font = `italic 900 ${size}px Avenir Next Condensed, Arial Narrow, Arial`; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillStyle = col; g.fillText(txt, 0, 0); g.restore(); };
  const name = String(T.gameName || 'SNOWLINE').toUpperCase();
  word(name, 128, 860, -Math.PI / 2, 92, cream); word(name, 128, 175, Math.PI / 2, 46, c1);
  // base (u 0.5..0.9): sintered black base, a big wordmark in the ski's colour (shows on grabs and in the air)
  g.fillStyle = '#121316'; g.fillRect(256, 0, 205, H);
  word(name, 358, H / 2, -Math.PI / 2, 150, c1); g.fillStyle = cream; g.fillRect(256, 120, 205, 10); g.fillRect(256, H - 130, 205, 10);
  // sidewall (u 0.9..1): black ABS over a steel edge
  g.fillStyle = '#1a1a1c'; g.fillRect(461, 0, 51, H); g.fillStyle = '#b9bec4'; g.fillRect(461, 0, 16, H);
  for (let i = 0; i < 2500; i++) { g.fillStyle = `rgba(255,255,255,${Math.random() * 0.05})`; g.fillRect(Math.random() * 461, Math.random() * H, 1, 1 + Math.random() * 5); }
  // roughness (G) / metalness (B)
  o.fillStyle = 'rgb(0,90,0)'; o.fillRect(0, 0, 32, H); o.fillStyle = 'rgb(0,70,0)'; o.fillRect(32, 0, 26, H); o.fillStyle = 'rgb(0,110,0)'; o.fillRect(58, 0, 6, H); o.fillStyle = 'rgb(0,80,255)'; o.fillRect(58, 0, 2, H);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 8;
  const tm = new THREE.CanvasTexture(orm); return { map: t, orm: tm };
}
function buildSki(mat, bindMat) {
  const pos = [], uv = [], idx = [], add = (x, y, z, u, v) => { pos.push(x, y, z); uv.push(u, v); return pos.length / 3 - 1; };
  const shape = (s) => {
    const a = Math.abs(s), tip = s > 0, wMax = tip ? 0.0605 : 0.0595, aw = 0.86;
    let w = 0.0468 + (wMax - 0.0468) * Math.pow(Math.min(a, aw) / aw, 2);
    if (a > aw) w = wMax * Math.sqrt(Math.max(0, 1 - ((a - aw) / (1 - aw)) ** 2));
    const rise = a > 0.74 ? Math.pow((a - 0.74) / 0.26, 2.1) * (tip ? 0.07 : 0.062) : 0;
    const th = 0.0135 - 0.008 * smooth(a / 0.92);
    return { w: Math.max(0.004, w), rise, th };
  };
  const st = []; for (let i = 0; i < N_ST; i++) { const t = (i / (N_ST - 1)) * 2 - 1; st.push(lerp(t, Math.sin(t * Math.PI / 2), 0.6)); }
  const TW = 5, rows = { top: [], base: [], side: [] };
  st.forEach((s, i) => {
    const { w, rise, th } = shape(s), z = s * SKI_L / 2, v = (s + 1) / 2;
    rows.top.push([...Array(TW).keys()].map((j) => { const u = j / (TW - 1), x = (u * 2 - 1) * w, dome = 1 - 0.35 * (u * 2 - 1) ** 2; return add(x, rise + th * dome, z, 0.01 + u * 0.48, v); }));
    rows.base.push([add(-w, rise, z, 0.5, v), add(w, rise, z, 0.9, v)]);
    rows.side.push([[add(-w, rise, z, 0.905, v), add(-w, rise + th * 0.65, z, 0.995, v)], [add(w, rise, z, 0.905, v), add(w, rise + th * 0.65, z, 0.995, v)]]);
  });
  const quad = (a, b, c, d, flip) => (flip ? idx.push(a, c, b, b, c, d) : idx.push(a, b, c, b, d, c));
  for (let i = 0; i < N_ST - 1; i++) {
    for (let j = 0; j < TW - 1; j++) quad(rows.top[i][j], rows.top[i][j + 1], rows.top[i + 1][j], rows.top[i + 1][j + 1], true);
    quad(rows.base[i][0], rows.base[i][1], rows.base[i + 1][0], rows.base[i + 1][1], false);
    // sides: bottom edge -> sidewall -> the topsheet's outer edge
    const sl = rows.side[i][0], sl2 = rows.side[i + 1][0], sr = rows.side[i][1], sr2 = rows.side[i + 1][1];
    quad(sl[0], sl[1], sl2[0], sl2[1], false); quad(sr[0], sr[1], sr2[0], sr2[1], true);
    quad(sl[1], rows.top[i][0], sl2[1], rows.top[i + 1][0], false); quad(sr[1], rows.top[i][TW - 1], sr2[1], rows.top[i + 1][TW - 1], true);
  }
  // tip and tail end caps (top row to base row at the first and last stations)
  for (const i of [0, N_ST - 1]) { const t = rows.top[i], b = rows.base[i]; const f = i === 0; for (let j = 0; j < TW - 1; j++) { if (f) idx.push(t[j], t[j + 1], b[0]); else idx.push(t[j + 1], t[j], b[0]); } if (f) idx.push(t[TW - 1], b[1], b[0]); else idx.push(b[1], t[TW - 1], b[0]); }
  const geo = new THREE.BufferGeometry(); geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2)); geo.setIndex(idx); geo.computeVertexNormals();
  geo.userData.rest = geo.attributes.position.array.slice();
  const grp = new THREE.Group(), ski = new THREE.Mesh(geo, mat); ski.castShadow = ski.receiveShadow = true; grp.add(ski);
  const b = new THREE.Mesh(bindingGeo(), bindMat); b.castShadow = true; grp.add(b);
  grp.userData.flex = [geo]; grp.userData.binding = [b];
  return grp;
}
// a park binding: toe piece with wings round the boot's toe lug, a heel tower, a long track and wide brake arms
function bindingGeo() {
  const dk = '#1f2125', mid = '#3a3d43', acc = T.skiColor || '#e8452c', alu = '#a9aeb5', P = PLATE, toeZ = BOOT_L / 2, heelZ = -BOOT_L / 2, L = [];
  const box = (w, h, d, x, y, z, col, r = 0.004, rx = 0) => { const g = roundBox(w, h, d, r); if (rx) g.rotateX(rx); g.translate(x, y, z); L.push([g, col]); };
  box(0.064, P - 0.016, 0.26, 0, 0.013 + (P - 0.016) / 2, -0.02, mid, 0.003);          // track / plate
  box(0.072, 0.03, 0.06, 0, P - 0.004, toeZ + 0.025, dk, 0.008);                         // toe housing
  box(0.078, 0.018, 0.03, 0, P + 0.02, toeZ + 0.004, acc, 0.005);                        // toe wings
  box(0.06, 0.012, 0.04, 0, P + 0.03, toeZ + 0.03, dk, 0.005);
  box(0.07, 0.06, 0.085, 0, 0.013 + 0.03, heelZ - 0.035, dk, 0.012);                    // heel tower
  box(0.074, 0.022, 0.05, 0, P + 0.03, heelZ - 0.012, acc, 0.006);                       // heel cup over the lug
  box(0.04, 0.012, 0.05, 0, 0.074, heelZ - 0.06, mid, 0.004, -0.5);                      // step-in lever
  for (const sx of [-1, 1]) { const g = new THREE.CylinderGeometry(0.0032, 0.0032, 0.13, 6); g.rotateX(Math.PI / 2 - 0.25); g.translate(sx * 0.054, 0.022, heelZ + 0.03); L.push([g, alu]);
    const f = roundBox(0.012, 0.012, 0.03, 0.004); f.translate(sx * 0.054, 0.006, heelZ + 0.09); L.push([f, dk]); }
  return bake(L);
}
// bend a ski: y offset at each point along it (s in [-1, 1] tail..tip)
export function flexSki(grp, bend) {
  for (const g of grp.userData.flex) {
    const p = g.attributes.position, r = g.userData.rest;
    for (let k = 0; k < p.count; k++) { const s = r[k * 3 + 2] / (SKI_L / 2); p.array[k * 3 + 1] = r[k * 3 + 1] + bend(s); }
    p.needsUpdate = true; g.computeVertexNormals();
  }
}

// ── boots: a two-piece freestyle boot. The lower shell rides the boot matrix (the foot); the cuff hangs off the shin bone,
// so it leans with the leg like a hinged boot and the pants' flared hems always have it inside them. ──
const BOOT = { shell: '#2a2c31', shell2: '#3b3f46', sole: '#141416', buckle: '#c9ccd1', liner: '#18191b' };
function bootShellGeo(lat) {
  const L = [], M = 28, stations = 26;
  const prof = (u) => {
    const a = lerp(lerp(0.041, 0.05, smooth(u / 0.4)), 0.043, smooth((u - 0.7) / 0.28));
    const yt = u < 0.36 ? lerp(0.12, 0.135, smooth(u / 0.36)) : u < 0.5 ? 0.14 : lerp(0.14, 0.068, smooth((u - 0.5) / 0.36)) - 0.012 * smooth((u - 0.9) / 0.1);
    const close = Math.sqrt(smooth(Math.min(u, 1 - u) / 0.05));
    return { a: a * lerp(0.35, 1, close), yt, close };
  };
  const rings = [];
  for (let i = 0; i < stations; i++) {
    const u = i / (stations - 1), z = -BOOT_L / 2 + 0.006 + u * (BOOT_L - 0.012), { a, yt, close } = prof(u), yb = 0.02, hh = (yt - yb) / 2 * lerp(0.25, 1, close);
    rings.push(superRing(lat * 0.003 * smooth((u - 0.6) / 0.4), yb + hh, z, a, hh, 3.2, M));
  }
  const shell = tube(rings, (i, j) => { const u = i / (stations - 1), y = rings[i][j].y; return y < 0.034 ? BOOT.sole : u > 0.42 && u < 0.58 && rings[i][j].y > 0.11 ? BOOT.shell2 : BOOT.shell; });
  const sole = roundBox(0.088, 0.022, BOOT_L + 0.004, 0.008); sole.translate(0, 0.011, 0); L.push([sole, BOOT.sole]);
  const toe = roundBox(0.07, 0.02, 0.032, 0.006); toe.translate(0, 0.021, BOOT_L / 2 - 0.002); L.push([toe, BOOT.sole]);
  const heel = roundBox(0.074, 0.022, 0.03, 0.006); heel.translate(0, 0.022, -BOOT_L / 2 + 0.002); L.push([heel, BOOT.sole]);
  for (const [u, tilt] of [[0.64, 0.5], [0.5, 0.3]]) {
    const z = -BOOT_L / 2 + u * BOOT_L, { a, yt } = prof(u);
    const strap = new THREE.TorusGeometry(1, 0.06, 4, 20, Math.PI); strap.scale(a + 0.003, yt - 0.045, 0.06); strap.translate(0, 0.045, 0); strap.rotateX(-tilt * 0.25); strap.translate(0, 0, z); L.push([strap, BOOT.liner]);
    const lev = roundBox(0.006, 0.016, 0.04, 0.0025); lev.rotateX(tilt); lev.translate(lat * (a + 0.004), yt - 0.03, z); L.push([lev, BOOT.buckle]);
  }
  const rest = bake(L); return mergeGeometries([shell.toNonIndexed(), rest], false);
}
function buildCuff(sk, sfx, lat) {
  // in bind space round the shin, from just under the ankle to ~28 cm above the sole; rigid on the shin (calf) bone
  const knee = bindAt(sk, 'calf' + sfx), ank = bindAt(sk, 'foot' + sfx), ey = V().subVectors(knee, ank).normalize();
  const ex = V(1, 0, 0).addScaledVector(ey, -ey.x).normalize(), ez = V().crossVectors(ex, ey).normalize();
  const M = 28, rings = [], cols = [];
  const n = 9; for (let i = 0; i < n; i++) {
    const t = i / (n - 1), h = lerp(-0.03, 0.19, t), a = lerp(0.052, 0.054, t), b = lerp(0.064, 0.066, t), r = [];
    for (let j = 0; j < M; j++) { const f = (j / M) * Math.PI * 2, cx = Math.sin(f), cz = Math.cos(f), tongue = 0.009 * Math.max(0, cz) ** 6 * smooth(t / 0.3);
      r.push(ank.clone().addScaledVector(ey, h).addScaledVector(ex, cx * a).addScaledVector(ez, cz * (b + tongue) + 0.004)); }
    rings.push(r);
  }
  const g = tube(rings, (i, j) => { const f = (j / M) * Math.PI * 2, cz = Math.cos(f); return i === n - 1 ? BOOT.liner : cz > 0.93 && i > 1 ? BOOT.shell2 : BOOT.shell; });
  // the power strap round the top, and a cuff buckle on the outside
  const top = ank.clone().addScaledVector(ey, 0.165), L = [];
  const strap = new THREE.CylinderGeometry(1, 1, 0.032, 24, 1, true); strap.scale(0.057, 1, 0.069);
  const basis = new THREE.Matrix4().makeBasis(ex, ey, ez); strap.applyMatrix4(basis); strap.translate(top.x, top.y, top.z); L.push([strap, T.skiColor || '#e8452c']);
  const lev = roundBox(0.01, 0.034, 0.03, 0.003); lev.applyMatrix4(basis); const lp = ank.clone().addScaledVector(ey, 0.1).addScaledVector(ex, lat * 0.056).addScaledVector(ez, 0.02); lev.translate(lp.x, lp.y, lp.z); L.push([lev, BOOT.buckle]);
  return mergeGeometries([g.toNonIndexed(), bake(L)], false);
}

// ── poles: one mesh each. Origin at the top of the grip, shaft down -y. ──
function buildPole(mat) {
  const L = 1.18, parts = [];
  const shaft = new THREE.CylinderGeometry(0.0085, 0.006, L - 0.12, 10).translate(0, -0.12 - (L - 0.12) / 2, 0); parts.push([shaft, '#d9dcdf']);
  const grip = new THREE.LatheGeometry([[0.011, 0.0], [0.016, -0.006], [0.0165, -0.03], [0.0145, -0.06], [0.0165, -0.09], [0.0175, -0.125], [0.012, -0.135]].map(([r, y]) => new THREE.Vector2(r, y)), 14); parts.push([grip, '#18191b']);
  const cap = new THREE.SphereGeometry(0.012, 10, 6, 0, Math.PI * 2, 0, Math.PI / 2).translate(0, 0, 0); parts.push([cap, T.skiColor || '#e8452c']);
  const loop = new THREE.TorusGeometry(0.035, 0.003, 4, 18, Math.PI * 1.3).rotateZ(-Math.PI * 0.65 - 1.57).rotateY(Math.PI / 2).translate(0, -0.035, -0.012); parts.push([loop, '#202124']);
  const basket = new THREE.CylinderGeometry(0.03, 0.026, 0.008, 16).translate(0, -L + 0.09, 0); parts.push([basket, '#18191b']);
  const ring = new THREE.TorusGeometry(0.03, 0.0035, 4, 18).rotateX(Math.PI / 2).translate(0, -L + 0.09, 0); parts.push([ring, T.skiColor || '#e8452c']);
  const ferrule = new THREE.CylinderGeometry(0.006, 0.004, 0.05, 8).translate(0, -L + 0.045, 0); parts.push([ferrule, '#222']);
  const tip = new THREE.ConeGeometry(0.004, 0.02, 8).rotateX(Math.PI).translate(0, -L - 0.008, 0); parts.push([tip, '#aaaaaa']);
  const m = new THREE.Mesh(bake(parts), mat); m.castShadow = true;
  const g = new THREE.Group(); g.add(m); g.userData.L = L; return g;
}

// ── soft goods built off the body itself (bind space), so they fit this model ──
// gloves: the hands' skin, puffed out, keeping its skin weights: they curl round the grips with the fingers
function buildGloves(view, parts) {
  const H = parts.Human, sk = H.skeleton, src = H.geometry, P = src.attributes.position, SI = src.attributes.skinIndex, SW = src.attributes.skinWeight;
  const out = [], idx = src.index.array;
  const mat = new THREE.MeshPhysicalMaterial({ vertexColors: true, roughness: 0.75, sheen: 0.4, sheenRoughness: 0.6, sheenColor: new THREE.Color(0.35, 0.35, 0.38) });
  for (const sfx of ['_l', '_r']) {
    const hand = boneSet(sk, 'hand' + sfx), wr = bindAt(sk, 'hand' + sfx), el = bindAt(sk, 'lowerarm' + sfx), sgn = Math.sign(wr.x);
    const fore = V().subVectors(wr, el).normalize();
    const pn = V().crossVectors(V().subVectors(bindAt(sk, 'index_01' + sfx), wr), V().subVectors(bindAt(sk, 'pinky_01' + sfx), wr)).normalize();
    if (pn.dot(V().subVectors(bindAt(sk, 'thumb_03' + sfx), wr)) < 0) pn.negate();
    const inG = new Uint8Array(P.count), v = V();
    for (let i = 0; i < P.count; i++) { if (Math.sign(P.getX(i)) !== sgn) continue; v.fromBufferAttribute(P, i); const along = V().subVectors(v, wr).dot(fore);
      if (weightIn(SI, SW, i, hand) > 0.3 || along > -0.075) inG[i] = along > -0.09 && v.distanceTo(wr) < 0.3 ? 1 : 0; }
    const keep = []; for (let t = 0; t < idx.length; t += 3) if (inG[idx[t]] && inG[idx[t + 1]] && inG[idx[t + 2]]) keep.push(idx[t], idx[t + 1], idx[t + 2]);
    // compact to the used vertices
    const map = new Int32Array(P.count).fill(-1), list = []; for (const k of keep) if (map[k] < 0) { map[k] = list.length; list.push(k); }
    const g = new THREE.BufferGeometry(), pos = new Float32Array(list.length * 3), si = new Uint16Array(list.length * 4), swt = new Float32Array(list.length * 4), col = new Float32Array(list.length * 3);
    list.forEach((k, n) => { pos.set([P.getX(k), P.getY(k), P.getZ(k)], n * 3); for (let c = 0; c < 4; c++) { si[n * 4 + c] = SI.getComponent(k, c); swt[n * 4 + c] = SW.getComponent(k, c); } });
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3)); g.setIndex(keep.map((k) => map[k])); g.computeVertexNormals();
    // puff out along smoothed normals: thicker on the back of the hand and the cuff, thin on the fingers
    const N = posSmoothNormals(g), back = new THREE.Color('#25272c'), palm = new THREE.Color('#3b3a3a'), cuff = new THREE.Color(T.skiColor || '#e8452c').lerp(new THREE.Color('#25272c'), 0.5), nn = V();
    for (let n = 0; n < list.length; n++) {
      v.fromBufferAttribute(g.attributes.position, n); nn.fromArray(N, n * 3);
      const along = V().subVectors(v, wr).dot(fore), fingers = smooth((along - 0.06) / 0.03), wrist = smooth((-along - 0.01) / 0.04);
      const d = lerp(lerp(0.009, 0.006, fingers), 0.014, wrist); v.addScaledVector(nn, d); pos.set([v.x, v.y, v.z], n * 3);
      const c = nn.dot(pn) > 0.25 && along > -0.01 ? palm : wrist > 0.5 ? cuff : back; col.set([c.r, c.g, c.b], n * 3);
    }
    g.setAttribute('skinIndex', new THREE.BufferAttribute(si, 4)); g.setAttribute('skinWeight', new THREE.BufferAttribute(swt, 4)); g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    g.attributes.position.needsUpdate = true; g.computeVertexNormals();
    const m = new THREE.SkinnedMesh(g, mat); m.name = 'glove' + sfx; m.bind(sk, H.bindMatrix); m.castShadow = true; m.frustumCulled = false;
    m.position.copy(H.position); m.quaternion.copy(H.quaternion); m.scale.copy(H.scale); H.parent.add(m); out.push(m);
  }
  return out;
}
function posSmoothNormals(g) {
  const P = g.attributes.position, n0 = g.attributes.normal, id = new Int32Array(P.count), map = new Map();
  for (let i = 0; i < P.count; i++) { const k = `${Math.round(P.getX(i) * 2e4)},${Math.round(P.getY(i) * 2e4)},${Math.round(P.getZ(i) * 2e4)}`; let j = map.get(k); if (j === undefined) { j = map.size; map.set(k, j); } id[i] = j; }
  const acc = new Float32Array(map.size * 3); for (let i = 0; i < P.count; i++) { acc[id[i] * 3] += n0.getX(i); acc[id[i] * 3 + 1] += n0.getY(i); acc[id[i] * 3 + 2] += n0.getZ(i); }
  const out = new Float32Array(P.count * 3), v = V(); for (let i = 0; i < P.count; i++) { v.fromArray(acc, id[i] * 3).normalize(); out.set([v.x, v.y, v.z], i * 3); } return out;
}
// samples of the head's surface in cylindrical coordinates round a vertical axis
function headSamples(parts, sk, ymin, ymax, zAxis, filter) {
  const s = [], v = V(), headB = new Set([boneIdx(sk, 'head'), boneIdx(sk, 'neck_01')]);
  for (const name of ['Human', 'beanie', 'hair_beanie']) {
    const o = parts[name]; if (!o || !o.visible) continue; const P = o.geometry.attributes.position, SI = o.geometry.attributes.skinIndex, SW = o.geometry.attributes.skinWeight;
    for (let i = 0; i < P.count; i++) { v.fromBufferAttribute(P, i); if (v.y < ymin || v.y > ymax) continue; if (name === 'Human' && weightIn(SI, SW, i, headB) < 0.5) continue; if (filter && !filter(name, v)) continue;
      s.push({ th: Math.atan2(v.x, v.z - zAxis), y: v.y, r: Math.hypot(v.x, v.z - zAxis), i, name }); }
  }
  return s;
}
const angD = (a, b) => Math.abs(Math.atan2(Math.sin(a - b), Math.cos(a - b)));
function maxR(samples, th, y, dth, dy) { let m = 0; for (const p of samples) if (Math.abs(p.y - y) < dy && angD(p.th, th) < dth && p.r > m) m = p.r; return m; }
function smoothRing(a, passes = 2) { const n = a.length; for (let p = 0; p < passes; p++) { const b = a.slice(); for (let i = 0; i < n; i++) a[i] = (b[(i + n - 1) % n] + 2 * b[i] + b[(i + 1) % n]) / 4; } return a; }
// neck gaiter, pulled up over the nose: a soft knit tube draped off the nose, chin and neck, skinned to the neck and head
function buildGaiter(parts, sk, eyeY) {
  const ZA = 0.035, NT = 44, NY = 16, y0 = 0.548, H = parts.Human, P = H.geometry.attributes.position, SI = H.geometry.attributes.skinIndex, SW = H.geometry.attributes.skinWeight;
  const yTop = (th) => { const f = (1 + Math.cos(th)) / 2; return lerp(eyeY - 0.004, eyeY - 0.028, Math.pow(f, 0.7)); };
  const samples = headSamples(parts, sk, y0 - 0.02, eyeY + 0.01, ZA, (n, v) => n === 'Human' || v.y < eyeY - 0.03);
  const R = [];
  for (let k = 0; k <= NY; k++) {
    const row = [];
    for (let j = 0; j < NT; j++) { const th = (j / NT) * Math.PI * 2 - Math.PI, y = lerp(y0, yTop(th), k / NY); row.push({ th, y, r0: maxR(samples, th, y, 0.16, 0.011) }); }
    R.push(row);
  }
  // the jacket's collar, where the gaiter tucks in
  const coll = new Float32Array(NT);
  if (parts.sweater) { const S = parts.sweater.geometry.attributes.position, v = V(); for (let i = 0; i < S.count; i++) { v.fromBufferAttribute(S, i); if (Math.abs(v.y - (y0 + 0.012)) > 0.02) continue; const th = Math.atan2(v.x, v.z - ZA), j = ((Math.round(((th + Math.PI) / (2 * Math.PI)) * NT) % NT) + NT) % NT, r = Math.hypot(v.x, v.z - ZA); if (!coll[j] || r < coll[j]) coll[j] = r; } }
  // drape: per angle, the cloth spans the convex hull of the face/neck profile and the collar (nose to chin to collar in straight runs)
  for (let j = 0; j < NT; j++) {
    const pts = R.map((row) => [row[j].y, row[j].r0]).filter((p) => p[1] > 0);
    const cr = coll[j] ? coll[j] - 0.004 : 0; if (cr) pts.unshift([y0 - 0.004, cr]);
    pts.sort((a, b) => a[0] - b[0]);
    const hull = []; for (const p of pts) { while (hull.length >= 2) { const [a, b] = [hull[hull.length - 2], hull[hull.length - 1]]; if ((b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0]) >= 0) hull.pop(); else break; } hull.push(p); }
    for (let k = 0; k <= NY; k++) { const y = R[k][j].y; let r = hull[0][1]; for (let h = 0; h < hull.length - 1; h++) if (y >= hull[h][0] && y <= hull[h + 1][0]) { r = lerp(hull[h][1], hull[h + 1][1], (y - hull[h][0]) / Math.max(1e-6, hull[h + 1][0] - hull[h][0])); break; }
      if (y > hull[hull.length - 1][0]) r = hull[hull.length - 1][1]; R[k][j].r = Math.max(r, R[k][j].r0); }
  }
  for (let k = 0; k <= NY; k++) { const a = smoothRing(R[k].map((p) => p.r), 3); R[k].forEach((p, j) => { p.r = a[j] + 0.008 + 0.004 * (1 - k / NY); }); }
  const rings = R.map((row) => row.map((p) => V(p.r * Math.sin(p.th), p.y, ZA + p.r * Math.cos(p.th))));
  const g = tube(rings, () => '#ffffff'); g.deleteAttribute('color');
  // a rolled top edge: shade by height
  // skin weights: from the nearest few head/neck vertices of the body
  const cand = []; const neckB = new Set([boneIdx(sk, 'head'), boneIdx(sk, 'neck_01'), boneIdx(sk, 'spine_03')]), v = V();
  for (let i = 0; i < P.count; i++) { const y = P.getY(i); if (y < y0 - 0.04 || y > eyeY + 0.02) continue; if (weightIn(SI, SW, i, neckB) < 0.6) continue; cand.push(i); }
  transferWeights(g, H.geometry, cand, 5);
  const uvs = new Float32Array(g.attributes.position.count * 2); rings.forEach((r, k) => r.forEach((p, j) => { uvs[(k * NT + j) * 2] = j / NT; uvs[(k * NT + j) * 2 + 1] = k / NY; })); g.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
  const tl = new THREE.TextureLoader(), nm = tl.load('./assets/tex/jersey_nor.jpg'); nm.wrapS = nm.wrapT = THREE.RepeatWrapping; nm.repeat.set(6, 2);
  const mat = new THREE.MeshPhysicalMaterial({ color: new THREE.Color(T.gaiterColor || '#24262b'), roughness: 0.95, sheen: 0.5, sheenRoughness: 0.7, sheenColor: new THREE.Color(0.4, 0.42, 0.45), normalMap: nm, normalScale: new THREE.Vector2(0.6, 0.6), side: THREE.DoubleSide });
  mat.onBeforeCompile = (sh) => { sh.fragmentShader = sh.fragmentShader.replace('#include <map_fragment>', `#include <map_fragment>
      { float v = vNormalMapUv.y / 2.0; float band = step(0.5, fract(v * 7.0 + 0.0)) * smoothstep(0.35, 0.45, v) * (1.0 - smoothstep(0.55, 0.62, v));
        diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.62, 0.6, 0.55) * 0.6, band * 0.0);
        diffuseColor.rgb *= 0.85 + 0.15 * smoothstep(0.0, 0.25, v) ; diffuseColor.rgb *= 1.0 - 0.25 * smoothstep(0.93, 1.0, v); }`); };
  const m = new THREE.SkinnedMesh(g, mat); m.name = 'gaiter'; m.bind(sk, H.bindMatrix); m.castShadow = true; m.receiveShadow = true; m.frustumCulled = false;
  m.position.copy(H.position); m.quaternion.copy(H.quaternion); m.scale.copy(H.scale); H.parent.add(m);
  return m;
}
function transferWeights(g, src, cand, K) {
  const P = g.attributes.position, S = src.attributes.position, SI = src.attributes.skinIndex, SW = src.attributes.skinWeight;
  const si = new Uint16Array(P.count * 4), sw = new Float32Array(P.count * 4), v = V(), u = V();
  for (let i = 0; i < P.count; i++) {
    v.fromBufferAttribute(P, i); const best = [];
    for (const c of cand) { u.fromBufferAttribute(S, c); const d = u.distanceToSquared(v); if (best.length < K || d < best[best.length - 1][0]) { best.push([d, c]); best.sort((a, b) => a[0] - b[0]); if (best.length > K) best.pop(); } }
    const acc = new Map(); for (const [d, c] of best) { const w = 1 / (Math.sqrt(d) + 0.005); for (let k = 0; k < 4; k++) { const b = SI.getComponent(c, k), x = SW.getComponent(c, k) * w; if (x > 0) acc.set(b, (acc.get(b) || 0) + x); } }
    const top = [...acc.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4), s = top.reduce((a, e) => a + e[1], 0) || 1;
    top.forEach(([b, w], k) => { si[i * 4 + k] = b; sw[i * 4 + k] = w / s; });
  }
  g.setAttribute('skinIndex', new THREE.BufferAttribute(si, 4)); g.setAttribute('skinWeight', new THREE.BufferAttribute(sw, 4));
}
// goggles: a big cylindrical lens and frame fitted to the face, the strap round the beanie. Rigid on the head bone.
function buildGoggles(parts, sk, eyeY) {
  const ZA = 0.045, samples = headSamples(parts, sk, eyeY - 0.06, eyeY + 0.08, ZA);
  // the strap: round the head, a little higher at the back
  const NT = 56, strapY = (th) => eyeY + 0.016 + 0.02 * (1 - Math.cos(th)) / 2, HW = 0.019;
  const rs = []; for (let j = 0; j < NT; j++) { const th = (j / NT) * Math.PI * 2 - Math.PI; rs.push(maxR(samples, th, strapY(th), 0.14, HW + 0.004) + 0.004); }
  smoothRing(rs, 4);
  // the face's front, where the frame sits: lens radius as a smooth function of the angle
  const TM = 1.2, nf = 25, Rf = []; for (let i = 0; i < nf; i++) { const th = lerp(-TM - 0.1, TM + 0.1, i / (nf - 1)); Rf.push(maxR(samples.filter((p) => p.name === 'Human' || Math.abs(p.th) > 0.9), th, eyeY + 0.006, 0.12, 0.038)); }
  for (let i = 0; i < nf; i++) if (!Rf[i]) Rf[i] = Rf[i - 1] || 0.1;
  for (let p = 0; p < 5; p++) { const b = Rf.slice(); for (let i = 1; i < nf - 1; i++) Rf[i] = Math.max(b[i], (b[i - 1] + b[i] + b[i + 1]) / 3); }
  for (let p = 0; p < 3; p++) { const b = Rf.slice(); for (let i = 1; i < nf - 1; i++) Rf[i] = (b[i - 1] + 2 * b[i] + b[i + 1]) / 4; }
  const Rat = (th) => { const f = clamp((th + TM + 0.1) / (2 * TM + 0.2), 0, 1) * (nf - 1), i = Math.min(nf - 2, Math.floor(f)); return lerp(Rf[i], Rf[i + 1], f - i) + 0.014; };
  // the outline: a rounded box with a notch for the nose, in (arc length, height) round the centre of the lens
  const R0 = Rat(0), HWID = TM * 0.95 * R0, HH = 0.046, CR = 0.032, yc = eyeY + 0.006;
  const sdf = (s, y) => { const qx = Math.abs(s) - (HWID - CR), qy = Math.abs(y) - (HH - CR); const box = Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - CR;
    const nose = 0.023 - Math.hypot(s / 1.1, y + HH + 0.008); return Math.max(box, nose); };
  const NO = 72, outline = []; for (let k = 0; k < NO; k++) { const a = (k / NO) * Math.PI * 2; let lo = 0, hi = 0.3; for (let it = 0; it < 30; it++) { const m = (lo + hi) / 2; if (sdf(Math.cos(a) * m, 0.006 + Math.sin(a) * m) < 0) lo = m; else hi = m; } outline.push([Math.cos(a) * lo, 0.006 + Math.sin(a) * lo]); }
  const P3 = (s, y, dr) => { const th = s / R0, r = Rat(th) + dr; return V(r * Math.sin(th), yc + y, ZA + r * Math.cos(th)); };
  // lens: rings shrinking to the centre, bulging a little (a toric lens)
  const lensRings = []; for (const f of [0.93, 0.8, 0.62, 0.42, 0.22, 0.0]) lensRings.push(outline.map(([s, y]) => P3(s * f, (y - 0.006) * f + 0.006, 0.004 + 0.006 * (1 - f * f))));
  const lensG = tube(lensRings); lensG.deleteAttribute('color');
  const uvs = new Float32Array(lensG.attributes.position.count * 2); lensRings.forEach((r, k) => r.forEach((p, j) => { const [s, y] = outline[j], f = [0.93, 0.8, 0.62, 0.42, 0.22, 0.0][k]; uvs[(k * NO + j) * 2] = 0.5 + s * f / (2 * HWID); uvs[(k * NO + j) * 2 + 1] = 0.5 + y * f / (2 * HH); })); lensG.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
  // frame: front lip round the lens, a wall back toward the face, foam against it
  const fc = T.goggleFrame || '#f2efe8', foam = '#1b1b1d', strapC = T.goggleStrap || '#1d1f24';
  const frameRings = [outline.map(([s, y]) => P3(s * 0.9, (y - 0.006) * 0.9 + 0.006, 0.0045)), outline.map(([s, y]) => P3(s * 1.0, y, 0.004)), outline.map(([s, y]) => P3(s * 1.035, (y - 0.006) * 1.05 + 0.006, -0.004)),
    outline.map(([s, y]) => P3(s * 1.04, (y - 0.006) * 1.06 + 0.006, -0.016)), outline.map(([s, y]) => P3(s * 1.0, y, -0.022))];
  const frameG = tube(frameRings, (i) => (i >= 3 ? foam : fc));
  // strap band
  const sp = [], top = [], bot = [];
  for (let j = 0; j < NT; j++) { const th = (j / NT) * Math.PI * 2 - Math.PI, r = rs[j], y = strapY(th); top.push(V(r * Math.sin(th), y + HW, ZA + r * Math.cos(th))); bot.push(V(r * Math.sin(th), y - HW, ZA + r * Math.cos(th))); }
  const strapG = tube([bot, top].map((r) => r), (i, j) => { const th = (j / NT) * Math.PI * 2 - Math.PI; return Math.abs(Math.abs(th) - Math.PI) < 0.35 ? (T.skiColor || '#e8452c') : strapC; });
  void sp;
  const fm = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.55, side: THREE.DoubleSide });
  const lm = new THREE.MeshPhysicalMaterial({ color: new THREE.Color(T.goggleColor || '#e8a33a'), metalness: 0.85, roughness: 0.06, iridescence: 1, iridescenceIOR: 1.7, iridescenceThicknessRange: [250, 600], clearcoat: 1, clearcoatRoughness: 0.03, side: THREE.DoubleSide });
  const gog = new THREE.Group(), frame = new THREE.Mesh(mergeGeometries([frameG.toNonIndexed(), strapG.toNonIndexed()], false), fm), lens = new THREE.Mesh(lensG, lm);
  frame.castShadow = true; lens.castShadow = true; gog.add(frame, lens);
  return gog;
}
// a rigid part built in bind space, hung off bone `name` so it follows it exactly
function hangOnBone(view, sk, name, obj) {
  const b = view.rig.R[name].bone; obj.matrixAutoUpdate = false; obj.matrix.copy(sk.boneInverses[boneIdx(sk, name)]); b.add(obj); return obj;
}

export function dressSkier(view) {
  const R = view.rig.R, parts = {}; view.model.traverse((o) => { if (o.isMesh) parts[o.name] = o; });
  const sk = parts.Human.skeleton;
  const atlas = skiAtlas();
  const skiMat = new THREE.MeshPhysicalMaterial({ map: atlas.map, roughnessMap: atlas.orm, metalnessMap: atlas.orm, roughness: 1, metalness: 1, clearcoat: 0.7, clearcoatRoughness: 0.18 });
  const bindMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.45, metalness: 0.25 });
  const skis = [buildSki(skiMat, bindMat), buildSki(skiMat, bindMat)];
  const bootMat = new THREE.MeshPhysicalMaterial({ vertexColors: true, roughness: 0.32, clearcoat: 0.6, clearcoatRoughness: 0.25 });
  // boots: [0] is the left foot (body +x); its outside is +x
  const boots = [1, -1].map((lat) => { const g = new THREE.Group(), m = new THREE.Mesh(bootShellGeo(lat), bootMat); m.castShadow = true; m.receiveShadow = true; g.add(m); return g; });
  for (const o of [...skis, ...boots]) { o.matrixAutoUpdate = false; view.body.add(o); }
  const sideOf = (sfx) => Math.sign(bindAt(sk, 'thigh' + sfx).x);
  for (const sfx of ['_l', '_r']) { const lat = sideOf(sfx), cuff = new THREE.Mesh(buildCuff(sk, sfx, lat), bootMat); cuff.castShadow = true; cuff.frustumCulled = false; hangOnBone(view, sk, 'calf' + sfx, cuff); }
  const poleMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.35, metalness: 0.5 });
  const poles = T.poles ? [buildPole(poleMat), buildPole(poleMat)] : [];
  for (const p of poles) { p.matrixAutoUpdate = false; view.body.add(p); }
  // the street shoes go (the boots go over the feet); so do the bare hands under the gloves' cuffs
  view.model.traverse((o) => { if (o.isMesh && /^shoes/.test(o.name)) o.visible = false; });
  const eyeY = (view.EU.uEyeA.value.y + view.EU.uEyeB.value.y) / 2;
  const gog = hangOnBone(view, sk, 'head', buildGoggles(parts, sk, eyeY));
  const gaiter = T.gaiter === false ? null : buildGaiter(parts, sk, eyeY);
  const mitts = buildGloves(view, parts);
  void R;
  return { skis, boots, poles, gog, mitts, gaiter };
}
