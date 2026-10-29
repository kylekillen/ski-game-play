// Controller + keyboard -> one plain input object the physics reads every frame.
// Standard gamepad mapping (Xbox and PlayStation pads in Chrome / Safari on a Mac):
//   left stick   steer / carve; push forward or back hard = nose / tail press (butter); in the air: tilt off-axis, picks the grab
//   right stick  sideways = wind up a spin (on the snow) / spin (in the air); down = backflip, up = frontflip; on a rail: swap
//   A            hold to crouch, let go to pop (longer hold = bigger pop)
//   LT / RT      grab with the left / right hand (both = two-handed grabs)
//   right stick also crouches while held and pops when you let it go (the Steep way); A does the same
//   X push with the poles (hold to keep poling)   LB tuck   B brake (hockey stop)   Y back to the last good spot
//   D-pad up/down  jump to the next / previous part of the park       Back  change camera      Start  menu
const dz = (v, d = 0.14) => (Math.abs(v) < d ? 0 : (v - Math.sign(v) * d) / (1 - d));
const B = { A: 0, B: 1, X: 2, Y: 3, LB: 4, RB: 5, LT: 6, RT: 7, BACK: 8, START: 9, LS: 10, RS: 11, UP: 12, DOWN: 13, LEFT: 14, RIGHT: 15 };

export class Input {
  constructor() {
    this.keys = new Set(); this.prev = []; this.just = {};
    this.state = { steer: 0, lsy: 0, rsx: 0, rsy: 0, crouch: false, popped: false, tuck: false, brake: false, grabL: false, grabR: false, pole: false };
    this.padName = null; this.wasCrouch = false;
    addEventListener('keydown', (e) => {
      if (e.repeat) return; this.keys.add(e.code);
      const j = { KeyR: 'retry', KeyC: 'camera', Escape: 'menu', KeyP: 'menu', BracketRight: 'next', BracketLeft: 'prev', KeyH: 'help', Enter: 'start', KeyF: 'photo' }[e.code];
      if (j) this.just[j] = true;
      if (['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Tab'].includes(e.code)) e.preventDefault();
    });
    addEventListener('keyup', (e) => this.keys.delete(e.code));
    addEventListener('blur', () => this.keys.clear());
  }
  take(name) { const v = !!this.just[name]; this.just[name] = false; return v; }

  poll() {
    const pads = navigator.getGamepads ? [...navigator.getGamepads()].filter((p) => p && p.connected) : [];
    const pad = pads.find((p) => p.mapping === 'standard') || pads[0];
    this.padName = pad ? pad.id : null;
    const s = this.state, k = (c) => this.keys.has(c);
    let steer = 0, lsy = 0, rsx = 0, rsy = 0, crouch = false, tuck = false, brake = false, gl = false, gr = false, pole = false;
    if (pad) {
      const b = (i) => !!(pad.buttons[i] && (pad.buttons[i].pressed || pad.buttons[i].value > 0.35));
      const hit = (i) => b(i) && !this.prev[i];
      steer = dz(pad.axes[0] || 0); lsy = dz(pad.axes[1] || 0); rsx = dz(pad.axes[2] || 0); rsy = dz(pad.axes[3] || 0);
      crouch = b(B.A); pole = b(B.X); tuck = b(B.LB); brake = b(B.B); gl = b(B.LT); gr = b(B.RT);
      if (hit(B.Y)) this.just.retry = true;
      if (hit(B.BACK)) this.just.camera = true;
      if (hit(B.START)) this.just.menu = true;
      if (hit(B.UP)) this.just.next = true;
      if (hit(B.DOWN)) this.just.prev = true;
      if (hit(B.LEFT)) this.just.left = true;
      if (hit(B.RIGHT)) this.just.right = true;
      if (hit(B.A)) this.just.a = true;
      if (hit(B.B)) this.just.b = true;
      if (hit(B.RB)) this.just.photo = true;
      this.prev = pad.buttons.map((x) => !!(x && (x.pressed || x.value > 0.35)));
    }
    // keyboard: WASD = left stick, arrows = right stick, Space = A, Shift = pole push, Z = tuck, X = brake, Q/E = grabs
    if (k('KeyA')) steer = -1; if (k('KeyD')) steer = 1;
    if (k('KeyW')) lsy = -1; if (k('KeyS')) lsy = 1;
    if (k('ArrowLeft')) rsx = -1; if (k('ArrowRight')) rsx = 1;
    if (k('ArrowUp')) rsy = -1; if (k('ArrowDown')) rsy = 1;
    if (k('Space')) crouch = true;
    if (k('ShiftLeft') || k('ShiftRight')) pole = true;
    if (k('KeyZ')) tuck = true;
    if (k('KeyX')) brake = true;
    if (k('KeyQ')) gl = true; if (k('KeyE')) gr = true;
    s.steer = steer; s.lsy = lsy; s.rsx = rsx; s.rsy = rsy; s.tuck = tuck; s.brake = brake; s.grabL = gl; s.grabR = gr; s.pole = pole;
    // the pop fires when A (Space) is let go
    if (this.wasCrouch && !crouch) s.popped = true;
    this.wasCrouch = crouch; s.crouch = crouch;
    return s;
  }
}
