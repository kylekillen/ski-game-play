// The skater and board you see. Physics decides where the board is; this
// file stands a rigged human model (assets/skater/skater.glb, CC0 MakeHuman) on
// top of it and poses the skeleton every frame: legs and arms reach for foot
// and hand targets, the spine, hips and head come from the pose table below.
import * as THREE from 'three';
import { mergeGeometries, mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import * as SkeletonUtils from 'three/addons/utils/SkeletonUtils.js';
import { TWEAKS as T } from './tweaks.js';
import { fitSkiClothes } from './gear.js';
const PUSH_DUR = 0.72, PUSH_ON = 0.22, PUSH_OFF = 0.62, BODY_R = 0.28, GETUP_TIME = 0.6;

const V = (x = 0, y = 0, z = 0) => new THREE.Vector3(x, y, z);
const Q = () => new THREE.Quaternion();
const X = V(1, 0, 0), Y = V(0, 1, 0), Z = V(0, 0, 1);
const clamp = (v, a, b) => Math.min(b, Math.max(a, v)), lerp = (a, b, t) => a + (b - a) * t;
const smooth = (t) => { t = clamp(t, 0, 1); return t * t * (3 - 2 * t); };
const hermite = (p0, v0, p1, v1, t) => { const t2 = t * t, t3 = t2 * t; return (2 * t3 - 3 * t2 + 1) * p0 + (t3 - 2 * t2 + t) * v0 + (-2 * t3 + 3 * t2) * p1 + (t3 - t2) * v1; };
const _m = new THREE.Matrix4();
// Critically damped spring, solved exactly for any frame time (Holden, "Spring-It-On", 2021). w = stiffness (1/s).
// Moves o[k] toward target t, keeping its velocity in o.v[k]: no overshoot, no pops, no lag spikes on a slow frame.
export function spring(o, k, t, w, dt) {
  const v = o.v[k] || 0, j0 = o[k] - t, j1 = v + j0 * w, e = Math.exp(-w * dt);
  o[k] = e * (j0 + j1 * dt) + t; o.v[k] = e * (v - j1 * w * dt);
}
// Solver targets (S) can be copied, mirrored and blended: that is how one movement hands over to the next without a pop.
const S_V = ['ank', 'fn', 'ff', 'kpole', 'hand', 'epole', 'palm'], S_DIR = new Set(['fn', 'ff', 'palm']);
function copyS(S, curl) {
  const o = { H: S.H.clone(), Qp: S.Qp.clone(), Qc: S.Qc.clone(), Qh: S.Qh.clone(), toe: [...(S.toe || [0, 0])], curl: [...curl] };
  for (const k of S_V) o[k] = (S[k] || [V(0, -1, 0), V(0, -1, 0)]).map((v) => v.clone());
  return o;
}
// the same pose seen in a mirror (x -> -x), carried by the other side of the body: looks identical, so a stance swap does not jump
function mirrorS(o) {
  const mq = (q) => { q.y = -q.y; q.z = -q.z; };
  o.H.x = -o.H.x; mq(o.Qp); mq(o.Qc); mq(o.Qh);
  for (const k of S_V) { o[k].forEach((v) => { v.x = -v.x; }); o[k].reverse(); }
  o.toe.reverse(); o.curl.reverse(); return o;
}
function blendS(S, A, w, curl) {
  S.H.lerpVectors(A.H, S.H, w); S.Qp = A.Qp.clone().slerp(S.Qp, w); S.Qc = A.Qc.clone().slerp(S.Qc, w); S.Qh = A.Qh.clone().slerp(S.Qh, w);
  if (!S.palm) S.palm = [V(0, -1, 0), V(0, -1, 0)];
  for (const k of S_V) for (let i = 0; i < 2; i++) { S[k][i].lerpVectors(A[k][i], S[k][i], w); if (S_DIR.has(k)) S[k][i].normalize(); }
  for (let i = 0; i < 2; i++) { S.toe[i] = lerp(A.toe[i], S.toe[i], w); curl[i] = lerp(A.curl[i], curl[i], w); }
}
const _p0 = V(), _p1 = V(), _q0 = Q(), _q1 = Q(), _s = V();
function blendM(a, b, w, out) {           // rigid transforms: lerp the place, slerp the turn
  a.decompose(_p0, _q0, _s); b.decompose(_p1, _q1, _s);
  return out.compose(_p0.lerp(_p1, w), _q0.slerp(_q1, w), _s.set(1, 1, 1));
}
// A rotation whose "up" is d and whose "front" leans toward p.
export function frameQ(d, p, out = Q()) {
  const y = d.clone().normalize(), z = p.clone().addScaledVector(y, -p.dot(y));
  if (z.lengthSq() < 1e-8) z.copy(Math.abs(y.x) < 0.9 ? X : Z).addScaledVector(y, -(Math.abs(y.x) < 0.9 ? y.x : y.z));
  z.normalize();
  return out.setFromRotationMatrix(_m.makeBasis(V().crossVectors(y, z), y, z));
}
export const turn = (yaw, lean = 0, side = 0) => Q().setFromEuler(new THREE.Euler(lean, yaw, -side, 'YXZ'));   // yaw toward the nose, lean toward the toes, side toward the nose
// Two-bone joint: where does the knee/elbow go between a and b?
export function bendPoint(a, b, L1, L2, bend, out) {
  const d = V().subVectors(b, a), dist = clamp(d.length(), Math.abs(L1 - L2) + 0.02, L1 + L2 - 0.002);
  d.normalize();
  const along = (L1 * L1 - L2 * L2 + dist * dist) / (2 * dist);
  const h = Math.sqrt(Math.max(0, L1 * L1 - along * along));
  const perp = bend.clone().addScaledVector(d, -bend.dot(d));
  if (perp.lengthSq() < 1e-8) perp.copy(Y).addScaledVector(d, -d.y);
  return out.copy(a).addScaledVector(d, along).addScaledVector(perp.normalize(), h);
}

// Body-space poses. x = along the board (front foot is +x), y = up, z = toe side.
// hip* = where the hips sit above the deck; pYaw/cYaw = how far hips/chest are turned toward the nose;
// lean = bend toward the toes; f*/b* = front/back foot (a = along the board, z = across, yaw, lift off the deck, w = 1 stuck to the deck);
// l*/r* = front/back hand relative to its shoulder; curl = how closed the fingers are.
const RIDE = { hipX: 0, hipY: 0.765, hipZ: -0.04, pYaw: 0.28, cYaw: 0.46, lean: 0.2, side: 0,
  fa: 0.205, fz: 0, fyaw: 0.3, flift: 0, fw: 1, ba: -0.215, bz: 0, byaw: -0.06, blift: 0, bw: 1,
  lx: 0.1, ly: -0.43, lz: 0.1, rx: -0.1, ry: -0.43, rz: 0.1, curl: 0.35 };
const pose = (o) => ({ ...RIDE, ...o });
const POSES = {
  ride: RIDE,
  crouch: pose({ hipY: 0.54, hipZ: -0.12, lean: 0.62, pYaw: 0.2, cYaw: 0.32, ba: -0.3, lx: 0.16, ly: -0.3, lz: 0.24, rx: -0.16, ry: -0.3, rz: 0.24 }),
  air: pose({ hipY: 0.59, hipZ: -0.08, lean: 0.46, lx: 0.17, ly: -0.33, lz: 0.15, rx: -0.18, ry: -0.35, rz: 0.08, curl: 0.25 }),
  flip: pose({ hipY: 0.66, hipZ: -0.05, lean: 0.36, fa: 0.25, fz: 0.05, flift: 0.19, fw: 0, ba: -0.27, blift: 0.17, bw: 0, lx: 0.24, ly: -0.16, lz: 0.12, rx: -0.24, ry: -0.19, rz: 0.08, curl: 0.2 }),
  grab: pose({ hipY: 0.45, hipZ: -0.08, lean: 0.66, lx: 0.3, ly: 0.12, lz: -0.02, rx: -0.32, ry: 0.14, rz: -0.02, curl: 0.25 }),
  grind: pose({ hipY: 0.64, hipZ: -0.06, lean: 0.42, lx: 0.22, ly: -0.35, lz: 0.15, rx: -0.22, ry: -0.37, rz: 0.06, curl: 0.3 }),   // arms out for balance, but low and loose (no aeroplane)
  manual: pose({ hipY: 0.7, lean: 0.3, lx: 0.27, ly: -0.28, lz: 0.17, rx: -0.28, ry: -0.31, rz: 0.05, curl: 0.3 }),
  slide: pose({ hipY: 0.6, lean: 0.18, lx: 0.24, ly: -0.31, lz: 0.16, rx: -0.25, ry: -0.29, rz: 0.04, curl: 0.3 }),
};
const KEYS = Object.keys(RIDE);
// Named grabs (physics' grabE.name): body changes on top of POSES.grab, where each hand takes the board ([along, above the deck, toward the toes],
// board space before the board's own tilt), and for the feet-off grabs where each foot goes: [along, height above the deck, toward the toes, yaw, toe point].
// A foot function gets the time, for grabs that keep moving (the tailwalk's walking legs).
const GRAB_POSE = {
  'Crail': { body: { hipY: 0.44, lean: 0.72, cYaw: 0.75, pYaw: 0.4, lx: 0.32, ly: 0.18, lz: -0.12 }, hand: [null, [0.36, 0.02, 0.07]] },
  'Stalefish': { body: { hipY: 0.42, lean: 0.48, cYaw: 0.2, hipZ: 0.02, lx: 0.34, ly: 0.16, lz: 0.05 }, hand: [null, [-0.1, 0.0, -0.105]], epole: [null, [-0.3, -0.2, -0.9]] },
  // the board held out at arm's length off the back hand, the other arm spread the other way, legs together: a cross
  'Christ Air': { body: { hipX: 0.5, hipY: -0.14, hipZ: 0.02, lean: 0.0, pYaw: 0.0, cYaw: 0.02, side: 0.0, lx: 0.62, ly: 0.12, lz: 0.0, curl: 0.15 }, hand: [null, [0.16, 0.0, -0.1]],
    epole: [null, [0, 0.4, 1]], f: [0.58, -1.0, 0.03, 0.1, 0.8], b: [0.45, -1.01, -0.02, -0.05, 0.8] },
  'Tailwalk': { body: { hipY: 0.6, lean: 0.22, cYaw: 0.25, lx: 0.36, ly: 0.05, lz: 0.12 }, hand: [null, [-0.38, 0.02, 0.0]],
    f: (t) => [0.14 + 0.26 * Math.sin(t * 8), -0.08 + 0.1 * Math.cos(t * 8), -0.22, 1.0, 0.5],
    b: (t) => [-0.14 - 0.26 * Math.sin(t * 8), -0.08 - 0.1 * Math.cos(t * 8), -0.26, 0.8, 0.5] },
  'Airwalk': { body: { hipY: 0.55, lean: 0.25, pYaw: 0.95, cYaw: 1.05, hipX: 0.04, rx: -0.42, ry: 0.1, rz: 0.05 }, hand: [[0.37, 0.02, 0.0], null],
    f: [0.72, -0.26, 0.2, 1.4, 0.7], b: [-0.66, 0.06, -0.14, 1.3, 0.8] },
  'Judo': { body: { hipY: 0.5, lean: 0.4, cYaw: 0.55, pYaw: 0.35, rx: -0.4, ry: 0.15, rz: -0.05 }, hand: [[0.24, 0.0, -0.105], null],
    f: [0.62, 0.2, 0.36, 1.2, 0.7] },
  'Benihana': { body: { hipY: 0.5, lean: 0.5, cYaw: 0.45, rx: -0.3, ry: 0.2, rz: 0.1 }, hand: [[0.14, 0.0, -0.105], null],
    b: [-0.6, -0.5, -0.08, -0.3, 0.9] },
  'Madonna': { body: { hipY: 0.5, lean: 0.35, cYaw: 0.6, pYaw: 0.4, rx: -0.38, ry: 0.22, rz: 0.0 }, hand: [[0.36, 0.02, 0.06], null],
    f: [-0.3, -0.55, -0.26, 0.2, 0.9] },
};
const DECK = 0.087;                                       // top of the deck above the ground
const deckY = (x) => { const k = Math.min(0.17, Math.max(0, Math.abs(x) - 0.25));   // past the nose/tail it stays at the tip's height
  return DECK + k * k * (x > 0 ? 5.6 : 4.8); };
const HOVER = 0.17, RETURN = 0.26;
const FLIP_PIVOT = 0.06;
// falls: the point of the body (above the feet, standing) that rides physics' body ball; where physics' board ball sits above our
// board's wheel contact; points on the board that can touch the ground (wheels, nose, tail, deck edges, grip)
const BAIL_C = 0.95, BOARD_C = 0.06;
const BOARD_PTS = [[0.11, 0, 0.205], [-0.11, 0, 0.205], [0.11, 0, -0.205], [-0.11, 0, -0.205], [0.11, 0.054, 0.205], [-0.11, 0.054, 0.205], [0.11, 0.054, -0.205], [-0.11, 0.054, -0.205],
  [0, 0.215, 0.4], [0, 0.2, -0.4], [0.103, 0.08, 0.2], [-0.103, 0.08, 0.2], [0.103, 0.08, -0.2], [-0.103, 0.08, -0.2], [0, 0.09, 0]].map(([x, y, z]) => new THREE.Vector3(x, y, z));
const _g0 = new THREE.Vector3(), _g1 = new THREE.Vector3(), _mb = new THREE.Matrix4(), _mi = new THREE.Matrix4();                                  // height of the board's middle, what it flips around                        // push: how long the foot waits for the next stroke, then how long it takes to step back on


// ── OUTFITS: whole looks. Pick one with `outfit` in tweaks.js (or add ?outfit=tee to the address). ──
// top: 'hoodie' | 'crew' | 'tee'   hat: 'none' | 'beanie' | 'cap' | 'capback'   print: 'sun' | 'wave' | 'none' (the chest graphic)
// shoes: [upper, sole, laces]. Every colour is a normal web colour: '#ff0000' is red. Copy a line to make your own.
export const OUTFITS = {
  // fit: 'shell' = the ski cut (gear.js fitSkiClothes): an oversized shell jacket to the thighs (top_ body, top2 shoulders + hood) and baggy pants over the boots
  skier:  { top: 'hoodie', fit: 'shell', top_: '#3a5c6b', top2: '#1f2328', print: 'none', ink: '#f1ead8', hat: 'beanie', hatC: '#e7b33c', pants: '#c4b18a', shoes: ['#202024', '#efe8d8', '#efe8d8'], hair: '#3f2a1c' },
  hoodie: { top: 'hoodie', top_: '#56604a', print: 'sun',  ink: '#f1ead8', hat: 'none',    hatC: '#1c1c1c', pants: '#25272c', shoes: ['#202024', '#efe8d8', '#efe8d8'], hair: '#ffffff' },
  crew:   { top: 'crew',   top_: '#b3261e', print: 'none', ink: '#ffffff', hat: 'beanie',  hatC: '#1c1c1c', pants: '#2b2f3a', shoes: ['#e9e4d6', '#efe8d8', '#e9e4d6'] },
  tee:    { top: 'tee',    top_: '#ebe5d6', print: 'wave', ink: '#1f3b63', hat: 'capback', hatC: '#1f3b63', hatC2: '#ebe5d6', pants: '#8f7c5a', shoes: ['#2a3550', '#f2ede2', '#f2ede2'] },
  night:  { top: 'hoodie', top_: '#1e2129', print: 'wave', ink: '#e7b33c', hat: 'beanie',  hatC: '#e7b33c', pants: '#3d4b5f', shoes: ['#6e2a22', '#efe8d8', '#efe8d8'] },
  sunday: { top: 'crew',   top_: '#2f5d8a', print: 'sun',  ink: '#f4d35e', hat: 'cap',     hatC: '#141414', hatC2: '#f4d35e', pants: '#1b1c20', shoes: ['#141414', '#141414', '#ffffff'] },
};
// ── the shoulders, narrowed at load (the MakeHuman build reads as a broad-shouldered adult; he is a lean young skater) ──
// Every skinned part shares one bind space and one skeleton, so the same warp is applied to all of them and to the bones:
// each arm slides in toward the spine by (1 - width) of the shoulder joint's distance from it, carried rigidly by the arm's
// own skin weights; the top of the chest, the trapezius and the deltoid ease in with it, fading out above the neck base and
// below the armpit. `fit` < 1 also takes the slack out of the sleeves and the sweater's shoulder (pulled toward the arm
// bone), where the chunky knit sat ~10 cm off the body. 1 / 1 = the model as built.
function narrowShoulders(parts, width, fit) {
  const sk = parts.Human && parts.Human.skeleton; if (!sk || (width === 1 && fit === 1)) return;
  const idx = (n) => sk.bones.findIndex((b) => b.name === n), bind = (n) => sk.boneInverses[idx(n)].clone().invert();
  const at = (n) => V().setFromMatrixPosition(bind(n));
  const sides = ['_l', '_r'].map((sfx) => {
    const sh = at('upperarm' + sfx), el = at('lowerarm' + sfx), sign = Math.sign(sh.x), arm = new Set();
    const ua = sk.bones[idx('upperarm' + sfx)]; ua.traverse((b) => arm.add(sk.bones.indexOf(b)));
    return { sfx, sh, el, sign, arm, ua, d: V(-sign * (1 - width) * Math.abs(sh.x), 0, 0) };
  });
  const S = sides[0].sh, y0 = S.y, xs = Math.abs(S.x);
  const done = new Set(), v = V(), seg = V(), q = V();
  for (const o of Object.values(parts)) {
    const g = o.geometry, P = g.attributes.position, SI = g.attributes.skinIndex, SW = g.attributes.skinWeight;
    if (!o.isSkinnedMesh || !SI || done.has(g)) continue; done.add(g);
    const cloth = /sweater|hood|tee/.test(o.name);
    for (let i = 0; i < P.count; i++) {
      v.fromBufferAttribute(P, i); const sd = sides[v.x * sides[0].sign >= 0 ? 0 : 1], ax = Math.abs(v.x);
      let aw = 0; for (let k = 0; k < 4; k++) if (sd.arm.has(SI.getComponent(i, k))) aw += SW.getComponent(i, k);
      const geo = smooth((ax - 0.04) / (xs - 0.04)) * smooth((v.y - (y0 - 0.17)) / 0.11) * (1 - smooth((v.y - (y0 + 0.04)) / 0.07));
      const f = Math.max(aw, geo);
      seg.subVectors(sd.el, sd.sh); const L = seg.length(); seg.divideScalar(L); const tr = v.clone().sub(sd.sh).dot(seg) / L;
      if (cloth && fit < 1 && aw > 0.01 && tr < 1) {   // take in the slack: toward the upper-arm bone (not the forearm), most at the shoulder
        const t = Math.max(0, tr); q.copy(sd.sh).addScaledVector(seg, t * L);
        const off = v.clone().sub(q), r = off.length(), keep = lerp(1, fit, aw * (1 - smooth((t - 0.5) / 0.5) * 0.6));
        if (r > 0.05) v.copy(q).addScaledVector(off, (0.05 + (r - 0.05) * keep) / r);
      }
      v.addScaledVector(sd.d, f); P.setXYZ(i, v.x, v.y, v.z);
    }
    P.needsUpdate = true; g.computeBoundingBox(); g.computeBoundingSphere();
  }
  // the skeleton: the arm bones move with the mesh, so the skin binds exactly as before
  const T4 = new THREE.Matrix4();
  for (const sd of sides) {
    const pc = bind('clavicle' + sd.sfx).invert(), a = sd.sh.clone().applyMatrix4(pc), b = sd.sh.clone().add(sd.d).applyMatrix4(pc);
    sd.ua.position.add(b.sub(a));
    T4.makeTranslation(-sd.d.x, -sd.d.y, -sd.d.z);
    for (const bi of sd.arm) sk.boneInverses[bi].multiply(T4);
  }
}

// ── the Skater screen (customize.js) mixes and matches these slots; a named outfit above is just a starting point ──
// bottom: 'pants' | 'shorts'   socks: 'none' or a colour (shorts only; the shoes stay on)
export const SLOTS = {
  top: ['hoodie', 'crew', 'tee'], print: ['none', 'sun', 'wave'], bottom: ['pants', 'shorts'], hat: ['none', 'beanie', 'cap', 'capback'],
  topC: ['#ebe5d6', '#1e2129', '#56604a', '#b3261e', '#2f5d8a', '#e7b33c', '#c96a8a', '#6a4c93', '#3f8f7a', '#e2733a'],
  bottomC: ['#25272c', '#2b2f3a', '#3d4b5f', '#8f7c5a', '#5d6b4a', '#b8b2a4', '#6e2a22', '#1f3b63'],
  hatC: ['#1c1c1c', '#ebe5d6', '#b3261e', '#1f3b63', '#e7b33c', '#56604a', '#c96a8a', '#3f8f7a'],
  socks: ['none', '#f2efe6', '#1c1c1c', '#b3261e', '#2f5d8a'],
  skin: ['#f1c9a5', '#e0ac85', '#c99570', '#a8734f', '#8a5a3c', '#5e3b26'],
  hair: ['#3f2a1c', '#1a1410', '#6b4a2e', '#a77c4f', '#d9b98a', '#9b3b22', '#2a2a2e', '#d8d4cc'],
};
// the look, as plain slots: from a named outfit (+ the colour tweaks), or the saved one from the Skater screen
export function presetLook(name) {
  const o = OUTFITS[name] || OUTFITS.hoodie, base = OUTFITS[name] ? name : 'hoodie';
  return { preset: base, top: o.top, topC: T.hoodieColor || o.top_, print: o.print, ink: o.ink, bottom: o.bottom || 'pants', bottomC: T.pantsColor || o.pants,
    socks: o.socks || '#f2efe6', hat: o.hat, hatC: T.beanieColor || o.hatC, hatC2: o.hatC2 || '', skin: T.skinColor || o.skin || '#c99570',
    hair: o.hair && o.hair !== '#ffffff' ? o.hair : '#3f2a1c', shoes: o.shoes, fit: o.fit || '', topC2: T.jacketColor2 || o.top2 || '' };
}
export const LOOK_KEY = 'ski-outfit';
// ?outfit= in the address wins, then what was picked on the Skater screen (until `outfit` in tweaks.js is changed), then the tweak
export function savedLook() {
  const url = new URLSearchParams(location.search).get('outfit');
  if (url) return presetLook(url);
  try { const s = JSON.parse(localStorage.getItem(LOOK_KEY) || 'null'); if (s && s.from === T.outfit && s.look) return { ...presetLook(s.look.preset), ...s.look }; } catch (e) { /* a bad save: fall through */ }
  return presetLook(T.outfit || 'hoodie');
}
// ── bare legs for shorts. The MakeHuman body was built with everything under the trousers cut away (it stops mid-thigh), so the
// shins are made here at load, the same way narrowShoulders works: the trouser legs, below mid-thigh, pulled in round the leg
// bones to a real leg's shape (knee, calf muscle at the back, slim ankle). They keep the trousers' skin weights, so they bend
// exactly as the trousers did, and stay inside the shorts and the shoes. (tools/build_skater.py's inputs are gone; see README.)
function shortsLegs(parts) {
  const pa = parts.pants, sk = pa && pa.skeleton; if (!sk) return null;
  const at = (n) => V().setFromMatrixPosition(sk.boneInverses[sk.bones.findIndex((b) => b.name === n)].clone().invert());
  const legs = {};
  for (const sfx of ['_l', '_r']) { const hip = at('thigh' + sfx); legs[Math.sign(hip.x)] = { hip, knee: at('calf' + sfx), ank: at('foot' + sfx) }; }
  const src = pa.geometry, P = src.attributes.position, top = legs[1].knee.y + 0.13;
  const g = new THREE.BufferGeometry();
  for (const k of ['position', 'skinIndex', 'skinWeight']) g.setAttribute(k, src.attributes[k].clone());
  const idx = src.index ? src.index.array : [...Array(P.count).keys()], keep = [];
  for (let i = 0; i < idx.length; i += 3) if ([0, 1, 2].every((j) => P.getY(idx[i + j]) < top)) keep.push(idx[i], idx[i + 1], idx[i + 2]);
  g.setIndex(keep);
  const gm = mergeVertices(g, 1e-5), Q2 = gm.attributes.position, v = V(), c = V();
  for (let i = 0; i < Q2.count; i++) {
    v.fromBufferAttribute(Q2, i); const L = legs[v.x >= 0 ? 1 : -1] || legs[1];
    if (v.y >= L.knee.y) c.lerpVectors(L.knee, L.hip, Math.min(1, (v.y - L.knee.y) / (L.hip.y - L.knee.y)));
    else c.lerpVectors(L.ank, L.knee, Math.max(0, (v.y - L.ank.y) / (L.knee.y - L.ank.y)));
    const dx = v.x - c.x, dz = v.z - c.z, rl = Math.hypot(dx, dz); if (rl < 1e-5) continue;
    const ux = dx / rl, uz = dz / rl, s = L.knee.y - v.y;      // s = metres below the knee
    const back = Math.max(0, -uz), front = Math.max(0, uz), out = Math.abs(ux);
    // radius round the bone: thigh, knee, calf (fullest ~11 cm below the knee, mostly at the back), ankle
    let r = s < 0 ? lerp(0.05, 0.06, smooth(-s / 0.12)) : s < 0.11 ? lerp(0.05, 0.047, s / 0.11) : lerp(0.047, 0.032, smooth((s - 0.11) / 0.3));
    r += back * 0.016 * Math.exp(-(((s - 0.12) / 0.09) ** 2)) + out * 0.004 * Math.exp(-(((s - 0.1) / 0.1) ** 2));
    r -= front * 0.006 * smooth((s - 0.05) / 0.2);           // the shin is flatter than the calf
    const cz = c.z + (s > 0 ? 0.008 : 0);                      // the leg sits a touch forward of the bone line below the knee
    Q2.setXYZ(i, c.x + ux * r, v.y, cz + uz * r);
  }
  gm.computeVertexNormals(); gm.computeBoundingBox(); gm.computeBoundingSphere();
  const m = new THREE.SkinnedMesh(gm, new THREE.MeshPhysicalMaterial()); m.name = 'skin_legs'; m.bind(sk, pa.bindMatrix);
  m.position.copy(pa.position); m.quaternion.copy(pa.quaternion); m.scale.copy(pa.scale); pa.parent.add(m);
  return m;
}
// the shorts' hem: the cargo trousers crease at the knee, and a straight cut through creases reads as torn cloth. So round
// the leg below `hem + 8 cm` is eased onto a clean tube (a touch roomier at the front, like a real pair of shorts), and the
// cut (the shorts shader) goes through that smooth tube.
function shortsHem(pa, hemY) {
  const sk = pa.skeleton, at = (n) => V().setFromMatrixPosition(sk.boneInverses[sk.bones.findIndex((b) => b.name === n)].clone().invert());
  const legs = {}; for (const sfx of ['_l', '_r']) { const hip = at('thigh' + sfx); legs[Math.sign(hip.x)] = { hip, knee: at('calf' + sfx), ank: at('foot' + sfx) }; }
  const P = pa.geometry.attributes.position, v = V(), c = V(), band = 0.08;
  for (let i = 0; i < P.count; i++) {
    v.fromBufferAttribute(P, i); if (v.y > hemY + band) continue;
    const L = legs[v.x >= 0 ? 1 : -1] || legs[1];
    if (v.y >= L.knee.y) c.lerpVectors(L.knee, L.hip, Math.min(1, (v.y - L.knee.y) / (L.hip.y - L.knee.y)));
    else c.lerpVectors(L.ank, L.knee, Math.max(0, (v.y - L.ank.y) / (L.knee.y - L.ank.y)));
    const dx = v.x - c.x, dz = v.z - c.z, rl = Math.hypot(dx, dz); if (rl < 1e-5) continue;
    const ux = dx / rl, uz = dz / rl, f = smooth((hemY + band - v.y) / band), want = 0.08 + 0.006 * Math.max(0, uz);
    const r = lerp(rl, want, f);
    P.setXYZ(i, c.x + ux * r, v.y, c.z + uz * r);
  }
  P.needsUpdate = true; pa.geometry.computeVertexNormals();
}
function outfitNow(look) {
  const L = look || savedLook();
  return { ...L, top_: L.topC, pants: L.bottomC };
}
// Adds bits of GLSL to a three.js material: `lag` runs after skinning (moves `transformed`), `frag` after the colour map (changes diffuseColor).
// vBind / vBindN = the vertex's place and facing on the model at rest, so paint can go where it belongs whatever the UVs are.
function look(m, { U, key, lag = '', frag = '', pre = '', nrm = '', skin = false, bv = '', vdecl = '', lit = '' }) {
  const decl = 'varying vec3 vBind; varying vec3 vBindN; uniform float uMirror; uniform vec3 uLagA, uLagB, uLagT, uLagH; uniform sampler2D uPrint;';
  m.onBeforeCompile = (sh) => {
    m.userData.shader = sh;
    for (const k in U) sh.uniforms[k] = U[k];
    if (!sh.uniforms.uPrint) sh.uniforms.uPrint = { value: null };
    sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\n' + decl + vdecl)
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvBind = position; vBindN = normal;' + bv)
      .replace('#include <skinning_vertex>', '#include <skinning_vertex>\n' + lag);
    sh.fragmentShader = sh.fragmentShader.replace('#include <common>', '#include <common>\n' + decl + `
      float hash2(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
      float vnoise(vec2 p) { vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
        return mix(mix(hash2(i), hash2(i + vec2(1, 0)), f.x), mix(hash2(i + vec2(0, 1)), hash2(i + vec2(1, 1)), f.x), f.y); }` + pre)
      .replace('#include <map_fragment>', '#include <map_fragment>\n' + frag)
      .replace('#include <normal_fragment_maps>', '#include <normal_fragment_maps>\n' + nrm)
      .replace('#include <lights_physical_fragment>', '#include <lights_physical_fragment>\n' + lit);
    if (skin) {                                   // skin: light soaks round the shadow edge, reddest first (wrap lighting, a cheap stand-in for subsurface scattering)
      const A = 'reflectedLight.directDiffuse += irradiance * BRDF_Lambert( material.diffuseContribution ) * ( 1.0 - F );';
      const chunk = THREE.ShaderChunk.lights_physical_pars_fragment;
      if (!chunk.includes(A)) console.error('skater: skin wrap-lighting hook not found in this three.js version');
      sh.fragmentShader = sh.fragmentShader.replace('#include <lights_physical_pars_fragment>', chunk.replace(A,
        `{ vec3 wr = vec3(0.5, 0.24, 0.16); float nl = dot(geometryNormal, directLight.direction);
           vec3 wi = clamp((vec3(nl) + wr) / (1.0 + wr), 0.0, 1.0); wi *= wi * (3.0 - 2.0 * wi) * 0.35 + 0.65 * wi;
           reflectedLight.directDiffuse += wi * directLight.color * BRDF_Lambert( material.diffuseContribution ) * ( 1.0 - F ); }`));
    }
  };
  // the colours are baked into the GLSL, so the cache key carries a hash of it: a re-dressed skater gets fresh programs
  let hh = 0; for (const s of [lag, frag, pre, nrm, bv, vdecl, lit]) for (let i = 0; i < s.length; i++) hh = (hh * 31 + s.charCodeAt(i)) | 0;
  m.customProgramCacheKey = () => 'sk-' + key + (skin ? 'S' : '') + hh;
}
// Cloth folds: a height field painted by position on the body at rest, turned into a bumped normal (screen-space derivatives,
// Mikkelsen 2010). Sleeves bunch at the cuff and crease at the elbow, the sweatshirt gathers above its hem, trousers stack on the shoe.
const FOLD_PRE = `
  uniform vec3 uSh, uEl, uWr, uKn, uAn; uniform float uHem, uFold;
  float segT(vec3 p, vec3 a, vec3 b) { vec3 ab = b - a; return clamp(dot(p - a, ab) / dot(ab, ab), 0.0, 1.0); }
  float rings(float s, float wl, float ph) { float x = sin((s / wl + ph) * 6.2832); return x * (0.75 + 0.25 * x * x); }
  vec3 foldNormal(vec3 n, float h, float fd) {
    vec3 p = -vViewPosition, dpx = dFdx(p), dpy = dFdy(p); float lx = max(length(dpx), 1e-6), ly = max(length(dpy), 1e-6);
    vec3 sx = dpx / lx, sy = dpy / ly, r1 = cross(sy, n), r2 = cross(n, sx); float det = dot(sx, r1) * fd;
    vec3 g = sign(det) * (dFdx(h) / lx * r1 + dFdy(h) / ly * r2);
    return normalize(abs(det) * n - g * uFold);
  }`;
const FOLD_TOP = `{
    vec3 p = vBind; vec3 q = vec3(abs(p.x), p.y, p.z); float h = 0.0;
    float t1 = segT(q, uSh, uEl), t2 = segT(q, uEl, uWr), w = vnoise(vec2(atan(p.z - uWr.z, p.y - uWr.y) * 3.0, q.x * 20.0));
    float arm = smoothstep(uSh.x - 0.02, uSh.x + 0.05, q.x);
    float fl = length(uWr - uEl), ul = length(uEl - uSh);
    h += arm * smoothstep(0.35, 0.95, t2) * 0.0035 * rings(t2 * fl, 0.036, w * 1.6);                 // cuff bunching
    h += arm * (1.0 - smoothstep(0.0, 0.3, t2)) * smoothstep(0.7, 1.0, t1) * 0.003 * rings(t1 * ul + t2 * fl, 0.055, w);   // elbow creases
    float hem = smoothstep(uHem + 0.22, uHem + 0.07, p.y) * step(p.y, uHem + 0.22) * (1.0 - arm);
    h += hem * 0.002 * rings(p.y, 0.06, 0.0);                                                         // gathered above the hem
    h += (1.0 - arm) * smoothstep(0.08, 0.16, abs(p.x)) * 0.003 * rings(p.y * 0.8 - abs(p.x) * 0.9, 0.07, w); // drape pulling from the armpits
    normal = foldNormal(normal, h, faceDirection); }`;
const FOLD_PANTS = `{
    vec3 p = vBind; vec3 q = vec3(abs(p.x), p.y, p.z); float h = 0.0, w = vnoise(vec2(atan(p.z - uKn.z, q.x - uKn.x) * 3.0, p.y * 9.0));
    h += smoothstep(uAn.y + 0.32, uAn.y + 0.08, p.y) * 0.007 * rings(p.y + 0.02 * sin(atan(p.z, q.x - uAn.x) * 3.0), 0.045, w * 1.5);   // stacked on the shoe
    float kn = 1.0 - smoothstep(0.03, 0.12, abs(p.y - uKn.y));
    h += kn * step(p.z, uKn.z + 0.01) * 0.004 * rings(p.y, 0.035, w);                                // behind the knee
    h += smoothstep(uKn.y + 0.05, uKn.y + 0.25, p.y) * 0.0025 * rings(p.y + q.x * 0.6, 0.08, w);    // thigh drape
    normal = foldNormal(normal, h, faceDirection); }`;
const glc = (c) => { const k = new THREE.Color(c); return `vec3(${k.r.toFixed(4)}, ${k.g.toFixed(4)}, ${k.b.toFixed(4)})`; };
const f3 = (x) => x.toFixed(4);
// Eyes, painted by direction from each eyeball's centre (no UVs needed): a fibrous iris with a dark limbal ring and a
// pupil, a not-quite-white sclera that pinks toward the corners, the upper lid's shadow across the top, and the lid itself
// sliding down over the ball when he blinks. uGaze turns the iris (the eyes lead the head and flick about, never a fixed stare).
const EYE_PRE = `
  uniform vec3 uEyeA, uEyeB, uGaze, uLidC, uIrisA, uIrisB; uniform float uBlink, uLidTop, uLidBot;
  float gLid = 0.0;`;
const EYE_FRAG = `{
    vec3 ce = vBind.x > 0.0 ? uEyeA : uEyeB, d = normalize(vBind - ce), g = normalize(uGaze);
    vec3 gx = normalize(cross(vec3(0.0, 1.0, 0.0), g)), gy = cross(g, gx);
    float a = acos(clamp(dot(d, g), -1.0, 1.0)), r = a / 0.5, th = atan(dot(d, gy), dot(d, gx));
    float fib = vnoise(vec2(th * 18.0, r * 2.5)) * 0.6 + vnoise(vec2(th * 47.0, r * 6.0)) * 0.4;
    vec3 iris = mix(uIrisA, uIrisB, smoothstep(0.25, 0.85, r)) * (0.6 + 0.75 * fib);
    iris = mix(iris, uIrisA * 1.5, (1.0 - smoothstep(0.0, 0.08, abs(r - 0.48))) * 0.35 * fib);        // the collarette round the pupil
    iris *= 1.0 - 0.75 * smoothstep(0.72, 1.0, r);                                                    // limbal ring
    float pr = 0.36 + 0.03 * sin(uBlink * 3.0);
    iris = mix(iris, vec3(0.012), 1.0 - smoothstep(pr - 0.04, pr + 0.02, r));
    float side = abs(d.x);
    vec3 scl = vec3(0.80, 0.77, 0.73) * (0.94 + 0.06 * vnoise(vec2(th * 9.0, a * 7.0)));
    scl = mix(scl, vec3(0.78, 0.55, 0.5), smoothstep(0.55, 0.95, side) * 0.55);
    scl = mix(scl, vec3(0.62, 0.3, 0.28), smoothstep(0.82, 1.0, vnoise(vec2(th * 30.0, a * 22.0))) * smoothstep(0.7, 1.4, r) * 0.25);   // faint vessels
    vec3 c = mix(iris, scl, smoothstep(0.96, 1.04, r));
    float el = atan(d.y, d.z);
    c *= 1.0 - 0.6 * smoothstep(uLidTop - 0.45, uLidTop + 0.05, el) - 0.25 * smoothstep(uLidBot + 0.25, uLidBot - 0.1, el);   // the lids shade the ball
    float edge = mix(uLidTop + 0.3, uLidBot - 0.18, uBlink);
    gLid = smoothstep(edge - 0.03, edge + 0.03, el) * step(0.02, uBlink);
    c = mix(c, uLidC * (0.55 + 0.45 * smoothstep(edge, edge + 0.3, el)), gLid);
    diffuseColor.rgb = c; }`;
const EYE_LIT = `material.clearcoat *= 1.0 - gLid; material.roughness = mix(material.roughness, 0.6, gLid);`;
// upper lashes ride the lid down over the eyeball (a turn about the eye's centre)
const LASH_V = `{ vec3 ce = position.x > 0.0 ? uEyeA : uEyeB, q = transformed - ce;
    if (q.y > -0.002 && q.z > -0.004) { float ang = min(0.0, mix(0.3, uLidBot - uLidTop - 0.18, uBlink)) * smoothstep(-0.002, 0.003, q.y), cs = cos(ang), sn = sin(ang);
      transformed = ce + vec3(q.x, q.y * cs - q.z * sn, q.y * sn + q.z * cs); } }`;
const LASH_VD = 'uniform vec3 uEyeA, uEyeB; uniform float uBlink, uLidTop, uLidBot;';
// sweatshirt / hoodie / tee: ribbed hem, kangaroo pocket on the hoodie, chest print
function torsoGLSL(hem, top, pocket, print, tee) {
  const chest = top - 0.2;
  return `{
    vec3 c = diffuseColor.rgb; float front = smoothstep(0.15, 0.45, vBindN.z) * step(0.0, vBind.z);
    ${tee ? '' : `float rib = 1.0 - smoothstep(${f3(hem + 0.05)}, ${f3(hem + 0.058)}, vBind.y);
    c *= 1.0 - rib * (0.1 + 0.08 * sin(atan(vBind.x, vBind.z) * 90.0));`}
    ${pocket ? `float py = vBind.y - ${f3(hem + 0.07)}, pw = 0.125 - py * 0.22;
    float inP = step(0.0, py) * step(py, 0.15) * step(abs(vBind.x), pw) * front;
    float edge = inP * (1.0 - smoothstep(0.004, 0.009, min(min(py, 0.15 - py), pw - abs(vBind.x))));
    float mouth = step(0.0, py) * step(py, 0.13) * front * (1.0 - smoothstep(0.0, 0.01, abs(abs(vBind.x) - pw)));
    c *= 1.0 - 0.18 * edge - 0.35 * mouth - 0.04 * inP;` : ''}
    ${print ? `vec2 pu = vec2(0.5 + vBind.x * uMirror / 0.21, 0.5 + (vBind.y - ${f3(chest)}) / 0.21);
    if (front > 0.0 && pu.x > 0.0 && pu.x < 1.0 && pu.y > 0.0 && pu.y < 1.0) { vec4 ink = texture2D(uPrint, pu); c = mix(c, ink.rgb, ink.a * front * 0.94); }` : ''}
    diffuseColor.rgb = c; }`;
}
// ski shell jacket (fit: 'shell'): shoulder yoke + hood in the second colour with a piping line, a front zip under a storm
// flap, a chest pocket zip, hand-warmer pocket zips, side seams, a drawcord hem and velcro cuff tabs, all painted by position
function shellGLSL(hem, c2) {
  return `{
    vec3 c = diffuseColor.rgb, p = vBind; vec3 q = vec3(abs(p.x), p.y, p.z); float ax = q.x;
    float arm = smoothstep(uSh.x - 0.03, uSh.x + 0.04, ax), t1 = segT(q, uSh, uEl), t2 = segT(q, uEl, uWr);
    float front = smoothstep(0.05, 0.3, vBindN.z) * step(0.0, p.z);
    float yk = 0.5 - 0.1 * smoothstep(0.08, 0.2, ax);
    float yoke = mix(smoothstep(yk - 0.003, yk + 0.003, p.y), 1.0 - smoothstep(0.2, 0.23, t1), arm) * (1.0 - step(0.001, t2) * arm);
    c = mix(c, ${glc(c2)}, yoke);
    float pip = mix(1.0 - smoothstep(0.0, 0.004, abs(p.y - yk)), 1.0 - smoothstep(0.0, 0.012, abs(t1 - 0.215)), arm) * (1.0 - step(0.001, t2) * arm);
    c = mix(c, vec3(0.92, 0.9, 0.85), pip * 0.8);
    float tor = 1.0 - arm;
    float zip = tor * front * (1.0 - smoothstep(0.0025, 0.0045, ax)) * step(${f3(hem + 0.01)}, p.y);
    float flap = tor * front * (1.0 - smoothstep(0.0, 0.003, abs(ax - 0.016)));
    c *= 1.0 - 0.55 * zip - 0.22 * flap;
    float cz = tor * front * step(0.02, p.x) * step(p.x, 0.13) * (1.0 - smoothstep(0.0015, 0.003, abs(p.y - 0.41 - (p.x - 0.02) * 0.45)));
    float hz = tor * front * step(${f3(hem + 0.07)}, p.y) * step(p.y, ${f3(hem + 0.24)}) * (1.0 - smoothstep(0.0015, 0.003, abs(ax - 0.105 - (p.y - ${f3(hem)}) * 0.18)));
    c *= 1.0 - 0.6 * (cz + hz);
    float seam = tor * (1.0 - smoothstep(0.0, 0.004, abs(p.z - 0.01 + 0.0 * p.y))) * smoothstep(0.12, 0.16, ax);
    c *= 1.0 - 0.18 * seam;
    float hb = 1.0 - smoothstep(0.018, 0.022, p.y - ${f3(hem)}); c *= 1.0 - 0.16 * hb * tor;
    c *= 1.0 - 0.3 * (1.0 - smoothstep(0.0, 0.003, abs(p.y - ${f3(hem + 0.02)}))) * tor;
    float cuff = arm * smoothstep(0.86, 0.9, t2); c = mix(c, ${glc(c2)}, cuff * 0.85);
    if (!gl_FrontFacing) c *= 0.4;
    diffuseColor.rgb = c; }`;
}
// skate shoe painted by position: vulcanised sole with a foxing stripe, suede toe cap, laces, padded collar, wear
function shoeGLSL(soleY, heelZ, toeZ, midX, topY, cols) {
  return `{
    float hh = vBind.y - ${f3(soleY)}, aa = (vBind.z - ${f3(heelZ)}) / ${f3(toeZ - heelZ)}, sx = abs(vBind.x) - ${f3(midX)};
    float side = sx * sign(vBind.x);
    vec3 up = ${glc(cols[0])}, sole = ${glc(cols[1])}, lace = ${glc(cols[2] || cols[1])};
    float n = vnoise(vec2(aa * 90.0, hh * 400.0 + sx * 300.0)) * 0.5 + vnoise(vec2(aa * 300.0, hh * 900.0)) * 0.5;
    vec3 c = up * (0.9 + 0.2 * n);
    float capM = smoothstep(0.69, 0.7, aa) + (1.0 - smoothstep(0.17, 0.18, aa)) * step(hh, 0.07);
    c = mix(c, up * (0.78 + 0.25 * n), clamp(capM, 0.0, 1.0));
    float stitch = (1.0 - smoothstep(0.0, 0.003, abs(aa - 0.697))) + (1.0 - smoothstep(0.0, 0.003, abs(aa - 0.183))) * step(hh, 0.07);
    c *= 1.0 - 0.3 * stitch * step(fract(aa * 260.0 + hh * 200.0), 0.6);
    float topF = smoothstep(0.35, 0.75, vBindN.y) * step(0.3, aa) * step(aa, 0.68);
    float strip = 1.0 - smoothstep(0.014, 0.02, abs(sx + 0.002));
    float bar = 1.0 - smoothstep(0.22, 0.34, abs(fract(aa * 17.0) - 0.5));
    float eyestay = (1.0 - smoothstep(0.019, 0.024, abs(sx + 0.002))) * (1.0 - strip);
    c = mix(c, up * 0.65, eyestay * topF * 0.6);
    c = mix(c, lace * (0.85 + 0.15 * n), strip * bar * topF);
    c = mix(c, up * 0.5, strip * (1.0 - bar) * topF * 0.7);
    float collar = smoothstep(${f3(topY - soleY - 0.035)}, ${f3(topY - soleY - 0.02)}, hh) * (1.0 - smoothstep(0.45, 0.6, aa));
    c = mix(c, up * 0.55, collar);
    float soleH = 0.026 + 0.008 * smoothstep(0.75, 1.0, aa);
    float sm = 1.0 - smoothstep(soleH - 0.0015, soleH + 0.0005, hh);
    vec3 sc = sole * (0.93 + 0.07 * n);
    sc *= 1.0 - 0.55 * (1.0 - smoothstep(0.0012, 0.0024, abs(hh - soleH * 0.55))) * smoothstep(0.03, 0.97, aa);
    sc = mix(sc, sole * vec3(0.55, 0.5, 0.45), (1.0 - smoothstep(0.0, 0.005, hh)) * 0.8);
    c = mix(c, sc, sm);
    float scuff = smoothstep(0.55, 0.95, aa) * smoothstep(-0.005, 0.02, side) * smoothstep(0.015, 0.04, hh) * step(hh, 0.08) * smoothstep(0.45, 0.75, vnoise(vec2(aa * 30.0, hh * 60.0)));
    c = mix(c, mix(up, vec3(0.8, 0.77, 0.7), 0.55), scuff * 0.85);
    c *= 0.75 + 0.25 * smoothstep(0.0, 0.05, hh + 0.01);
    diffuseColor.rgb = c; }`;
}
// cap: six panels with stitched seams, eyelets, a contrast button and bill
function capGLSL(c2) {
  return `{
    vec3 c = diffuseColor.rgb;
    if (vUv.x > 1.5) { c = mix(c * 0.8, c, step(0.0, vBindN.y)); }
    else { float u = vUv.x * 1.5, vy = 1.0 - vUv.y; float seam = 1.0 - smoothstep(0.0, 0.02, abs(fract(u + 0.5) - 0.5)); c *= 1.0 - 0.28 * seam;
      float ey = 1.0 - smoothstep(0.012, 0.02, length(vec2((fract(u) - 0.5) * 2.5, vy + 0.075) * vec2(1.0, 3.0)));
      c = mix(c, c * 0.35, ey); c = mix(c, ${glc(c2)}, step(-0.004, vy)); }
    diffuseColor.rgb = c; }`;
}
// the strands drawn onto the hair cards: 8 clumps side by side, root at the top (v = 1), each a fan of fine hairs that
// thin out and fade toward their tips, denser in the middle of the card so its edges never show. Greyscale: the material tints it.
function hairTexture() {
  const W = 1024, H = 512, c = document.createElement('canvas'); c.width = W; c.height = H; const g = c.getContext('2d');
  let sd = 31; const r = () => { sd = (sd * 16807) % 2147483647; return sd / 2147483647; };
  g.lineCap = 'round';
  for (let col = 0; col < 8; col++) {
    const x0 = col * 128, n = 70 + (r() * 40 | 0), bend = (r() - 0.5) * 30;
    for (let k = 0; k < n; k++) {
      const u = (r() + r() + r()) / 3, x = x0 + 8 + u * 112, len = H * (0.55 + 0.45 * r()) * (1 - 0.5 * Math.abs(u - 0.5)), wv = (r() - 0.5) * 14;
      const v = 0.55 + 0.45 * r(), steps = 14;
      for (let i = 0; i < steps; i++) {
        const a = i / steps, b = (i + 1) / steps, ya = a * len, yb = b * len;
        const xa = x + bend * a * a + wv * Math.sin(a * 3.1), xb = x + bend * b * b + wv * Math.sin(b * 3.1);
        const al = (1 - Math.pow(a, 2.2)) * (0.55 + 0.45 * (1 - Math.abs(u - 0.5) * 2)), l = (v * (0.7 + 0.2 * a)) * 255 | 0;
        g.strokeStyle = `rgba(${l},${l},${l},${al.toFixed(3)})`; g.lineWidth = (1.1 + 1.6 * r()) * (1 - 0.6 * a);
        g.beginPath(); g.moveTo(xa, ya); g.lineTo(xb, yb); g.stroke();
      }
    }
  }
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 8; t.flipY = false; t.generateMipmaps = true; return t;
}
// the chest print: original artwork drawn here, with the game's name round it
function printTexture(kind, ink) {
  const c = document.createElement('canvas'); c.width = c.height = 512; const g = c.getContext('2d');
  g.fillStyle = g.strokeStyle = ink; g.lineCap = 'round'; g.lineJoin = 'round';
  const name = String(T.gameName || 'SKATE').toUpperCase();
  if (kind === 'sun') {
    g.lineWidth = 16; g.beginPath(); g.arc(256, 250, 118, 0, Math.PI * 2); g.stroke();
    g.beginPath(); g.arc(256, 250, 70, Math.PI, 0); g.fill();
    for (let k = 0; k < 9; k++) { const a = Math.PI + (k + 0.5) * Math.PI / 9; g.lineWidth = 9; g.beginPath(); g.moveTo(256 + Math.cos(a) * 84, 250 + Math.sin(a) * 84); g.lineTo(256 + Math.cos(a) * (k % 2 ? 100 : 108), 250 + Math.sin(a) * (k % 2 ? 100 : 108)); g.stroke(); }
    g.lineWidth = 10; for (let k = 0; k < 3; k++) { g.beginPath(); for (let x = 156; x <= 356; x += 6) g.lineTo(x, 268 + k * 26 + Math.sin(x * 0.07 + k) * 7); g.stroke(); }
    g.font = 'bold 44px Arial Black, Arial, sans-serif'; g.textAlign = 'center';
    const words = name.split(' '), w = words.slice(0, 3).join(' ');
    g.save(); g.translate(256, 250); const R = 150, step = 0.155, a0 = -Math.PI / 2 - step * (w.length - 1) / 2;
    for (let i = 0; i < w.length; i++) { g.save(); g.rotate(a0 + i * step + Math.PI / 2); g.fillText(w[i], 0, -R); g.restore(); }
    g.restore();
  } else if (kind === 'wave') {
    g.lineWidth = 12; g.strokeRect(126, 120, 260, 200);
    for (let k = 0; k < 5; k++) { g.lineWidth = 10; g.beginPath(); for (let x = 140; x <= 372; x += 5) g.lineTo(x, 160 + k * 34 + Math.sin(x * 0.05 + k * 0.9) * 12); g.stroke(); }
    g.font = 'bold 40px Arial Black, Arial, sans-serif'; g.textAlign = 'center';
    const words = name.split(' '); g.fillText(words[0], 256, 378); if (words[1]) g.fillText(words.slice(1).join(' '), 256, 422);
  }
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 4; return t;
}

export class SkaterView {
  constructor(scene) {
    this.root = new THREE.Group(); scene.add(this.root);       // rider
    this.boardRoot = new THREE.Group(); scene.add(this.boardRoot); // board (stays behind on a bail)
    this.board = new THREE.Group(); this.boardRoot.add(this.board);   // tilts with manuals, grinds, slides (the feet ride this)
    this.flipper = new THREE.Group(); this.board.add(this.flipper);   // flips and shuvs, turning about the middle of the board
    this.deck = new THREE.Group(); this.deck.position.y = -FLIP_PIVOT; this.flipper.add(this.deck);
    this.buildBoard();

    this.body = new THREE.Group(); this.root.add(this.body);
    this.body.matrixAutoUpdate = false;
    this.P = { ...RIDE };
    this.visUp = V(0, 1, 0);
    this.rig = null;                                       // set once the model has loaded
    this.time = 0; this.comp = 0; this.compV = 0; this.steer = 0; this.pushW = 0; this.swing = 0; this.dip = 0;
    this.grabW = [0, 0]; this.reach = 0; this.look = V(1, 0, 0); this.headYaw = 0.9; this.prevFwd = V(); this.prevPos = V(); this.prevState = 'ground'; this.prevY = 0; this.vy = 0;
    this.push = { on: false, w: 0, since: 9, last: -1, L: 0.6, dir: 1, s0: V(), cur: V(), end: V(), pitch: 0 };
    this.bl = null; this.snap = true; this.last = null; this.shot = null;
    this.loadModel();
  }
  // the model file is loaded once and kept untouched as a template; each dressing works on a fresh copy of it (its own
  // geometry and materials, the textures shared), so a re-dress from the Skater screen is instant and never re-downloads
  loadModel(wear) {
    const n = this.loads = (this.loads || 0) + 1;
    const dress = () => {
      if (n !== this.loads) return;                       // a newer re-dress came in meanwhile: only the last one is put on
      this.loadsDone = n;
      const model = SkeletonUtils.clone(this.template);
      // the copy's parts share one skeleton with its own bind matrices, like the file's (narrowShoulders moves them for all parts at once)
      const skels = new Map(); this.template.traverse((o) => { if (o.isSkinnedMesh) skels.set(o.name, o.skeleton); });
      const shared = new Map();
      model.traverse((o) => { if (!o.isMesh) return; o.geometry = o.geometry.clone(); o.material = o.material.clone();
        if (o.isSkinnedMesh) { const src = skels.get(o.name); if (!shared.has(src)) { o.skeleton.boneInverses = o.skeleton.boneInverses.map((m) => m.clone()); shared.set(src, o.skeleton); } o.skeleton = shared.get(src); } });
      const old = this.model;
      try { this.setupRig(model, wear); } catch (e) { console.error('skater: could not dress him', e); return; }
      if (old) { this.body.remove(old); old.traverse((o) => { if (o.isMesh) o.geometry.dispose(); }); }
      this.dressed = (this.dressed || 0) + 1;
    };
    if (this.template) { setTimeout(dress, 0); return; }
    if (this.templateLoading) { this.templateLoading.push(dress); return; }
    this.templateLoading = [dress];
    new GLTFLoader().load('./assets/skater/skater.glb', (g) => { this.template = g.scene; this.template.updateMatrixWorld(true); const q = this.templateLoading; this.templateLoading = null; q.forEach((f) => f()); },
      undefined, (e) => console.error('skater model did not load', e));
  }
  // put on a new look in place (the Skater screen)
  redress(wear) { this.loadModel(wear); }
  get pendingDress() { return this.loads !== this.loadsDone; }

  // ── the model: pick the outfit's parts, dress them, measure the skeleton ──
  setupRig(model, wear) {
    const tl = new THREE.TextureLoader(), O = this.outfit = outfitNow(wear);
    const tex = (url, rep) => { const t = tl.load(url); t.wrapS = t.wrapT = THREE.RepeatWrapping; if (rep) t.repeat.set(rep, rep); return t; };
    const grey = (mat, keep) => {                         // keep the folds painted into a texture, throw away its colour
      const img = mat.map && mat.map.image; if (!img) return;
      const c = document.createElement('canvas'); c.width = img.width; c.height = img.height;
      const g = c.getContext('2d', { willReadFrequently: true }); g.drawImage(img, 0, 0);
      const d = g.getImageData(0, 0, c.width, c.height), p = d.data; let sum = 0, n = 0;
      for (let i = 0; i < p.length; i += 16) { sum += p[i] * 0.3 + p[i + 1] * 0.59 + p[i + 2] * 0.11; n++; }
      const mean = sum / n || 1;
      for (let i = 0; i < p.length; i += 4) { const l = (p[i] * 0.3 + p[i + 1] * 0.59 + p[i + 2] * 0.11) / mean; p[i] = p[i + 1] = p[i + 2] = clamp((1 + (l - 1) * keep) * 215, 0, 255); }
      g.putImageData(d, 0, 0);
      const t = new THREE.CanvasTexture(c); t.flipY = mat.map.flipY; t.colorSpace = THREE.SRGBColorSpace; t.wrapS = mat.map.wrapS; t.wrapT = mat.map.wrapT; t.anisotropy = 4;
      mat.map = t;
    };
    const average = (img) => {
      const c = document.createElement('canvas'); c.width = c.height = 32; const g = c.getContext('2d'); g.drawImage(img, 0, 0, 32, 32);
      const p = g.getImageData(0, 0, 32, 32).data; let r = 0, gg = 0, b = 0;
      for (let i = 0; i < p.length; i += 4) { r += p[i]; gg += p[i + 1]; b += p[i + 2]; }
      const n = p.length / 4; return new THREE.Color().setRGB(r / n / 255, gg / n / 255, b / n / 255, THREE.SRGBColorSpace);
    };
    const bbox = (o, f) => { const p = o.geometry.attributes.position, b = new THREE.Box3(), v = V(); for (let i = 0; i < p.count; i++) { v.fromBufferAttribute(p, i); if (!f || f(v)) b.expandByPoint(v); } return b; };
    const show = { sweater: O.top !== 'tee', hood: O.top === 'hoodie', tee: O.top === 'tee', skin_arms: O.top === 'tee',
      beanie: O.hat === 'beanie', cap: O.hat === 'cap', capback: O.hat === 'capback',
      hair_beanie: O.hat === 'beanie', hair_cap: O.hat === 'cap' || O.hat === 'capback', hair_full: O.hat === 'none' };
    const parts = {}; this.lagU = [];
    model.traverse((o) => { if (o.isMesh) parts[o.name] = o; });
    narrowShoulders(parts, T.shoulderWidth ?? 0.88, T.sleeveFit ?? 0.8);
    const shorts = O.bottom === 'shorts', shell = O.fit === 'shell' && O.top === 'hoodie' && !shorts;
    if (shell) fitSkiClothes(parts);
    if (shorts) { const lg = shortsLegs(parts); if (lg) parts.skin_legs = lg; else console.error('skater: could not make the legs for shorts'); }
    const fabric = (m, rep) => { const f = new THREE.MeshPhysicalMaterial({ name: m.name, roughness: 0.92, sheen: 0.3, sheenRoughness: 0.8, normalMap: tex('./assets/tex/jersey_nor.jpg', rep), normalScale: new THREE.Vector2(0.8, 0.8) }); return f; };
    const U = this.U = { uMirror: { value: 1 }, uLagA: { value: V() }, uLagB: { value: V() }, uLagT: { value: V() }, uLagH: { value: V() } };
    // joints at rest, in the meshes' own space (all parts share it): where the folds go
    { const sk = parts.Human && parts.Human.skeleton, at = (n) => { const i = sk.bones.findIndex((b) => b.name === n); return V().setFromMatrixPosition(sk.boneInverses[i].clone().invert()); };
      if (sk) { const J = { uSh: at('upperarm_l'), uEl: at('lowerarm_l'), uWr: at('hand_l'), uKn: at('calf_l'), uAn: at('foot_l') };
        for (const k in J) U[k] = { value: J[k] }; this.handX = Math.min(Math.abs(J.uWr.x), Math.abs(at('hand_r').x)); } }
    U.uFold = { value: 1 };
    // the eyes: each eyeball's centre and where the lids sit on it (from the lashes), for the eye paint and the blink
    { const eye = Object.values(parts).find((o) => /high-poly|low-poly/.test(o.material.name)), lash = Object.values(parts).find((o) => /lash/.test(o.material.name));
      const EU = this.EU = { uEyeA: { value: V() }, uEyeB: { value: V() }, uGaze: { value: V(0, 0, 1) }, uBlink: { value: 0 }, uLidTop: { value: 0.5 }, uLidBot: { value: -0.5 },
        uLidC: { value: new THREE.Color(O.skin).multiplyScalar(0.5) }, uIrisA: { value: new THREE.Color(0.42, 0.27, 0.1) }, uIrisB: { value: new THREE.Color(0.2, 0.12, 0.05) } };
      if (eye) { const a = bbox(eye, (v) => v.x > 0), b = bbox(eye, (v) => v.x < 0); a.getCenter(EU.uEyeA.value); b.getCenter(EU.uEyeB.value);
        this.eyeR = (a.max.x - a.min.x) / 2;
        if (lash) { const p = lash.geometry.attributes.position, v = V(), c = EU.uEyeA.value; let top = 9, bot = -9;
          for (let i = 0; i < p.count; i++) { v.fromBufferAttribute(p, i); if (v.x <= 0) continue; v.sub(c); if (v.z < 0 || Math.abs(v.x) > this.eyeR * 0.3) continue; const el = Math.atan2(v.y, v.z);
            if (v.y > 0) top = Math.min(top, el); else bot = Math.max(bot, el); }
          if (top < 9) EU.uLidTop.value = top; if (bot > -9) EU.uLidBot.value = bot; } } }
    for (const [name, o] of Object.entries(parts)) {
      o.castShadow = true; o.receiveShadow = true; o.frustumCulled = false;
      if (name in show && !show[name]) { o.visible = false; continue; }
      let m = o.material; const n = m.name, cut = /brow|lash|short|hair_cards/.test(n);
      m.transparent = false; m.depthWrite = true; m.alphaTest = cut ? 0.4 : 0; m.metalness = 0;
      m.side = /body|low-poly|high-poly|shoes|brow|lash/.test(n) ? THREE.FrontSide : THREE.DoubleSide;
      if (name === 'skin_legs') {                         // bare shins under shorts (shortsLegs): skin, with socks painted on
        const kn = U.uKn.value, an = U.uAn.value, shoeTop = parts.shoes ? bbox(parts.shoes).max.y : an.y + 0.13, sockTop = an.y + 0.19;
        m = new THREE.MeshPhysicalMaterial({ name: 'legs', roughness: 0.55, sheen: 0.25, sheenRoughness: 0.45, sheenColor: new THREE.Color(0.9, 0.5, 0.4), specularIntensity: 0.4 });
        m.color.set(O.skin).multiplyScalar(0.8);
        const sock = O.socks && O.socks !== 'none' ? O.socks : null;
        look(m, { U, key: 'legs', skin: true, pre: 'float gSock = 0.0;', lit: '#ifdef USE_SHEEN\nmaterial.sheenColor *= 1.0 - gSock;\n#endif\nmaterial.roughness = mix(material.roughness, 0.95, gSock);',
          frag: `{ float y = vBind.y; if (y < ${f3(shoeTop - 0.04)}) discard;
            vec3 c = diffuseColor.rgb * (0.94 + 0.08 * vnoise(vBind.xy * 180.0) + 0.04 * vnoise(vBind.zy * 600.0));
            float kn = exp(-pow((y - ${f3(kn.y - 0.01)}) / 0.035, 2.0)) * smoothstep(0.0, 0.6, vBindN.z);
            c = mix(c, c * vec3(1.06, 0.84, 0.8), kn * 0.45);
            ${sock ? `float sk = 1.0 - smoothstep(${f3(sockTop - 0.003)}, ${f3(sockTop + 0.001)}, y);
            float ang = atan(abs(vBind.x) - ${f3(Math.abs(an.x))}, vBind.z - ${f3(an.z)});
            vec3 sc = ${glc(sock)} * (0.9 + 0.1 * sin(ang * 70.0)) * (1.0 - 0.12 * (1.0 - smoothstep(0.0, 0.012, ${f3(sockTop)} - y)));
            c = mix(c, sc, sk); gSock = sk;` : ''}
            diffuseColor.rgb = c; }` });
      } else if (/body/.test(n)) {                               // skin: nudge the painted skin toward your skinColor, soft sheen like real skin
        const a = average(m.map.image), w = new THREE.Color(O.skin);
        const hi = tl.load('./assets/skater/skin.webp'); hi.flipY = m.map.flipY; hi.colorSpace = THREE.SRGBColorSpace; hi.anisotropy = 8; hi.wrapS = m.map.wrapS; hi.wrapT = m.map.wrapT;
        const sk = new THREE.MeshPhysicalMaterial({ name: n, map: hi, normalMap: m.normalMap, roughness: 0.52, sheen: 0.25, sheenRoughness: 0.45, sheenColor: new THREE.Color(0.9, 0.5, 0.4), specularIntensity: 0.4 });
        sk.color.setRGB(clamp(w.r / a.r * 0.8, 0.2, 2.5), clamp(w.g / a.g * 0.8, 0.2, 2.5), clamp(w.b / a.b * 0.8, 0.2, 2.5)); m = sk;
        const pb = parts.pants && bbox(parts.pants), hx = (this.handX || 0.45) - 0.1;
        // the scalp under the hair is hair-coloured, so a gap between hair cards reads as thick hair, not a bald patch
        let scalp = '';
        const hr = parts.hair_full;
        if (name === 'Human' && hr) { const hb = bbox(hr), zc = (hb.min.z + hb.max.z) / 2, zr = (hb.max.z - hb.min.z) / 2, yf = bbox(hr, (v) => v.z > zc + zr * 0.6).min.y, yb = bbox(hr, (v) => v.z < zc - zr * 0.3).min.y;
          const ys = bbox(hr, (v) => Math.abs(v.z - zc) < zr * 0.3).min.y, EX = Math.abs(this.EU.uEyeA.value.x) + 0.035, hc = new THREE.Color(O.hair && O.hair !== '#ffffff' ? O.hair : '#d9c2a6').multiplyScalar(0.09);
          scalp = `{ float zz = (vBind.z - ${f3(zc)}) / ${f3(zr)}, line = zz > 0.0 ? mix(${f3(ys + 0.03)}, ${f3(yf + 0.035)}, smoothstep(0.0, 0.7, zz)) : mix(${f3(ys + 0.03)}, ${f3(yb)}, smoothstep(0.0, 0.6, -zz));
            float sc = smoothstep(line, line + 0.02, vBind.y) * step(${f3(hb.min.y)}, vBind.y) * (1.0 - smoothstep(${f3(EX)}, ${f3(EX + 0.006)}, abs(vBind.x)) * (1.0 - smoothstep(${f3(ys + 0.08)}, ${f3(ys + 0.09)}, vBind.y)));
            diffuseColor.rgb = mix(diffuseColor.rgb, ${glc(hc)} * (0.75 + 0.5 * vnoise(vBind.xz * 900.0)), sc); gScalp = sc; }`; }
        look(m, { U, key: 'skin' + name, skin: true, pre: 'float gScalp = 0.0;', lit: '#ifdef USE_SHEEN\nmaterial.sheenColor *= 1.0 - gScalp;\n#endif\nmaterial.roughness = mix(material.roughness, 0.85, gScalp);', frag: (pb && name === 'Human' ? `if (vBind.y < ${(pb.max.y - 0.035).toFixed(3)} && abs(vBind.x) < ${hx.toFixed(3)}) discard;` : '') + scalp });
      } else if (shell && (name === 'sweater' || name === 'hood')) {   // the ski shell: nylon, two-tone, zips and taped seams painted on
        const c2 = O.topC2 || '#1f2328';
        m = new THREE.MeshPhysicalMaterial({ name, roughness: 0.62, sheen: 0.35, sheenRoughness: 0.5, normalMap: tex('./assets/tex/jersey_nor.jpg', 11), normalScale: new THREE.Vector2(0.22, 0.22), specularIntensity: 0.55, side: THREE.DoubleSide });
        m.color.set(name === 'hood' ? c2 : O.top_); m.sheenColor.copy(m.color).lerp(new THREE.Color(1, 1, 1), 0.35);
        const b = bbox(o), hem = b.min.y, top = b.max.y;
        if (name === 'hood') look(m, { U, key: 'shellHood', frag: `diffuseColor.rgb *= 1.0 - 0.35 * (1.0 - smoothstep(0.0, 0.004, abs(vBind.x)));`, lag: `transformed += uLagH * clamp((${(top - 0.02).toFixed(3)} - position.y) / 0.2, 0.0, 1.0);` });
        else {
          U.uHemsweater = { value: hem };
          look(m, { U: { ...U, uHem: U.uHemsweater }, key: 'shell', lag: `transformed += uLagT * (1.0 - smoothstep(${hem.toFixed(3)}, ${(hem + 0.3).toFixed(3)}, position.y)) * 1.3;`,
            frag: shellGLSL(hem, c2), pre: FOLD_PRE, nrm: FOLD_TOP });
        }
      } else if (name === 'sweater' || name === 'hood' || name === 'tee') {
        m = fabric(m, name === 'tee' ? 6 : 5); m.side = THREE.DoubleSide; m.color.set(O.top_); m.sheenColor.copy(m.color).lerp(new THREE.Color(1, 1, 1), 0.2);
        const b = bbox(o), hem = b.min.y, top = b.max.y;
        if (name === 'hood') m.defines = { USE_UV: '' }, look(m, { U, key: 'hood', frag: `diffuseColor.rgb *= (1.0 - 0.3 * (1.0 - smoothstep(0.0, 0.006, abs(vUv.x - 0.5)))) * (1.0 - 0.25 * (1.0 - smoothstep(0.0, 0.02, abs(1.0 - vUv.y - 0.15))));`, lag: `transformed += uLagH * clamp((${(top - 0.02).toFixed(3)} - position.y) / 0.2, 0.0, 1.0);` });
        else {
          const print = O.print !== 'none' ? printTexture(O.print, O.ink) : null;
          if (print) U.uPrint = { value: print };
          U['uHem' + name] = { value: hem };
          look(m, { U: { ...U, uHem: U['uHem' + name] }, key: name + (O.top === 'hoodie' ? 'H' : '') + (print ? 'P' : ''), lag: `transformed += uLagT * (1.0 - smoothstep(${hem.toFixed(3)}, ${(hem + 0.2).toFixed(3)}, position.y));`,
            frag: torsoGLSL(hem, top, O.top === 'hoodie', !!print, name === 'tee'), pre: FOLD_PRE, nrm: FOLD_TOP });
        }
      } else if (name === 'pants') {
        grey(m, shell ? 0.3 : 0.75); m.color.set(O.pants); m.roughness = 0.9; m.normalScale && m.normalScale.set(1.2, 1.2);
        const b = bbox(o), hem = b.min.y;
        if (shorts) {                                     // skate shorts: the same cargo cut, hemmed just below the knee
          const sh = U.uKn.value.y - 0.03; shortsHem(o, sh);
          look(m, { U: { ...U, uHem: { value: hem } }, key: 'shorts', pre: FOLD_PRE, nrm: FOLD_PANTS,
            frag: `if (vBind.y < ${f3(sh)}) discard;
              diffuseColor.rgb *= 1.0 - 0.3 * (1.0 - smoothstep(0.0, 0.0025, abs(vBind.y - ${f3(sh + 0.022)})));
              diffuseColor.rgb *= 1.0 - 0.12 * (1.0 - smoothstep(0.0, 0.02, vBind.y - ${f3(sh)}));
              if (!gl_FrontFacing) diffuseColor.rgb *= 0.55;` });
        } else if (shell) {                               // baggy ski pants: the cargo cut in a soft nylon; the swing peaks at the shin, not at the hem (it sits on the boot)
          m.roughness = 0.78; m.metalness = 0; m.normalScale && m.normalScale.set(0.6, 0.6);
          look(m, { U: { ...U, uHem: { value: hem }, uFold: { value: 0.4 } }, key: 'skipants', pre: FOLD_PRE, nrm: FOLD_PANTS,
            lag: `{ float w = (1.0 - smoothstep(${hem.toFixed(3)}, ${(hem + 0.5).toFixed(3)}, position.y)) * smoothstep(${hem.toFixed(3)}, ${(hem + 0.14).toFixed(3)}, position.y); transformed += w * 0.8 * (position.x > 0.0 ? uLagA : uLagB); }`,
            frag: `if (!gl_FrontFacing) diffuseColor.rgb *= 0.45;` });
        } else look(m, { U: { ...U, uHem: { value: hem } }, key: 'pants', pre: FOLD_PRE, nrm: FOLD_PANTS, lag: `{ float w = 1.0 - smoothstep(${hem.toFixed(3)}, ${(hem + 0.45).toFixed(3)}, position.y); transformed += w * w * (position.x > 0.0 ? uLagA : uLagB); }` });
      } else if (name === 'shoes') {
        const L = bbox(o, (v) => v.x > 0), mid = (L.min.x + L.max.x) / 2;
        m = new THREE.MeshPhysicalMaterial({ name: 'shoes', roughness: 0.82, sheen: 0.5, sheenRoughness: 0.8 });
        m.sheenColor.set(O.shoes[0]).lerp(new THREE.Color(1, 1, 1), 0.3);
        look(m, { U, key: 'shoes', frag: shoeGLSL(L.min.y, L.min.z, L.max.z, mid, L.max.y, O.shoes) });
        this.shoeBox = L;
      } else if (name === 'beanie') { m.color.set(O.hatC); m.roughness = 1; m.normalMap = tex('./assets/tex/jersey_nor.jpg', 3); m.roughnessMap = tex('./assets/tex/jersey_arm.jpg', 3); }
      else if (name === 'cap' || name === 'capback') { m = new THREE.MeshPhysicalMaterial({ name: 'cap', color: new THREE.Color(O.hatC), roughness: 0.85, sheen: 0.6, sheenRoughness: 0.6, normalMap: tex('./assets/tex/jersey_nor.jpg', 4), side: THREE.DoubleSide });
        m.defines = { USE_UV: '' }; look(m, { U, key: 'cap', frag: capGLSL(O.hatC2 || '#e8e2d2') }); }
      else if (/low-poly|high-poly/.test(n)) {           // wet eyes catch a highlight (clearcoat = the cornea); iris, pupil and lids painted (EYE_FRAG)
        m = new THREE.MeshPhysicalMaterial({ name: n, roughness: 0.35, clearcoat: 1, clearcoatRoughness: 0.03, specularIntensity: 0.6 });
        look(m, { U: { ...U, ...this.EU }, key: 'eyes', pre: EYE_PRE, frag: EYE_FRAG, lit: EYE_LIT }); }
      else if (/lash/.test(n)) { m.transparent = true; m.depthWrite = false; m.alphaTest = 0.05; o.renderOrder = 2; m.color.setRGB(0.6, 0.55, 0.5);
        look(m, { U: { ...U, ...this.EU }, key: 'lash', bv: LASH_V, vdecl: LASH_VD }); }
      else if (/brow/.test(n)) {                          // soft brows the colour of his hair, not drawn on in marker
        m.transparent = true; m.depthWrite = false; m.alphaTest = 0.03; o.renderOrder = 2;
        m.color.set(O.hair && O.hair !== '#ffffff' ? O.hair : '#d9c2a6').multiplyScalar(0.8); m.roughness = 0.8; }
      else if (/short|hair_cards/.test(n)) {                         // hair: strands shine along their length (anisotropic), darker at the roots
        // two passes, as hair is done in games: a solid core where the cards are dense, then the wispy ends blended softly over it
        const hairCol = O.hair && O.hair !== '#ffffff' ? O.hair : /hair_cards/.test(n) ? '#3f2a1c' : '#d9c2a6', hairMap = /hair_cards/.test(n) ? (this.hairMap || (this.hairMap = hairTexture())) : m.map;
        const mk = (extra) => { const h = new THREE.MeshPhysicalMaterial({ name: n, map: hairMap, side: THREE.DoubleSide, roughness: 0.6, vertexColors: /hair_cards/.test(n) && !!o.geometry.attributes.color, anisotropy: /hair_cards/.test(n) ? 0 : 0.7, anisotropyRotation: Math.PI / 2,
          sheen: 0.3, sheenRoughness: 0.45, sheenColor: new THREE.Color(0.3, 0.22, 0.15), specularIntensity: 0.25, ...extra });
          h.color.set(hairCol); if (/hair_cards/.test(n)) { h.sheen = 0.12; h.specularIntensity = 0.12; h.specularColor.set(hairCol).lerp(new THREE.Color(1, 1, 1), 0.35); } return h; };
        const hb = bbox(o), hf = `diffuseColor.rgb *= 0.62 + 0.3 * smoothstep(${hb.min.y.toFixed(3)}, ${hb.max.y.toFixed(3)}, vBind.y) * (0.8 + 0.4 * vnoise(vec2(vBind.x * 220.0, vBind.z * 220.0)));`;
        m = mk({ alphaTest: 0.5, alphaToCoverage: true }); look(m, { U, key: 'hair', frag: hf });
        const fm = mk({ transparent: true, depthWrite: true, alphaTest: 0.06 }); fm.sheen = 0; fm.specularIntensity = 0;   // no shine on the wisps: their back faces caught the sun and turned the hair blond look(fm, { U, key: 'hairF', frag: hf + 'if (diffuseColor.a > 0.5) discard;' });
        const fr = new THREE.SkinnedMesh(o.geometry, fm); fr.name = name + '_wisps'; fr.bind(o.skeleton, o.bindMatrix); fr.renderOrder = 3; fr.frustumCulled = false;
        fr.position.copy(o.position); fr.quaternion.copy(o.quaternion); fr.scale.copy(o.scale); o.parent.add(fr);
      }
      m.needsUpdate = true; o.material = m;
    }
    const shoes = parts.shoes;
    // stand the model on the ground at the body origin
    this.body.add(model); model.updateMatrixWorld(true);
    shoes.geometry.computeBoundingBox(); const sb = shoes.geometry.boundingBox;
    model.position.y = -sb.min.y; model.updateMatrixWorld(true);
    this.model = model;
    const inv = this.body.matrixWorld.clone().invert(), R = {}, s = V();
    model.traverse((b) => {
      if (!b.isBone) return;
      const r = { bone: b, par: R[b.parent.name] || null, lp: b.position.clone(), lq: b.quaternion.clone(), wp0: V(), wq0: Q(), wp: V(), wq: Q(), pwp: V(), pwq: Q() };
      _m.multiplyMatrices(inv, b.matrixWorld).decompose(r.wp0, r.wq0, s); r.wp.copy(r.wp0); r.wq.copy(r.wq0);
      _m.multiplyMatrices(inv, b.parent.matrixWorld).decompose(r.pwp, r.pwq, s);
      R[b.name] = r;
    });
    const limb = (a, b, c) => {
      const d0 = V().subVectors(b.wp0, a.wp0), d1 = V().subVectors(c.wp0, b.wp0), ac = V().subVectors(c.wp0, a.wp0).normalize();
      const pole = d0.clone().addScaledVector(ac, -d0.dot(ac));
      a.len = d0.length(); b.len = d1.length(); a.f0i = frameQ(d0, pole).invert(); b.f0i = frameQ(d1, pole).invert();
      return [a, b, c];
    };
    const side = (sfx) => {
      const hand = R['hand' + sfx], fingers = [];
      const pn = V().crossVectors(V().subVectors(R['index_01' + sfx].wp0, hand.wp0), V().subVectors(R['pinky_01' + sfx].wp0, hand.wp0)).normalize();
      if (pn.dot(V().subVectors(R['thumb_03' + sfx].wp0, hand.wp0)) < 0) pn.negate();          // palm side is the thumb side
      for (const f of ['index', 'middle', 'ring', 'pinky']) for (let i = 1; i <= 3; i++) {
        const r = R[`${f}_0${i}${sfx}`], nx = R[`${f}_0${i + 1}${sfx}`];
        const dir = nx ? V().subVectors(nx.wp0, r.wp0) : V().subVectors(r.wp0, r.par.wp0);
        fingers.push({ r, axis: V().crossVectors(dir.normalize(), pn).normalize().applyQuaternion(r.wq0.clone().invert()) });
      }
      return { leg: limb(R['thigh' + sfx], R['calf' + sfx], R['foot' + sfx]), ball: R['ball' + sfx], arm: limb(R['upperarm' + sfx], R['lowerarm' + sfx], hand), clav: R['clavicle' + sfx], fingers,
        palm: pn.clone().applyQuaternion(hand.wq0.clone().invert()) };
    };
    const rig = { R, pelvis: R.pelvis, spine: [R.spine_01, R.spine_02, R.spine_03], neck: R.neck_01, head: R.head, sides: [side('_l'), side('_r')] };
    const hipMid = V().addVectors(R.thigh_l.wp0, R.thigh_r.wp0).multiplyScalar(0.5);
    rig.hip0 = hipMid.y;                                                            // hip centre above the ground, standing straight
    rig.hipLocal = hipMid.sub(R.pelvis.wp0).applyQuaternion(R.pelvis.wq0.clone().invert()).negate();   // from the hip centre back to the pelvis bone
    rig.ankleH = R.foot_l.wp0.y;                                                    // ankle above the sole
    rig.footBack = (sb.min.z + sb.max.z) / 2 - R.foot_l.wp0.z;                      // ankle to the middle of the sole
    rig.legLen = R.thigh_l.len + R.calf_l.len; rig.armLen = R.upperarm_l.len + R.lowerarm_l.len;
    this.rig = rig; this.snap = true;
    // secondary motion: each spring is a weight hanging off a bone; the cloth near it is pushed by how far the weight trails behind
    const sideA = R.calf_l.wp0.x > 0 ? '_l' : '_r', sideB = sideA === '_l' ? '_r' : '_l';
    this.springs = [['uLagA', 'calf' + sideA, 1], ['uLagB', 'calf' + sideB, 1], ['uLagT', 'spine_02', 0.8], ['uLagH', 'neck_01', 1.1]]
      .map(([u, b, k]) => ({ u, bone: R[b].bone, k, x: V(), v: V(), p: V(), init: false }));
    this.addStrings(R);
  }

  // hoodie drawstrings: two cords that hang from the neck and swing
  addStrings(R) {
    this.strings = [];
    if (this.outfit.top !== 'hoodie' || this.outfit.fit === 'shell') return;
    const hood = this.model.getObjectByName('hood'); if (!hood) return;
    const p = hood.geometry.attributes.position, v = V(); let zf = -9, yf = 0;
    for (let i = 0; i < p.count; i++) { v.fromBufferAttribute(p, i); if (Math.abs(v.x) < 0.06 && v.z > zf) { zf = v.z; yf = v.y; } }
    const mat = new THREE.MeshStandardMaterial({ color: new THREE.Color(this.outfit.ink || '#eeeeee'), roughness: 0.8 });
    const cord = new THREE.CylinderGeometry(0.0032, 0.0032, 0.17, 6).translate(0, -0.085, 0), tip = new THREE.CylinderGeometry(0.0042, 0.0038, 0.022, 8).translate(0, -0.18, 0);
    const bone = R.spine_03.bone; this.model.updateMatrixWorld(true);
    for (const x of [-0.032, 0.032]) {
      const g = new THREE.Group(); g.add(new THREE.Mesh(cord, mat), new THREE.Mesh(tip, mat)); g.children.forEach((c) => { c.castShadow = true; });
      const w = V(x, yf - 0.035, zf - 0.008).applyMatrix4(this.model.matrixWorld);   // model space -> world -> the chest bone
      bone.worldToLocal(w); g.position.copy(w); bone.add(g);
      this.strings.push({ g, dir: V(0, -1, 0.15).normalize(), vel: V() });
    }
  }

  // cloth lag + cords; dt in seconds. Cheap: a handful of vector ops.
  secondary(dt, mirrorX) {
    if (!this.springs) return;
    const h = Math.min(dt, 1 / 30), inv = _m.copy(this.model.matrixWorld).invert(), m3 = new THREE.Matrix3().setFromMatrix4(inv);
    this.U.uMirror.value = (T.stance === 'goofy' ? -1 : 1) * (mirrorX ? -1 : 1);
    for (const s of this.springs) {
      s.bone.getWorldPosition(s.p);
      if (!s.init || this.snap || h <= 0) { s.x.copy(s.p); s.v.set(0, 0, 0); s.init = true; }
      // a soft, slightly bouncy spring (Holden, "Spring-It-On", 2021): x'' = k (p - x) - c x'
      s.v.addScaledVector(V().subVectors(s.p, s.x), 160 * h).multiplyScalar(Math.exp(-11 * h)); s.x.addScaledVector(s.v, h);
      const off = V().subVectors(s.x, s.p).clampLength(0, 0.06).multiplyScalar(0.55 * s.k);
      this.U[s.u].value.copy(off.applyMatrix3(m3));
    }
    for (const st of this.strings) {                // a pendulum per cord, in the chest bone's frame
      const b = st.g.parent, q = b.getWorldQuaternion(Q()), qi = q.clone().invert();
      const lag = V().subVectors(this.springs[3].x, this.springs[3].p).multiplyScalar(6);
      const want = V(0, -1, 0).sub(lag).normalize().applyQuaternion(qi);
      const fwd = V(0, 0, 1).applyQuaternion(this.model.getWorldQuaternion(Q())).applyQuaternion(qi);   // keep them in front of the chest
      if (want.dot(fwd) < 0.12) want.addScaledVector(fwd, 0.12 - want.dot(fwd)).normalize();
      st.vel.addScaledVector(V().subVectors(want, st.dir), 90 * h).multiplyScalar(Math.exp(-6 * h));
      st.dir.addScaledVector(st.vel, h).normalize();
      st.g.quaternion.setFromUnitVectors(V(0, -1, 0), st.dir);
    }
  }


  buildBoard() {
    const L = 0.81, W = 0.206, TH = 0.011, NL = 36, NW = 8;
    // deck shape: rounded nose and tail, both kicked up, with a shallow dish (concave) across the middle
    const P = (i, j, top) => {
      const s = (j / NL) * 2 - 1, a = Math.abs(s), z = s * L / 2, kz = Math.max(0, Math.abs(z) - 0.25);
      const hw = W / 2 * (a > 0.74 ? Math.sqrt(Math.max(0, 1 - ((a - 0.74) / 0.26) ** 2)) : 1), u = (i / NW) * 2 - 1;
      return [u * hw, kz * kz * (z > 0 ? 5.6 : 4.8) + 0.011 * u * u * Math.max(0, 1 - kz * 9) + (top ? TH : 0), z];
    };
    const surf = (top) => { const pos = [], uv = [], idx = [];
      for (let j = 0; j <= NL; j++) for (let i = 0; i <= NW; i++) { pos.push(...P(i, j, top)); uv.push(i / NW, j / NL); }
      for (let j = 0; j < NL; j++) for (let i = 0; i < NW; i++) { const a = j * (NW + 1) + i, b = a + 1, c = a + NW + 1, d = c + 1; if (top) idx.push(a, c, b, b, c, d); else idx.push(a, b, c, b, d, c); }
      const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2)); g.setIndex(idx); g.computeVertexNormals(); return g; };
    const edge = () => { const pos = [], idx = []; let n = 0;
      for (const i of [0, NW]) for (let j = 0; j < NL; j++) { pos.push(...P(i, j, true), ...P(i, j + 1, true), ...P(i, j, false), ...P(i, j + 1, false)); if (i) idx.push(n, n + 2, n + 1, n + 1, n + 2, n + 3); else idx.push(n, n + 1, n + 2, n + 1, n + 3, n + 2); n += 4; }
      const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.setIndex(idx); g.computeVertexNormals(); return g; };
    const canvas = (w, h, draw) => { const c = document.createElement('canvas'); c.width = w; c.height = h; draw(c.getContext('2d'), w, h); const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 8; return t; };
    let sd = 99; const r = () => { sd = (sd * 1664525 + 1013904223) >>> 0; return sd / 4294967296; };
    const gripT = canvas(256, 1024, (g, w, h) => {     // grip tape: black sandpaper, a little dusty where the feet go
      g.fillStyle = '#161616'; g.fillRect(0, 0, w, h);
      for (let i = 0; i < 26000; i++) { const v = 20 + r() * 60 | 0; g.fillStyle = `rgba(${v},${v},${v},${r() * 0.8})`; g.fillRect(r() * w, r() * h, 1, 1); }
      for (const y of [0.3, 0.72]) { const gr = g.createRadialGradient(w / 2, h * y, 0, w / 2, h * y, 150); gr.addColorStop(0, 'rgba(150,140,125,0.16)'); gr.addColorStop(1, 'rgba(150,140,125,0)'); g.fillStyle = gr; g.fillRect(0, 0, w, h); }
    });
    const artT = canvas(256, 1024, (g, w, h) => {      // the graphic: an original sunrise-and-waves design in your boardColor
      g.fillStyle = T.boardColor; g.fillRect(0, 0, w, h);
      g.fillStyle = 'rgba(20,24,40,0.92)'; g.fillRect(0, h * 0.5, w, h * 0.5);
      g.fillStyle = 'rgba(255,255,255,0.9)'; g.beginPath(); g.arc(w / 2, h * 0.5, 78, Math.PI, 0); g.fill();
      g.strokeStyle = 'rgba(255,255,255,0.85)'; g.lineWidth = 7;
      for (let k = 0; k < 9; k++) { const a = Math.PI + (k + 0.5) * Math.PI / 9; g.beginPath(); g.moveTo(w / 2 + Math.cos(a) * 96, h * 0.5 + Math.sin(a) * 96); g.lineTo(w / 2 + Math.cos(a) * (150 + (k % 2) * 60), h * 0.5 + Math.sin(a) * (150 + (k % 2) * 60)); g.stroke(); }
      g.strokeStyle = T.boardColor; g.lineWidth = 9;
      for (let k = 0; k < 6; k++) { const y = h * 0.56 + k * 62; g.beginPath(); for (let x = -10; x <= w + 10; x += 8) g.lineTo(x, y + Math.sin(x * 0.06 + k * 1.3) * 11); g.stroke(); }
      g.strokeStyle = 'rgba(235,225,200,0.5)';        // scratches from slides
      for (let i = 0; i < 90; i++) { const y = h * (0.3 + r() * 0.4), x = r() * w; g.lineWidth = 0.6 + r() * 2.4; g.beginPath(); g.moveTo(x, y); g.lineTo(x + (r() - 0.5) * 180, y + (r() - 0.5) * 26); g.stroke(); }
    });
    // name on the bottom, the ply edge and wear on the nose and tail
    { const g = artT.image.getContext('2d'), w = artT.image.width, h = artT.image.height;
      g.save(); g.translate(w * 0.5, h * 0.79); g.rotate(-Math.PI / 2); g.fillStyle = 'rgba(255,255,255,0.92)'; g.font = 'bold 54px Arial Black, Arial, sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle';
      g.fillText(String(T.gameName || '').split(' ').slice(-2).join(' ').toUpperCase(), 0, 0); g.restore();
      for (const y0 of [0, h - 70]) for (let i = 0; i < 160; i++) { const y = y0 + r() * 70; g.fillStyle = `rgba(${200 + r() * 30 | 0},${170 + r() * 30 | 0},${120 + r() * 30 | 0},${0.3 + r() * 0.6})`; g.fillRect(r() * w, y, 2 + r() * 30, 1 + r() * 3); }
      artT.needsUpdate = true; }
    const plyT = canvas(512, 16, (g, w, h) => { const cs = ['#d8b88a', '#c9a46e', '#3a6ea5', '#d8b88a', '#c9a46e', '#d8b88a', '#b8935e']; for (let i = 0; i < 7; i++) { g.fillStyle = cs[i]; g.fillRect(0, i * h / 7, w, h / 7 + 1); }
      for (let i = 0; i < 400; i++) { g.fillStyle = `rgba(60,40,20,${r() * 0.25})`; g.fillRect(r() * w, r() * h, 1 + r() * 6, 1); } });
    const mk = (g, m, par = this.deck) => { const x = new THREE.Mesh(g, m); x.castShadow = true; x.receiveShadow = true; par.add(x); return x; };
    const y0 = 0.076;
    mk(surf(true), new THREE.MeshStandardMaterial({ map: gripT, roughness: 1, bumpMap: gripT, bumpScale: 1.5 })).position.y = y0;
    mk(surf(false), new THREE.MeshStandardMaterial({ map: artT, roughness: 0.38 })).position.y = y0;
    const eg = edge(); { const n = eg.attributes.position.count, uv = new Float32Array(n * 2); for (let i = 0; i < n; i++) { uv[i * 2] = (i >> 2) / NL; uv[i * 2 + 1] = (i & 2) ? 0 : 1; } eg.setAttribute('uv', new THREE.BufferAttribute(uv, 2)); }
    mk(eg, new THREE.MeshStandardMaterial({ map: plyT, roughness: 0.7 })).position.y = y0;
    // trucks: baseplate, kingpin and bushings stay on the deck; the hanger (axle and wheels) swings on its pivot, so the deck can lean into a carve
    const metal = new THREE.MeshStandardMaterial({ color: 0xbfc3c8, roughness: 0.3, metalness: 1 }), dark = new THREE.MeshStandardMaterial({ color: 0x3a3c40, roughness: 0.35, metalness: 0.9 });
    const bush = new THREE.MeshStandardMaterial({ color: T.bushingColor || 0xe8a33a, roughness: 0.55 });
    const wheelM = new THREE.MeshPhysicalMaterial({ color: T.wheelColor, roughness: 0.42, clearcoat: 0.3, clearcoatRoughness: 0.6 });
    const wheelG = new THREE.LatheGeometry([[0.0115, -0.0165], [0.0215, -0.0165], [0.0255, -0.0135], [0.0268, -0.008], [0.027, 0.004], [0.0262, 0.012], [0.0235, 0.016], [0.0175, 0.0168], [0.0115, 0.0145]].map(([a, b]) => new THREE.Vector2(a, b)), 28);
    const bearG = mergeGeometries([new THREE.CylinderGeometry(0.0112, 0.0112, 0.03, 18), new THREE.TorusGeometry(0.0075, 0.0012, 6, 18).rotateX(Math.PI / 2).translate(0, 0.0152, 0), new THREE.TorusGeometry(0.0075, 0.0012, 6, 18).rotateX(Math.PI / 2).translate(0, -0.0152, 0)]);
    const nutG = new THREE.CylinderGeometry(0.0058, 0.0058, 0.006, 6);
    this.wheels = []; this.hangers = [];
    for (const z of [-0.205, 0.205]) {
      const s = Math.sign(z), pivY = 0.05;
      mk(mergeGeometries([new THREE.BoxGeometry(0.062, 0.006, 0.088).translate(0, 0.0727, z), new THREE.BoxGeometry(0.03, 0.022, 0.03).translate(0, 0.06, z + s * 0.018),
        new THREE.CylinderGeometry(0.0045, 0.0045, 0.052, 8).rotateX(s * 0.75).translate(0, 0.052, z - s * 0.006)]), metal);
      for (const k of [0, 1]) mk(new THREE.CylinderGeometry(0.0115, 0.0105, 0.011, 14).rotateX(s * 0.75).translate(0, 0.061 - k * 0.019, z - s * (0.0 + k * 0.016)), bush);
      mk(nutG.clone().rotateX(s * 0.75).translate(0, 0.033, z - s * 0.03), dark);
      const hg = new THREE.Group(); hg.position.set(0, pivY, z); this.deck.add(hg); this.hangers.push({ g: hg, s });
      mk(mergeGeometries([new THREE.CylinderGeometry(0.0105, 0.0125, 0.128, 14).rotateZ(Math.PI / 2).translate(0, 0.027 - pivY, 0),
        new THREE.CylinderGeometry(0.009, 0.0135, 0.034, 10).translate(0, 0.043 - pivY, -s * 0.004), new THREE.BoxGeometry(0.05, 0.018, 0.024).translate(0, 0.036 - pivY, -s * 0.004)]), metal, hg);
      mk(new THREE.CylinderGeometry(0.004, 0.004, 0.214, 8).rotateZ(Math.PI / 2).translate(0, 0.027 - pivY, 0), metal, hg);
      for (const x of [-0.094, 0.094]) {
        const w = mk(wheelG, wheelM, hg); w.rotation.z = Math.PI / 2; w.position.set(x, 0.027 - pivY, 0);
        const b = new THREE.Mesh(bearG, dark); w.add(b);
        const nut = new THREE.Mesh(nutG, metal); nut.position.y = -Math.sign(x) * 0.02; w.add(nut);
        this.wheels.push(w);
      }
    }
    this.wheelSpin = 0;
  }

  // ── skeleton plumbing ──
  setQ(r, wq) { r.wq.copy(wq); r.bone.quaternion.copy(r.par ? r.par.wq : r.pwq).invert().multiply(wq); }
  place(r) { return r.wp.copy(r.lp).applyQuaternion(r.par.wq).add(r.par.wp); }
  follow(r) { r.wq.multiplyQuaternions(r.par.wq, r.lq); r.bone.quaternion.copy(r.lq); return this.place(r); }
  aim(r, d, p) { this.place(r); this.setQ(r, frameQ(d, p).multiply(r.f0i).multiply(r.wq0)); }
  // hips, spine, neck, head, collar bones: everything the limbs hang from
  spineFK(S) {
    const g = this.rig, p = g.pelvis, pq = S.Qp.clone().multiply(p.wq0);
    p.wq.copy(pq); p.wp.copy(g.hipLocal).applyQuaternion(pq).add(S.H);
    p.bone.quaternion.copy(p.pwq).invert().multiply(pq);
    p.bone.position.copy(p.wp).sub(p.pwp).applyQuaternion(p.pwq.clone().invert());
    g.spine.forEach((r, i) => { this.place(r); this.setQ(r, S.Qp.clone().slerp(S.Qc, (i + 1) / 3).multiply(r.wq0)); });
    this.place(g.neck); this.setQ(g.neck, S.Qc.clone().slerp(S.Qh, 0.45).multiply(g.neck.wq0));
    this.place(g.head); this.setQ(g.head, S.Qh.clone().multiply(g.head.wq0));
    for (const s of g.sides) { this.follow(s.clav); this.place(s.arm[0]); this.place(s.leg[0]); }
  }
  limbIK([a, b, c], target, pole) {
    const mid = bendPoint(a.wp, target, a.len, b.len, pole, V());
    const d = V().subVectors(target, a.wp).normalize(), bend = V().subVectors(mid, a.wp); bend.addScaledVector(d, -bend.dot(d));
    if (bend.lengthSq() < 1e-6) bend.copy(pole);
    this.aim(a, V().subVectors(mid, a.wp), bend);
    this.place(b); this.aim(b, V().subVectors(target, b.wp), bend); this.place(c);
  }
  // Pose the whole skeleton from a set of targets: hips H, hip/chest/head turns, ankles, hands.
  solve(S, curl) {
    const g = this.rig;
    this.spineFK(S);
    g.sides.forEach((s, i) => {
      this.limbIK(s.leg, S.ank[i], S.kpole[i]);
      const foot = s.leg[2], fq = frameQ(S.fn[i], S.ff[i]);
      this.setQ(foot, fq.clone().multiply(foot.wq0));
      this.place(s.ball); this.setQ(s.ball, fq.multiply(Q().setFromAxisAngle(X, -S.toe[i])).multiply(s.ball.wq0));
      this.limbIK(s.arm, S.hand[i], S.epole[i]);
      // turn the forearm so the palm faces where it should (the elbow solve alone leaves it wherever the bend puts it)
      const lo = s.arm[1], hand = s.arm[2], ax = V().subVectors(hand.wp, lo.wp).normalize();
      const cur = s.palm.clone().applyQuaternion(Q().multiplyQuaternions(lo.wq, hand.lq)), want = S.palm ? S.palm[i].clone() : V(0, -1, 0);
      cur.addScaledVector(ax, -cur.dot(ax)); want.addScaledVector(ax, -want.dot(ax));
      let tw = cur.lengthSq() > 1e-6 && want.lengthSq() > 1e-6 ? Math.atan2(V().crossVectors(cur, want).dot(ax), cur.dot(want)) : 0;
      tw = clamp(tw, -1.7, 1.7);
      this.setQ(lo, Q().setFromAxisAngle(ax, tw * 0.65).multiply(lo.wq));
      this.setQ(hand, Q().setFromAxisAngle(ax, tw * 0.35).multiply(lo.wq).multiply(hand.lq));
      const c = curl[i];
      s.fingers.forEach((f, k) => f.r.bone.quaternion.copy(f.r.lq).multiply(Q().setFromAxisAngle(f.axis, c * (k % 3 === 0 ? 0.75 : 1.05) + 0.12 * (k / 3 | 0) * c)));
    });
  }

  update(dt, ph) {
    // after a fall he walks over to his board (physics' 'fetch'): that is walking, with the board left lying where it ended up
    const fetch = ph.state === 'bail' && !!ph.bail && ph.bail.phase === 'fetch';
    const bail = ph.state === 'bail' && !fetch, walk = ph.state === 'walk' || fetch, goofy = T.stance === 'goofy';
    if (bail && !this.prevVisBail && !this.snap) this.bb0 = this.flipper.matrixWorld.clone();   // the board as it was when he slammed
    const cat = walk ? 'walk' : bail ? 'bail' : 'ride';
    const b = ph.bail || {};
    // the board changes hands (ride <-> walk): remember where it was so it can travel, not teleport
    if (this.cat && cat !== this.cat && cat !== 'bail' && this.cat !== 'bail' && !this.snap) {
      this.boardRoot.updateMatrixWorld(true); this.bxf = { M: this.flipper.matrixWorld.clone(), t: 0, dur: 0.32 };
    }
    // root follows the physics board
    const k = 1 - Math.exp(-(ph.state === 'air' ? 10 : 22) * dt);
    this.visUp.lerp(bail ? (b.surfaceNormal || b.normal || Y) : ph.up, this.snap ? 1 : k).normalize();
    const z = ph.fwd.clone().addScaledVector(this.visUp, -ph.fwd.dot(this.visUp)).normalize();
    const x = V().crossVectors(this.visUp, z);
    const M = new THREE.Matrix4().makeBasis(x, this.visUp, z).setPosition(ph.pos);
    // body flips: rider and board turn together about the hips; an unfinished one unwinds instead of snapping back
    const bf = ph.bodyFlip && ph.state === 'air' ? ph.bodyFlip : null, full = Math.PI * 2;
    if (bf) { const tr = Math.sign(ph.getVel(V()).dot(ph.fwd)) || 1; this.flipA = (bf.angle || 0) * (bf.dir || 1) * tr; this.flipV = 0; }
    else if (this.flipA) { const o = { a: this.flipA, v: { a: this.flipV } }; spring(o, 'a', Math.round(this.flipA / full) * full, 14, dt); this.flipA = o.a; this.flipV = o.v.a; if (Math.abs(this.flipA - Math.round(this.flipA / full) * full) < 1e-3) this.flipA = 0; }
    if (this.flipA) M.multiply(_m.makeTranslation(0, 0.62, 0)).multiply(new THREE.Matrix4().makeRotationX(this.flipA)).multiply(_m.makeTranslation(0, -0.62, 0));
    // revert: physics turns the board through the last half-turn (boardPose.yaw); the rider turns with it
    const ry = ph.revert && ph.state === 'ground' ? (ph.revert.yaw || 0) : 0;
    this.root.matrixAutoUpdate = false;
    this.boardRoot.matrixAutoUpdate = false;
    if (bail && this.rig) this.bailFrames(ph, dt);         // the body and the board go their own ways (physics' bail ball and board)
    else {
      this.bl = null;
      this.root.matrix.copy(M); if (ry) this.root.matrix.multiply(_m.makeRotationY(ry));
      this.boardRoot.matrix.copy(M);
    }
    this.root.matrixWorldNeedsUpdate = true; this.boardRoot.matrixWorldNeedsUpdate = true;

    // what the rider is doing to the board: weight into a carve, manuals, grind styles, tweaks, slides
    const turnRate = dt > 0 && this.prevFwd.lengthSq() && !walk ? V().crossVectors(this.prevFwd, ph.fwd).dot(ph.up) / dt : 0;
    const toeSide = goofy ? 1 : -1;                                                   // which way (in board terms) the toes point
    // carve lean: half from how fast the board is actually turning, half from physics' lean (it leads the turn, so the body commits first)
    const carve = ph.state === 'ground' && !ph.slide && !ph.revert ? clamp(turnRate * ph.speed * toeSide * 0.015 - (ph.lean || 0) * toeSide * 0.15 * Math.min(1, Math.abs(ph.speed) / 3), -0.3, 0.3) : 0;
    this.steer += (carve - this.steer) * (1 - Math.exp(-7 * dt));
    let roll = 0, yaw = 0, pitch = 0, rise = 0, wrap = 0, wrapZ = 0;
    const mirrorX = !!ph.switchStance && !walk && !bail;    // a fall is the same either way round, and you get up in your own stance
    if (ph.trick) {
      const d = ph.trick.def, pr = Math.min(1, ph.trick.t / d.dur), e = pr * pr * (3 - 2 * pr);   // flips wind up and settle, they don't spin at a constant rate
      // which way is which on the board: its +x is the regular rider's heel side, its tail is -z (+z riding switch).
      // A kickflip rolls the deck over toward the heels; a backside shuvit takes the tail round behind you (heel side).
      const heel = goofy ? -1 : 1, tail = mirrorX ? 1 : -1;
      if (d.roll) roll = -d.roll * heel * e * Math.PI * 2;
      if (d.yaw) yaw = d.yaw * heel * tail * e * Math.PI;
      // impossible: end over end round the back foot (front foot for a nollie), the leading end coming up first
      if (d.pitch) { const lead = (ph.nollie ? 1 : -1) * -tail; wrap = d.pitch * lead * e * Math.PI * 2; wrapZ = 0.2 * (ph.nollie ? -tail : tail); }
      rise = 0.14 * Math.sin(pr * Math.PI) * (d.pitch ? 0.4 : 1);                  // the board floats up to meet the feet
    }
    if (ph.state === 'air' && ph.popT < 0.22) pitch = -0.42 * Math.sin((ph.popT / 0.22) * Math.PI);
    if (bail) roll = yaw = pitch = rise = 0;
    const bp = !walk && !bail && ph.boardPose || { pitch: 0, yaw: 0 };
    const pPitch = pitch + bp.pitch, pYawB = bp.yaw, pRoll = -toeSide * (this.steer * 0.35 + (bp.roll || 0));   // the part the feet stay on
    const lift = ph.state === 'air' || bail || walk ? 0 : 0.205 * Math.abs(Math.sin(pPitch)) + 0.027 * (1 - Math.cos(pPitch));   // keep the low wheels on the ground
    this.board.rotation.set(pPitch, pYawB, pRoll);
    this.board.position.y = lift;
    this.flipper.rotation.set(wrap, yaw, roll, 'YZX');
    // the impossible turns about the wrapping foot (an axle across the board, 7 cm above its middle), not the board's centre
    const wy = wrap ? 0.07 : 0, sW = Math.sin(wrap), cW = Math.cos(wrap);
    this.flipper.position.set(0, FLIP_PIVOT + rise + (wy - (wy * cW - wrapZ * sW)), wrapZ - (wy * sW + wrapZ * cW));
    // wheels roll with the ground speed and keep spinning (slowing) in the air; trucks keep the axles level when the deck leans
    if (ph.state === 'ground' && !ph.slide) this.wheelSpin = ph.speed / 0.027; else if (ph.state === 'grind' || bail || walk) this.wheelSpin *= Math.exp(-3 * dt); else this.wheelSpin *= Math.exp(-0.6 * dt);
    for (const w of this.wheels) w.rotation.x += this.wheelSpin * dt;
    for (const h of this.hangers) { h.g.rotation.z = -pRoll * 0.92; h.g.rotation.y = h.s * pRoll * 0.55; }

    // body space: x along the board toward the front foot, z toward the toes. Goofy is the mirror image; riding switch mirrors it end for end.
    this.body.matrix.makeRotationY(-Math.PI / 2); if (goofy || mirrorX) this.body.matrix.scale(V(mirrorX ? -1 : 1, 1, goofy ? -1 : 1));
    this.body.matrixWorldNeedsUpdate = true;
    const jumped = this.prevPos.distanceToSquared(ph.pos) > 9 || (this.prevVisBail && !bail && !fetch);
    this.carrying = !fetch;
    const snapNow = jumped || this.snap;
    if (snapNow) this.bxf = null;
    if (this.rig) {
      this.animate(dt, ph, { pitch: pPitch, yaw: pYawB - ry, roll: pRoll, lift, revert: ry }, snapNow, cat, mirrorX);
      if (bail || fetch) this.bailBoard(ph, dt);
      this.root.updateMatrixWorld(true);
      if (walk && !fetch) this.carryBoard();
      this.snap = snapNow; this.secondary(dt, mirrorX); this.eyes(dt, ph); this.snap = false;
    }
    this.boardRoot.updateMatrixWorld(true);
    if (this.bxf) {                                 // board handing over: travel from where it was
      const X = this.bxf; X.t += dt; const w = smooth(X.t / X.dur);
      const L = _m.multiplyMatrices(this.board.matrix, this.flipper.matrix).invert();
      this.boardRoot.matrix.copy(blendM(X.M, this.flipper.matrixWorld, w, new THREE.Matrix4())).multiply(L);
      this.boardRoot.matrix.elements[13] += 0.12 * Math.sin(w * Math.PI) * (cat === 'ride' ? 1 : 0);   // lifted over the feet, not dragged through them
      this.boardRoot.updateMatrixWorld(true);
      if (X.t >= X.dur) this.bxf = null;
    }
    this.cat = cat;
    this.prevFwd.copy(ph.fwd); this.prevPos.copy(ph.pos); this.prevState = ph.state; this.prevVisBail = bail;
  }

  // eyes: little flicks from point to point (saccades), leading the head into a turn, and a blink every few seconds
  // (and on a big look round, and when he slams); screwed shut while he tumbles
  eyes(dt, ph) {
    const E = this.EU; if (!E) return;
    const ey = this.ey || (this.ey = { next: 0.6, tx: 0, ty: 0, x: 0, y: 0, v: {}, bt: -1, nb: 2, lead: 0 }), R = Math.random;
    const bail = ph.state === 'bail', lead = bail || ph.state === 'walk' ? 0 : this.eyeLead || 0;
    if ((ey.next -= dt) <= 0) { ey.tx = (R() - 0.5) * 0.22; ey.ty = (R() - 0.6) * 0.12; ey.next = 0.35 + R() * 2.2; }
    if (Math.abs(lead - ey.lead) > 0.3 || (bail && !this.eyeBail)) { if (ey.bt < 0) ey.bt = 0; ey.lead = lead; }
    this.eyeBail = bail;
    spring(ey, 'x', ey.tx + lead, 45, dt); spring(ey, 'y', ey.ty - 0.06, 45, dt);
    if ((ey.nb -= dt) <= 0 && ey.bt < 0) { ey.bt = 0; ey.nb = 1.8 + R() * 4.5; }
    let bl = 0;
    if (ey.bt >= 0) { const t = (ey.bt += dt); bl = t < 0.06 ? smooth(t / 0.06) : 1 - smooth((t - 0.08) / 0.14); if (t > 0.24) ey.bt = -1; }
    if (bail && ph.bail) { const b = ph.bail; bl = Math.max(bl, b.phase === 'tumble' ? 0.85 : b.phase === 'slide' ? 0.6 : b.phase === 'settle' ? 0.3 * (b.severity || 0) : 0); }
    E.uBlink.value = bl; E.uGaze.value.set(Math.sin(ey.x), Math.sin(ey.y), 1).normalize();
  }

  // on foot: the board rides under the carrying arm, gripped by its edge, wheels out
  carryBoard() {
    const g = this.rig, hand = g.sides[1].arm[2].wp, sh = g.sides[1].arm[0].wp, mid = g.spine[1].wp;
    const RB = _m.multiplyMatrices(this.root.matrix, this.body.matrix);
    const out = V(0, 0, sh.z - mid.z); if (out.lengthSq() < 1e-6) out.set(0, 0, 1); out.normalize();   // away from the body, sideways
    const c = hand.clone().addScaledVector(Y, -0.125).addScaledVector(out, 0.03);
    const P0 = c.applyMatrix4(RB), along = V(1, -0.18, 0).transformDirection(RB), inward = out.clone().negate().transformDirection(RB);
    const bx = V().crossVectors(inward, along).normalize(), bz = V().crossVectors(bx, inward).normalize();
    const F = new THREE.Matrix4().makeBasis(bx, inward, bz).setPosition(P0.addScaledVector(inward, -0.0215));
    this.board.rotation.set(0, 0, 0); this.board.position.y = 0; this.flipper.rotation.set(0, 0, 0); this.flipper.position.y = FLIP_PIVOT;
    for (const h of this.hangers) h.g.rotation.set(0, 0, 0);
    this.boardRoot.matrix.copy(F).multiply(_m.makeTranslation(0, -FLIP_PIVOT, 0)); this.boardRoot.matrixWorldNeedsUpdate = true;
  }

  animate(dt, ph, brd, snap, cat, mirrorX) {
    const g = this.rig, P = this.P, bail = ph.state === 'bail', air = ph.state === 'air', ground = ph.state === 'ground';
    this.time += dt; this.snap = false;
    // a different kind of movement (riding, walking, falling) or the feet swapping ends: hand over from the last pose
    if (!snap && this.last && (cat !== this.prevCat || mirrorX !== this.prevMirror)) {
      const A = copyS(this.last, this.lastCurl || [P.curl, P.curl]);
      if (mirrorX !== this.prevMirror) mirrorS(A);
      this.xf = { A, t: 0, dur: cat === 'bail' ? 0.22 : cat === 'walk' || this.prevCat === 'walk' ? 0.3 : 0.26 };
    }
    if (snap) this.xf = null;
    this.prevCat = cat; this.prevMirror = mirrorX;
    if (cat === 'walk') return this.walkPose(dt, ph, snap);
    const B = this.body.matrix, Bi = B.clone().invert(), toBody = this.root.matrix.clone().multiply(B).invert();
    // D: how the board has moved under the feet, in body space
    const D = Bi.clone().multiply(_m.makeRotationFromEuler(new THREE.Euler(brd.pitch, brd.yaw, brd.roll)).setPosition(0, brd.lift, 0)).multiply(B);
    const vel = ph.getVel(V()), sp = vel.length(), vb = vel.clone().transformDirection(toBody);
    const sgn = (ground ? ph.speed : vb.x) < -0.3 ? -1 : 1;
    const yawB = brd.yaw * (T.stance === 'goofy' ? -1 : 1) * (mirrorX ? -1 : 1);

    // ── pick a pose and ease toward it ──
    let name = 'ride';
    const flipping = ph.trick && ph.trick.t < ph.trick.def.dur;
    if (bail) name = 'ride';                                   // what a fall gets up into
    else if (ph.state === 'grind') name = 'grind';
    else if (air) name = ph.grab ? 'grab' : flipping ? 'flip' : 'air';
    else if (ph.crouch) name = 'crouch';
    else if (ph.manual) name = 'manual';
    else if (ph.slide) name = 'slide';
    const tg = { ...POSES[name === 'flip' ? 'air' : name] };
    const wob = Math.sin(this.time * 6.1) * 0.6 + Math.sin(this.time * 9.3 + 1.3) * 0.4;      // small, never-quite-still balance
    const tv = Math.sign(vb.z) || 1;                                                          // sliding sideways: which way (toes or heels) we are travelling
    if (name === 'manual') { const b = ph.manual.bal, d = ph.manual.dir, k = 0.35 + Math.abs(b);
      tg.hipX = -0.1 * d; tg.lean = 0.3 + 0.08 * d; tg.side = -0.1 * d + 0.16 * b + 0.035 * wob * k;
      tg.ly += 0.2 * b + 0.05 * wob * k; tg.ry -= 0.2 * b + 0.05 * wob * k; tg.lx += 0.04 * d; tg.lz += 0.04 * wob * k; }
    if (name === 'slide') { tg.side = -0.18 * sgn; tg.hipX = -0.05 * sgn; tg.lean = 0.2 - 0.38 * tv; tg.hipZ = -0.1 * tv; tg.lz += 0.14 * tv; tg.rz += 0.14 * tv; tg.ly += 0.06; }
    const gn0 = ph.grab && ph.grabE ? ph.grabE.name : '', GP = name === 'grab' && GRAB_POSE[gn0];
    if (GP) Object.assign(tg, GP.body);
    if (name === 'flip') { tg.ly += 0.07; tg.ry += 0.05; tg.lx += 0.03; tg.rx -= 0.03; tg.hipY = 0.63; }
    if (name === 'grind') {                              // each grind and slide has its own body
      const gn = (ph.grind && ph.grind.entry && ph.grind.entry.name) || '';
      tg.side = -brd.pitch * 0.5 + 0.02 * wob; tg.hipX = brd.pitch * 0.3;
      if (/5-0/.test(gn)) { tg.hipX = -0.11; tg.lean = 0.26; tg.lx = 0.3; tg.ly = -0.24; tg.fyaw = 0.45; }
      else if (/Nosegrind/.test(gn)) { tg.hipX = 0.12; tg.lean = 0.55; tg.hipY = 0.6; tg.rx = -0.3; tg.ry = -0.22; }
      else if (/Smith/.test(gn)) { tg.hipX = -0.07; tg.hipY = 0.57; tg.lean = 0.55; tg.hipZ = -0.02; tg.lz = 0.28; tg.ly = -0.22; tg.rx = -0.3; tg.ry = -0.26; }
      else if (/Crooked/.test(gn)) { tg.hipX = 0.1; tg.hipY = 0.6; tg.lean = 0.6; tg.hipZ = 0.04; tg.rx = -0.3; tg.ry = -0.2; tg.lz = 0.24; }
      else if (/slide/.test(gn)) {                      // board across the rail: hips over it, the upper body leads the way
        tg.hipY = 0.64; tg.lean = 0.25 + 0.16 * tv; tg.hipZ = -0.03 * tv; tg.cYaw += 0.3 * tv; tg.pYaw += 0.1 * tv;
        tg.lz = 0.12 + 0.2 * tv; tg.rz = 0.08 - 0.18 * tv; tg.ly = -0.27; tg.ry = -0.3;
        if (/Tail/.test(gn)) tg.hipX = -0.09; else if (/Nose/.test(gn)) tg.hipX = 0.09;
        if (/Lip/.test(gn)) tg.side += 0.06;
      }
    }
    tg.pYaw += yawB * 0.6; tg.cYaw += yawB * 0.35;
    // every channel rides a critically damped spring: no pops when the target jumps, no overshoot
    if (!P.v) P.v = {};
    if (snap) { for (const key of KEYS) { P[key] = tg[key]; P.v[key] = 0; } }
    else { const w = name === 'flip' ? 30 : air ? 17 : 14; for (const key of KEYS) spring(P, key, tg[key], w, dt); }

    // flips: the feet are driven straight from the trick clock (too quick to ease): pop, flick or scoop, tuck, catch
    let { fa, fz, fyaw, flift, fw, ba, bz, byaw, blift, bw } = P;
    let popUp = 0;
    const F0 = { fa, fz, fyaw, flift, ba, bz, byaw, blift };
    if (air && !ph.grab) {
      const pp = ph.popT < 0.24 ? Math.sin(clamp(ph.popT / 0.24, 0, 1) * Math.PI) : 0;    // the snap of the pop: legs straighten, front foot drags up the grip
      popUp = 0.09 * pp; fa += 0.075 * smooth(ph.popT / 0.14) * (ph.trick ? 1 : 1 - smooth((ph.popT - 0.2) / 0.2));
      if (ph.trick && ph.trick.def.dur) {
        const d = ph.trick.def, pr = clamp(ph.trick.t / d.dur, 0, 1.3);
        const pulse = (a, b) => Math.sin(clamp((pr - a) / (b - a), 0, 1) * Math.PI);
        const off = smooth((pr - 0.06) / 0.14) * (1 - smooth((pr - 0.74) / 0.18));
        const r = Math.sign(d.roll || 0);
        if (d.roll) { const fl = pulse(0.08, 0.55); fz -= r * 0.16 * fl; fa += 0.06 * fl; fyaw += r * 0.55 * fl; flift += 0.06 * fl; }   // kickflip: up and off the heel-side corner of the nose; heelflip: heel kicks out over the toes
        if (d.yaw) { const sc = pulse(0.0, 0.38) * (d.roll ? 0.6 : 1); bz -= Math.sign(d.yaw) * 0.13 * sc; ba -= 0.06 * sc; byaw -= Math.sign(d.yaw) * 0.4 * sc; }   // the back foot scoops the tail round
        if (d.pitch) {          // impossible: the wrapping foot stays put as the axle, the other one lifts out of the board's way
          const rise = 0.056 * Math.sin(clamp(pr, 0, 1) * Math.PI), out = off * 1.1;
          if (ph.nollie) { fa = 0.2; flift = rise; fyaw = 0.1; ba -= 0.04 * out; bz += 0.24 * out; blift += 0.12 * out; }
          else { ba = -0.2; blift = rise; byaw = 0; fa += 0.03 * out; fz += 0.24 * out; flift += 0.14 * out; }
        } else { flift = Math.max(flift, 0.19 * off); blift = Math.max(blift, 0.17 * off); }
        fw = clamp(1 - smooth(pr / 0.1) + smooth((pr - 0.8) / 0.12), 0, 1);       // the front foot catches first
        bw = clamp(1 - smooth((pr - 0.03) / 0.1) + smooth((pr - 0.86) / 0.12), 0, 1);
      }
    }
    // what the trick clock added to the feet: followed exactly in the air, eased away after (no snap on landing)
    { const fo = this.footOff || (this.footOff = { v: {} }), cur = { fa, fz, fyaw, flift, ba, bz, byaw, blift };
      for (const key in F0) { const d = cur[key] - F0[key];
        if (air || snap) { fo[key] = d; fo.v[key] = 0; } else spring(fo, key, 0, 26, dt); }
      ({ fa, fz, fyaw, flift, ba, bz, byaw, blift } = Object.fromEntries(Object.keys(F0).map((key) => [key, F0[key] + fo[key]]))); }
    // feet-off grabs: physics says how far off (ph.feet.off); the feet kick out to the grab's spots and come back
    const FP = ph.feet && GRAB_POSE[ph.feet.name], toeP = [0, 0];
    if (FP) this.fkPose = FP;
    { const o = this.fkS || (this.fkS = { k: 0, v: {} }); if (snap) { o.k = FP ? smooth(ph.feet.off) : 0; o.v.k = 0; } else spring(o, 'k', FP ? smooth(ph.feet.off) : 0, 28, dt); }
    const fk = clamp(this.fkS.k, 0, 1);
    if (fk > 0.002 && this.fkPose) {
      const G = this.fkPose, at = (x) => (typeof x === 'function' ? x(this.time) : x);
      if (G.f) { const t = at(G.f); fa = lerp(fa, t[0], fk); flift = lerp(flift, t[1], fk); fz = lerp(fz, t[2], fk); fyaw = lerp(fyaw, t[3], fk); fw *= 1 - fk; toeP[0] = t[4] * fk; }
      if (G.b) { const t = at(G.b); ba = lerp(ba, t[0], fk); blift = lerp(blift, t[1], fk); bz = lerp(bz, t[2], fk); byaw = lerp(byaw, t[3], fk); bw *= 1 - fk; toeP[1] = t[4] * fk; }
    } else if (fk <= 0.002) this.fkPose = null;
    // hippie jump: up off the deck, knees tuck at the top, back down onto the bolts
    const hip = ph.hippie && ground ? Math.max(0, ph.hippie.y || 0) : 0;
    this.hipJ = snap ? hip : hip > (this.hipJ || 0) ? hip : (this.hipJ || 0) + (hip - (this.hipJ || 0)) * (1 - Math.exp(-30 * dt));
    if (this.hipJ > 0.002) { const hw = smooth(this.hipJ / 0.04), tuck = 0.12 * smooth(this.hipJ / 0.35);
      fw *= 1 - hw; bw *= 1 - hw; flift = Math.max(flift, this.hipJ + tuck); blift = Math.max(blift, this.hipJ + tuck); }
    const spinRate = air && dt > 0 ? (ph.spin - (this.prevSpin || 0)) / dt : 0; this.prevSpin = air ? ph.spin : 0;
    this.spinLead = (this.spinLead || 0) + ((snap ? 0 : clamp(spinRate * 0.07, -0.55, 0.55) * (T.stance === 'goofy' ? -1 : 1)) - (this.spinLead || 0)) * (1 - Math.exp(-9 * dt));

    // knees soak up landings and bumps
    if (snap) { this.comp = this.compV = 0; this.prevY = ph.pos.y; this.vy = 0; }
    if (this.prevState === 'air' && ground) this.compV += ph.landing && ph.landing.impact != null ? 0.5 + 2 * ph.landing.impact : clamp(-ph.vel.y * 0.3, 0, 2.6);
    if (this.prevHip > 0.01 && !this.hipJ) this.compV += 1;
    this.prevHip = this.hipJ;
    const bump = ph.bump || 0; if (bump > (this.prevBump || 0) + 0.01) this.compV += (bump - (this.prevBump || 0)) * 1.6; this.prevBump = bump;
    if (ground && dt > 0) { const vy = (ph.pos.y - this.prevY) / dt; this.compV += clamp((vy - this.vy) * 0.12, -0.6, 0.6); this.vy = vy; } else this.vy = 0;
    this.prevY = ph.pos.y;
    const h = Math.min(dt, 1 / 60); this.compV += (-150 * this.comp - 17 * this.compV) * h; this.comp = clamp(this.comp + this.compV * h, -0.04, 0.3);

    // ── pushing ──
    const ps = this.push, phase = ground && !bail ? ph.pushPhase : -1;
    const backDeck = V(P.ba, deckY(P.ba), P.bz).applyMatrix4(D);
    if (snap) { ps.on = false; ps.w = 0; ps.since = 9; this.pushW = 0; }
    if (phase >= 0) {
      if (!ps.on || phase < ps.last - 0.3) {            // a new stroke: start from wherever the foot is right now
        ps.s0.copy(ps.w > 0 ? ps.cur : backDeck); ps.on = true; ps.w = 1; ps.dir = ph.pushDir || 1;
        ps.L = clamp(Math.abs(ph.speed) * (PUSH_OFF - PUSH_ON) * (ph.pushDur ?? PUSH_DUR), 0.5, 0.85);
      }
      ps.last = phase; ps.since = 0;
      const L = ps.L, xr = 0.3, xo = xr - L, vs = L / (PUSH_OFF - PUSH_ON), zp = 0.215, c = ps.cur;
      if (phase < PUSH_ON) {                             // step off and reach forward beside the board
        const s = phase / PUSH_ON;
        c.set(hermite(ps.s0.x * ps.dir, 0, xr, -vs * PUSH_ON * 0.7, s), lerp(ps.s0.y, 0, smooth(s)) + 0.05 * Math.sin(s * Math.PI), lerp(ps.s0.z, zp, smooth(s * 1.5)));
        ps.pitch = lerp(ps.pitch, -0.12 * Math.sin(s * Math.PI), 0.5);
      } else if (phase < PUSH_OFF) {                     // planted: the ground carries the foot back past the board
        const u = (phase - PUSH_ON) / (PUSH_OFF - PUSH_ON);
        c.set(xr - L * u, 0, zp); ps.pitch = 0.75 * smooth((u - 0.45) / 0.55);
      } else {                                           // lift and swing forward again
        const s = (phase - PUSH_OFF) / (1 - PUSH_OFF), d = 1 - PUSH_OFF;
        c.set(hermite(xo, -vs * d * 0.6, -0.12, 0.9 * d, s), lerp(0, 0.16, smooth(s)), lerp(zp, 0.15, smooth(s))); ps.pitch = lerp(0.75, 0.2, smooth(s));
      }
      c.x *= ps.dir;
    } else if (ps.w > 0) {
      if (ps.on) { ps.on = false; ps.end.copy(ps.cur); ps.since = 0; ps.ret = null; }
      ps.since += dt; ps.last = -1;
      const hover = ground ? HOVER : 0;
      if (ps.since < hover) { ps.cur.copy(ps.end); ps.cur.x += ps.dir * 0.75 * ps.since * (1 - 0.5 * ps.since / hover); ps.cur.y += 0.02 * ps.since / hover; }   // carry on forward in case another stroke follows
      else {                                             // no more pushing: step back onto the tail bolts
        const r = (ps.since - hover) / RETURN;
        if (r >= 1) ps.w = 0;
        else { if (!ps.ret) ps.ret = ps.cur.clone(); ps.cur.lerpVectors(ps.ret, backDeck, smooth(r)); ps.cur.y += 0.035 * Math.sin(r * Math.PI); ps.pitch *= 1 - smooth(r); }
      }
    }
    const stroking = phase >= 0 || (ps.w > 0 && ps.since < HOVER + 0.02);
    this.pushW += ((stroking ? 1 : 0) - this.pushW) * (snap ? 1 : 1 - Math.exp(-(stroking ? 11 : 7) * dt));
    const u = clamp((phase - PUSH_ON) / (PUSH_OFF - PUSH_ON), 0, 1);
    const swingT = phase < 0 ? 0.5 : phase < PUSH_ON ? 1 : phase < PUSH_OFF ? Math.cos(u * Math.PI) : lerp(-1, 0.3, (phase - PUSH_OFF) / (1 - PUSH_OFF));
    this.swing += (swingT - this.swing) * (1 - Math.exp(-14 * dt));
    this.dip += ((phase >= PUSH_ON * 0.4 && phase < PUSH_OFF ? Math.sin(clamp((phase - PUSH_ON * 0.4) / (PUSH_OFF - PUSH_ON * 0.4), 0, 1) * Math.PI) : 0) - this.dip) * (1 - Math.exp(-12 * dt));
    const pw = smooth(this.pushW), pw0 = pw, sw = this.swing, fwdPush = ps.dir > 0;

    // ── targets for the solver ──
    const st = this.steer, speedTuck = ground ? Math.min(0.05, Math.abs(ph.speed) * 0.004) : 0;
    // standing still: breathing deepens, the weight drifts slowly from foot to foot, the shoulders settle (never a frozen statue)
    const still = ground && !ph.manual && !ph.slide ? 1 - smooth((Math.abs(ph.speed) - 0.15) / 0.6) : 0;
    this.idleW = snap ? still : (this.idleW || 0) + (still * (1 - pw0) - (this.idleW || 0)) * (1 - Math.exp(-2.5 * dt));
    const iw = this.idleW, drift = Math.sin(this.time * 0.53) * 0.7 + Math.sin(this.time * 0.29 + 1.1) * 0.3;
    const breathe = Math.sin(this.time * (1.7 - 0.5 * iw)) * (0.004 + 0.006 * iw);
    // a sketchy landing: arms wheel, the hips drop and sway, for about a second
    const Ld = ph.landing, skT = Ld && Ld.quality === 'sketchy' && ground ? Math.pow(clamp(1 - (Ld.age ?? 9) / 1.1, 0, 1), 1.2) : 0;
    this.skW = snap ? 0 : (this.skW || 0) + (skT - (this.skW || 0)) * (1 - Math.exp(-14 * dt));
    const wobA = ground ? clamp(ph.wobble || 0, 0, 1) : 0, sk = this.skW;
    // reverts: the shoulders lead the board round
    const mir = (T.stance === 'goofy' ? -1 : 1) * (mirrorX ? -1 : 1), dRev = (brd.revert || 0) - (this.prevRev || 0); this.prevRev = brd.revert || 0;
    const revRate = dt > 0 && Math.abs(dRev) < 1 ? dRev / dt : 0;
    this.revLead = snap ? 0 : (this.revLead || 0) + (clamp(revRate * 0.09 * mir, -0.7, 0.7) - (this.revLead || 0)) * (1 - Math.exp(-12 * dt));
    const shake = sk * 0.12 * Math.sin(this.time * 8.5) + wobA * 0.06 * Math.sin(this.time * 15.3) * Math.sin(this.time * 4.1 + 1);
    const hipY = lerp(P.hipY, 0.8, pw) - this.comp - speedTuck - Math.abs(st) * 0.12 - pw * (0.035 + 0.06 * this.dip) + breathe - sk * 0.06 - wobA * 0.05;
    const lean = lerp(P.lean, 0.3 + 0.1 * this.dip, pw) + st * 0.9 + this.comp * 0.7 + speedTuck * 2 + sk * 0.12 * Math.sin(this.time * 6.3 + 0.5);
    const pYaw = lerp(P.pYaw, fwdPush ? 1.02 + 0.2 * sw : -0.45, pw) + this.spinLead * 0.35 + this.revLead * 0.4, cYaw = lerp(P.cYaw, fwdPush ? 1.08 - 0.24 * sw : -0.35, pw) + this.spinLead + this.revLead;
    const S = { H: V(lerp(P.hipX, 0.12 * ps.dir, pw) + 0.035 * iw * drift, DECK + hipY - 0.012 * iw * Math.abs(drift), lerp(P.hipZ, 0.01, pw) + st * 0.16), ank: [V(), V()], fn: [V(), V()], ff: [V(), V()], toe: [0, 0], kpole: [V(), V()], hand: [V(), V()], epole: [V(), V()] };
    S.H.y += brd.lift * 0.5 + popUp + (this.hipJ || 0);
    S.Qp = turn(pYaw, lean * 0.35, (P.side + shake - 0.09 * iw * drift) * 0.5); S.Qc = turn(cYaw + 0.05 * iw * Math.sin(this.time * 0.41), lean - 0.04 * iw + breathe * 2 * iw, P.side + shake + 0.04 * iw * drift);
    // head: look where you are going
    const want = sp > 0.6 ? V(vb.x, 0, vb.z).normalize() : V(sgn, 0, 0);
    this.look.lerp(want, snap ? 1 : 1 - Math.exp(-6 * dt)); if (this.look.lengthSq() < 1e-4) this.look.copy(want);
    let rel = Math.atan2(this.look.x, this.look.z) - cYaw; rel = Math.atan2(Math.sin(rel), Math.cos(rel));
    const hy = cYaw + clamp(rel, -1.25, 1.25);
    this.headYaw = snap ? hy : this.headYaw + (hy - this.headYaw) * (1 - Math.exp(-9 * dt));
    this.eyeLead = clamp(hy - this.headYaw, -0.45, 0.45);                           // the eyes get there first
    S.Qh = turn(this.headYaw, lean * 0.25 + (air ? 0.22 : 0.06) + (ph.crouch ? 0.1 : 0), P.side * 0.3);

    // feet: stuck to the deck (wherever the board tilts) or lifted clear of it
    const foot = (i, along, zz, yawF, liftF, w) => {
      const free = V(along, deckY(along) + liftF, zz), on = V(along, deckY(along), zz).applyMatrix4(D);
      const sole = free.lerp(on, w), f = V(Math.sin(yawF), 0, Math.cos(yawF));
      S.ff[i].copy(f).lerp(f.clone().transformDirection(D), w).normalize();
      S.fn[i].copy(Y).lerp(V(0, 1, 0).transformDirection(D), w).normalize();
      return sole;
    };
    const soles = [foot(0, fa, fz, lerp(fyaw, fwdPush ? 1.2 : -0.5, pw), flift, fw), foot(1, ba, bz, byaw, blift, bw)];
    if (ps.w > 0) {                                      // the pushing foot follows its own path
      const yawF = (fwdPush ? 1.4 : -1.4) * this.pushW + P.byaw * (1 - this.pushW), f = V(Math.sin(yawF), 0, Math.cos(yawF)), c = Math.cos(ps.pitch), s = Math.sin(ps.pitch);
      soles[1].copy(ps.cur); soles[1].y += 0.075 * Math.max(0, s);
      S.ff[1].copy(f).multiplyScalar(c).addScaledVector(Y, -s); S.fn[1].copy(Y).multiplyScalar(c).addScaledVector(f, s); S.toe[1] = Math.max(0, ps.pitch) * 0.9;
    }
    for (let i = 0; i < 2; i++) if (toeP[i] > 0) {          // a kicked-out foot points its toes (ankle extended), not flat like on the deck
      const a = toeP[i] * 0.9, f = S.ff[i].clone(), c = Math.cos(a), sn = Math.sin(a);
      S.ff[i].copy(f).multiplyScalar(c).addScaledVector(Y, -sn).normalize(); S.fn[i].copy(Y).multiplyScalar(c).addScaledVector(f, sn).normalize(); S.toe[i] = Math.max(S.toe[i], toeP[i] * 0.3);
    }
    for (let i = 0; i < 2; i++) {
      S.ank[i].copy(soles[i]).addScaledVector(S.fn[i], g.ankleH).addScaledVector(S.ff[i], -g.footBack);
      S.kpole[i].copy(S.ff[i]).addScaledVector(X, (i ? -0.5 : 0.5) * (1 - pw)).addScaledVector(Y, 0.2);
    }

    // hands: hanging/balancing off the shoulders, or holding the board in a grab
    this.spineFK(S);
    const yq = turn(cYaw), gh = ph.grab && ph.grabE ? ph.grabE.hand : '';
    const free = [V(P.lx, P.ly, P.lz), V(P.rx, P.ry, P.rz)];
    if (sk > 0.01 || wobA > 0.01) for (let i = 0; i < 2; i++) {            // wheel the arms to catch the balance
      const a = this.time * 12.5 + i * 2.6, r = 0.16 * sk;
      free[i].x += (i ? -1 : 1) * (0.06 * sk + 0.1 * wobA); free[i].y += r * Math.sin(a) + 0.16 * sk + 0.12 * wobA; free[i].z += r * Math.cos(a) + 0.05 * wobA * Math.sin(this.time * 17 + i);
    }
    if (this.hipJ) { const u = smooth(this.hipJ / 0.25); free[0].y += 0.14 * u; free[1].y += 0.12 * u; }
    if (pw > 0) { free[0].lerp(V(0.06, -0.44 + 0.05 * Math.abs(sw), 0.07 + 0.2 * sw), pw); free[1].lerp(V(-0.06, -0.44 + 0.05 * Math.abs(sw), 0.07 - 0.2 * sw), pw); }
    const sway = (ground ? 0.014 : 0.008) * Math.sin(this.time * 2.3) + 0.006 * wob;
    const grabAt = gh === 'both' ? [V(0.31, deckY(0.31) + 0.01, 0.07), V(-0.31, deckY(-0.31) + 0.01, 0.07)] : [V(0.03, DECK, -0.1), V(-0.02, DECK, 0.1)];
    if (GP && GP.hand) GP.hand.forEach((h, i) => { if (h) grabAt[i] = V(h[0], deckY(h[0]) + h[1], h[2]); });
    const curl = [0, 0], shift = V();
    for (let pass = 0; pass < 3 && gh; pass++) {           // a grab: fold forward until the hand can get there
      let need = 0;
      for (let i = 0; i < 2; i++) if (gh === 'both' || gh === (i ? 'back' : 'front')) need = Math.max(need, grabAt[i].clone().applyMatrix4(D).distanceTo(g.sides[i].arm[0].wp) - g.armLen * 0.97 - 0.07);
      this.reach += (clamp(this.reach + need * 1.5, 0, 0.6) - this.reach) * (1 - Math.exp(-12 * dt / 3));
      S.Qp = turn(pYaw, (lean + this.reach) * 0.35, P.side * 0.5); S.Qc = turn(cYaw, lean + this.reach, P.side); this.spineFK(S);
    }
    if (!gh && this.reach) { this.reach *= Math.exp(-9 * dt); S.Qp = turn(pYaw, (lean + this.reach) * 0.35, P.side * 0.5); S.Qc = turn(cYaw, lean + this.reach, P.side); this.spineFK(S); }
    for (let i = 0; i < 2; i++) {
      const sh = g.sides[i].arm[0].wp, want = gh === 'both' || gh === (i ? 'back' : 'front') ? 1 : 0;
      this.grabW[i] += (want - this.grabW[i]) * (snap ? 1 : 1 - Math.exp(-(want ? 13 : 9) * dt));
      const w = smooth(this.grabW[i]);
      S.hand[i].copy(free[i]).applyQuaternion(yq).add(sh); S.hand[i].y += sway * (i ? -1 : 1) - this.comp * 0.3; S.hand[i].x += 0.01 * Math.sin(this.time * 1.7 + i * 2);
      S.epole[i].set(i ? -0.35 : 0.35, -0.5, -0.8); if (GP && GP.epole && GP.epole[i]) S.epole[i].set(...GP.epole[i]); S.epole[i].applyQuaternion(yq);
      if (w > 0.001) {
        const G = grabAt[i].applyMatrix4(D), d = V().subVectors(G, sh), over = d.length() - g.armLen * 0.97 - 0.07;
        if (over > 0) shift.addScaledVector(d.normalize(), over * w * (gh === 'both' ? 0.5 : 1));          // can't reach: bring the body down to the board
        S.hand[i].lerp(G.addScaledVector(V().subVectors(sh, G).normalize(), 0.075), w);
      }
      curl[i] = lerp(P.curl, 1.1, w);
    }
    if (shift.lengthSq() > 0) { shift.clampLength(0, 0.3); S.H.add(shift); S.H.y = Math.max(S.H.y, DECK + 0.36); for (let i = 0; i < 2; i++) if (this.grabW[i] < 0.5) S.hand[i].add(shift); }
    // palms: toward the legs when the arms hang, face down when they are out for balance or holding the board
    S.palm = [0, 1].map((i) => {
      const sh = g.sides[i].arm[0].wp, h = S.hand[i], mid = g.spine[1].wp;
      const inward = V(mid.x - h.x, 0, mid.z - h.z); if (inward.lengthSq() < 1e-6) inward.set(0, 0, -1); inward.normalize();
      const down = Math.max(smooth((h.y - (sh.y - 0.5)) / 0.35), smooth(this.grabW[i]));
      return inward.multiplyScalar(1 - down).addScaledVector(Y, -down - 0.2).normalize();
    });
    // never over-stretch or fold a leg: move the hips instead
    for (let pass = 0; pass < 2; pass++) for (let i = 0; i < 2; i++) {
      const hip = V(i ? -1 : 1, 0, 0).multiplyScalar(g.sides[0].leg[0].wp0.x - 0).applyQuaternion(S.Qp).add(S.H), d = hip.sub(S.ank[i]), len = d.length();
      if (len > g.legLen * 0.985) S.H.addScaledVector(d, -(len - g.legLen * 0.985) / len * (i === 1 && ps.w > 0 ? 0.5 : 1));
      else if (len < 0.3) S.H.addScaledVector(d, (0.3 - len) / (len || 1));
    }

    if (bail) this.fall(S, curl, ph, dt);
    this.finish(S, curl, dt);
  }

  // hand over from the previous movement if one is fading out, then pose the skeleton
  finish(S, curl, dt) {
    if (this.xf) { const X = this.xf; X.t += dt; const w = smooth(X.t / X.dur); if (w < 1) blendS(S, X.A, w, curl); else this.xf = null; }
    this.solve(S, curl);
    this.last = S; this.lastCurl = [curl[0], curl[1]];
  }

  // ── on foot: a walk that becomes a run, the board under the right arm ──
  // Stride length comes from the speed, so a planted foot never skates over the ground.
  walkPose(dt, ph, snap) {
    const fe = ph.bail && ph.bail.fetch, g = this.rig, w = ph.walk || (fe ? { speed: fe.v, grounded: true, vy: 0 } : { speed: 0, grounded: true, vy: 0 }), v = Math.max(0, w.speed || 0), TAU = Math.PI * 2;
    const W = this.wk || (this.wk = { ph: 0, run: 0, air: 0 });
    if (snap) { W.run = smooth((v - 2.1) / 1.6); W.air = w.grounded ? 0 : 1; this.comp = this.compV = 0; }
    W.run += (smooth((v - 2.1) / 1.6) - W.run) * (1 - Math.exp(-6 * dt));
    W.air += ((w.grounded ? 0 : 1) - W.air) * (1 - Math.exp(-14 * dt));
    if (W.wasAir && w.grounded) this.compV += clamp(-(W.vy || 0) * 0.25, 0.4, 2);
    W.wasAir = !w.grounded; W.vy = w.vy || 0;
    const hh = Math.min(dt, 1 / 60); this.compV += (-150 * this.comp - 17 * this.compV) * hh; this.comp = clamp(this.comp + this.compV * hh, -0.04, 0.2);
    const r = W.run, f = lerp(0.55 + 0.32 * Math.min(v, 1.8), 1.42, r), beta = lerp(0.6, 0.34, r);   // cycles a second; share of the cycle a foot is down
    W.ph = (W.ph + f * dt) % 1;
    const L = v * beta / f, amp = smooth(v / 0.45), air = W.air;
    const S = { H: V(), ank: [V(), V()], fn: [V(), V()], ff: [V(), V()], toe: [0, 0], kpole: [V(), V()], hand: [V(), V()], epole: [V(), V()] };
    for (let i = 0; i < 2; i++) {                        // i = 0 left foot (-z), 1 right foot (+z); each half a cycle apart
      const p = (W.ph + i * 0.5) % 1, zz = (i ? 1 : -1) * lerp(0.1, 0.085, r);
      let x, y = 0, pitch;
      if (p < beta) { const s = p / beta; x = L / 2 - L * s;                       // planted: the ground carries it back under you
        pitch = (lerp(0.22, 0, smooth(s / 0.2)) * (1 - r) - lerp(0.55, 0.35, r) * smooth((s - 0.62) / 0.38)) * amp; }
      else { const s = (p - beta) / (1 - beta), m = -v * (1 - beta) / f * 0.35;   // swing it through
        x = hermite(-L / 2, m, L / 2, m * 0.5, s); y = amp * lerp(0.075, 0.24, r) * Math.sin(Math.PI * Math.pow(s, lerp(0.85, 0.6, r)));
        pitch = lerp(-0.5, 0.2 * (1 - r), smooth(s)) * amp; }
      x += lerp(0.02, 0.06, r) * amp;
      x = lerp(x, i ? -0.08 : 0.12, air); y = lerp(y, 0.2 + (i ? 0.06 : 0), air); pitch = lerp(pitch, i ? -0.3 : 0.1, air);
      const ff = V(Math.cos(pitch), Math.sin(pitch), 0), fn = V(-Math.sin(pitch), Math.cos(pitch), 0);
      const centre = pitch > 0 ? V(x - 0.11, y, zz).addScaledVector(ff, 0.11) : V(x + 0.08, y, zz).addScaledVector(ff, -0.08);   // rock on the heel, peel off the ball
      S.ank[i].copy(centre).addScaledVector(fn, g.ankleH).addScaledVector(ff, -g.footBack);
      S.ff[i].copy(ff); S.fn[i].copy(fn); S.toe[i] = Math.max(0, -pitch) * 0.9 * (1 - air);
      S.kpole[i].set(1, 0.15, zz * 0.6).normalize();
    }
    const bobW = 0.5 + 0.5 * Math.cos(2 * TAU * W.ph), bobR = 0.5 + 0.5 * Math.cos(2 * TAU * (W.ph - beta / 2));
    const pel = -lerp(0.11, 0.17, r) * Math.cos(TAU * W.ph) * amp;                       // the hip of the leading leg comes forward
    // lean into speeding up, sit back to slow down (smoothed, so a stride doesn't jerk the trunk)
    const acc = dt > 0 && W.v0 !== undefined && !snap ? (v - W.v0) / dt : 0; W.v0 = v;
    W.acc = snap ? 0 : (W.acc || 0) + (clamp(acc, -8, 8) - (W.acc || 0)) * (1 - Math.exp(-5 * dt));
    const lean = lerp(0.05, 0.22, r) * amp + clamp(W.acc * 0.035, -0.12, 0.2) + air * 0.12 + this.comp * 0.8 + Math.sin(this.time * 1.7) * 0.01;
    S.H.set(lerp(0, 0.05, r) * amp, g.hip0 * lerp(0.975, 0.962, r) - amp * lerp(0.022 * bobW, 0.03 * bobR, r) - air * 0.1 - this.comp,
      -0.022 * amp * (1 - 0.5 * r) * Math.sin(TAU * W.ph));
    S.Qp = turn(Math.PI / 2 + pel, lean * 0.4, 0.05 * amp * Math.sin(TAU * W.ph)); S.Qc = turn(Math.PI / 2 - pel * 0.7, lean, 0);
    S.Qh = turn(Math.PI / 2 - pel * 0.2, 0.04 - lean * 0.45, 0);
    this.spineFK(S);
    const yq = turn(Math.PI / 2 - pel * 0.7), curl = [lerp(0.35, 0.65, r), this.carrying ? 1.05 : lerp(0.35, 0.65, r)];
    for (let i = 0; i < 2; i++) {
      const sh = g.sides[i].arm[0].wp, sw = -Math.cos(TAU * W.ph) * (i ? -1 : 1);    // an arm swings forward with the opposite leg
      const o = i === 1 && this.carrying ? V(-0.1 - 0.02 * r, -0.45 + 0.03 * r, 0.04 + 0.02 * sw * amp)  // the carrying arm stays put, board clear of the leg
        : V(0.07 + 0.03 * r + 0.05 * air, lerp(-0.52, -0.3, r) + 0.05 * Math.max(0, sw) * amp + air * 0.22, lerp(0.02, 0.07, r) + sw * lerp(0.15, 0.26, r) * amp);
      if (i === 1 && !this.carrying) o.x = -o.x;                                       // empty-handed: both arms swing
      S.hand[i].copy(o).applyQuaternion(yq).add(sh);
      S.epole[i].set(i ? -0.35 : 0.35, -0.4, -0.8).applyQuaternion(yq);
    }
    S.palm = [0, 1].map((i) => { const h = S.hand[i], mid = g.spine[1].wp, d = V(mid.x - h.x, 0, mid.z - h.z); if (d.lengthSq() < 1e-6) d.set(0, 0, -1); return d.normalize().addScaledVector(Y, -0.2).normalize(); });
    this.finish(S, curl, dt);
  }

  // ── bailing ──
  // Physics throws the body as a ball (BODY_R) and the board on its own, each with momentum and spin, and lets them bounce, slide
  // and settle on whatever they hit (phys.bail). Here the rider hangs on that ball: his hips ride it and he turns with it, a contact
  // pass keeps trunk and head resting on top of the real surface (slopes, bowl walls, stair edges), the limbs flail in the air and
  // splay out onto the ground (hands and feet found by raycast, so nothing sinks into a slope), and the get-up lifts him off the
  // ground into his stance exactly where physics will put him back on the board.

  // height of world point p above the surface below it (along -n), and that surface's normal; the plane through `fb` if the ray misses
  groundAt(ph, p, n, fb) {
    _g0.copy(p).addScaledVector(n, 0.7); _g1.copy(n).negate();
    const h = ph.cast(_g0, _g1, 2.2);
    if (h && !h.back) return h.dist - 0.7;
    return _g0.subVectors(p, fb).dot(n);
  }

  // the root frame for a fall: the ball's place and turn, rolled onto the back or the front once he is down
  bailFrames(ph, dt) {
    const b = ph.bail, R = this.root.matrix;
    if (!b || !b.bodyPos || !b.bodyQuat) { this.bl = null; return; }
    let BL = this.bl;
    if (!BL) {                                     // the slam: hang wherever he is now on the ball, so nothing jumps
      const G0 = b.bodyQuat, Rq = Q().setFromRotationMatrix(R);       // (mid-flip, mid-spin: whatever way up he is)
      const off = V().setFromMatrixPosition(R).add(V(0, BAIL_C, 0).applyQuaternion(Rq)).sub(b.bodyPos).applyQuaternion(G0.clone().invert());
      BL = this.bl = { offL: off, offQ: G0.clone().invert().multiply(Rq), corr: 0, wG: 0, side: 0, sup: 0, rollW: 0, v: {}, lim: null, seed: Math.random() * 40, t: 0,
        Rraw: new THREE.Matrix4(), n: V(0, 1, 0), frozen: null, Rs: null };
    }
    BL.t = typeof b.t === 'number' ? b.t : BL.t + dt;
    const n = BL.n.copy(b.surfaceNormal || Y).normalize(), G = b.bodyQuat;
    // how near the ground the ball is: 1 lying on it, 0 thrown clear
    const wGt = 1 - smooth((this.groundAt(ph, b.bodyPos, n, ph.pos) - BODY_R) / 0.3);
    spring(BL, 'wG', wGt, wGt > BL.wG ? 16 : 7, dt);
    // physics only lays the long axis flat; which side he lies on is free (the ball is round), so settle onto the back or the front
    const a = V(0, 1, 0).applyQuaternion(G), face = V(T.stance === 'goofy' ? 1 : -1, 0, 0).applyQuaternion(G);
    const fp = face.addScaledVector(a, -face.dot(a)), up = n.clone().addScaledVector(a, -n.dot(a)), ul = up.length();
    let ang = 0;
    if (fp.lengthSq() > 1e-4 && ul > 1e-3) {
      fp.normalize(); up.multiplyScalar(1 / ul);
      const d = fp.dot(up);
      if (!BL.side || BL.side * d < -0.35) BL.side = d >= 0 ? 1 : -1;      // +1 on his back, -1 on his front; sticky
      up.multiplyScalar(BL.side); ang = Math.atan2(_g0.crossVectors(fp, up).dot(a), fp.dot(up));
    }
    spring(BL, 'rollW', BL.wG * (b.phase === 'tumble' ? 0.6 : 1) * smooth(ul / 0.6), 6, dt);
    spring(BL, 'sup', BL.side || 1, 5, dt);
    const k = 1 - smooth(BL.t / 0.5);                // the offset from the slam (place and turn) melts into the ball
    const Gv = Q().setFromAxisAngle(a, ang * BL.rollW).multiply(G).multiply(Q().slerp(BL.offQ, k));
    _p0.copy(BL.offL).applyQuaternion(G).multiplyScalar(k).add(b.bodyPos);
    BL.Rraw.compose(_p0, Gv, _s.set(1, 1, 1)).multiply(_m.makeTranslation(0, -BAIL_C, 0));
    if (b.phase === 'getup' && !BL.frozen) {       // freeze where he lies; get up toward where physics will stand him
      BL.frozen = { Rl: R.clone(), F: this.last ? copyS(this.last, this.lastCurl || [0.4, 0.4]) : null };
      BL.Rs = this.predictStand(ph, b);
    }
    if (BL.frozen) R.copy(BL.Rs);
    else { R.copy(BL.Rraw); R.elements[12] += n.x * BL.corr; R.elements[13] += n.y * BL.corr; R.elements[14] += n.z * BL.corr; }
  }

  // where physics' recover() will put him back on his board (same rules: nearest clear level spot, not facing a wall)
  predictStand(ph, b) {
    if (b.stand && b.face) { const f = b.face.clone().setY(0).normalize(); return new THREE.Matrix4().makeBasis(V().crossVectors(Y, f).normalize(), Y, f).setPosition(b.stand); }
    let at = null;
    try { at = ph.safeSpot ? ph.safeSpot(b.bodyPos) : null; } catch (e) { at = null; }
    const head = (b.heading || ph.fwd).clone().setY(0); if (head.lengthSq() < 1e-6) head.set(1, 0, 0); head.normalize();
    if (at) { const w = ph.cast(at.clone().add(V(0, 0.3, 0)), head, 2.5); if (w && w.normal.y < 0.5) head.negate(); }
    else { const h = ph.history, s = (h && h[Math.max(0, h.length - 6)]) || ph.park.spawn; at = s.pos.clone(); head.copy(s.fwd).setY(0).normalize(); }
    return new THREE.Matrix4().makeBasis(V().crossVectors(Y, head).normalize(), Y, head).setPosition(at);
  }

  // the board in a fall: physics' board ball, resting on its wheels or its nose and tail, then brought back under his feet
  bailBoard(ph, dt) {
    const b = ph.bail, BL = this.bl, R = this.boardRoot.matrix;
    if (!b || !b.boardPos || !b.boardQuat) return;
    R.compose(b.boardPos, b.boardQuat, _s.set(1, 1, 1)).multiply(_m.makeTranslation(0, -BOARD_C, 0));
    // never through the ground: the lowest of wheels, kicks and deck edges sits on the surface once it is down
    const h = ph.cast(_g0.copy(b.boardPos).add(V(0, 0.4, 0)), _g1.set(0, -1, 0), 1.2);
    if (h && !h.back) {
      let lo = 9; for (const p of BOARD_PTS) lo = Math.min(lo, _g0.copy(p).applyMatrix4(R).sub(h.point).dot(h.normal));
      const sh = b.boardGround ? -lo : Math.max(0, -lo);
      if (Math.abs(sh) < 0.15) { R.elements[12] += h.normal.x * sh; R.elements[13] += h.normal.y * sh; R.elements[14] += h.normal.z * sh; }
    }
    // the slam: the board starts from wherever it was (mid-flip, tilted on a rail) and eases into physics' board, no snap
    if (this.bb0) { const X0 = _mi.copy(R).invert().multiply(this.bb0).multiply(_m.makeTranslation(0, -FLIP_PIVOT, 0)), p = V(), q = Q();
      X0.decompose(p, q, _s); this.bbX = { p, q, t: 0 }; this.bb0 = null; }
    if (this.bbX) { const X = this.bbX; X.t += dt; const k = 1 - smooth(X.t / 0.4);
      if (k <= 0) this.bbX = null; else R.multiply(_m.compose(X.p.clone().multiplyScalar(k), Q().slerp(X.q, k), _s.set(1, 1, 1))); }
  }

  // a foot (ankle, as a ball) that has ended up inside the board's box is pushed out the shortest way, and stops moving into it
  offBoard(st, b) {
    const Mb = new THREE.Matrix4().compose(b.boardPos, b.boardQuat, V(1, 1, 1)).multiply(new THREE.Matrix4().makeTranslation(0, -BOARD_C, 0));
    const l = st.p.clone().applyMatrix4(Mb.clone().invert()), r = 0.07;
    const px = 0.105 + r - Math.abs(l.x), up = 0.1 + r - l.y, dn = l.y + 0.01 + r, pz = 0.41 + r - Math.abs(l.z);
    if (px <= 0 || up <= 0 || dn <= 0 || pz <= 0) return;
    const m = Math.min(px, up, dn, pz), d = V();
    if (m === up) d.set(0, 1, 0); else if (m === dn) d.set(0, -1, 0); else if (m === px) d.set(Math.sign(l.x) || 1, 0, 0); else d.set(0, 0, Math.sign(l.z) || 1);
    l.addScaledVector(d, m); st.p.copy(l.applyMatrix4(Mb));
    const dw = d.transformDirection(Mb), vn = st.v.dot(dw); if (vn < 0) st.v.addScaledVector(dw, -vn);
  }

  // Rewrites S for a fall (body space of the bail root): trunk on the ball, contact with the ground, limbs flailing or splayed out.
  fall(S, curl, ph, dt) {
    const g = this.rig, b = ph.bail, BL = this.bl;
    if (!BL) return;
    if (BL.frozen) return this.getUp(S, curl, ph, dt);
    const t = BL.t, n = BL.n, B = this.body.matrix, R = this.root.matrix, seed = BL.seed;
    const spinM = b.spin ? b.spin.length() : 0, wG = smooth(BL.wG), air = 1 - wG, sup = clamp((BL.sup + 1) / 2, 0, 1);
    const fl = air * (0.5 + 0.5 * clamp(spinM / 6, 0, 1));                       // how hard the limbs flail
    const osc = (f, o) => Math.sin(t * f + seed + o);
    const lie = b.phase === 'settle' ? b.pt : 0, breath = 0.03 * Math.sin(t * 2.6) * wG;
    const groan = sup * 0.3 * Math.sin(Math.PI * clamp((lie - 0.1) / 0.9, 0, 1)) * smooth((b.severity || 0.5) / 0.4);   // lifts his head, drops it again
    const F = { H: V(0.03 * fl * osc(7, 1), BAIL_C, 0.03 * fl * osc(6, 2)), toe: [0.35, 0.35], ank: [V(), V()], hand: [V(), V()], fn: [V(), V()], ff: [V(), V()], kpole: [V(), V()], epole: [V(), V()], palm: [V(), V()] };
    F.Qp = turn(0.25 * fl * osc(5.3, 0), lerp(0.4, 0.02, wG), 0.15 * fl * osc(4.1, 3));
    F.Qc = turn(0.35 * fl * osc(6.1, 1), lerp(0.5, lerp(0.12, -0.02, sup), wG) + breath, 0.22 * fl * osc(5.2, 4));
    F.Qh = F.Qc.clone().multiply(turn(lerp(0.3 * fl * osc(4.4, 2), (1 - sup) * 1.15 * (seed % 2 < 1 ? 1 : -1), wG), lerp(0.4, lerp(-0.25, 0.12 + groan, sup), wG)));
    this.spineFK(F);
    // contact: trunk, head and shoulders never below the surface; once down, he rests on it (the ball is fatter than a lying body)
    const Mb = _mb.multiplyMatrices(BL.Rraw, B);
    let pen = -9;
    const hc = _p1.set(0, 0.09, 0).applyQuaternion(g.head.wq).add(g.head.wp);
    for (const [p, r] of [[g.pelvis.wp, 0.13], [g.spine[1].wp, 0.13], [g.spine[2].wp, 0.14], [hc, 0.105], [g.sides[0].arm[0].wp, 0.075], [g.sides[1].arm[0].wp, 0.075]])
      pen = Math.max(pen, r - this.groundAt(ph, _p0.copy(p).applyMatrix4(Mb), n, ph.pos));
    spring(BL, 'corr', Math.max(0, pen) * (1 - wG) + pen * wG, 18, dt);
    if (BL.corr < pen) { BL.corr = pen; BL.v.corr = Math.max(0, BL.v.corr || 0); }
    R.copy(BL.Rraw); R.elements[12] += n.x * BL.corr; R.elements[13] += n.y * BL.corr; R.elements[14] += n.z * BL.corr;
    const Mw = _mb.multiplyMatrices(R, B), toB = _mi.copy(Mw).invert(), nb = n.clone().transformDirection(toB);
    // limbs: thrown about in the air, splayed out on the ground (on his back: arms out, a knee up; on his front: hands by his head)
    const L = g.legLen, want = [];
    for (let i = 0; i < 2; i++) {
      const sx = i ? -1 : 1, si = i * 2.1;
      const hT = V(sx * (0.32 + 0.12 * osc(9.5, si)), 0.06 + 0.4 * osc(10.5 + i, si + 1), 0.22 + 0.2 * Math.cos(t * (10.5 + i) + seed + si + 1));
      const hG = V(sx * 0.34, 0.2 - 0.06 * i, 0.24).lerp(V(sx * 0.52, 0.14 + 0.12 * i, -0.08), sup);
      want.push(hT.lerp(hG, wG).applyQuaternion(F.Qc).add(g.sides[i].arm[0].wp));
    }
    for (let i = 0; i < 2; i++) {
      const sx = i ? -1 : 1, si = i * 2.7;
      const aT = V(sx * 0.17, -0.64 * L + 0.14 * osc(8 + i, si), 0.2 + 0.2 * osc(8 + i, si + 1.2));
      const aG = V(sx * 0.2, -0.95 * L, -0.06).lerp(i ? V(sx * 0.15, -0.6 * L, 0.24) : V(sx * 0.2, -0.95 * L, 0.03), sup);
      want.push(aT.lerp(aG, wG).applyQuaternion(F.Qp).add(g.sides[i].leg[0].wp));
    }
    // onto the ground (by raycast), never into it; each hand and foot on its own spring, so they drag and land rather than snap
    if (!BL.lim) BL.lim = want.map((p) => ({ p: p.clone().applyMatrix4(Mw), v: V() }));
    for (let j = 0; j < 4; j++) {
      const thick = j < 2 ? 0.04 : 0.085, w = want[j].applyMatrix4(Mw), hgt = this.groundAt(ph, w, n, ph.pos);
      const lift = (thick - hgt) * wG + Math.max(0, thick - hgt - (thick - hgt) * wG);
      w.addScaledVector(n, lift);
      const st = BL.lim[j], k = wG > 0.5 ? 16 : 24;
      for (const c of ['x', 'y', 'z']) { const o = { x: st.p[c], v: { x: st.v[c] } }; spring(o, 'x', w[c], k, dt); st.p[c] = o.x; st.v[c] = o.v.x; }
      const under = thick - (hgt + lift) - _g0.subVectors(st.p, w).dot(n);
      if (under > 0) { st.p.addScaledVector(n, under); const vn = st.v.dot(n); if (vn < 0) st.v.addScaledVector(n, -vn); }
      if (j >= 2 && b.boardPos) this.offBoard(st, b);       // feet go round the board, not through it
      (j < 2 ? F.hand[j] : F.ank[j - 2]).copy(st.p).applyMatrix4(toB);
    }
    for (let i = 0; i < 2; i++) {
      const sx = i ? -1 : 1;
      F.ff[i].copy(V(0, -0.3, 1).lerp(V(sx * 0.3, -0.6, -0.7).lerp(V(sx * 0.35, -0.55, 0.75), sup), wG)).normalize().applyQuaternion(F.Qp);
      F.fn[i].copy(V(0, 1, 0.3).lerp(V(0, 0.7, -0.6).lerp(V(0, 0.75, 0.6), sup), wG)).normalize().applyQuaternion(F.Qp);
      F.kpole[i].set(sx * 0.25 * wG, 0.2 * air, 1).applyQuaternion(F.Qp);
      F.epole[i].set(sx * 0.55, -0.55, lerp(-0.5, -0.25, wG)).applyQuaternion(F.Qc);
      F.palm[i].set(sx * 0.3, -0.7, 0.3).lerp(nb.clone().multiplyScalar(lerp(-1, 0.5, sup)), wG).normalize();
      curl[i] = lerp(0.6, 0.3, wG);
    }
    Object.assign(S, F);
  }

  // up off the ground: from where he lies (frozen at the start of the get-up), through a crouch, into his riding stance
  getUp(S, curl, ph, dt) {
    const BL = this.bl, FZ = BL.frozen, B = this.body.matrix, u = clamp(ph.bail.pt / GETUP_TIME, 0, 1);
    if (!FZ.F) return;
    const K = _mb.multiplyMatrices(BL.Rs, B).invert().multiply(_mi.multiplyMatrices(FZ.Rl, B)), kq = Q().setFromRotationMatrix(K);
    const Lp = copyS(FZ.F, FZ.F.curl);                // the lying pose, seen from the standing frame
    Lp.H.applyMatrix4(K); Lp.Qp.premultiply(kq); Lp.Qc.premultiply(kq); Lp.Qh.premultiply(kq);
    for (const key of S_V) for (const v of Lp[key]) { if (S_DIR.has(key) || key === 'kpole' || key === 'epole') v.transformDirection(K); else v.applyMatrix4(K); }
    const C = copyS(S, curl);                       // the crouch on the ground he pushes up through
    C.H.set(S.H.x * 0.5, 0.52, S.H.z - 0.08);
    C.Qp.multiply(turn(0, 0.45)); C.Qc.multiply(turn(0, 0.8)); C.Qh.multiply(turn(0, -0.5));
    for (let i = 0; i < 2; i++) { C.ank[i].y -= DECK; C.hand[i].copy(C.ank[i]).add(V(0.04 * (i ? -1 : 1), 0.4, 0.14)); C.palm[i].set(0, -1, 0.2).normalize(); }
    const u1 = smooth(u / 0.55), u2 = smooth((u - 0.42) / 0.58), uh = smooth((u - 0.08) / 0.42);
    const X = copyS(C, curl), cX = [...curl];
    blendS(X, Lp, u1, cX);
    for (let i = 0; i < 2; i++) { X.hand[i].lerpVectors(Lp.hand[i], C.hand[i], uh); X.ank[i].y += 0.1 * Math.sin(Math.PI * u1) * (1 - u2); }
    const cS = [...curl]; blendS(S, X, u2, cS); curl[0] = cS[0]; curl[1] = cS[1];
  }
}
