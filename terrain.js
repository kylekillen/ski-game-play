// The mountain as a height function: ground(x, z) is the snow height in metres.
// Everything the skier can touch on the snow comes from here (physics), and the
// snow meshes are just a picture of it (world.js). Downhill is +z, across is x, up is y.
//
// Prior art: real park building. Table-tops follow the published terrain-park
// standards of thumb (lip angle 20-30 deg, a near-flat deck, a rounded knuckle and a
// landing 5-10 deg steeper than the approach, e.g. Snow Park Technologies / NSAA
// "Freestyle Terrain Layout" notes and McNeil & Hubbard's jump-safety papers,
// which design landings for an "equivalent fall height"). Jumps are piecewise Hermite
// profiles along the fall line with snow-pile sides at ~45 deg, added on top of the run.

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const smooth = (t) => { t = clamp(t, 0, 1); return t * t * (3 - 2 * t); };
const D = Math.PI / 180;

// ── the run's long profile: [z where the section starts, slope in degrees] ──
export const SECTIONS = [
  [-60, 4],     // top deck, start hut
  [40, 15],     // roll-in
  [120, 9],     // jib garden
  [420, 15],    // roll-in
  [470, 10.5],  // jump lines 1 (small / medium)
  [780, 15],    // roll-in
  [820, 12],    // big air line
  [1120, 10],   // jib garden 2 + rollers
  [1340, 6],    // run-out
  [1450, 1.5],  // base area
  [1700, 1],
];
export const Z0 = -80, Z1 = 1720;
const STEP = 0.5, N = Math.ceil((Z1 - Z0) / STEP) + 1, BASE = new Float32Array(N), SLOPE = new Float32Array(N);
{
  // slope at each z, blended between sections over 24 m so the run has no creases
  const at = (z) => {
    let s = SECTIONS[0][1];
    for (let i = 1; i < SECTIONS.length; i++) { const [z0, d] = SECTIONS[i]; s += (d - SECTIONS[i - 1][1]) * smooth((z - z0 + 12) / 24); }
    return Math.tan(s * D);
  };
  let y = 460;
  for (let i = 0; i < N; i++) { const z = Z0 + i * STEP; SLOPE[i] = at(z); if (i) y -= (SLOPE[i] + SLOPE[i - 1]) * 0.5 * STEP; BASE[i] = y; }
}
export function baseY(z) {
  const f = clamp((z - Z0) / STEP, 0, N - 1.001), i = f | 0, t = f - i;
  // cubic Hermite with the slope as the tangent: smooth curvature (linear pieces made every sample a tiny knuckle
  // that threw the skier into the air at speed)
  const t2 = t * t, t3 = t2 * t, m0 = -SLOPE[i] * STEP, m1 = -SLOPE[i + 1] * STEP;
  return (2 * t3 - 3 * t2 + 1) * BASE[i] + (t3 - 2 * t2 + t) * m0 + (-2 * t3 + 3 * t2) * BASE[i + 1] + (t3 - t2) * m1 + (z < Z0 ? (Z0 - z) * SLOPE[0] : 0);
}
export function baseSlope(z) { const i = clamp(Math.round((z - Z0) / STEP), 0, N - 1); return SLOPE[i]; }   // tan of the downhill angle

// ── value noise (deterministic) ──
function hash(i, j) { let h = (i * 374761393 + j * 668265263) | 0; h = (h ^ (h >>> 13)) * 1274126177 | 0; return ((h ^ (h >>> 16)) >>> 0) / 4294967296; }
function vnoise(x, z) {
  const i = Math.floor(x), j = Math.floor(z), fx = x - i, fz = z - j, u = fx * fx * (3 - 2 * fx), v = fz * fz * (3 - 2 * fz);
  const a = hash(i, j), b = hash(i + 1, j), c = hash(i, j + 1), d = hash(i + 1, j + 1);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}
export function fbm(x, z, oct = 4) { let s = 0, a = 1, f = 1, n = 0; for (let k = 0; k < oct; k++) { s += a * vnoise(x * f, z * f); n += a; a *= 0.5; f *= 2.03; } return s / n; }

// ── the groomed run: its half-width and where its centre wanders ──
export function runHalf(z) { return 62 + 10 * Math.sin(z * 0.004 + 1.2) + (z > 1400 ? Math.min(60, (z - 1400) * 0.5) : 0); }
export function runCenter(z) { return 6 * Math.sin(z * 0.0023); }

// ── profiles: knots [u, r, dLeft, dRight], cubic Hermite between them ──
class Profile {
  constructor(knots) { this.k = knots; this.u0 = knots[0][0]; this.u1 = knots[knots.length - 1][0]; }
  at(u) {
    const k = this.k; if (u <= this.u0 || u >= this.u1) return 0;
    let i = 0; while (i < k.length - 2 && u > k[i + 1][0]) i++;
    const [ua, ra, , da] = k[i], [ub, rb, db] = k[i + 1], h = ub - ua, t = (u - ua) / h, t2 = t * t, t3 = t2 * t;
    return (2 * t3 - 3 * t2 + 1) * ra + (t3 - 2 * t2 + t) * h * da + (-2 * t3 + 3 * t2) * rb + (t3 - t2) * h * db;
  }
}
// soft max(0, a) so feature sides are rounded where they meet the run
const softPos = (a, k) => (a > k ? a : a > -k ? (a + k) * (a + k) / (4 * k) : 0);

export const FEATURES = [];   // everything shaped into the snow
export const RAILS = [];      // everything you can slide: rails and boxes
export const SPAWNS = [];     // places you can start from
export const JUMPS = [];      // lips, for the speed helper and the camera

// A table-top: kicker, flat deck of `gap` metres from lip to knuckle, landing.
// lip: lip angle (deg), kh: kicker height above its base, drop: lip above the deck, land: landing angle (deg).
function table({ x, z, gap, lip = 26, kh = 2.2, drop = 0.9, land = 32, w = 7, name, speed }) {
  const tb = baseSlope(z), tl = Math.tan(lip * D), td = Math.tan(-0.5 * D), tL = Math.tan(land * D);
  const Lr = 2.3 * kh / (tl + tb);                    // ramp length: a near-circular transition
  const back = drop / Math.tan(55 * D);
  const deckS = tb - td;                              // deck slope relative to the run (rises: the run falls away faster)
  const rK = kh - drop + deckS * (gap - back);        // knuckle height above the run
  const kn = 2.4;                                     // knuckle rounding
  const landS = tb - tL;                              // landing, relative (negative)
  const Lt = 12;                                      // transition back into the run
  const u0 = -Lr, uK = gap, uKe = uK + kn * 0.5, rKe = rK + landS * kn * 0.5;
  const rA = Math.min(-landS * Lt * 0.5, rKe * 0.6);  // where the landing starts curving out into the run
  const uA = uKe + (rKe - rA) / -landS, Ll = uA - uKe;
  const knots = [
    [u0, 0, 0, 0],
    [0, kh, tl + tb, -Math.tan(55 * D) + tb],         // the lip: sharp
    [back, kh - drop, deckS, deckS],
    [uK - kn * 0.5, rK - deckS * kn * 0.5, deckS, deckS],
    [uKe, rKe, landS, landS],
    [uA, rA, landS, landS],
    [uA + Lt * (rA / (-landS * Lt * 0.5)), 0, 0, 0],
  ];
  const p = new Profile(knots);
  const f = { kind: 'table', name, x, z, w, prof: p, u0, u1: p.u1, side: 1.25, lipZ: z, gap, lip, land, kh };
  addFeature(f);
  JUMPS.push({ name, x, z, gap, lip, w, speed, kh, landZ0: z + uK, landZ1: z + uA + 3 });
  return f;
}
// a smooth whoop across the run
function roller({ x, z, len = 14, h = 1.6, w = 14 }) {
  const p = new Profile([[0, 0, 0, 0], [len * 0.5, h, 0, 0], [len, 0, 0, 0]]);
  addFeature({ kind: 'roller', x, z, w, prof: p, u0: 0, u1: len, side: 0.8 });
}
// a kicker into a steeper, lower landing (step-down)
function stepdown({ x, z, kh = 1.3, lip = 16, w = 8, cut = 3.2, len = 34, name }) {
  const tb = baseSlope(z), tl = Math.tan(lip * D), Lr = 2.3 * kh / (tl + tb);
  const p = new Profile([[-Lr, 0, 0, 0], [0, kh, tl + tb, -1.0], [1.4, 0.15, -0.45, -0.45], [len * 0.5, -cut, -0.28, -0.28], [len, 0, 0, 0]]);
  addFeature({ kind: 'stepdown', x, z, w, prof: p, u0: -Lr, u1: len, side: 1.0, cutW: w + 10 });
  JUMPS.push({ name, x, z, gap: 4, lip, w, speed: 12, kh, landZ0: z + 4, landZ1: z + len * 0.6 });
}
function addFeature(f) {
  f.zMin = f.z + f.u0 - 1; f.zMax = f.z + f.u1 + 1;
  const reach = f.w / 2 + 12 + (f.cutW || 0);
  f.xMin = f.x - reach; f.xMax = f.x + reach;
  FEATURES.push(f);
}
function featureH(f, x, z) {
  const u = z - f.z, r = f.prof.at(u);
  if (r === 0) return 0;
  const v = Math.abs(x - f.x) - f.w / 2;
  if (r < 0) { const fall = smooth(1 - (v + 0) / 9); return v <= 0 ? r : r * fall; }   // a cut fades back into the run
  const vs = v > 0.24 ? v - 0.12 : v > 0 ? v * v / 0.48 : 0;      // crisp, slightly rounded groomed shoulders
  return softPos(r - vs * f.side, Math.min(0.25, r * 0.5 + 1e-4));  // soft toe where the side meets the run (none where r is 0)
}

// A rail or box. segs: [[length, world slope in degrees (negative = down)], ...] along +z, curve: rainbow bulge (m).
// clear: lowest height above the snow anywhere along it. ride: true = a snow pad you can just ride onto.
function rail({ x, z, segs, kind = 'rail', clear = 0.45, curve = 0, name, ride = true }) {
  const pts = [];
  let zz = z, y = 0; pts.push([x, 0, zz]);
  const total = segs.reduce((s, [l]) => s + l, 0);
  for (const [len, deg] of segs) {
    const n = Math.max(2, Math.ceil(len / 0.5));
    for (let i = 1; i <= n; i++) { const dz = len / n * Math.cos(deg * D); zz += dz; y += len / n * Math.sin(deg * D); pts.push([x, y, zz]); }
  }
  if (curve) pts.forEach((p, i) => { const s = (p[2] - z) / (zz - z); p[1] += curve * 4 * s * (1 - s); });
  // lift the whole thing so its lowest point clears the snow
  let lift = -Infinity;
  for (const p of pts) lift = Math.max(lift, ground(p[0], p[2], true) + clear - p[1]);
  for (const p of pts) p[1] += lift;
  const bare = (p) => ground(p[0], p[2], true), startH = pts[0][1] - bare(pts[0]);
  const w = kind === 'box' ? 0.55 : kind === 'tube' ? 0.32 : 0.06;
  const R = { kind, name, w, pts, len: total, topOff: kind === 'box' ? 0.04 : kind === 'tube' ? 0.16 : 0.03 };
  RAILS.push(R);
  // the snow under it: an on-ramp up to its start (ride-on), then a bed that keeps `clear` under the rail, then a drop-off
  const gapTop = kind === 'box' ? 0.06 : kind === 'tube' ? 0.1 : 0.14, padLen = (ride ? 5 : 3.5) + startH * 3, tb = baseSlope(z);
  const rel = pts.map((p) => [p[2] - z, p[1] - bare(p)]);
  const knots = [[-padLen, 0, 0, 0]];
  const r0 = startH - gapTop, d0 = (rel[1][1] - rel[0][1]) / (rel[1][0] - rel[0][0]);
  knots.push([-0.6, r0, Math.min(0.9, r0 / padLen * 1.6), d0], [0.2, r0 + d0 * 0.2, d0, d0]);
  for (let i = 3; i < rel.length; i++) {
    const [u, r] = rel[i], [up, rp] = rel[i - 1], [un, rn] = rel[Math.min(rel.length - 1, i + 1)];
    const d = (rn - rp) / Math.max(1e-3, un - up);
    knots.push([u, Math.max(0, r - clear), r - clear > 0 ? d : 0, r - clear > 0 ? d : 0]);
  }
  const uE = rel[rel.length - 1][0] + 0.6, rE = Math.max(0, rel[rel.length - 1][1] - clear), dl = Math.tan(30 * D) - tb;
  knots.push([uE, rE, 0, -dl]);
  if (rE > 0.05) knots.push([uE + rE / dl * 0.8, rE * 0.3, -dl * 0.6, -dl * 0.6]), knots.push([uE + rE / dl * 0.8 + 4, 0, 0, 0]);
  else knots.push([uE + 2, 0, 0, 0]);
  const prof = new Profile(knots);
  addFeature({ kind: 'bed', x, z, w: kind === 'box' ? 2.4 : 2.0, prof, u0: -padLen, u1: prof.u1, side: 1.1 });
  return R;
}

// ── the park ──
// jib garden 1: three lanes
rail({ x: -30, z: 150, segs: [[9, -2]], kind: 'box', clear: 0.35, name: 'Flat Box' });
rail({ x: 0, z: 152, segs: [[5, -1], [6, -24]], name: 'Flat-Down Rail' });
rail({ x: 30, z: 150, segs: [[11, -3]], curve: 1.1, name: 'Rainbow Rail' });
rail({ x: -30, z: 205, segs: [[11, -20]], kind: 'box', clear: 0.4, name: 'Down Box' });
rail({ x: 0, z: 208, segs: [[12, -18]], name: 'Down Rail' });
rail({ x: 30, z: 206, segs: [[9, -2]], kind: 'tube', clear: 0.35, name: 'Tube' });
rail({ x: -30, z: 262, segs: [[4, -1], [6, -22], [4, -1]], kind: 'box', clear: 0.4, name: 'Down-Flat-Down Box' });
rail({ x: 0, z: 265, segs: [[4, -22], [4, -1], [5, -22]], name: 'Kinked Rail' });
rail({ x: 30, z: 262, segs: [[13, -6]], curve: 1.4, kind: 'box', clear: 0.35, name: 'Rainbow Box' });
rail({ x: -30, z: 322, segs: [[16, -12]], kind: 'box', clear: 0.4, name: 'Long Box' });
rail({ x: 0, z: 325, segs: [[3, -1], [8, -26], [3, -1], [5, -26]], name: 'Double Kink' });
rail({ x: 30, z: 322, segs: [[14, -9]], name: 'Long Down Rail', clear: 0.6 });
SPAWNS.push({ name: 'Jib Garden', x: 0, z: 128 });

// jump lines 1: small on the left, medium on the right
table({ x: -26, z: 520, gap: 6, lip: 22, kh: 1.4, drop: 0.6, land: 27, w: 6, name: 'Small Jump 1', speed: 9.5 });
table({ x: -26, z: 600, gap: 7, lip: 23, kh: 1.5, drop: 0.6, land: 28, w: 6, name: 'Small Jump 2', speed: 10 });
table({ x: -26, z: 680, gap: 8, lip: 24, kh: 1.6, drop: 0.7, land: 28, w: 6, name: 'Small Jump 3', speed: 10.5 });
table({ x: 22, z: 525, gap: 11, lip: 25, kh: 2.0, drop: 0.8, land: 30, w: 7, name: 'Medium Jump 1', speed: 12 });
table({ x: 22, z: 612, gap: 13, lip: 26, kh: 2.2, drop: 0.9, land: 31, w: 7, name: 'Medium Jump 2', speed: 13 });
table({ x: 22, z: 700, gap: 14, lip: 27, kh: 2.4, drop: 0.9, land: 31, w: 7, name: 'Medium Jump 3', speed: 13.5 });
SPAWNS.push({ name: 'Jump Lines', x: 0, z: 462 });

// big air line, with a step-down off to the side
table({ x: 0, z: 880, gap: 17, lip: 28, kh: 2.8, drop: 1.1, land: 33, w: 8, name: 'Big Air 1', speed: 15 });
table({ x: 0, z: 985, gap: 20, lip: 29, kh: 3.1, drop: 1.2, land: 34, w: 9, name: 'Big Air 2', speed: 16 });
table({ x: 0, z: 1090, gap: 23, lip: 30, kh: 3.4, drop: 1.3, land: 35, w: 10, name: 'Big Air 3', speed: 17 });
stepdown({ x: -42, z: 900, name: 'Step-Down' });
rail({ x: 40, z: 905, segs: [[22, -13]], name: 'Mega Rail', clear: 0.7 });
SPAWNS.push({ name: 'Big Air', x: 0, z: 800 });

// jib garden 2 and the rollers
for (let i = 0; i < 6; i++) roller({ x: -32, z: 1160 + i * 20, len: 13, h: 1.2 + 0.15 * (i % 3), w: 16 });
rail({ x: 4, z: 1165, segs: [[5, -1], [10, -20], [5, -1]], kind: 'box', clear: 0.45, name: 'Big Kink Box' });
rail({ x: 4, z: 1230, segs: [[24, -11]], curve: 0.6, name: 'Long Rainbow' });
rail({ x: 32, z: 1170, segs: [[10, -4]], kind: 'tube', clear: 0.5, name: 'Big Tube' });
rail({ x: 32, z: 1240, segs: [[6, -4], [6, -22]], kind: 'box', clear: 0.45, name: 'Flat-Down Box' });
SPAWNS.push({ name: 'Jib Garden 2', x: 0, z: 1135 });
SPAWNS.unshift({ name: 'Top of the Park', x: 0, z: -20 });

// spatial bins over z for the feature lookup (every 10 m)
const BIN = 10, BINS = new Map();
for (const f of FEATURES) for (let b = Math.floor(f.zMin / BIN); b <= Math.floor(f.zMax / BIN); b++) { if (!BINS.has(b)) BINS.set(b, []); BINS.get(b).push(f); }

// The snow height. bare = without features (used to seat rails).
export function ground(x, z, bare = false) {
  let y = baseY(z);
  const c = runCenter(z), hw = runHalf(z), ax = Math.abs(x - c);
  // gentle crown on the run, rising mountainside beyond it
  const out = ax - hw;
  if (out > -12) { const o = out + 12; y += o < 250 ? 0.06 * o + 0.0011 * o * o : 83.75 + 0.61 * (o - 250); }
  // natural lumps off the groomed run (none on it): rolling snow near the run, bigger ridges and gullies further out
  const wild = smooth((out + 4) / 30);
  if (wild > 0) {
    const far = smooth((out - 60) / 300);
    y += (fbm(x * 0.03, z * 0.03, 3) - 0.5) * 5 * wild + (fbm(x * 0.006, z * 0.006, 4) - 0.5) * 120 * far;
  }
  // a soft groomer wave so the run is never a perfect plane
  y += (vnoise(x * 0.03, z * 0.02) - 0.5) * 0.5 * (1 - wild);
  if (bare) return y;
  const list = BINS.get(Math.floor(z / BIN));
  if (list) for (let i = 0; i < list.length; i++) { const f = list[i]; if (x > f.xMin && x < f.xMax) y += featureH(f, x, z); }
  return y;
}
// surface normal by central differences (out: {x,y,z})
export function normal(x, z, out, e = 0.12) {
  const hx = ground(x + e, z) - ground(x - e, z), hz = ground(x, z + e) - ground(x, z - e);
  const l = Math.hypot(hx, 2 * e, hz); out.x = -hx / l; out.y = 2 * e / l; out.z = -hz / l; return out;
}
// how groomed the snow is here: 1 on the run, 0 off in the wild
export function groomed(x, z) { return 1 - smooth((Math.abs(x - runCenter(z)) - runHalf(z) + 4) / 14); }

for (const s of SPAWNS) s.y = ground(s.x, s.z);

// the speed each jump wants at its lip: the one that lands a straight air 40% of the way down the landing
// (no-drag ballistics at the default gravity; physics' speed helper aims for it)
export const G_DESIGN = 10.4;
function landAt(J, v) {
  const tb = Math.atan(baseSlope(J.z)), a = J.lip * D;
  let x = 0, y = ground(J.x, J.z) + 0.02, z = J.z + 0.05, vy = v * Math.sin(a), vz = v * Math.cos(a);
  for (let t = 0; t < 6; t += 1 / 240) { const sp = Math.hypot(vy, vz), dr = 0.0031 * sp / 240; vy -= G_DESIGN / 240 + vy * dr; vz -= vz * dr; y += vy / 240; z += vz / 240; if (t > 0.05 && y <= ground(J.x, z)) return z; }
  void x; void tb; return z;
}
for (const J of JUMPS) {
  const want = J.landZ0 + (J.landZ1 - J.landZ0) * 0.45;
  let lo = 2, hi = 30;
  for (let k = 0; k < 40; k++) { const m = (lo + hi) / 2; if (landAt(J, m) < want) lo = m; else hi = m; }
  J.speed = +((lo + hi) / 2).toFixed(2);
  J.speedMin = 0; J.speedMax = 0;
  { let a = 2, b = 30; for (let k = 0; k < 30; k++) { const m = (a + b) / 2; if (landAt(J, m) < J.landZ0) a = m; else b = m; } J.speedMin = +a.toFixed(2); }
  { let a = 2, b = 30; for (let k = 0; k < 30; k++) { const m = (a + b) / 2; if (landAt(J, m) < J.landZ1) a = m; else b = m; } J.speedMax = +a.toFixed(2); }
}
