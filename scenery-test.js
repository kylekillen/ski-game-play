// Test page for scenery.js: ?cam=x,y,z&look=x,y,z&camg=1(lift cam y above ground)&lookg=1&fov=55&noscenery=1&fly=1&time=14
import * as THREE from 'three';
import { createGfx } from './gfx.js';
import { buildWorld } from './world.js';
import { ground } from './terrain.js';

const qs = new URLSearchParams(location.search);
const v3 = (s, d) => { if (!s) return d; const a = s.split(',').map(Number); return new THREE.Vector3(a[0], a[1], a[2]); };
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(+(qs.get('fov') || 55), innerWidth / innerHeight, 0.1, 9000);
const gfx = createGfx(scene, camera, { graphicsQuality: qs.get('q') || 'high', timeOfDay: +(qs.get('time') || 14), depthOfField: 0, motionBlur: 0, fisheye: 0 });
const world = buildWorld(scene, gfx, {});
let scenery = null;
const cam = v3(qs.get('cam'), new THREE.Vector3(0, 6, -60));
if (qs.get('camg')) cam.y += ground(cam.x, cam.z);
const look = v3(qs.get('look'), new THREE.Vector3(0, 0, 200));
if (qs.get('lookg')) look.y += ground(look.x, look.z);
camera.position.copy(cam); camera.lookAt(look);
const focus = qs.get('focus') ? v3(qs.get('focus')) : cam.clone().lerp(look, Math.min(1, 12 / cam.distanceTo(look)));
window.__stats = { frames: 0, upd: [], frame: [], calls: 0, tris: 0, errors: [] };
addEventListener('error', (e) => window.__stats.errors.push(String(e.message)));
async function init() {
  if (!qs.get('noscenery')) {
    const { buildScenery } = await import('./scenery.js');
    const t0 = performance.now();
    scenery = buildScenery(scene, gfx, {});
    window.__stats.build = performance.now() - t0;
  }
  window.__scenery = scenery; window.__gfx = gfx; window.__scene = scene; window.__camera = camera;
  let last = performance.now();
  const info = gfx.renderer.info; info.autoReset = false;
  const fly = qs.get('fly'), t00 = performance.now();
  function frame() {
    const now = performance.now(), dt = Math.min(0.05, (now - last) / 1000); last = now;
    if (fly) { const t = (now - t00) / 1000, z = cam.z + t * 15; camera.position.set(cam.x, ground(cam.x, z) + 3, z); focus.set(cam.x, camera.position.y - 1.5, z + 5); camera.lookAt(cam.x, focus.y - 3, z + 40); }
    world.update(focus);
    const u0 = performance.now();
    if (scenery) scenery.update(dt, camera.position);
    const u1 = performance.now();
    info.reset();
    gfx.render(dt, focus);
    const S = window.__stats; S.frames++; S.calls = info.render.calls; S.tris = info.render.triangles;
    S.upd.push(u1 - u0); S.frame.push(performance.now() - now); if (S.upd.length > 240) { S.upd.shift(); S.frame.shift(); }
    requestAnimationFrame(frame);
  }
  frame();
}
init().catch((e) => { console.error(e); window.__stats.errors.push(String(e.stack || e)); });
