// Names and scores what you just did. Reads the physics every frame (rotation is measured
// from the body's actual turn, so a trick is named for what happened, not for what was pressed).
// Freeski naming: spins in 180s, Left/Right, Switch; off-axis by where the flip sits in the spin
// (Cork / Rodeo backwards, Bio / Misty forwards, Flatspin on its side), Double/Triple by inversions,
// then the grab. Rails: "<spin> On <slide> [Swap] <spin> Out".
import * as THREE from 'three';

const V = (x = 0, y = 0, z = 0) => new THREE.Vector3(x, y, z);
const UP = V(0, 1, 0);
const GRAB_NAMES = { 'Safety': 'Safety', 'Mute': 'Mute', 'Japan': 'Japan', 'Tip': 'Tip', 'Tail': 'Tail', 'Critical': 'Critical', 'Truck Driver': 'Truck Driver', 'Double Tail': 'Double Tail', 'Octo': 'Octo Grab' };
const GRAB_PTS = { 'Safety': 100, 'Mute': 150, 'Japan': 220, 'Tip': 160, 'Tail': 130, 'Critical': 240, 'Truck Driver': 260, 'Double Tail': 220, 'Octo': 300 };
const round180 = (d) => Math.round(d / 180) * 180;
const MULT = ['', '', 'Double ', 'Triple ', 'Quad '];

export class Tricks {
  constructor(hud) {
    this.hud = hud; this.score = 0; this.line = null; this.air = null; this.rail = null; this.prevQ = new THREE.Quaternion(); this.best = 0;
    this.lineIdle = 0; this.butter = 0; this.wasPress = false; this.log = [];
  }
  startAir(ph, e) {
    this.air = { total: 0, spin: 0, flip: 0, inv: 0, inverted: false, switch: e.switch, grabs: {}, grab: null, t: 0, fromRail: e.rail ? this.lastRail : null };
    this.prevQ.copy(ph.q);
  }
  update(dt, ph) {
    for (const e of ph.events) this.on(e, ph);
    const A = this.air;
    if (ph.state === 'air' && A) {
      A.t += dt;
      // the turn since last frame, split into spin (about the vertical) and flip (about the sideways axis of travel)
      const dq = ph.q.clone().multiply(this.prevQ.clone().invert());
      if (dq.w < 0) { dq.x = -dq.x; dq.y = -dq.y; dq.z = -dq.z; dq.w = -dq.w; }
      const ang = 2 * Math.acos(Math.min(1, dq.w)), s = Math.sqrt(Math.max(1e-12, 1 - dq.w * dq.w));
      if (ang > 1e-5) {
        const ax = V(dq.x / s, dq.y / s, dq.z / s);
        const d = V(ph.vel.x, 0, ph.vel.z); if (d.lengthSq() < 1e-4) d.set(0, 0, 1); d.normalize();
        const lat = V().crossVectors(d, UP).normalize();
        // spin is measured about his own long axis (so a spin stays a spin upside down), flip about the jump's sideways axis
        const bu = V(0, 1, 0).applyQuaternion(ph.q);
        A.total += ang; A.spin += ang * ax.dot(bu); A.flip += ang * ax.dot(lat) * (A.switch ? -1 : 1);
      }
      this.prevQ.copy(ph.q);
      const up = V(0, 1, 0).applyQuaternion(ph.q);
      if (!A.inverted && up.y < 0.22) { A.inverted = true; A.inv++; }
      if (A.inverted && up.y > 0.6) A.inverted = false;
      if (ph.grab) { const g = ph.grab.split(':')[0]; A.grabs[g] = (A.grabs[g] || 0) + dt; }
      this.hud.live(this.airName(A, true));
    }
    if (ph.state === 'rail' && this.rail) {
      const R = this.rail, rel = ph.rail ? ph.rail.rel : 0; R.t += dt;
      if (Math.abs(Math.sin(rel)) > 0.7) R.perpT += dt; else if (Math.cos(rel) < -0.7) R.swT += dt;
      R.perp = R.perpT > 0.45 * R.t; R.sw = !R.perp && R.swT > 0.5 * R.t;
      this.hud.live(this.railName(R, true));
    }
    // butters: rotation on the snow while pressing
    if (ph.state === 'ground') {
      const pressing = Math.abs(ph.press) > 0.35;
      if (pressing) this.butter += ph.yawRate * dt; else if (this.wasPress) { const deg = Math.abs(this.butter) * 180 / Math.PI; if (deg > 150) this.award({ name: `${ph.press > 0 ? 'Nose' : 'Tail'} Butter ${round180(deg)}`, pts: 120 + round180(deg) * 0.8, clean: true }); this.butter = 0; }
      this.wasPress = pressing;
      if (this.line) { this.lineIdle += dt; if (this.lineIdle > 4.5 || ph.speed < 1.5 && this.lineIdle > 1.5) this.endLine(false); }
    }
  }
  on(e, ph) {
    if (e.type === 'air') { if (!e.rail || !this.rail) this.startAir(ph, e); else { this.startAir(ph, e); this.air.fromRail = this.lastRail; } }
    if (e.type === 'rail') {
      const spunOn = this.air ? this.air.spin * 180 / Math.PI : 0;
      const relDeg = Math.abs(((e.rel * 180 / Math.PI) % 360 + 540) % 360 - 180);   // 0 = forward, 180 = switch
      this.rail = { name: e.name, kind: e.kind, t: 0, on: e.air ? round180(Math.abs(spunOn) + 90) - 90 : 0, perp: Math.abs(relDeg - 90) < 45, sw: relDeg > 135, swaps: 0, perpT: 0, swT: 0 };
      if (Math.abs(this.rail.on) < 90 && this.rail.perp && e.air) this.rail.on = 90;
      this.air = null;
    }
    if (e.type === 'railSwap' && this.rail) this.rail.swaps++;
    if (e.type === 'railEnd' && this.rail) {
      this.lastRail = this.rail; this.rail = null;
      const R = this.lastRail; R.done = true;
      // scored now if he rides off without spinning out; spinning out is added when he lands
      R.pts = Math.round(150 + R.t * 260 + R.swaps * 150 + Math.abs(R.on) * 0.8);
    }
    if (e.type === 'land') this.landed(e, ph);
    if (e.type === 'crash') this.crashed(e);
  }
  airName(A, live) {
    const deg = Math.abs(A.total) * 180 / Math.PI, spin = Math.abs(A.spin) * 180 / Math.PI;
    const dir = A.spin < 0 ? 'Right' : 'Left';
    let core = '';
    const flips = Math.max(A.inv ? 1 : 0, Math.round(Math.abs(A.flip) / (2 * Math.PI) - 0.15));
    if (A.inv === 0 || flips === 0) { const s = round180(spin); core = s >= 180 ? `${dir} ${s}` : ''; }
    else {
      const back = A.flip > 0, n = MULT[flips] ?? `${flips}x `, sDeg = round180(spin), ratio = spin / Math.max(1, Math.abs(A.flip) * 180 / Math.PI);
      if (sDeg < 180) core = `${n}${back ? 'Backflip' : 'Frontflip'}`;
      else if (back) core = `${dir} ${n}${ratio >= 1.75 ? 'Cork' : 'Rodeo'} ${sDeg}`;
      else core = `${dir} ${n}${ratio >= 1.75 ? 'Bio' : 'Misty'} ${sDeg}`;
    }
    let g = null, gt = 0; for (const [k, t] of Object.entries(A.grabs)) if (t > gt) { g = k; gt = t; }
    const grab = g && gt > 0.12 ? (gt > 0.7 ? 'Tweaked ' : '') + GRAB_NAMES[g] : '';
    let name = [A.switch && core ? 'Switch' : '', core, grab].filter(Boolean).join(' ');
    if (A.fromRail && A.fromRail.done) name = this.railName(A.fromRail) + (core ? ` ${core.replace(/^(Left|Right) /, '')} Out` : '');
    if (!name) name = live ? '' : 'Straight Air';
    return name;
  }
  railName(R, live) {
    const slide = R.perp ? (R.kind === 'rail' ? 'Rail Slide' : 'Boardslide') : R.sw ? 'Switch Zero' : 'Zero Spin';
    return [R.on >= 180 ? `${R.on} On` : '', slide, R.swaps ? (R.swaps > 1 ? `${R.swaps}x Swap` : 'Swap') : ''].filter(Boolean).join(' ') + (live ? '' : ` · ${R.name}`);
  }
  airPoints(A) {
    const deg = Math.abs(A.total) * 180 / Math.PI, spin = round180(Math.abs(A.spin) * 180 / Math.PI);
    const flips = A.inv ? Math.max(1, Math.round(Math.abs(A.flip) / (2 * Math.PI) - 0.15)) : 0;
    let p = 50 + A.t * 60 + spin * 1.0 + flips * 500;
    for (const [k, t] of Object.entries(A.grabs)) if (t > 0.12) p += (GRAB_PTS[k] || 100) * Math.min(2, 0.5 + t);
    if (A.switch) p *= 1.15;
    return Math.round(p);
  }
  landed(e, ph) {
    const A = this.air; this.air = null;
    if (!A) return;
    if (A.fromRail && A.fromRail.done) {
      const R = A.fromRail; const out = round180(Math.abs(A.spin) * 180 / Math.PI);
      this.award({ name: this.airName(A), pts: R.pts + out * 0.9, clean: e.clean, perfect: e.perfect });
      this.lastRail = null; return;
    }
    if (A.t < 0.45 && Math.abs(A.total) < 2.5) return;    // a hop, not a trick
    this.award({ name: this.airName(A), pts: this.airPoints(A), clean: e.clean, perfect: e.perfect });
  }
  crashed(e) {
    this.air = null; this.rail = null; this.lastRail = null;
    this.hud.result({ name: e.why === 'flat' ? 'Flat Landing' : e.why === 'body' ? 'Slam' : 'Bail', pts: 0, bad: true });
    this.endLine(true);
  }
  award(t) {
    const pts = Math.round(t.pts * (t.perfect ? 1.25 : t.clean ? 1 : 0.6));
    if (!this.line) this.line = { tricks: [], pts: 0 };
    this.line.tricks.push(t.name); this.line.pts += pts; this.lineIdle = 0;
    this.log.push({ ...t, pts }); if (this.log.length > 50) this.log.shift();
    this.hud.result({ name: t.name, pts, clean: t.clean, perfect: t.perfect, combo: this.line.tricks.length });
  }
  endLine(lost) {
    const L = this.line; this.line = null; this.lineIdle = 0;
    if (!L) return;
    const total = lost ? 0 : Math.round(L.pts * (1 + 0.25 * (L.tricks.length - 1)));
    this.score += total; this.best = Math.max(this.best, total);
    this.hud.lineDone({ n: L.tricks.length, total, lost });
  }
}
