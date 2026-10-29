// The skier you see. Physics (physics.js) decides where the skis are and how the body is turned;
// this file dresses the rigged human from rider.js (the skate game's MakeHuman model, CC0) as a
// park skier and poses his skeleton every frame: an athletic ski stance that flexes, angulates into
// carves, winds up for spins, tucks and reaches for real grabs, then a ragdoll when he crashes.
// Skis, boots, poles, goggles and mitts are built here from code (original designs).
//
// Prior art: procedural pose targets + two-bone IK (the rig's solve(), as in the skate game), blended
// with critically damped springs (Holden, "Spring-It-On"); Jibbers' approach of moving the body toward
// pose targets rather than playing canned clips; a Verlet stick ragdoll (Jakobsen, "Advanced
// Character Physics", GDC 2001) for crashes.
import * as THREE from 'three';
import { SkaterView, spring, frameQ, turn } from './rider.js';
import { ground } from './terrain.js';
import { TWEAKS as T } from './tweaks.js';

const V = (x = 0, y = 0, z = 0) => new THREE.Vector3(x, y, z);
const Q = () => new THREE.Quaternion();
const clamp = (v, a, b) => Math.min(b, Math.max(a, v)), lerp = (a, b, t) => a + (b - a) * t;
const smooth = (t) => { t = clamp(t, 0, 1); return t * t * (3 - 2 * t); };
import { SKI_L, PLATE, flexSki, dressSkier } from './gear.js';
const _mw = new THREE.Matrix4(), _u = new THREE.Vector3(), _p = new THREE.Vector3();

// ── poses: a few numbers each, blended with springs ──
const STANCE = { hip: 0.8, hipZ: -0.07, lean: 0.36, head: -0.28, armX: 0.33, armY: 0.02, armZ: 0.3, spread: 0.12, curl: 0.85 };

export class SkierView extends SkaterView {
  constructor(scene) {
    super(scene);
    this.boardRoot.visible = false;
    this.gear = null; this.st = { hip: 0.8, hipZ: -0.07, lean: 0.36, roll: 0, yawC: 0, yawP: 0, sideC: 0, grabW: 0, armOut: 0, plant: 0, flex: 0, crunch: 0, v: {} };
    this.grabNow = null; this.grabBlend = 0; this.rd = null; this.poleT = [0, 0]; this.lastTurn = 0;
  }
  makeGear() { this.gear = dressSkier(this); }

  // physics -> pose
  update(dt, ph) {
    if (!this.rig) { this.root.matrixAutoUpdate = false; this.root.matrix.compose(ph.pos, ph.q, V(1, 1, 1)); this.root.matrixWorldNeedsUpdate = true; return; }
    if (!this.gear) this.makeGear();
    this.time += dt;
    this.body.matrix.identity(); this.body.matrixWorldNeedsUpdate = true;
    if (ph.state === 'crash') { this.ragdoll(dt, ph); }
    else {
      this.rd = null; this.boardRoot.visible = false;
      this.pose(dt, ph);
    }
    this.root.updateMatrixWorld(true);
    this.secondary(dt, false);
    this.eyes(dt, { state: ph.state === 'crash' ? 'bail' : 'ride', bail: ph.state === 'crash' ? { phase: 'tumble' } : null });
    this.prevState = ph.state;
  }

  pose(dt, ph) {
    const s = this.st, air = ph.state === 'air', rail = ph.state === 'rail', grnd = ph.state === 'ground';
    const snap = !this.posed; this.posed = true;
    const sp = ph.vel.length();
    for (const e of ph.events || []) {
      if (e.type === 'pop' || e.type === 'launch') this.popT = 0;
      // landing: kick the hip spring down (the legs soak it up and spring back), arms come forward
      if (e.type === 'land') { s.v.hip = (s.v.hip || 0) - clamp(e.impact, 1.5, 13) * (T.landSoak ?? 0.32); this.landT = 0; }
    }
    if (this.popT != null) this.popT += dt; if (this.landT != null) this.landT += dt;
    // root: the physics body, rolled into the carve about the snow contact (the whole skier inclines into the turn)
    const rollT = grnd ? -Math.atan(ph.edge || 0) * 0.85 : 0;
    spring(s, 'roll', rollT, snap ? 999 : 9, dt);
    const M = new THREE.Matrix4().compose(ph.pos, ph.q, V(1, 1, 1));
    M.multiply(new THREE.Matrix4().makeRotationZ(s.roll));
    this.root.matrixAutoUpdate = false; this.root.matrix.copy(M); this.root.matrixWorldNeedsUpdate = true;
    // the snow plane seen from the rolled body: feet are put on it, so the inside leg folds and both skis stay on the snow
    const nb = V(0, 1, 0).applyAxisAngle(V(0, 0, 1), -s.roll), snowY = (x, z) => -(nb.x * x + nb.z * z) / nb.y;

    // ── the stance: an athletic flex, deeper with the crouch / tuck / a landing; pressure on the shins ──
    const g = this.rig, hip0 = g.hip0 + PLATE;
    const tuck = grnd ? ph.tuck || 0 : 0, crouch = ph.crouch || 0;
    let hipT = hip0 * (0.85 - 0.19 * crouch - 0.22 * tuck), leanT = 0.3 + 0.32 * crouch + 0.5 * tuck, hipZT = -0.06 - 0.05 * crouch;
    // the pop: legs snap straight for a moment, then fold up under him
    const pt = air && this.popT != null ? this.popT : 9;
    if (air) { const ext = pt < 0.16 ? Math.sin(pt / 0.16 * Math.PI) : 0; hipT = hip0 * (0.72 + 0.2 * ext - 0.1 * crouch); leanT = 0.4 - 0.15 * ext; }
    if (rail) { hipT = hip0 * 0.79; leanT = 0.3; }
    const press = grnd ? ph.press || 0 : 0;
    hipZT += press * 0.18; leanT += press * 0.25;
    if (grnd && ph.brake > 0.1) { hipT -= 0.07 * ph.brake; leanT -= 0.08 * ph.brake; }
    // pole push: reach (upright), plant, crunch down over the poles, recover
    const pu = grnd && ph.poleU >= 0 ? ph.poleU : -1;
    let crunch = 0; if (pu >= 0) crunch = pu < 0.3 ? -0.3 * Math.sin(pu / 0.3 * Math.PI / 2) : pu < 0.62 ? -0.3 + 1.3 * Math.sin((pu - 0.3) / 0.32 * Math.PI / 2) : 1 - (pu - 0.62) / 0.38;
    spring(s, 'crunch', pu >= 0 ? crunch : 0, snap ? 999 : 18, dt);
    hipT -= 0.06 * Math.max(0, s.crunch); leanT += 0.45 * s.crunch;
    const grab = air && ph.grab ? ph.grab : null;
    spring(s, 'grabW', grab ? 1 : 0, snap ? 999 : 13, dt);
    if (grab) this.grabNow = grab;
    if (s.grabW > 0.02 && this.grabNow) { hipT = lerp(hipT, hip0 * 0.62, s.grabW); leanT = lerp(leanT, 1.0, s.grabW); }
    spring(s, 'hip', hipT, snap ? 999 : 15, dt); spring(s, 'lean', leanT, snap ? 999 : 12, dt); spring(s, 'hipZ', hipZT, snap ? 999 : 12, dt);
    s.hip = Math.max(s.hip, hip0 * 0.48);
    // upper body: counter-rotation in carves (chest faces down the hill), the wind-up twist before a spin
    const turnRate = grnd ? ph.yawRate || 0 : 0, wind = ph.windup || 0;
    spring(s, 'yawC', clamp(-turnRate * 0.12, -0.35, 0.35) + wind * 0.75 + (rail && ph.rail ? -Math.sin(ph.rail.rel) * 0.5 : 0), snap ? 999 : 10, dt);
    spring(s, 'yawP', wind * 0.3 + (rail && ph.rail ? -Math.sin(ph.rail.rel) * 0.2 : 0), snap ? 999 : 10, dt);
    spring(s, 'sideC', -s.roll * 0.45, snap ? 999 : 10, dt);
    spring(s, 'armOut', air ? 0.55 : rail ? 1 : 0.1 + 0.4 * Math.abs(s.roll), snap ? 999 : 8, dt);

    // ── targets in body space (x left, y up, z forward; y = 0 is the ski base) ──
    const S = { H: V(0, s.hip, s.hipZ), ank: [V(), V()], fn: [V(0, 1, 0), V(0, 1, 0)], ff: [V(0, 0, 1), V(0, 0, 1)], toe: [0, 0], kpole: [V(), V()], hand: [V(), V()], epole: [V(), V()], palm: [V(), V()] };
    S.Qp = turn(s.yawP, s.lean * 0.35, -s.sideC * 0.4);
    S.Qc = turn(s.yawC, s.lean, -s.sideC);
    S.Qh = turn(s.yawC * 0.35, -0.12 - s.lean * 0.2, -s.sideC * 0.3);
    const ankY = PLATE + g.ankleH, spread = 0.115, edgeLift = 0.05 * Math.abs(Math.sin(s.roll));
    // edge angulation: knees drive into the hill, the inside ski a touch ahead
    const knee = clamp(s.roll, -0.6, 0.6);
    for (let i = 0; i < 2; i++) {
      const sd = i === 0 ? 1 : -1, x = sd * spread, z = (sd * Math.sign(knee) > 0 ? 0.05 : -0.02) * Math.abs(knee) * 2;
      S.ank[i].set(x, ankY + (grnd ? snowY(x, z) + edgeLift : 0), z);
      S.kpole[i].set(sd * 0.06 - knee * 0.6, 0, 1).normalize();
    }
    // butter: the skis pitch with the press (the pressed end stays down, the other lifts)
    const pitch = -press * 0.28;
    if (Math.abs(pitch) > 1e-3) for (let i = 0; i < 2; i++) { S.ff[i].set(0, -Math.sin(pitch), Math.cos(pitch)); S.fn[i].set(0, Math.cos(pitch), Math.sin(pitch)); S.ank[i].y += Math.abs(Math.sin(pitch)) * SKI_L * 0.42 - 0.02; S.ank[i].z -= Math.sin(pitch) * 0.05; }
    if (air) for (let i = 0; i < 2; i++) S.ank[i].x *= 0.85;
    // hands: holding the poles out in front, wider for balance in the air and on rails; up with the pop, forward on landing
    const ao = s.armOut, popArm = air && pt < 0.4 ? Math.sin(pt / 0.4 * Math.PI) : 0, landArm = grnd && this.landT != null && this.landT < 0.5 ? Math.sin(this.landT / 0.5 * Math.PI) : 0;
    for (let i = 0; i < 2; i++) {
      const sd = i === 0 ? 1 : -1;
      S.hand[i].set(sd * (0.29 + 0.13 * ao), s.hip + 0.14 + 0.06 * ao + 0.18 * popArm - 0.08 * landArm, 0.34 - 0.1 * ao + 0.12 * landArm)
        .applyQuaternion(Q().setFromAxisAngle(V(0, 1, 0), s.yawC * 0.8)).add(V(0, 0, s.hipZ + 0.02));
      S.epole[i].set(sd, -0.45, -0.55).normalize();
      S.palm[i].set(-sd * 0.7, -0.2, 0.2).normalize();
    }
    if (tuck > 0.05) for (let i = 0; i < 2; i++) { const sd = i === 0 ? 1 : -1; S.hand[i].lerp(V(sd * 0.13, s.hip + 0.04, 0.44), tuck); }
    // pole push arms: reach forward and up, drive down and back past the hips, swing through
    if (pu >= 0) {
      const reach = V(0, s.hip + 0.42, 0.42), drive = V(0, s.hip - 0.02, -0.22), low = V(0, s.hip + 0.05, 0.15);
      const P = pu < 0.3 ? reach.clone().lerp(V(0, s.hip + 0.3, 0.38), pu / 0.3) : pu < 0.62 ? V(0, s.hip + 0.3, 0.38).lerp(drive, smooth((pu - 0.3) / 0.32)) : drive.clone().lerp(low, smooth((pu - 0.62) / 0.38)).lerp(reach, smooth((pu - 0.8) / 0.2));
      const w = Math.min(1, pu * 8, (1 - pu) * 8 + (ph.poleP && ph.poleP.t >= 0 ? 1 : 0));
      for (let i = 0; i < 2; i++) { const sd = i === 0 ? 1 : -1; S.hand[i].lerp(V(sd * 0.3, P.y, P.z), Math.min(1, w)); }
    }
    // pole plants on the snow when a turn starts: the inside pole taps forward
    if (grnd && sp > 3 && pu < 0) {
      const tr = Math.sign(turnRate);
      if (Math.abs(turnRate) > 0.35 && tr !== this.lastTurn) { this.poleT[tr > 0 ? 0 : 1] = 0.001; this.lastTurn = tr; }
      if (Math.abs(turnRate) < 0.1) this.lastTurn = 0;
    }
    const curl = [0.9, 0.9];
    this.grabSki = [-1, -1];
    if (s.grabW > 0.02 && this.grabNow) this.grabPose(S, s.grabW, this.grabNow, curl);
    // make sure a grabbing hand actually reaches its ski: if the arm is too short, the ski (and knee) come up to meet it
    if (this.grabSki[0] >= 0 || this.grabSki[1] >= 0) {
      this.spineFK(S);
      for (let i = 0; i < 2; i++) {
        const k = this.grabSki[i]; if (k < 0) continue;
        const sh = g.sides[i].arm[0].wp, d = S.hand[i].clone().sub(sh), L = d.length(), max = g.armLen * 0.95;
        if (L > max) { const fix = d.multiplyScalar(-(L - max) / L * s.grabW); S.hand[i].add(fix); S.ank[k].add(fix); }
      }
    }
    this.solve(S, curl);
    this.placeGear(S, ph, dt, grnd, press, pu);
  }

  // grab shapes. side: 0 = left ski/hand, 1 = right.
  grabPose(S, w, name, curl) {
    const [kind, hand] = name.split(':'), h = hand === 'R' ? 1 : 0, o = 1 - h, sd = (i) => (i === 0 ? 1 : -1);
    const hip = S.H.y;
    const feet = [S.ank[0].clone(), S.ank[1].clone()], ff = [V(0, 0, 1), V(0, 0, 1)], fn = [V(0, 1, 0), V(0, 1, 0)];
    const knees = (y, z = 0.05) => { for (const i of [0, 1]) { feet[i].y += y * 1.5; feet[i].z += z + 0.06; } };
    const end = (i, which, out = 0) => {      // a point on ski i: tip / tail / mid, out = toward that ski's outside
      const c = feet[i].clone().addScaledVector(fn[i], -0.09);
      const along = which === 'tip' ? 0.62 : which === 'tail' ? -0.55 : 0.05;
      return c.addScaledVector(ff[i], along).add(V(sd(i) * out, 0.02, 0));
    };
    const hands = [null, null];
    if (kind === 'Safety') { knees(0.22); hands[h] = end(h, 'mid', 0.06); }
    else if (kind === 'Mute') { knees(0.24); hands[h] = end(o, 'mid', -0.0).add(V(0, 0, 0.12)); }
    else if (kind === 'Japan') { knees(0.2); feet[o].add(V(0, 0.18, -0.2)); ff[o].set(0, -0.55, 0.83).normalize(); fn[o].set(0, 0.83, 0.55); hands[h] = end(o, 'mid').add(V(0, 0.05, 0.1)); }
    else if (kind === 'Tip') { knees(0.16); feet[h].add(V(0, 0.18, 0.08)); ff[h].set(0, 0.55, 0.83).normalize(); fn[h].set(0, 0.83, -0.55); hands[h] = end(h, 'tip'); }
    else if (kind === 'Tail') { knees(0.18); feet[h].add(V(0, 0.16, -0.12)); ff[h].set(0, -0.5, 0.86).normalize(); fn[h].set(0, 0.86, 0.5); hands[h] = end(h, 'tail', 0.03); }
    else if (kind === 'Critical') { knees(0.2); feet[o].add(V(0, 0.15, -0.1)); ff[o].set(0, -0.45, 0.89).normalize(); fn[o].set(0, 0.89, 0.45); hands[h] = end(o, 'tail'); }
    else if (kind === 'Truck Driver') { knees(0.22, 0.12); for (const i of [0, 1]) { ff[i].set(0, 0.5, 0.86).normalize(); fn[i].set(0, 0.86, -0.5); hands[i] = end(i, 'tip'); } }
    else if (kind === 'Double Tail') { knees(0.2, -0.08); for (const i of [0, 1]) { ff[i].set(0, -0.45, 0.89).normalize(); fn[i].set(0, 0.89, 0.45); hands[i] = end(i, 'tail'); } }
    else if (kind === 'Octo') { knees(0.2); ff[0].set(0, 0.5, 0.86).normalize(); fn[0].set(0, 0.86, -0.5); ff[1].set(0, -0.45, 0.89).normalize(); fn[1].set(0, 0.89, 0.45); hands[0] = end(0, 'tip'); hands[1] = end(1, 'tail'); }
    void hip;
    const skiOf = { Safety: [h, h], Mute: [o, o], Japan: [o, o], Tip: [h, h], Tail: [h, h], Critical: [o, o], 'Truck Driver': [0, 1], 'Double Tail': [0, 1], Octo: [0, 1] }[kind] || [-1, -1];
    for (const i of [0, 1]) if (hands[i]) this.grabSki[i] = kind === 'Truck Driver' || kind === 'Double Tail' || kind === 'Octo' ? i : skiOf[0];
    for (const i of [0, 1]) {
      S.ank[i].lerp(feet[i], w); S.ff[i].lerp(ff[i], w).normalize(); S.fn[i].lerp(fn[i], w).normalize();
      if (hands[i]) { S.hand[i].lerp(hands[i], w); curl[i] = lerp(curl[i], 1.2, w); S.epole[i].lerp(V(sd(i), 0.2, -0.4).normalize(), w); }
    }
    // the chest turns toward the grabbing hand's target
    if (hands[h]) { const t = hands[h]; S.Qc = turn(Math.atan2(t.x, Math.max(0.1, t.z)) * 0.5 * w, 0.75, 0).slerp(S.Qc, 1 - w); }
  }

  placeGear(S, ph, dt, grnd, press, pu = -1) {
    const gr = this.gear, g = this.rig;
    for (let i = 0; i < 2; i++) {
      const foot = g.sides[i].leg[2];
      const q = frameQ(S.fn[i], S.ff[i]);
      const c = foot.wp.clone().addScaledVector(S.fn[i], -(g.ankleH)).addScaledVector(S.ff[i], g.footBack || 0.04);
      gr.boots[i].matrix.compose(c, q, V(1, 1, 1));
      gr.skis[i].matrix.compose(c.clone().addScaledVector(S.fn[i], -PLATE), q, V(1, 1, 1));
    }
    // ski flex: on the snow each ski bends to the shape of the snow under it (a straight ski would stab into a
    // transition or float over a knuckle), plus the press (bent over its pressed end) and a hard landing (camber flattened)
    const pk = clamp(press, -1, 1), land = (ph.landWob || 0) * clamp((ph.impact || 0) / 10, 0, 1);
    const base = (s) => (pk > 0 ? -pk * 0.11 * Math.max(0, s) ** 1.6 + pk * 0.05 * Math.max(0, -s) ** 2 : pk < 0 ? pk * 0.11 * Math.max(0, -s) ** 1.6 - pk * 0.05 * Math.max(0, s) ** 2 : 0) - land * 0.02 * (1 - s * s);
    const NS = 9, ST = this.flexS || (this.flexS = [new Float32Array(NS), new Float32Array(NS)]);
    for (let i = 0; i < 2; i++) {
      const sk = gr.skis[i], tgt = ST[i];
      if (grnd && !press) {
        const Mw = _mw.multiplyMatrices(this.root.matrix, sk.matrix), up = _u.set(0, 1, 0).transformDirection(Mw);
        for (let k = 0; k < NS; k++) {
          const sz = (k / (NS - 1) * 2 - 1) * SKI_L * 0.48, p = _p.set(0, 0, sz).applyMatrix4(Mw);
          const d = (ground(p.x, p.z) - p.y) / Math.max(0.3, up.y);
          tgt[k] += (clamp(d, -0.035, 0.25) - tgt[k]) * (1 - Math.exp(-30 * dt));
        }
      } else for (let k = 0; k < NS; k++) tgt[k] *= Math.exp(-12 * dt);
      let mx = 0; for (let k = 0; k < NS; k++) mx = Math.max(mx, Math.abs(tgt[k]));
      const key = Math.round(pk * 40) + ':' + Math.round(land * 20) + ':' + (mx > 0.003 ? [...tgt].map((v) => Math.round(v * 300)).join(',') : '0');
      if (key === sk.userData.flexKey) continue;
      sk.userData.flexKey = key;
      flexSki(sk, (s) => { const f = (s * 0.5 + 0.5) * (NS - 1), j = Math.min(NS - 2, Math.floor(f)), t = f - j; return base(s) + (mx > 0.003 ? tgt[j] + (tgt[j + 1] - tgt[j]) * t : 0); });
    }
    // poles: in the hands, tips trailing near the snow; a turn's pole plant taps; a pole push plants both and they stay
    // put in the snow while the skier slides past them
    const plant = pu >= 0.3 && pu < 0.62;
    if (plant && !this.planted) this.planted = { z: 0.32 + S.H.z * 0.5 };
    if (!plant) this.planted = null;
    if (this.planted) this.planted.z -= ph.speed * dt;
    for (let i = 0; i < gr.poles.length; i++) {
      const hand = g.sides[i].arm[2], sd = i === 0 ? 1 : -1, hp = hand.wp.clone(), L = gr.poles[i].userData.L || 1.18;
      let tip = V(sd * 0.46, 0.06, -0.4 + S.H.z);
      if (ph.state === 'air' || ph.state === 'rail') tip = V(sd * 0.62, S.hand[i].y - 0.75, -0.75);
      if (grnd && ph.tuck > 0.05) tip.lerp(V(sd * 0.25, S.H.y + 0.1, -0.9), ph.tuck);
      if (this.poleT[i] > 0) { this.poleT[i] += dt; const u = this.poleT[i] / 0.45; tip.lerp(V(sd * 0.3, 0.0, 0.55), Math.sin(Math.min(1, u) * Math.PI)); if (u >= 1) this.poleT[i] = 0; }
      if (pu >= 0) {
        if (this.planted) tip.set(sd * 0.36, -0.06, this.planted.z);
        else if (pu < 0.3) tip.set(sd * 0.4, S.hand[i].y - 0.85, S.hand[i].z - 0.35 + pu);       // swinging forward to plant
        else tip.set(sd * 0.42, 0.25, -0.75);                                                    // flicked out behind
      }
      const d = tip.sub(hp).normalize();
      // never through the snow: shorten the reach along the same direction if the tip would go under
      gr.poles[i].matrix.compose(hp, Q().setFromUnitVectors(V(0, -1, 0), d), V(1, 1, 1));
      void L;
    }
  }

  // ── crashing: a Verlet stick figure takes over the skeleton ──
  ragdoll(dt, ph) {
    const g = this.rig;
    if (!this.rd) this.rd = this.buildRagdoll(ph);
    const rd = this.rd, P = rd.p, h = Math.min(dt, 1 / 30) / 4, grav = T.gravity ?? 9.81;
    for (let it = 0; it < 4; it++) {
      for (const p of P) { const v = p.x.clone().sub(p.o).multiplyScalar(0.995); p.o.copy(p.x); p.x.add(v).y -= grav * h * h; }
      for (let k = 0; k < 6; k++) {
        for (const [a, b, L] of rd.sticks) { const d = P[b].x.clone().sub(P[a].x), l = d.length() || 1e-6, f = (l - L) / l * 0.5; P[a].x.addScaledVector(d, f); P[b].x.addScaledVector(d, -f); }
        for (const p of P) { const gy = ground(p.x.x, p.x.z) + p.r; if (p.x.y < gy) { p.x.y = gy; const v = p.x.clone().sub(p.o); p.o.x = p.x.x - v.x * 0.55; p.o.z = p.x.z - v.z * 0.55; p.o.y = p.x.y + Math.max(0, -v.y) * 0.15; } }
      }
    }
    // pose the skeleton from the particles (root at the pelvis, axis-aligned, so body space = world - pelvis)
    const pel = P[rd.i.pelvis].x, origin = pel.clone();
    this.root.matrix.makeTranslation(origin.x, origin.y, origin.z); this.root.matrixWorldNeedsUpdate = true;
    const L = (n) => P[rd.i[n]].x.clone().sub(origin);
    const hipL = L('hipL'), hipR = L('hipR'), chest = L('chest'), head = L('head'), shL = L('shL'), shR = L('shR');
    const H = hipL.clone().add(hipR).multiplyScalar(0.5);
    const upP = chest.clone().sub(H).normalize(), leftP = hipL.clone().sub(hipR).normalize();
    const fwdP = V().crossVectors(leftP, upP).normalize();
    const basis = (x, y) => { const z = V().crossVectors(x, y).normalize(); const xx = V().crossVectors(y, z).normalize(); return Q().setFromRotationMatrix(new THREE.Matrix4().makeBasis(xx, y, z)); };
    const upC = head.clone().sub(chest).normalize(), leftC = shL.clone().sub(shR).normalize();
    const S = { H, Qp: basis(leftP, upP), Qc: basis(leftC, upC), Qh: basis(leftC, upC), ank: [L('ankL'), L('ankR')], kpole: [L('kneeL').sub(H).normalize(), L('kneeR').sub(H).normalize()], fn: [V(), V()], ff: [V(), V()], toe: [0, 0],
      hand: [L('handL'), L('handR')], epole: [L('elbL').sub(shL).normalize(), L('elbR').sub(shR).normalize()], palm: [V(0, -1, 0), V(0, -1, 0)] };
    // kpole should point from the hip-ankle line toward the knee
    for (let i = 0; i < 2; i++) {
      const hipP = i ? hipR : hipL, kn = L(i ? 'kneeR' : 'kneeL'), an = S.ank[i], d = an.clone().sub(hipP).normalize();
      const k = kn.clone().sub(hipP); k.addScaledVector(d, -k.dot(d)); S.kpole[i] = k.lengthSq() > 1e-6 ? k.normalize() : fwdP.clone();
      S.ff[i].copy(L(i ? 'toeR' : 'toeL').sub(an)).normalize(); S.fn[i].copy(an.clone().sub(kn)).normalize().negate();
      S.fn[i].addScaledVector(S.ff[i], -S.fn[i].dot(S.ff[i])).normalize();
    }
    this.solve(S, [0.5, 0.5]);
    this.placeGear(S, ph, dt, false, 0);
    ph.com.copy(pel);
  }
  buildRagdoll(ph) {
    const g = this.rig, R = g.R, W = new THREE.Matrix4().multiplyMatrices(this.root.matrix, this.body.matrix);
    const at = (r) => r.wp.clone().applyMatrix4(W);
    const S = g.sides;
    const pts = {
      head: at(R.head).add(V(0, 0.1, 0).applyQuaternion(Q().setFromRotationMatrix(W))), chest: at(R.spine_03), pelvis: at(R.pelvis),
      hipL: at(S[0].leg[0]), hipR: at(S[1].leg[0]), kneeL: at(S[0].leg[1]), kneeR: at(S[1].leg[1]), ankL: at(S[0].leg[2]), ankR: at(S[1].leg[2]),
      shL: at(S[0].arm[0]), shR: at(S[1].arm[0]), elbL: at(S[0].arm[1]), elbR: at(S[1].arm[1]), handL: at(S[0].arm[2]), handR: at(S[1].arm[2]),
    };
    const fw = V(0, 0, 1).transformDirection(W);
    pts.toeL = pts.ankL.clone().addScaledVector(fw, 0.3); pts.toeR = pts.ankR.clone().addScaledVector(fw, 0.3);
    const names = Object.keys(pts), i = {}; names.forEach((n, k) => { i[n] = k; });
    const v = (ph.crashVel || ph.vel).clone().multiplyScalar(1 / 60), wv = (ph.crashW || V()).clone();
    const c = ph.com.clone();
    const p = names.map((n) => { const x = pts[n]; const spinV = V().crossVectors(wv, x.clone().sub(c)).multiplyScalar(1 / 60); return { x: x.clone(), o: x.clone().sub(v).sub(spinV), r: n === 'head' ? 0.12 : n.startsWith('toe') ? 0.03 : 0.08 }; });
    const pairs = [['head', 'chest'], ['chest', 'pelvis'], ['pelvis', 'hipL'], ['pelvis', 'hipR'], ['hipL', 'hipR'], ['hipL', 'kneeL'], ['kneeL', 'ankL'], ['hipR', 'kneeR'], ['kneeR', 'ankR'], ['ankL', 'toeL'], ['ankR', 'toeR'], ['kneeL', 'toeL'], ['kneeR', 'toeR'],
      ['chest', 'shL'], ['chest', 'shR'], ['shL', 'shR'], ['shL', 'elbL'], ['elbL', 'handL'], ['shR', 'elbR'], ['elbR', 'handR'], ['shL', 'pelvis'], ['shR', 'pelvis'], ['head', 'shL'], ['head', 'shR'], ['chest', 'hipL'], ['chest', 'hipR']];
    const sticks = pairs.map(([a, b]) => [i[a], i[b], pts[a].distanceTo(pts[b])]);
    // ragdolls fold at the joints too much without a few "muscle" sticks: knees and elbows can't straighten past straight
    return { p, sticks, i };
  }
}
