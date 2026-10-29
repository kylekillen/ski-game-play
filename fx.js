// Snow spray, powder puffs and ski tracks.
// Spray: CPU particles drawn as soft sprites lit by the sun (a few thousand at most), the usual
// "kick-up" emitter on ski edges as in Steep / SSX: amount from how much the skis skid and how fast.
// Tracks: two ribbons pressed into the snow behind the skis, fading out at their tail.
import * as THREE from 'three';
import { ground, normal, groomed } from './terrain.js';

const V = (x = 0, y = 0, z = 0) => new THREE.Vector3(x, y, z);
const MAX = 3000, TRACK = 600;

export class Fx {
  constructor(scene) {
    const g = new THREE.BufferGeometry();
    this.pos = new Float32Array(MAX * 3); this.vel = new Float32Array(MAX * 3); this.life = new Float32Array(MAX); this.size = new Float32Array(MAX); this.age = new Float32Array(MAX);
    g.setAttribute('position', new THREE.BufferAttribute(this.pos, 3)); g.setAttribute('aSize', new THREE.BufferAttribute(this.size, 1)); g.setAttribute('aAlpha', new THREE.BufferAttribute(new Float32Array(MAX), 1));
    this.mat = new THREE.ShaderMaterial({
      transparent: true, depthWrite: false,
      uniforms: { uScale: { value: 600 }, uSun: { value: new THREE.Color(1, 0.97, 0.92) }, uSky: { value: new THREE.Color(0.55, 0.65, 0.8) } },
      vertexShader: `attribute float aSize; attribute float aAlpha; varying float vA; uniform float uScale;
        void main() { vec4 mv = modelViewMatrix * vec4(position, 1.0); gl_Position = projectionMatrix * mv; gl_PointSize = aSize * uScale / -mv.z; vA = aAlpha; }`,
      fragmentShader: `varying float vA; uniform vec3 uSun, uSky;
        void main() { vec2 c = gl_PointCoord - 0.5; float r = dot(c, c); if (r > 0.25) discard; float a = (1.0 - r * 4.0); a *= a * vA;
          vec3 col = mix(uSky, uSun, 0.6 + 0.4 * (0.5 - c.y)) * 2.2; gl_FragColor = vec4(col, a); }`,
    });
    this.points = new THREE.Points(g, this.mat); this.points.frustumCulled = false; scene.add(this.points);
    this.n = 0; this.head = 0; this.carry = 0;
    // tracks
    this.tracks = [0, 1].map(() => {
      const tg = new THREE.BufferGeometry(), p = new Float32Array(TRACK * 2 * 3), a = new Float32Array(TRACK * 2);
      tg.setAttribute('position', new THREE.BufferAttribute(p, 3)); tg.setAttribute('aA', new THREE.BufferAttribute(a, 1));
      const idx = []; for (let i = 0; i < TRACK - 1; i++) { const k = i * 2; idx.push(k, k + 2, k + 1, k + 1, k + 2, k + 3); } tg.setIndex(idx);
      const m = new THREE.ShaderMaterial({ transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
        vertexShader: 'attribute float aA; varying float vA; void main() { vA = aA; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
        fragmentShader: 'varying float vA; void main() { gl_FragColor = vec4(0.42, 0.47, 0.55, vA * 0.22); }' });
      const mesh = new THREE.Mesh(tg, m); mesh.frustumCulled = false; scene.add(mesh);
      return { tg, p, a, n: 0, last: null };
    });
  }
  emit(p, v, size, life) {
    const i = this.head; this.head = (this.head + 1) % MAX; this.n = Math.min(MAX, this.n + 1);
    this.pos.set([p.x, p.y, p.z], i * 3); this.vel.set([v.x, v.y, v.z], i * 3); this.life[i] = life; this.age[i] = 0; this.size[i] = size;
  }
  burst(p, n, power) {
    for (let k = 0; k < n; k++) {
      const a = Math.random() * Math.PI * 2, s = power * (0.3 + Math.random());
      this.emit(V(p.x + (Math.random() - 0.5) * 0.6, p.y + 0.05, p.z + (Math.random() - 0.5) * 0.8), V(Math.cos(a) * s, 1 + Math.random() * power * 0.7, Math.sin(a) * s), 0.12 + Math.random() * 0.25, 0.6 + Math.random() * 0.8);
    }
  }
  update(dt, ph, skier) {
    // spray from the skis: skidding sideways, braking, hard carves, deep snow
    if (ph.state === 'ground' && ph.speed > 2) {
      const sp = ph.speed, deep = 1 - groomed(ph.pos.x, ph.pos.z);
      const amt = (ph.skid * 1.4 + (ph.brake || 0) * 1.2 + Math.abs(ph.edge || 0) * 0.35 + deep * 0.5) * Math.min(1, sp / 12);
      this.carry += amt * sp * 22 * dt;
      const side = V().crossVectors(ph.n, ph.vel).normalize(), back = ph.vel.clone().normalize();
      while (this.carry > 1) {
        this.carry -= 1;
        const s = Math.sign(ph.edge || 0) || (Math.random() < 0.5 ? 1 : -1);
        const p = ph.pos.clone().addScaledVector(back, -0.3 - Math.random() * 0.6).addScaledVector(side, -s * 0.15 + (Math.random() - 0.5) * 0.3);
        const v = ph.vel.clone().multiplyScalar(0.35 + Math.random() * 0.3).addScaledVector(side, -s * (1 + Math.random() * 2.5) * (0.5 + ph.skid)).add(V(0, 0.8 + Math.random() * 2.2, 0));
        this.emit(p, v, 0.07 + Math.random() * 0.2 + deep * 0.15, 0.5 + Math.random() * 0.7);
      }
    }
    for (const e of ph.events) {
      if (e.type === 'land') this.burst(ph.pos, Math.min(160, 30 + e.impact * 14), 0.8 + e.impact * 0.25);
      if (e.type === 'crash') this.burst(ph.com, 200, 3);
      if (e.type === 'polePlant') { const f = V(Math.sin(ph.yaw), 0, Math.cos(ph.yaw)), l = V(f.z, 0, -f.x); for (const sd of [1, -1]) this.burst(ph.pos.clone().addScaledVector(l, sd * 0.36).addScaledVector(f, 0.3), 8, 0.35); }
    }
    if (ph.state === 'crash' && ph.speed > 3 && Math.random() < 0.5) this.burst(ph.com, 4, 1.2);
    // move them: drag, gravity, settle on the snow
    const P = this.pos, Vl = this.vel, A = this.points.geometry.attributes.aAlpha.array;
    for (let i = 0; i < MAX; i++) {
      if (this.life[i] <= 0) { A[i] = 0; continue; }
      this.age[i] += dt; const t = this.age[i] / this.life[i];
      if (t >= 1) { this.life[i] = 0; A[i] = 0; continue; }
      const k = Math.exp(-2.2 * dt);
      Vl[i * 3] *= k; Vl[i * 3 + 2] *= k; Vl[i * 3 + 1] = Vl[i * 3 + 1] * k - 6.5 * dt;
      P[i * 3] += Vl[i * 3] * dt; P[i * 3 + 1] += Vl[i * 3 + 1] * dt; P[i * 3 + 2] += Vl[i * 3 + 2] * dt;
      const gy = ground(P[i * 3], P[i * 3 + 2]); if (P[i * 3 + 1] < gy + 0.02) { P[i * 3 + 1] = gy + 0.02; Vl[i * 3 + 1] = 0; }
      this.size[i] *= 1 + dt * 0.9;
      A[i] = (1 - t) * Math.min(1, t * 8) * 0.85;
    }
    this.points.geometry.attributes.position.needsUpdate = true; this.points.geometry.attributes.aAlpha.needsUpdate = true; this.points.geometry.attributes.aSize.needsUpdate = true;
    this.updateTracks(ph, skier);
  }
  updateTracks(ph, skier) {
    const on = ph.state === 'ground';
    const fwd = V(Math.sin(ph.yaw), 0, Math.cos(ph.yaw)), left = V(fwd.z, 0, -fwd.x);
    this.tracks.forEach((tr, i) => {
      if (!on) { tr.last = null; tr.gap = true; return; }
      const c = ph.pos.clone().addScaledVector(left, (i ? -1 : 1) * 0.12);
      if (tr.last && tr.last.distanceToSquared(c) < 0.09) return;
      if (tr.last && tr.last.distanceToSquared(c) > 9) tr.gap = true;
      // shift down the ring (simple: keep newest at the end)
      const n = tr.n < TRACK ? tr.n++ : TRACK;
      if (n === TRACK) { tr.p.copyWithin(0, 6); tr.a.copyWithin(0, 2); }
      const k = (n === TRACK ? TRACK - 1 : n) * 2;
      const nrm = normal(c.x, c.z, V()), w = 0.05, y = ground(c.x, c.z) + 0.012;
      const l = V().crossVectors(nrm, fwd).normalize();
      tr.p.set([c.x + l.x * w, y, c.z + l.z * w, c.x - l.x * w, y, c.z - l.z * w], k * 3);
      const alpha = tr.gap ? 0 : 1; tr.gap = false;
      tr.a[k] = alpha; tr.a[k + 1] = alpha;
      tr.last = c;
      // fade the oldest third
      const m = Math.min(tr.n, TRACK);
      for (let j = 0; j < Math.min(m, 200); j++) { const f = j / 200; if (tr.a[j * 2] > 0) { tr.a[j * 2] = Math.min(tr.a[j * 2], f); tr.a[j * 2 + 1] = tr.a[j * 2]; } }
      tr.tg.attributes.position.needsUpdate = true; tr.tg.attributes.aA.needsUpdate = true; tr.tg.setDrawRange(0, Math.max(0, (m - 1) * 6));
    });
    void skier;
  }
}
