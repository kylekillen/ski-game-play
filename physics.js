// The skier's physics: snow, air, rails, crashes. Everything is in metres and seconds,
// stepped at 240 Hz. The view (skier.js) only draws what this decides.
//
// Prior art this follows:
//  - carving: a ski on edge turns on a circle set by its sidecut, R = Rsc * cos(edge)
//    (Howe, "The New Skiing Mechanics"; Lind & Sanders, "The Physics of Skiing"), and
//    drag F = 1/2 rho CdA v^2 with CdA ~0.6 m^2 upright, ~0.25 tucked (wind-tunnel numbers).
//  - ground contact: the "implied normal force" test (a heightfield contact that would
//    need to PULL the skier down to stay on is a launch), the standard way to get lips
//    and rollers to throw you naturally.
//  - air: angular momentum kept through the air, tucking (grabs) speeds the spin
//    (I drops), sticks add a bounded torque; a landing assistant nudges toward a landable
//    attitude near the snow, the way Jibbers exposes "landing assist" and "stabilizer"
//    strengths (all tunable here in TWEAKS, see tweaks.js).
//  - rails: a magnet that snaps the skis onto the line and toward 0/90 degrees, Jibbers'
//    "rail turn speed" and "magnet strength".
import * as THREE from 'three';
import { ground, normal, groomed, baseSlope, RAILS, JUMPS, SPAWNS } from './terrain.js';
import { TWEAKS as T } from './tweaks.js';

const V = (x = 0, y = 0, z = 0) => new THREE.Vector3(x, y, z);
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const wrap = (a) => Math.atan2(Math.sin(a), Math.cos(a));
const UP = V(0, 1, 0);
export const COM_H = 0.92;        // centre of mass above the soles, standing
const H = 1 / 240, MASS = 75;

// Rails as straight segments for the magnet: [a, b, rail, index]
const SEGS = [];
for (const R of RAILS) for (let i = 0; i < R.pts.length - 1; i++) {
  const a = V(...R.pts[i]), b = V(...R.pts[i + 1]);
  SEGS.push({ a, b, R, i, d: V().subVectors(b, a).normalize(), len: a.distanceTo(b), s0: 0 });
}
for (const R of RAILS) { let s = 0; for (const g of SEGS) if (g.R === R) { g.s0 = s; s += g.len; } R.total = s; }

const _n = V(), _t = V(), _a = V(), _b = V(), _q = new THREE.Quaternion();

export class SkiPhysics {
  constructor() {
    this.pos = V(); this.vel = V(); this.yaw = 0; this.n = V(0, 1, 0);
    this.state = 'ground';
    this.q = new THREE.Quaternion();      // body orientation (air, rail, landing)
    this.w = V();                         // angular velocity (world, rad/s)
    this.com = V();
    this.crouch = 0; this.charge = 0; this.windup = 0; this.flipLoad = 0;
    this.edge = 0; this.press = 0; this.tuck = 0; this.brake = 0; this.skid = 0;
    this.grab = null; this.grabT = 0;
    this.airT = 0; this.rail = null; this.history = []; this.histT = 0;
    this.events = [];                     // things that happened this frame, for tricks/audio/camera
    this.switch = false; this.lastLand = null; this.impact = 0; this.landWob = 0;
    this.crashT = 0; this.simTime = 0; this.relYaw = 0; this.butterSpin = 0;
    this.respawn(SPAWNS[0]);
  }

  respawn(s, vel) {
    const y = ground(s.x, s.z);
    this.pos.set(s.x, y, s.z); this.vel.copy(vel || V(0, 0, 0.5)); this.yaw = s.yaw ?? 0;
    this.state = 'ground'; this.rail = null; this.grab = null; this.windup = 0; this.flipLoad = 0; this.crouch = 0; this.charge = 0;
    this.w.set(0, 0, 0); this.spinRate = this.flipRate = this.rollRate = 0; this.crashT = 0; this.airT = 0; this.landWob = 0; this.switch = !!s.switch;
    normal(this.pos.x, this.pos.z, this.n);
    this.vel.addScaledVector(this.n, -this.vel.dot(this.n));
    this.groundQuat(this.q);
    this.history.length = 0;
    this.events.push({ type: 'respawn' });
  }

  // body orientation on the snow: up = surface normal, forward = the skis
  groundQuat(out) {
    const f = _t.set(Math.sin(this.yaw), 0, Math.cos(this.yaw));
    f.addScaledVector(this.n, -f.dot(this.n)).normalize();
    const x = _a.crossVectors(this.n, f).normalize();
    return out.setFromRotationMatrix(new THREE.Matrix4().makeBasis(x, this.n, f));
  }
  get fwd() { return V(0, 0, 1).applyQuaternion(this.q); }
  get up() { return V(0, 1, 0).applyQuaternion(this.q); }
  get speed() { return this.vel.length(); }

  update(dt, inp) {
    this.events.length = 0;
    const steps = Math.max(1, Math.min(12, Math.round(dt / H)));
    const h = dt / steps;
    for (let i = 0; i < steps; i++) { this.step(h, inp, i === 0); this.simTime += h; }
    inp.popped = false;
  }

  step(h, inp, first) {
    const g = T.gravity ?? 9.81;
    // the right stick is a second jump button (the Steep scheme): pushing it any way crouches and charges the pop,
    // letting it spring back to the middle pops. Sideways still winds up a spin and up/down loads a flip, so the
    // wind-up and the jump are one motion. On a rail, only a hold that went down pops (sideways alone is a swap);
    // while buttering (nose/tail press) the stick turns the butter and doesn't pop.
    const rsm = Math.hypot(inp.rsx, inp.rsy), rs = this.rs || (this.rs = { on: false, t: 0, down: false, butter: false });
    let rsPop = false;
    if (this.state === 'ground' || this.state === 'rail') {
      if (rsm > (T.rsPopOn ?? 0.45)) { if (!rs.on) { rs.on = true; rs.t = 0; rs.down = false; rs.butter = false; } rs.t += h; if (inp.rsy > 0.4) rs.down = true; if (Math.abs(this.press) > 0.35) rs.butter = true; }
      else if (rs.on && rsm < (T.rsPopOff ?? 0.3)) {
        rs.on = false;
        if ((T.rightStickPop ?? true) && rs.t > 0.07 && !rs.butter && (this.state === 'ground' || rs.down)) rsPop = true;
      }
    } else rs.on = false;
    this.rsPop = rsPop;
    // the crouch: A held (or the right stick). Charging the pop takes popTime for a full one.
    const wantCrouch = inp.crouch || rs.on ? 1 : 0;
    this.crouch += (wantCrouch - this.crouch) * (1 - Math.exp(-14 * h));
    if ((inp.crouch || rs.on) && this.state !== 'air' && this.state !== 'crash') this.charge = Math.min(1, this.charge + h / (T.popTime ?? 0.45));
    // wind-up: right stick sideways on the snow loads the upper body for a spin; right stick up/down loads a flip
    if (this.state === 'ground' || this.state === 'rail') {
      const rx = inp.rsx, ry = inp.rsy;
      if (Math.abs(rx) > 0.25) this.windup = clamp(this.windup + rx * h / (T.windTime ?? 0.32), -1, 1);
      else this.windup *= Math.exp(-(T.windDecay ?? 2.2) * h);
      // a quick pull-and-let-go of the right stick is a plain pop: the flip only starts loading after a longer hold
      if (Math.abs(ry) > 0.35 && (!rs.on || rs.t > (T.flipLoadDelay ?? 0.35))) this.flipLoad = clamp(this.flipLoad + ry * h / 0.35, -1, 1);
      else this.flipLoad *= Math.exp(-3 * h);
    }
    if (this.state === 'ground') this.stepGround(h, inp, g);
    else if (this.state === 'air') this.stepAir(h, inp, g);
    else if (this.state === 'rail') this.stepRail(h, inp, g);
    else if (this.state === 'crash') this.stepCrash(h, inp, g);
  }

  // ── on the snow ──
  stepGround(h, inp, g) {
    // the snow normal under him, as kept by the last step (sampled just behind the feet, so at a lip it is the ramp's
    // face, not a blend with the drop on its far side)
    const n = this.n;
    const f = _t.set(Math.sin(this.yaw), 0, Math.cos(this.yaw)); f.addScaledVector(n, -f.dot(n)).normalize();
    const side = V().crossVectors(n, f).normalize();     // +side = the skier's left
    const v = this.vel;
    const sp = v.length();
    let vf = v.dot(f), vs = v.dot(side);
    const back = vf < 0;                                   // riding switch (the skis point uphill of the motion)
    this.switch = back && sp > 0.8 ? true : (!back && sp > 0.8 ? false : this.switch);
    const groom = groomed(this.pos.x, this.pos.z);

    // stick: steer (x), lean fore/aft (y: up = forward = nose press). Press needs a firm push.
    const st = inp.steer, ly = -inp.lsy;
    const pressT = Math.abs(ly) > 0.62 ? Math.sign(ly) * (Math.abs(ly) - 0.62) / 0.38 : 0;
    this.press += (pressT - this.press) * (1 - Math.exp(-10 * h));
    this.tuck += ((inp.tuck ? 1 : 0) - this.tuck) * (1 - Math.exp(-6 * h));
    const braking = inp.brake && sp > 0.6;
    this.brake += ((braking ? 1 : 0) - this.brake) * (1 - Math.exp(-9 * h));

    // turning: carve on the sidecut at speed, pivot (skid) when slow or on the brake
    const speedK = clamp(sp / 4, 0, 1);
    const Rmin = (T.carveRadius ?? 9) + sp * 0.35;
    let yawRate = -st * sp / Rmin * speedK * (1 - 0.6 * Math.abs(this.press)) * (T.turnSpeed ?? 1);
    yawRate += -st * (T.pivotRate ?? 2.6) * (1 - speedK * 0.8);           // pivot: you can always turn on the spot
    // butter: pressing the nose or tail, right stick swings the skis round the pressed end
    if (Math.abs(this.press) > 0.35 && Math.abs(inp.rsx) > 0.3) { yawRate += -inp.rsx * (T.butterRate ?? 3.4) * Math.abs(this.press); this.butterSpin += -inp.rsx * (T.butterRate ?? 3.4) * Math.abs(this.press) * h; }
    else this.butterSpin = 0;
    // braking: hockey stop. Swing the skis across the motion (toward the side you steer, else the nearer side)
    if (this.brake > 0.05 && sp > 0.8) {
      const vref = _a.copy(v).normalize(); if (back) vref.negate();
      const rel = -Math.atan2(V().crossVectors(f, vref).dot(n), f.dot(vref));     // skis relative to the motion
      if (!this.brakeSide) this.brakeSide = Math.abs(st) > 0.2 ? -Math.sign(st) : (Math.sign(rel) || 1);
      if (Math.abs(st) > 0.2) this.brakeSide = -Math.sign(st);
      const target = this.brakeSide * Math.PI / 2 * 0.92;
      yawRate = yawRate * (1 - this.brake) + clamp((target - rel) * 7, -5, 5) * this.brake;
    } else this.brakeSide = 0;
    this.yaw = wrap(this.yaw + yawRate * h);
    this.yawRate = yawRate;

    // pole push (X): a double-pole stroke. Reach, plant, push (the thrust), recover; holding X strokes again.
    // Thrust fades out as you get faster (you can't pole faster than you can swing your arms).
    const P = this.poleP || (this.poleP = { t: -1, dur: T.poleTime ?? 0.85 });
    if (P.t < 0 && inp.pole && Math.abs(this.press) < 0.35 && this.brake < 0.2) P.t = 0;
    if (P.t >= 0) {
      const u0 = P.t / P.dur; P.t += h; const u = P.t / P.dur;
      if (u0 < 0.3 && u >= 0.3) this.events.push({ type: 'polePlant' });
      if (u > 0.3 && u < 0.62) {
        const fade = clamp(1 - sp / (T.poleMaxSpeed ?? 9), 0, 1), a = (T.polePush ?? 7.5) * fade * Math.sin((u - 0.3) / 0.32 * Math.PI);
        v.addScaledVector(back ? f.clone().negate() : f, a * h);
      }
      if (u >= 1) P.t = inp.pole ? 0 : -1;
    }
    this.poleU = P.t >= 0 ? P.t / P.dur : -1; this.poleP = P;
    // forces: gravity along the slope, snow friction, air drag
    const gt = V(0, -g, 0).addScaledVector(n, g * n.y);
    v.addScaledVector(gt, h);
    const mu = (T.snowFriction ?? 0.03) + 0.025 * (1 - groom);
    const CdA = (T.dragArea ?? 0.55) * (1 - 0.55 * this.tuck) * (1 - 0.15 * this.crouch);
    if (sp > 1e-3) {
      const dec = (mu * g * n.y + 0.5 * 1.2 * CdA * sp * sp / MASS) * h;
      v.multiplyScalar(Math.max(0, sp - dec) / sp);
    }
    // the skis grip sideways. Carving redirects the motion along the skis (little loss); skidding scrubs it off.
    vf = v.dot(f); vs = v.dot(side);
    const ang = Math.abs(Math.atan2(vs, Math.abs(vf)));                 // skid angle 0..pi/2
    const grip = (T.edgeGrip ?? 14) * (1 - 0.8 * Math.abs(this.press)) * (1 - 0.93 * Math.max(this.brake, clamp((ang - 0.5) / 0.6, 0, 1)));
    const lost = vs * (1 - Math.exp(-grip * h));
    const carve = Math.max(0, Math.cos(ang * 2)) * (1 - this.brake);    // edge locked = little energy lost
    const redirect = Math.abs(lost) * (0.92 * carve) * (back ? -1 : 1);
    const sp0 = v.length();
    v.addScaledVector(side, -lost).addScaledVector(f, redirect);
    // skidding sideways costs energy (hockey stop): extra friction while the skis are across the motion
    const scrub = (Math.sin(ang) * (0.35 + (T.brakeStrength ?? 0.5) * this.brake)) * g * h;
    const sp1 = v.length(); if (sp1 > 1e-4) v.multiplyScalar(Math.min(sp0, Math.max(0, sp1 - scrub)) / sp1);
    this.skid = Math.sin(ang) * Math.min(1, sp / 3);
    this.edge = clamp(yawRate * sp / g, -1.1, 1.1) * speedK;           // lean into the turn (tan of the edge angle)

    this.helpSpeed(h);
    // move, then keep to the snow (or leave it)
    this.pos.addScaledVector(v, h);
    const gy = ground(this.pos.x, this.pos.z), gap = this.pos.y - gy;
    const behind = (o) => { const s = Math.max(1e-3, Math.hypot(v.x, v.z)); return normal(this.pos.x - v.x / s * 0.1, this.pos.z - v.z / s * 0.1, o, 0.06); };
    if (gap <= 0) { this.pos.y = gy; behind(n); const vn = v.dot(n); if (vn < 0) v.addScaledVector(n, -vn); }
    else {
      const implied = 2 * gap / (h * h);                                 // m/s^2 we would have to pull him down to stay on
      // he only leaves the snow when it falls away faster than gravity (plus a little leg 'stick') can hold him to it
      // just after a landing the legs are soaking it up and hold him down harder (no bouncing off a knuckle)
      if (implied < (T.gravity ?? 9.81) * n.y + (T.stick ?? 2.5) + (this.simTime - (this.landedAt ?? -9) < 0.25 ? 25 : 0)) { this.pos.y = gy; behind(n); const vn = v.dot(n); if (vn > 0) v.addScaledVector(n, -vn); }
      else return this.takeoff(false, inp);
    }
    // the pop: let go of A
    if (inp.popped || this.rsPop) return this.takeoff(true, inp);
    this.landWob *= Math.exp(-4 * h);
    this.groundQuat(this.q);
    this.com.copy(this.pos).addScaledVector(n, COM_H - 0.32 * this.crouch);
    this.checkRails(inp, false);
    this.remember(h);
  }

  // a gentle, hidden speed check before each jump so the landing is reachable (T.speedHelp 0 = off):
  // predict the speed you will have at the lip (friction, drag and the climb, along your line), nudge toward the jump's speed
  helpSpeed(h) {
    const k = T.speedHelp ?? 0.6; this.helping = null; if (!k) return;
    const sp = this.vel.length(); if (sp < 1) return;
    for (const J of JUMPS) {
      const dz = J.z - this.pos.z, dx = Math.abs(this.pos.x - J.x);
      if (dz < 0.4 || dz > (T.helpReach ?? 40) || dx > J.w / 2 + 2 || this.vel.z < sp * 0.7) continue;
      this.helping = J;
      if (!this.pred || this.pred.J !== J || this.simTime - this.pred.t > 1 / 30) this.pred = { J, t: this.simTime, v: this.predictLip(J, sp) };
      const want = J.speed * (T.jumpSpeed ?? 1) - (this.charge > 0.3 ? 0.3 : 0), vp = this.pred.v;
      const rate = clamp((want - vp) * (vp / sp) * 4, -7, 6) * k;
      this.vel.multiplyScalar(Math.max(0, sp + rate * h) / sp);
      this.pred.v += rate * h * (sp / Math.max(vp, 1));
      return;
    }
  }
  predictLip(J, v) {
    const g = T.gravity ?? 9.81, CdA = (T.dragArea ?? 0.55) * (1 - 0.55 * this.tuck), mu = T.snowFriction ?? 0.03, x = this.pos.x;
    let z = this.pos.z, y = ground(x, z), e = v * v * 0.5;
    const dzs = 0.25;
    while (z < J.z - 0.05) {
      const z2 = Math.min(J.z - 0.05, z + dzs), y2 = ground(x, z2), ds = Math.hypot(z2 - z, y2 - y);
      e += -g * (y2 - y) - (mu * g + 0.5 * 1.2 * CdA * 2 * e / MASS) * ds;
      if (e < 0.5) return 1;
      z = z2; y = y2;
    }
    return Math.sqrt(2 * e);
  }

  takeoff(popped, inp) {
    if (this.poleP) this.poleP.t = -1; this.poleU = -1;
    const n = this.n;
    if (popped) {
      const k = this.charge;
      // on a fast kicker the legs add less (most of the height is the ramp's): pop shrinks with speed
      // how much this is a kicker: the snow rising against the run's own fall line (0 on a plain slope, 1 on a lip)
      const fd = V(this.vel.x, 0, this.vel.z).normalize(), sDown = -(n.x * fd.x + n.z * fd.z) / n.y * -1;
      const kick = clamp((baseSlope(this.pos.z) - sDown) / 0.3, 0, 1);
      const pop = ((T.popMin ?? 2.4) + ((T.popMax ?? 4.2) - (T.popMin ?? 2.4)) * k * (2 - k)) * (1 + (clamp(1.25 - this.vel.length() / 16, 0.45, 1) - 1) * kick);
      // pop mostly up off the snow, a touch more vertical than the surface normal
      this.vel.addScaledVector(V().copy(n).lerp(UP, 0.3).normalize(), pop);
      this.events.push({ type: 'pop', power: k });
    } else this.events.push({ type: 'launch' });
    this.charge = 0; if (this.rs) this.rs.on = false;
    this.state = 'air'; this.airT = 0; this.takeoffSwitch = this.switch; this.airPopped = popped;
    this.groundQuat(this.q);
    this.com.copy(this.pos).addScaledVector(n, COM_H - 0.32 * this.crouch);
    this.legs0 = COM_H - 0.32 * this.crouch;          // leg length at takeoff: the air pose eases from this
    // the wind-up and the flip load turn into rotation as you leave the snow
    const spin = this.windup * (T.spinMax ?? 7.2), flip = this.flipLoad * (T.flipMax ?? 5.0);
    this.setFlipAxis();
    this.spinRate = -spin; this.flipRate = flip; this.rollRate = 0; this.spinAng = 0; this.flipAng = 0; this.tti = 9; this.ttiT = 9;
    // a butter that is still swinging carries its rotation into the air
    if (this.yawRate && Math.abs(this.press) > 0.35) this.spinRate += this.yawRate * 0.8;
    this.syncW();
    this.windup = 0; this.flipLoad = 0;
    this.airStart = { pos: this.pos.clone(), t: this.simTime };
    this.events.push({ type: 'air', popped, switch: this.switch, rail: !!this.leftRail });
    this.leftRail = null;
  }

  // flips turn about a sideways axis fixed in the world for the whole jump (across the line of flight), signed so
  // that 'back' is the skier's own back. With a spin about the vertical on top, the two make one tilted axis: a cork.
  setFlipAxis() {
    const d = V(this.vel.x, 0, this.vel.z); if (d.lengthSq() < 1e-4) d.set(Math.sin(this.yaw), 0, Math.cos(this.yaw)); d.normalize();
    const ax = V().crossVectors(d, UP).normalize(), right = V(-1, 0, 0).applyQuaternion(this.q);
    this.flipAxis = ax.multiplyScalar(right.dot(ax) >= 0 ? 1 : -1);
  }

  // the equivalent world angular velocity (for landing checks, rails, the ragdoll)
  syncW(boost = 1) {
    const bu = V(0, 1, 0).applyQuaternion(this.q);
    this.w.set(0, 0, 0).addScaledVector(this.flipAxis || V(), (this.flipRate || 0) * boost).addScaledVector(bu, (this.spinRate || 0) * boost);
  }

  // ── in the air ──
  stepAir(h, inp, g) {
    this.airT += h;
    if (this.railOut > 0 && (this.railOut -= h) <= 0 && Math.abs(inp.rsx) < 0.2) this.spinRate = 0;
    const v = this.vel;
    v.y -= g * h;
    const sp = v.length(), CdA = (T.dragArea ?? 0.55) * (T.airDrag ?? 0.7) * (1 - 0.4 * this.tuckAir());
    if (sp > 1e-3) v.multiplyScalar(Math.max(0, sp - 0.5 * 1.2 * CdA * sp * sp / MASS * h) / sp);
    this.com.addScaledVector(v, h);
    // grabs: triggers, held
    this.updateGrab(inp, h);
    // body axes
    const up = V(0, 1, 0).applyQuaternion(this.q), fw = V(0, 0, 1).applyQuaternion(this.q), rt = V(-1, 0, 0).applyQuaternion(this.q);
    // stick torques: right stick x spins (about the body's long axis), y flips (about the shoulders); left stick x rolls off-axis
    const aS = T.airSpinAccel ?? 11, aF = T.airFlipAccel ?? 8, maxS = T.spinMax ?? 7.2, maxF = T.flipMax ?? 5.0;
    if (!this.flipAxis) this.setFlipAxis();
    const FA = this.flipAxis;
    // Rotation is two parts, the way a freeskier thinks of it: SPIN about his own long axis (right stick sideways) and
    // FLIP about the jump's sideways axis, fixed in the world (right stick down = back, up = front). Both at once is a
    // cork / rodeo / misty: he spins while the flip tips him over. The left stick rolls him off-axis a little.
    // Pushed, a rate eases toward the stick; let go, it keeps going (momentum).
    const rx = inp.rsx, ry = inp.rsy, lx = this.grab ? 0 : inp.steer, k = 1 - Math.exp(-(T.airControl ?? 5) * h);
    if (Math.abs(rx) > 0.2) this.spinRate += (-rx * maxS - this.spinRate) * k;
    if (Math.abs(ry) > 0.25) this.flipRate += (ry * maxF - this.flipRate) * k;
    this.rollRate += ((Math.abs(lx) > 0.3 ? -lx * (T.airRoll ?? 2.2) : 0) - this.rollRate) * k;
    if (Math.abs(rx) < 0.2 && Math.abs(ry) < 0.25) { const d = Math.exp(-(T.airDamp ?? 0.25) * h); this.spinRate *= d; this.flipRate *= d; }
    // rotation solver ("trick assist"): with the stick let go, carry the spin to a whole number of half turns and the
    // flip to whole turns, timed to the snow, so a trick finishes clean (a 540, a double cork) instead of drifting
    this.ttiT += h; if (this.ttiT > 0.05) { this.ttiT = 0; this.tti = this.timeToSnow(); }
    const ta = T.trickAssist ?? 0.8;
    if (ta > 0 && this.tti < 4) {
      const left = Math.max(0.06, this.tti - 0.06), boostNow = 1 + (T.tuckBoost ?? 0.35) * this.tuckAir();
      // how far round each rotation still has to go to be landable: up onto the landing snow's normal (flip, about the
      // jump axis) and the skis onto the landing direction, forward or switch (spin, about his own long axis)
      const nL = this.landN || V(0, 1, 0), dL = this.landD || V(0, 0, 1);
      const upB = V(0, 1, 0).applyQuaternion(this.q), fwB = V(0, 0, 1).applyQuaternion(this.q);
      const angAbout = (from, to, ax) => { const a = from.clone().addScaledVector(ax, -from.dot(ax)), b = to.clone().addScaledVector(ax, -to.dot(ax)); return Math.atan2(ax.dot(V().crossVectors(a, b)), a.dot(b)); };
      const remFlip = angAbout(upB, nL, FA), remSpin = angAbout(fwB, dL, upB);
      const solve = (rem, rate, unit, max) => {
        const dir = Math.sign(rate) || 0; if (!dir || Math.abs(rate) < 0.8) return null;
        let r0 = ((rem * dir) % unit + unit) % unit; if (r0 > unit - 0.12) r0 -= unit;   // already (just past) a stop
        let best = null;
        for (let k = 0; k < 3; k++) {
          const need = dir * (r0 + k * unit) / left / boostNow;
          if (Math.abs(need) > max * 1.25 || need * dir < 0) continue;
          if (best == null || Math.abs(need - rate) < Math.abs(best - rate)) best = need;
        }
        return best;
      };
      const kk = 1 - Math.exp(-14 * ta * h); this.solving = false;
      if (Math.abs(rx) < 0.2) { const r = solve(remSpin, this.spinRate, Math.PI, maxS); if (r != null) { this.spinRate += (r - this.spinRate) * kk; this.solving = true; } }
      if (Math.abs(ry) < 0.25) { const r = solve(remFlip, this.flipRate, Math.PI * 2, maxF); if (r != null) { this.flipRate += (r - this.flipRate) * kk; this.solving = true; } }
    }
    void aS; void aF;
    // stabilizer: not flipping? the skis follow the flight path like an arrow, the way a skier keeps them pointed at the landing
    const stab = T.stabilizer ?? 0.8;
    if (stab && Math.abs(ry) < 0.25 && Math.abs(this.flipRate) < 1.5 && up.y > 0.3) {
      const vd = _a.copy(this.vel).addScaledVector(rt, -this.vel.dot(rt)); const vl = vd.length();
      if (vl > 2) {
        vd.divideScalar(vl); const f2 = fw.dot(vd) >= 0 ? fw : _b.copy(fw).negate();
        const ang = Math.atan2(V().crossVectors(f2, vd).dot(rt), f2.dot(vd));
        _q.setFromAxisAngle(rt, ang * (1 - Math.exp(-(T.stabRate ?? 2.6) * stab * h))); this.q.premultiply(_q).normalize();
      }
    }
    // landing assistant: close to the snow with the sticks let go, ease toward a landable attitude
    this.assist(h, inp);
    // integrate orientation; tucked or grabbing = smaller moment of inertia = faster
    const boost = 1 + (T.tuckBoost ?? 0.35) * this.tuckAir();
    this.spinAng = (this.spinAng || 0) + (this.spinRate || 0) * boost * h; this.flipAng = (this.flipAng || 0) + (this.flipRate || 0) * boost * h;
    if (this.flipRate) { _q.setFromAxisAngle(FA, this.flipRate * boost * h); this.q.premultiply(_q); }
    if (this.spinRate) { _q.setFromAxisAngle(UP, this.spinRate * boost * h); this.q.multiply(_q); }
    if (this.rollRate) { _q.setFromAxisAngle(V(0, 0, 1), this.rollRate * h); this.q.multiply(_q); }
    this.q.normalize(); this.syncW(boost);
    this.spinAcc = (this.spinAcc || 0);
    // feet below the centre of mass along the body
    // legs: from their length at takeoff, folding up under him over a quarter second (never pushing the feet down)
    const airLegs = COM_H - 0.24 - 0.16 * (this.grab ? 1 : 0), l0 = this.legs0 ?? airLegs, ka = Math.min(1, this.airT / 0.25);
    const legs = Math.min(l0, l0 + (airLegs - l0) * ka * ka * (3 - 2 * ka));
    const bodyUp = V(0, 1, 0).applyQuaternion(this.q);
    this.pos.copy(this.com).addScaledVector(bodyUp, -legs);
    // rails catch you from above
    if (this.checkRails(inp, true)) return;
    // touching the snow: the feet (and ski ends), or the body
    const gF = ground(this.pos.x, this.pos.z), gC = ground(this.com.x, this.com.z);
    this.lastAirGround = gF;
    const tips = this.skiEnds();
    let hit = this.pos.y <= gF && this.airT > 0.04;
    // a ski tip or tail digging in (not just after takeoff: on a curved lip the tail sits under the tangent line)
    if (this.airT > 0.18 && this.vel.y < 0) for (const p of tips) if (p.y <= ground(p.x, p.z) - 0.04) hit = true;
    const bodyHit = this.com.y - 0.25 <= gC;
    if (hit || bodyHit) this.touchdown(gF, bodyHit && !hit, inp);
  }
  // seconds until the feet reach the snow on the current flight path (no drag), sampled every 1/60 s
  timeToSnow() {
    let x = this.com.x, y = this.com.y - (COM_H - 0.24), z = this.com.z, vx = this.vel.x, vy = this.vel.y, vz = this.vel.z;
    const g = T.gravity ?? 9.81, dt = 1 / 60;
    for (let t = 0; t < 4; t += dt) {
      vy -= g * dt; x += vx * dt; y += vy * dt; z += vz * dt;
      if (vy < 0 && y <= ground(x, z)) {
        const n = this.landN = normal(x, z, this.landN || V()), d = V(vx, vy, vz); d.addScaledVector(n, -d.dot(n)).normalize();
        const fw = V(0, 0, 1).applyQuaternion(this.q); this.landD = fw.dot(d) >= 0 ? d : d.negate();
        return t;
      }
    }
    return 9;
  }
  tuckAir() { return this.grab ? 1 : this.crouch * 0.6; }
  skiEnds() {
    const fw = V(0, 0, 1).applyQuaternion(this.q), out = [];
    for (const s of [0.86, -0.86]) out.push(V().copy(this.pos).addScaledVector(fw, s));
    return out;
  }
  // how far from landable, and the nearest landable attitude (forward or switch) for the snow below
  landTarget() {
    const gx = this.com.x + this.vel.x * 0.25, gz = this.com.z + this.vel.z * 0.25;
    const n = normal(gx, gz, V());
    const vdir = V().copy(this.vel).addScaledVector(n, -this.vel.dot(n));
    if (vdir.lengthSq() < 1e-4) vdir.set(Math.sin(this.yaw), 0, Math.cos(this.yaw));
    vdir.normalize();
    const fw = V(0, 0, 1).applyQuaternion(this.q);
    const dir = fw.dot(vdir) >= 0 ? vdir : vdir.clone().negate();
    const x = V().crossVectors(n, dir).normalize();
    const q = new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(x, n, dir));
    return { q, n, dir };
  }
  assist(h, inp) {
    const k = T.landAssist ?? 0.7; if (!k) return;
    const gy = ground(this.com.x, this.com.z), alt = this.com.y - gy;
    const vy = -this.vel.y, tti = vy > 0.1 ? alt / vy : 9;
    if (tti > 0.55 || Math.abs(inp.rsx) > 0.2 || Math.abs(inp.rsy) > 0.25) return;
    const { q } = this.landTarget();
    const ang = 2 * Math.acos(Math.min(1, Math.abs(q.dot(this.q))));
    if (this.solving && ang > 0.35) return;
    if (ang > (T.assistRange ?? 1.0) * (0.6 + 0.8 * k)) return;     // too far round to save
    // spin down and swing toward the target, harder the closer the snow
    const s = k * (1 - tti / 0.55);
    // the rotation solver is already bringing him round: only polish the last few degrees, don't brake the spin
    if (this.solving && ang > 0.35) return;
    if (!this.solving) { const dmp = Math.exp(-7 * s * h); this.spinRate *= dmp; this.flipRate *= dmp; this.rollRate *= dmp; this.syncW(); }
    this.q.slerp(q, 1 - Math.exp(-(T.assistRate ?? 8) * s * h));
  }

  touchdown(gy, bodyOnly, inp) {
    const { q, n, dir } = this.landTarget();
    normal(this.pos.x, this.pos.z, n);
    const bodyUp = V(0, 1, 0).applyQuaternion(this.q), fw = V(0, 0, 1).applyQuaternion(this.q);
    const tilt = Math.acos(clamp(bodyUp.dot(n), -1, 1));
    const fwFlat = fw.clone().addScaledVector(n, -fw.dot(n)); const fl = fwFlat.length();
    const vt = V().copy(this.vel).addScaledVector(n, -this.vel.dot(n)), sp = vt.length();
    const align = fl > 1e-3 && sp > 0.5 ? Math.acos(clamp(Math.abs(fwFlat.dot(vt)) / (fl * sp), 0, 1)) : 0;
    const wmag = this.w.length();
    const ease = T.landAssist ?? 0.7;
    const tiltOK = (T.landTilt ?? 38) * Math.PI / 180 * (1 + 0.35 * ease), alignOK = (T.landAlign ?? 38) * Math.PI / 180 * (1 + 0.35 * ease);
    const impact = -this.vel.dot(n);
    if (bodyOnly || tilt > tiltOK || align > alignOK || wmag > 9 || impact > (T.maxImpact ?? 16) || this.grab && (T.grabLandCrash ?? true) && this.grabT > 0 && !this.grabLetGo(tilt)) {
      return this.crash(bodyOnly ? 'body' : tilt > tiltOK ? 'tilt' : align > alignOK ? 'sideways' : impact > (T.maxImpact ?? 16) ? 'flat' : 'spin');
    }
    // landed: the skis go down along the motion (forward or switch), the legs soak it up
    const clean = tilt < 0.26 && align < 0.26 && impact < 11, perfect = tilt + align < 0.14 && impact < 8;
    this.pos.y = gy; this.vel.addScaledVector(n, -this.vel.dot(n));
    // a sketchy landing costs speed
    if (!clean) this.vel.multiplyScalar(1 - 0.25 * Math.min(1, (tilt + align) / 1.2));
    const fwd = fwFlat.lengthSq() > 1e-6 ? fwFlat.normalize() : dir;
    const swOK = fwd.dot(vt) < 0;
    this.yaw = Math.atan2(fwd.x, fwd.z);
    // straighten the skis onto the line of motion (the legs do it as you land)
    const vy = Math.atan2(vt.x, vt.z) + (swOK ? Math.PI : 0); this.yaw = wrap(vy + wrap(this.yaw - vy) * 0.3);
    this.switch = swOK;
    this.state = 'ground'; this.w.set(0, 0, 0); this.spinRate = this.flipRate = this.rollRate = 0; this.grab = null;
    this.impact = impact; this.landWob = clean ? 0.2 : 1;
    this.crouch = Math.max(this.crouch, clamp(impact / 9, 0.3, 1));
    this.n.copy(n); this.groundQuat(this.q);
    // a blink of air over a bump (not a pop) is not a landing: no compression, spray, shake or sound
    const micro = !this.airPopped && this.airT < 0.22 && impact < 2.5;
    this.landedAt = this.simTime;
    this.events.push({ type: 'land', clean, perfect, tilt, align, impact, switch: swOK, airT: this.airT, micro });
    if (micro) { this.landWob = 0; this.crouch = 0; }
  }
  grabLetGo() { return true; }

  updateGrab(inp, h) {
    const L = inp.grabL, R = inp.grabR;
    if (!L && !R) { if (this.grab) this.events.push({ type: 'grabEnd', grab: this.grab, t: this.grabT }); this.grab = null; this.grabT = 0; return; }
    const ly = -inp.lsy, lx = inp.steer;
    let name;
    if (L && R) name = ly < -0.5 ? 'Double Tail' : Math.abs(lx) > 0.5 ? 'Octo' : 'Truck Driver';
    else {
      const hand = L ? 'L' : 'R', same = L ? lx < -0.5 : lx > 0.5, opp = L ? lx > 0.5 : lx < -0.5;
      name = ly > 0.5 ? 'Tip' : ly < -0.5 ? (opp ? 'Critical' : 'Tail') : opp ? 'Mute' : same ? 'Japan' : 'Safety';
      name += ':' + hand;
    }
    if (!this.grab || this.grab !== name) { if (this.grab) this.events.push({ type: 'grabEnd', grab: this.grab, t: this.grabT }); this.grab = name; this.grabT = 0; this.events.push({ type: 'grab', grab: name }); }
    this.grabT += h;
  }

  // ── rails ──
  checkRails(inp, air) {
    if (this.railCool > 0) { this.railCool -= 1 / 240; return false; }
    const p = this.pos;
    for (const sg of SEGS) {
      // closest point on the segment (in plan, then height)
      _a.subVectors(p, sg.a); let s = clamp(_a.dot(sg.d), 0, sg.len);
      const c = _b.copy(sg.a).addScaledVector(sg.d, s);
      const top = c.y + sg.R.topOff * 0;
      const lat = Math.hypot(p.x - c.x, p.z - c.z);
      const reach = sg.R.w / 2 + (T.railMagnet ?? 0.32);
      if (lat > reach) continue;
      const dy = p.y - top;
      const vAlong = this.vel.dot(sg.d);
      if (dy < -0.32 || dy > (air ? 0.25 : 0.12) || vAlong < 1.2) continue;
      if (air && this.vel.y > 2.5) continue;
      if (s <= 0 && sg.i === 0 && _a.dot(sg.d) < -0.2) continue;   // not before the start
      return this.lockRail(sg, s, vAlong, air);
    }
    return false;
  }
  lockRail(sg, s, vAlong, air) {
    const R = sg.R;
    // the skis' angle to the rail snaps to the nearest 0/90/180/270 within the magnet's pull
    const fw = V(0, 0, 1).applyQuaternion(this.q); const rYaw = Math.atan2(sg.d.x, sg.d.z), sYaw = Math.atan2(fw.x, fw.z);
    let rel = wrap(sYaw - rYaw);
    const air0 = air ? this.w.dot(UP) : 0;
    // riding on from the snow with a wind-up: hop the skis round 90 onto it (a slide)
    let relV = air0 * 0.6;
    if (air && Math.abs(air0) > 2) rel = wrap(rel + air0 * 0.1);     // carry the spin you came in with round onto the rail
    if (!air && Math.abs(this.windup) > 0.3) { relV = -Math.sign(this.windup) * (T.railTurn ?? 7); this.windup = 0; }
    this.rail = { R, seg: SEGS.indexOf(sg), s: sg.s0 + s, v: vAlong, rel, relV, t: 0, startRel: rel, swaps: 0, enteredAir: air };
    this.state = 'rail'; this.grab = null; this.w.set(0, 0, 0); this.spinRate = this.flipRate = this.rollRate = 0;
    this.events.push({ type: 'rail', name: R.name, kind: R.kind, rel, air });
    return true;
  }
  railPoint(R, s, out, dir) {
    let sg = null; for (const g of SEGS) if (g.R === R && s >= g.s0 - 1e-6 && s <= g.s0 + g.len + 1e-6) { sg = g; break; }
    if (!sg) return null;
    out.copy(sg.a).addScaledVector(sg.d, s - sg.s0); if (dir) dir.copy(sg.d); return sg;
  }
  stepRail(h, inp, g) {
    const r = this.rail, R = r.R, dir = V(), at = V();
    const sg = this.railPoint(R, r.s, at, dir);
    if (!sg) return this.leaveRail(inp, false);
    // gravity along the rail, sliding friction (metal is slick, the box top grabs a bit), a little air drag
    const mu = R.kind === 'rail' ? (T.railFriction ?? 0.05) : (T.boxFriction ?? 0.08);
    r.v += (-g * dir.y - mu * g * Math.sqrt(1 - dir.y * dir.y) * Math.sign(r.v) - 0.004 * r.v * r.v * Math.sign(r.v)) * h;
    r.s += r.v * h; r.t += h;
    // right stick turns the skis on the rail; the magnet settles them at 0 / 90
    const turn = T.railTurn ?? 7;
    if (Math.abs(inp.rsx) > 0.4) r.relV = -inp.rsx * turn;
    else {
      const near = Math.round(r.rel / (Math.PI / 2)) * (Math.PI / 2), k = (T.railSnap ?? 14) * 9;
      r.relV += (wrap(near - r.rel) * k - r.relV * 2 * Math.sqrt(k)) * h;
    }
    const prevQ = Math.round(r.rel / (Math.PI / 2));
    r.rel = wrap(r.rel + r.relV * h);
    if (Math.round(r.rel / (Math.PI / 2)) !== prevQ && Math.abs(inp.rsx) > 0.4) { r.swaps++; this.events.push({ type: 'railSwap', rel: r.rel }); }
    this.pos.copy(at);
    const rYaw = Math.atan2(dir.x, dir.z) + r.rel;
    this.yaw = rYaw;
    // body: the skis lie on the rail, pitched by its slope as far as they point along it
    const hl = Math.hypot(dir.x, dir.z), tanS = dir.y / Math.max(1e-3, hl);
    const along = V(Math.sin(rYaw), tanS * Math.cos(r.rel), Math.cos(rYaw)).normalize();
    const left = V().crossVectors(UP, along).normalize(), upv = V().crossVectors(along, left).normalize();
    this.q.setFromRotationMatrix(new THREE.Matrix4().makeBasis(left, upv, along));
    this.vel.copy(dir).multiplyScalar(r.v);
    this.com.copy(this.pos).addScaledVector(upv, COM_H - 0.2);
    this.n.copy(upv);
    if (inp.popped || this.rsPop) return this.leaveRail(inp, true);
    if (r.s >= R.total || r.s <= 0 || r.v < 0.3) return this.leaveRail(inp, false);
  }
  leaveRail(inp, popped) {
    const r = this.rail;
    this.events.push({ type: 'railEnd', name: r.R.name, t: r.t, rel: r.rel, swaps: r.swaps, popped });
    this.leftRail = r; this.rail = null; this.railCool = 0.25;
    if (popped) {
      const k = this.charge, pop = ((T.popMin ?? 2.4) + ((T.popMax ?? 4.2) - (T.popMin ?? 2.4)) * k * (2 - k)) * 0.85;
      this.vel.y += pop;
    } else this.vel.y += 0.4;
    this.charge = 0;
    this.state = 'air'; this.airT = 0; this.takeoffSwitch = Math.abs(r.rel) > Math.PI / 2; this.setFlipAxis();
    const spin = this.windup * (T.spinMax ?? 7.2) * 0.8;
    this.spinRate = -spin; this.flipRate = 0; this.rollRate = 0; this.windup = 0; this.spinAng = 0; this.flipAng = 0; this.tti = 9; this.ttiT = 9;
    // sideways off the end with no spin loaded: turn out to the nearer way down (forward or switch) during the drop
    if (Math.abs(spin) < 1) {
      const rel = wrap(r.rel), toFwd = -rel, toSw = wrap(Math.PI - rel), turn = Math.abs(toFwd) <= Math.abs(toSw) ? toFwd : toSw;
      if (Math.abs(turn) > 0.2) this.spinRate = clamp(turn / 0.32, -9, 9);
      this.railOut = Math.abs(turn) > 0.2 ? 0.32 : 0;
    }
    this.events.push({ type: 'air', popped, switch: this.takeoffSwitch, rail: true });
  }

  // ── crashing: the view runs a ragdoll; physics slides the body down and waits ──
  crash(why) {
    this.state = 'crash'; this.crashT = 0; this.grab = null; this.rail = null;
    this.crashVel = this.vel.clone(); this.crashW = this.w.clone();
    this.events.push({ type: 'crash', why });
  }
  stepCrash(h, inp, g) {
    this.crashT += h;
    // the body's own slide (the view's ragdoll follows the snow itself); used for the camera fallback and respawn
    const v = this.vel; v.y -= g * h; this.com.addScaledVector(v, h);
    const gy = ground(this.com.x, this.com.z) + 0.25;
    if (this.com.y < gy) { this.com.y = gy; const n = normal(this.com.x, this.com.z, V()); const vn = v.dot(n); if (vn < 0) v.addScaledVector(n, -vn * 1.3); v.multiplyScalar(Math.exp(-2.2 * h)); }
    this.pos.copy(this.com);
    if (this.crashT > (T.crashTime ?? 2.6) || (this.crashT > 0.9 && inp.popped)) this.recover();
  }
  // back to the snow a couple of seconds before the hit, with the speed you had, for another go
  recover() {
    const back = T.retryBack ?? 2.2;
    const t0 = (this.airStart ? this.airStart.t : this.simTime) - back;
    let pick = null;
    for (const s of this.history) if (s.t <= t0) pick = s;
    if (!pick) pick = this.history[0];
    if (pick) { this.respawn({ x: pick.pos.x, z: pick.pos.z, yaw: pick.yaw, switch: pick.sw }, pick.vel.clone()); }
    else this.respawn(SPAWNS[0]);
  }
  remember(h) {
    this.histT += h; if (this.histT < 0.1) return; this.histT = 0;
    this.history.push({ t: this.simTime, pos: this.pos.clone(), vel: this.vel.clone(), yaw: this.yaw, sw: this.switch });
    if (this.history.length > 120) this.history.shift();
  }
}
