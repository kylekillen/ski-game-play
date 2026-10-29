// Snowline: a freestyle ski park in the browser. This file wires it together and runs the frame:
// input -> physics (240 Hz inside) -> tricks -> skier pose -> camera -> picture.
import * as THREE from 'three';
import { TWEAKS as T } from './tweaks.js';
import { createGfx } from './gfx.js';
import { buildWorld } from './world.js';
import { ground, SPAWNS } from './terrain.js';
import { SkiPhysics } from './physics.js';
import { SkierView } from './skier.js';
import { Input } from './input.js';
import { Tricks } from './tricks.js';
import { Hud, Menu } from './hud.js';
import { Fx } from './fx.js';
import { Audio } from './audio.js';

const V = (x = 0, y = 0, z = 0) => new THREE.Vector3(x, y, z);
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const $ = (id) => document.getElementById(id);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(T.camFov, innerWidth / innerHeight, 0.08, 9000);
const gfx = createGfx(scene, camera, T);
const world = buildWorld(scene, gfx, T);
let scenery = null;
import('./scenery.js').then((m) => { scenery = m.buildScenery(scene, gfx, T); window.game && (window.game.scenery = scenery); }).catch((e) => console.warn('scenery not loaded', e));
const ph = new SkiPhysics();
const skier = new SkierView(scene);
const input = new Input();
const hud = new Hud();
const menu = new Menu();
const tricks = new Tricks(hud);
const fx = new Fx(scene);
const audio = new Audio();

// ── camera: behind the line of travel (not the skis, so spins don't swing it), a bit above, springy ──
const cam = { pos: V(), look: V(), heading: 0, mode: 0, fov: T.camFov, shake: 0, init: false, v: V(), lv: V() };
const MODES = [{ name: 'Follow', d: 1, h: 1 }, { name: 'Filmer', d: 2.1, h: 1.9 }, { name: 'Low', d: 0.72, h: 0.45 }];
function updateCamera(dt) {
  const M = MODES[cam.mode], focus = ph.state === 'crash' ? ph.com.clone() : ph.com.clone();
  const hv = V(ph.vel.x, 0, ph.vel.z);
  if (hv.length() > 1.2 && ph.state !== 'air') {
    const want = Math.atan2(hv.x, hv.z); let d = Math.atan2(Math.sin(want - cam.heading), Math.cos(want - cam.heading));
    cam.heading += d * (1 - Math.exp(-(ph.state === 'rail' ? 3 : 2.4) * dt));
  } else if (ph.state === 'ground' && hv.length() <= 1.2) {
    const want = ph.yaw + (ph.switch ? Math.PI : 0); const d = Math.atan2(Math.sin(want - cam.heading), Math.cos(want - cam.heading)); cam.heading += d * (1 - Math.exp(-1.2 * dt));
  }
  const dir = V(Math.sin(cam.heading), 0, Math.cos(cam.heading));
  const dist = T.camDist * M.d * (1 + clamp(ph.speed / 30, 0, 0.35)), height = T.camHeight * M.h;
  const want = focus.clone().addScaledVector(dir, -dist).add(V(0, height, 0));
  // in the air, hang back and rise a little to keep the landing in frame
  if (ph.state === 'air') want.y += Math.min(1.2, ph.airT * 0.8);
  const gy = ground(want.x, want.z) + 0.7; if (want.y < gy) want.y = gy;
  const lookT = focus.clone().addScaledVector(dir, 2.2 + ph.speed * 0.06).add(V(0, ph.state === 'air' ? -0.3 : 0.15, 0));
  // smooth the camera's offset from the skier, not its position: no lag-behind at speed, but soft swings
  const offW = want.clone().sub(focus), lookO = lookT.clone().sub(focus);
  if (!cam.init) { cam.off = offW.clone(); cam.lo = lookO.clone(); cam.init = true; cam.fy = focus.y; }
  // vertical: follow the body loosely in the air (so the jump's height reads), tightly on the snow
  cam.fyK = (cam.fyK ?? 12) + ((ph.state === 'air' ? 3.5 : 12) - (cam.fyK ?? 12)) * (1 - Math.exp(-2.5 * dt));   // the follow rate itself eases, so a landing doesn't jolt
  cam.fy += (focus.y - cam.fy) * (1 - Math.exp(-cam.fyK * dt));
  cam.off.lerp(offW, 1 - Math.exp(-T.camLag * dt)); cam.lo.lerp(lookO, 1 - Math.exp(-9 * dt));
  const base = V(focus.x, cam.fy, focus.z);
  cam.pos.copy(base).add(cam.off); cam.look.copy(base).add(cam.lo);
  // keep the lens above the snow with a soft lift (a hard clamp jolted the picture on every landing hill)
  { const cgy = Math.max(ground(cam.pos.x, cam.pos.z), ground(cam.pos.x + (cam.look.x - cam.pos.x) * 0.15, cam.pos.z + (cam.look.z - cam.pos.z) * 0.15)) + 0.7;
    const want = Math.max(0, cgy - cam.pos.y); cam.lift = (cam.lift || 0) + (want - (cam.lift || 0)) * (1 - Math.exp(-(want > (cam.lift || 0) ? 14 : 3) * dt));
    cam.pos.y += cam.lift; const hard = cgy - 0.5; if (cam.pos.y < hard) cam.pos.y = hard; }
  if (game.debugCam) { const d = game.debugCam; cam.pos.copy(focus).add(V(...d.off)); cam.look.copy(focus).add(V(...(d.look || [0, 0, 0]))); }
  camera.position.copy(cam.pos);
  if (game.freeCam) { camera.position.set(...game.freeCam.pos); camera.lookAt(...game.freeCam.look); camera.fov = T.camFov; camera.updateProjectionMatrix(); return; }
  for (const e of ph.events) if (e.type === 'land') cam.shake = Math.min(0.5, e.impact * 0.03); else if (e.type === 'crash') cam.shake = 0.5;
  cam.shake *= Math.exp(-6 * dt);
  const sh = cam.shake, t = performance.now() / 1000;
  camera.lookAt(cam.look.clone().add(V(Math.sin(t * 37) * sh * 0.3, Math.sin(t * 43) * sh * 0.3, 0)));
  if (game.debugCam) camera.lookAt(cam.look);
  const fov = T.camFov + clamp(ph.speed - 6, 0, 18) * 0.45;
  cam.fov += (fov - cam.fov) * (1 - Math.exp(-2 * dt)); camera.fov = cam.fov; camera.updateProjectionMatrix();
}

// ── instant replay: the last few seconds, slowed down, from a filmer's spot beside the line (RB / F) ──
const REC = [], REC_SEC = 7;
const KEYS_V = ['pos', 'q', 'vel', 'com', 'n', 'crashVel', 'crashW', 'w'], KEYS_S = ['state', 'edge', 'crouch', 'tuck', 'press', 'brake', 'grab', 'windup', 'landWob', 'impact', 'yawRate', 'skid', 'switch', 'airT', 'yaw'];
function record() {
  const o = { t: simTime, events: [] };
  for (const k of KEYS_V) if (ph[k]) o[k] = ph[k].clone();
  for (const k of KEYS_S) o[k] = ph[k];
  o.rail = ph.rail ? { rel: ph.rail.rel } : null;
  o.speed = ph.speed; REC.push(o);
  while (REC.length && simTime - REC[0].t > REC_SEC) REC.shift();
}
let replay = null;
function startReplay() {
  if (REC.length < 30) return;
  const s0 = REC[0], mid = REC[Math.floor(REC.length * 0.55)];
  const dir = mid.vel.clone().setY(0); if (dir.lengthSq() < 0.01) dir.set(0, 0, 1); dir.normalize();
  const side = V(dir.z, 0, -dir.x);
  // a filmer standing off to the side of the line, on whichever side has the clearer view (lower snow), up on a bank
  let spot = null, best = Infinity;
  for (const sd of [1, -1]) for (const d of [16, 22]) { const c = mid.com.clone().addScaledVector(side, sd * d).addScaledVector(dir, 4); const gy = ground(c.x, c.z); if (gy < best) { best = gy; spot = c; } }
  spot.y = Math.max(ground(spot.x, spot.z) + 3.5, mid.com.y + 1);
  replay = { t: s0.t, end: REC[REC.length - 1].t, spot, look: s0.com.clone(), saved: REC.slice() };
  skier.posed = false; hud.toast('Replay', 1.5);
}
function stepReplay(dt) {
  const R = replay, rec = R.saved; R.t += dt * 0.5;
  let i = rec.findIndex((o) => o.t >= R.t); if (i < 0) { replay = null; skier.posed = false; cam.init = false; return; }
  const o = rec[i];
  skier.update(dt * 0.5, o);
  R.look.lerp(o.com, 1 - Math.exp(-6 * dt));
  const dist = R.spot.distanceTo(R.look);
  camera.position.copy(R.spot); camera.lookAt(R.look); camera.fov = clamp(2 * Math.atan(3.2 / dist) * 180 / Math.PI, 14, 55); camera.updateProjectionMatrix();
}

// ── title / spawns ──
let started = false, spot = 0;
const spots = $('spots');
SPAWNS.forEach((s, i) => { const b = document.createElement('button'); b.textContent = s.name; b.onclick = (e) => { e.stopPropagation(); spot = i; begin(); }; spots.appendChild(b); });
const markSpot = () => [...spots.children].forEach((b, i) => b.classList.toggle('on', i === spot));
markSpot();
function goTo(i, toast = true) {
  spot = (i + SPAWNS.length) % SPAWNS.length; const s = SPAWNS[spot];
  ph.respawn({ x: s.x, z: s.z, yaw: 0 }, V(0, 0, 2)); cam.init = false; cam.heading = 0;
  if (toast) hud.toast(s.name);
  $('where').textContent = s.name;
}
function begin() {
  if (started) return; started = true; $('start').classList.add('hidden'); audio.start(); goTo(spot); $('help').classList.remove('off'); helpT = 12;
}
$('start').addEventListener('click', begin);
let helpT = 0;
// the title screen camera: a slow drift over the park
goTo(0, false);

// ── the loop ──
let last = performance.now(), simTime = 0, frames = 0, fpsT = 0;
const game = { ph, skier, tricks, world, gfx, cam, camera, scene, fx, audio, startReplay, get simTime() { return simTime; }, ready: false, input, hud, fps: 0, begin, goTo };
window.game = game;
function frame(now) {
  requestAnimationFrame(frame);
  const dt = Math.min(0.05, Math.max(0.0005, (now - last) / 1000)); last = now;
  const inp = input.poll();
  if (!started) {
    if (input.take('a') || input.take('start')) begin();
    if (input.take('next') || input.take('right')) { spot = (spot + 1) % SPAWNS.length; markSpot(); }
    if (input.take('prev') || input.take('left')) { spot = (spot - 1 + SPAWNS.length) % SPAWNS.length; markSpot(); }
    // drift over the park
    const t = now / 1000, s = SPAWNS[spot];
    camera.position.set(s.x + 40 * Math.sin(t * 0.05), ground(s.x, s.z + 30) + 18, s.z - 30 + 10 * Math.cos(t * 0.05));
    camera.lookAt(s.x, ground(s.x, s.z + 60), s.z + 60);
    world.update(camera.position); if (scenery) scenery.update(dt, camera.position);
    skier.update(dt, ph);
    gfx.render(dt, V(s.x, ground(s.x, s.z + 40), s.z + 40));
    if (gfx.ready && !game.ready) { game.ready = true; $('loading').textContent = ''; }
    return;
  }
  if (input.take('menu')) menu.toggle();
  if (menu.open) {
    if (input.take('next')) menu.nav(-1, 0); if (input.take('prev')) menu.nav(1, 0);
    if (input.take('left')) menu.nav(0, -1); if (input.take('right')) menu.nav(0, 1);
    if (input.take('a')) menu.press(); if (input.take('b')) menu.toggle(false);
    inp.popped = false; inp.crouch = false;
  } else {
    if (input.take('retry')) { if (ph.state === 'crash') ph.recover(); else { ph.airStart = { t: ph.simTime - 0.01 }; ph.recover(); } tricks.endLine(true); }
    if (input.take('next')) goTo(spot + 1); if (input.take('prev')) goTo(spot - 1);
    if (input.take('camera')) { cam.mode = (cam.mode + 1) % MODES.length; hud.toast(MODES[cam.mode].name + ' camera', 1.2); }
    if (input.take('help')) $('help').classList.toggle('off');
    if (input.take('photo')) { if (replay) { replay = null; skier.posed = false; cam.init = false; } else startReplay(); }
  }
  input.take('a'); input.take('b'); input.take('left'); input.take('right');
  if (helpT > 0 && (helpT -= dt) <= 0) $('help').classList.add('off');
  if (replay) {
    if (input.take('b') || inp.popped) { replay = null; skier.posed = false; cam.init = false; }
    else { stepReplay(dt); world.update(camera.position); if (scenery) scenery.update(dt, camera.position); hud.update(dt, ph, tricks, input.padName); gfx.render(dt, replay ? replay.look : ph.com); return; }
  }
  const sdt = menu.open ? 0 : dt;
  if (sdt > 0) ph.update(sdt, inp);
  simTime += sdt;
  if (sdt > 0) record();
  tricks.update(sdt, ph);
  skier.update(sdt || 1e-4, ph);
  fx.update(sdt, ph, skier);
  audio.update(sdt, ph);
  updateCamera(Math.max(sdt, 1e-4));
  world.update(ph.com); if (scenery) scenery.update(dt, camera.position);
  hud.update(dt, ph, tricks, input.padName);
  gfx.render(dt, ph.com);
  if (gfx.ready) game.ready = true;
  frames++; fpsT += dt; if (fpsT > 1) { game.fps = frames / fpsT; frames = 0; fpsT = 0; dynRes(game.fps); }
}
// dynamic resolution: hold the frame rate by drawing fewer pixels when the picture gets heavy (and more when there's room)
let resCalm = 0;
function dynRes(fps) {
  if (T.dynamicRes === false) return;
  if (fps < 52) { gfx.setScale(gfx.scale * (fps < 40 ? 0.85 : 0.93)); resCalm = 0; }
  else if (fps > 58 && (resCalm += 1) > 4 && gfx.scale < 1) { gfx.setScale(gfx.scale * 1.06); resCalm = 0; }
}
requestAnimationFrame(frame);
addEventListener('gamepadconnected', (e) => hud.toast('Controller connected', 2) || void e);
