// Sound, all made live with WebAudio except a few CC0 impact/grind samples (assets/sfx):
// wind that rises with speed, the hiss of skis on snow (edge carve vs. sideways scrape), the
// spray of a hockey stop, landings, rail slides and crashes.
const NOISE_SEC = 2;
export class Audio {
  constructor() { this.ctx = null; this.buf = {}; }
  start() {
    if (this.ctx) { this.ctx.resume(); return; }
    const ctx = this.ctx = new (window.AudioContext || window.webkitAudioContext)();
    const n = ctx.createBuffer(1, ctx.sampleRate * NOISE_SEC, ctx.sampleRate), d = n.getChannelData(0);
    let b0 = 0, b1 = 0, b2 = 0;   // pinkish noise
    for (let i = 0; i < d.length; i++) { const w = Math.random() * 2 - 1; b0 = 0.99765 * b0 + w * 0.099; b1 = 0.963 * b1 + w * 0.2965; b2 = 0.57 * b2 + w * 1.0526; d[i] = (b0 + b1 + b2 + w * 0.1848) * 0.2; }
    const src = () => { const s = ctx.createBufferSource(); s.buffer = n; s.loop = true; s.start(0, Math.random() * NOISE_SEC); return s; };
    this.master = ctx.createGain(); this.master.gain.value = 0.8; this.master.connect(ctx.destination);
    const chain = (type, f, q) => { const s = src(), fl = ctx.createBiquadFilter(); fl.type = type; fl.frequency.value = f; fl.Q.value = q; const g = ctx.createGain(); g.gain.value = 0; s.connect(fl).connect(g).connect(this.master); return { f: fl, g }; };
    this.wind = chain('bandpass', 400, 0.6);
    this.windHi = chain('highpass', 2500, 0.5);
    this.carve = chain('bandpass', 1800, 0.9);
    this.scrape = chain('bandpass', 900, 0.7);
    this.amb = chain('lowpass', 300, 0.3); this.amb.g.gain.value = 0.05;
    const load = (k, u) => fetch(u).then((r) => r.arrayBuffer()).then((a) => ctx.decodeAudioData(a)).then((b) => { this.buf[k] = b; }).catch(() => {});
    ['impactSoft_heavy_000', 'impactSoft_heavy_001', 'impactSoft_heavy_002', 'impactMetal_light_000', 'impactMetal_medium_000', 'impactPlank_medium_000', 'grind_metal'].forEach((k) => load(k, `./assets/sfx/${k}.mp3`));
  }
  play(k, vol = 1, rate = 1) {
    const b = this.buf[k]; if (!b || !this.ctx) return null;
    const s = this.ctx.createBufferSource(); s.buffer = b; s.playbackRate.value = rate; const g = this.ctx.createGain(); g.gain.value = vol; s.connect(g).connect(this.master); s.start(); return { s, g };
  }
  update(dt, ph) {
    if (!this.ctx) return;
    const t = this.ctx.currentTime, sp = ph.speed, on = ph.state === 'ground', k = 0.06;
    const set = (p, v) => p.setTargetAtTime(v, t, k);
    set(this.wind.g.gain, Math.min(0.5, (sp / 22) ** 2 * 0.5)); set(this.wind.f.frequency, 250 + sp * 30);
    set(this.windHi.g.gain, Math.min(0.12, (sp / 25) ** 3 * 0.12));
    const skid = on ? ph.skid + (ph.brake || 0) * 0.8 : 0;
    set(this.carve.g.gain, on ? Math.min(0.35, sp / 18 * 0.3 * (0.4 + Math.abs(ph.edge || 0))) : 0); set(this.carve.f.frequency, 1200 + sp * 60);
    set(this.scrape.g.gain, on ? Math.min(0.6, skid * sp / 10 * 0.6) : 0); set(this.scrape.f.frequency, 600 + sp * 40);
    for (const e of ph.events) {
      if (e.type === 'land') this.play('impactSoft_heavy_00' + (Math.random() * 3 | 0), Math.min(1, 0.25 + e.impact / 10), 0.8 + Math.random() * 0.2);
      if (e.type === 'crash') { this.play('impactSoft_heavy_001', 1, 0.7); setTimeout(() => this.play('impactSoft_heavy_002', 0.7, 0.75), 180); }
      if (e.type === 'pop') this.play('impactSoft_heavy_000', 0.18, 1.6);
      if (e.type === 'polePlant') this.play('impactSoft_heavy_002', 0.12, 2.2);
      if (e.type === 'rail') { this.play(e.kind === 'rail' || e.kind === 'tube' ? 'impactMetal_medium_000' : 'impactPlank_medium_000', 0.6); this.grind = this.play('grind_metal', 0.0, e.kind === 'box' ? 0.6 : 1); if (this.grind) { this.grind.s.loop = true; this.grind.g.gain.setTargetAtTime(e.kind === 'box' ? 0.25 : 0.45, t, 0.05); } }
      if (e.type === 'railEnd' && this.grind) { this.grind.g.gain.setTargetAtTime(0, t, 0.05); const g = this.grind; setTimeout(() => g.s.stop(), 400); this.grind = null; }
      if (e.type === 'railSwap') this.play('impactMetal_light_000', 0.3, 1.2);
    }
  }
}
