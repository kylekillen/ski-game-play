// Everything you can tune, in one place. Change a number, save, refresh the browser.
// The in-game Settings menu (Start button) changes these live and remembers them.
export const TWEAKS = {
  gameName: 'Snowline',

  // ── difficulty: 'easy' | 'normal' | 'hard' sets the four helpers below it (see PRESETS) ──
  difficulty: 'normal',
  landAssist: 0.7,      // 0 = none .. 1 = strong: near the snow, with the sticks let go, you swing toward a landable angle
  speedHelp: 0.6,       // 0 = off .. 1: a hidden speed check before each jump so you reach the landing
  landTilt: 38,         // degrees off upright you can still ride away from
  landAlign: 38,        // degrees the skis can be across the motion and still land

  // ── the mountain ──
  gravity: 10.4,        // m/s^2 (earth is 9.81; a bit more feels snappier, Jibbers players like ~11)
  snowFriction: 0.03,
  dragArea: 0.55,       // m^2, standing up (tuck roughly halves it)
  airDrag: 0.7,         // drag in the air relative to on the snow

  // ── skiing ──
  carveRadius: 8,       // m, tightest carve at low speed (grows with speed)
  turnSpeed: 1,
  pivotRate: 2.6,       // rad/s, turning on the spot when slow
  edgeGrip: 14,         // how hard the edges hold sideways (lower = skiddier)
  butterRate: 3.4,      // rad/s, butter spins (nose/tail press + right stick)
  stick: 6,             // how hard the legs keep you on the snow over a bump before it throws you (m/s^2)

  // ── pole push (X) ──
  polePush: 7.5,        // m/s^2 at the peak of a stroke
  poleTime: 0.85,       // s per stroke
  poleMaxSpeed: 9,      // m/s: no push left at this speed

  // ── jumping and spinning ──
  rightStickPop: true,  // the right stick crouches while held and pops when let go (as in Steep); false = only A pops
  popTime: 0.45,        // s of holding A for a full pop
  popMin: 2.2, popMax: 3.9,   // m/s added by a tap / full pop
  windTime: 0.3,        // s to wind up fully with the right stick
  windDecay: 2.2,
  spinMax: 7.4,         // rad/s, a full wind-up (about 1.2 turns a second)
  flipMax: 5.8,         // rad/s
  airControl: 4,        // how fast the right stick steers the rotation in the air (1/s)
  offAxis: 1.5,         // how much a diagonal leans toward the flip (corks)
  airRollAccel: 5,
  airDamp: 0.25,
  tuckBoost: 0.35,      // grabbing / tucking spins you this much faster (smaller moment of inertia)
  assistRange: 1.0, assistRate: 8,
  trickAssist: 0.8,     // 0 = off .. 1: let go of the stick and the spin / flip finish on a clean 180 / full flip in time for the snow
  stabilizer: 0.8,      // 0 = off: with no flip on the stick the skis follow the flight path (keeps you pointed at the landing)
  stabRate: 2.6,
  maxImpact: 16,        // m/s straight into the snow you can survive
  crashTime: 2.6,       // s on the snow before the retry
  retryBack: 2.2,       // s before the takeoff that a retry puts you back

  // ── rails ──
  railMagnet: 0.32,     // m either side the rail catches you
  railTurn: 7,          // rad/s turning the skis on a rail
  railSnap: 14,         // how hard the skis settle at 0 / 90 degrees
  railFriction: 0.05, boxFriction: 0.08,

  // ── camera ──
  camDist: 3.9, camHeight: 1.35, camFov: 68, camLag: 5,

  // ── the picture ──
  graphicsQuality: 'medium',   // 'low' | 'medium' | 'high' (high = full retina; heavy on a laptop)
  dynamicRes: true,     // drop the resolution a little when the frame rate dips
  look: 'snow',
  fillSky: 0x8fb0e0, fillGround: 0xdde6f0,   // shade light: blue sky above, white snow bouncing up
  timeOfDay: 16.6,
  sunAngle: 0,
  sunAz: -25,           // where the sun is round the compass (degrees; 0 = across the run from the left, -90 = straight up the hill behind you)
  exposure: 0.5,
  haze: 0.35,
  fisheye: 0.15,
  motionBlur: 0.45,
  depthOfField: 0.12,
  snowSparkle: 1,

  // ── the skier ──
  outfit: 'skier',
  shoulderWidth: 0.9, sleeveFit: 0.85,
  skiColor: '#e8452c', skiColor2: '#1b1d22', poles: true, goggleColor: '#e8a33a',
};

export const PRESETS = {
  easy:   { landAssist: 1.0, speedHelp: 1.0, landTilt: 48, landAlign: 50 },
  normal: { landAssist: 0.7, speedHelp: 0.6, landTilt: 38, landAlign: 38 },
  hard:   { landAssist: 0.0, speedHelp: 0.0, landTilt: 26, landAlign: 25 },
};

// saved settings from the in-game menu win over the numbers above
const KEY = 'ski-tweaks';
try { Object.assign(TWEAKS, JSON.parse(localStorage.getItem(KEY) || '{}')); } catch (e) { /* no storage (tests, node) */ }
export function saveTweaks(keys) {
  try { const o = JSON.parse(localStorage.getItem(KEY) || '{}'); for (const k of keys) o[k] = TWEAKS[k]; localStorage.setItem(KEY, JSON.stringify(o)); } catch (e) { /* ignore */ }
}
export function resetTweaks() { try { localStorage.removeItem(KEY); } catch (e) { /* ignore */ } }
