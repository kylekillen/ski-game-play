// The words on screen: score, trick names, lines, the settings menu (Start / Esc).
import { TWEAKS as T, PRESETS, saveTweaks, resetTweaks } from './tweaks.js';

const $ = (id) => document.getElementById(id);

export class Hud {
  constructor() {
    this.trickT = 0; this.lineT = 0; this.toastT = 0; this.liveName = '';
  }
  live(name) {
    if (this.resultT > 0) return;
    if (name === this.liveName) return; this.liveName = name;
    const el = $('trick'); el.textContent = name; el.className = 'hud ' + (name ? 'live' : 'off'); $('trickpts').className = 'hud off';
  }
  result({ name, pts, clean, perfect, bad, combo }) {
    this.liveName = '';
    const el = $('trick'); el.textContent = name; el.className = 'hud ' + (bad ? 'bad' : 'ok');
    const p = $('trickpts'); p.textContent = bad ? '' : `${perfect ? 'perfect · ' : clean ? 'clean · ' : 'sketchy · '}+${pts.toLocaleString()}`; p.className = 'hud ' + (bad ? 'off' : clean ? 'ok' : 'sketchy');
    this.resultT = 2.4;
    if (combo > 1) { const l = $('line'); l.innerHTML = `Line ×${combo}<small>keep it going</small>`; l.className = 'hud'; this.lineT = 5; }
  }
  lineDone({ n, total, lost }) {
    const l = $('line');
    l.innerHTML = lost ? `Line lost<small>${n} trick${n > 1 ? 's' : ''}</small>` : `+${total.toLocaleString()}<small>${n}-trick line</small>`;
    l.className = 'hud'; this.lineT = 3;
  }
  toast(text, t = 2) { const el = $('toast'); el.textContent = text; el.className = 'hud'; this.toastT = t; }
  update(dt, ph, tricks, padName) {
    if ((this.resultT -= dt) <= 0 && this.resultT > -1) { this.resultT = -9; if (!this.liveName) { $('trick').className = 'hud off'; $('trickpts').className = 'hud off'; } }
    if (this.lineT > 0 && (this.lineT -= dt) <= 0) $('line').className = 'hud off';
    if (this.toastT > 0 && (this.toastT -= dt) <= 0) $('toast').className = 'hud off';
    $('score').textContent = tricks.score.toLocaleString();
    $('best').textContent = tricks.best ? `best line ${tricks.best.toLocaleString()}` : '';
    $('speed').innerHTML = `${Math.round(ph.speed * 3.6)}<small>KM/H</small>`;
    const pad = $('pad'); pad.className = 'hud' + (padName ? ' on' : ''); pad.textContent = padName ? 'Controller' : 'No controller — press any button on it';
    // wind-up meter: shows the spin you have loaded
    const w = $('wind'), wv = ph.windup || 0;
    if (Math.abs(wv) > 0.05 && ph.state !== 'air') { w.className = ''; const i = w.firstChild; i.style.left = wv < 0 ? `${50 + wv * 50}%` : '50%'; i.style.width = `${Math.abs(wv) * 50}%`; }
    else w.className = 'off';
  }
}

// ── settings ──
const ROWS = [
  { h: 'Difficulty' },
  { k: 'difficulty', seg: ['easy', 'normal', 'hard'], note: 'Easy: strong landing help and speed checks. Hard: none, like the real thing.' },
  { h: 'Physics' },
  { k: 'gravity', name: 'Gravity', min: 7, max: 14, step: 0.1 },
  { k: 'spinMax', name: 'Spin speed', min: 4, max: 11, step: 0.1 },
  { k: 'flipMax', name: 'Flip speed', min: 3, max: 8, step: 0.1 },
  { k: 'popMax', name: 'Pop height', min: 2.5, max: 6.5, step: 0.1 },
  { k: 'landAssist', name: 'Landing assist', min: 0, max: 1, step: 0.05 },
  { k: 'stabilizer', name: 'Stabilizer', min: 0, max: 1.5, step: 0.05 },
  { k: 'speedHelp', name: 'Jump speed help', min: 0, max: 1, step: 0.05 },
  { k: 'edgeGrip', name: 'Edge grip', min: 5, max: 25, step: 0.5 },
  { k: 'butterRate', name: 'Butter spin', min: 1, max: 6, step: 0.1 },
  { k: 'railMagnet', name: 'Rail magnet', min: 0.1, max: 0.7, step: 0.01 },
  { k: 'railTurn', name: 'Rail turn speed', min: 3, max: 12, step: 0.1 },
  { h: 'Camera & picture' },
  { k: 'camDist', name: 'Camera distance', min: 2.5, max: 9, step: 0.1 },
  { k: 'camHeight', name: 'Camera height', min: 0.6, max: 4, step: 0.05 },
  { k: 'camFov', name: 'Field of view', min: 50, max: 95, step: 1 },
  { k: 'exposure', name: 'Brightness', min: 0.3, max: 1.2, step: 0.01 },
  { k: 'motionBlur', name: 'Motion blur', min: 0, max: 1.5, step: 0.05 },
  { k: 'graphicsQuality', seg: ['low', 'medium', 'high'], note: 'Picture quality takes effect after a refresh.' },
  { h: '' },
  { k: 'reset', button: 'Reset everything to default' },
];

export class Menu {
  constructor() { this.el = $('menu'); this.open = false; this.sel = 1; this.build(); }
  build() {
    const el = this.el; el.innerHTML = '<h2>Settings</h2>';
    this.rows = [];
    for (const r of ROWS) {
      if (r.h !== undefined) { const h = document.createElement('h3'); h.textContent = r.h; el.appendChild(h); continue; }
      const row = document.createElement('div'); row.className = 'row'; el.appendChild(row); this.rows.push({ r, row });
      if (r.seg) {
        row.style.gridTemplateColumns = '1fr'; const seg = document.createElement('div'); seg.className = 'seg'; row.appendChild(seg);
        for (const v of r.seg) { const b = document.createElement('button'); b.textContent = v; b.onclick = () => this.set(r, v); seg.appendChild(b); }
        if (r.note) { const n = document.createElement('div'); n.className = 'note'; n.textContent = r.note; el.appendChild(n); }
      } else if (r.button) {
        row.style.gridTemplateColumns = '1fr'; const b = document.createElement('div'); b.className = 'seg'; b.innerHTML = `<button>${r.button}</button>`; b.firstChild.onclick = () => this.reset(); row.appendChild(b);
      } else {
        row.innerHTML = `<span>${r.name}</span><input type="range" min="${r.min}" max="${r.max}" step="${r.step}"><span></span>`;
        row.children[1].oninput = (e) => this.set(r, +e.target.value);
      }
    }
    this.refresh();
  }
  refresh() {
    this.rows.forEach(({ r, row }, i) => {
      row.classList.toggle('sel', i === this.sel);
      if (r.seg) [...row.querySelectorAll('button')].forEach((b) => b.classList.toggle('on', b.textContent === T[r.k]));
      else if (!r.button) { row.children[1].value = T[r.k]; row.children[2].textContent = (+T[r.k]).toFixed(r.step < 0.1 ? 2 : r.step < 1 ? 1 : 0); }
    });
  }
  set(r, v) {
    T[r.k] = v; const keys = [r.k];
    if (r.k === 'difficulty') { Object.assign(T, PRESETS[v]); keys.push(...Object.keys(PRESETS[v])); }
    saveTweaks(keys); this.refresh();
  }
  reset() { resetTweaks(); location.reload(); }
  toggle(on = !this.open) { this.open = on; this.el.classList.toggle('off', !on); this.refresh(); }
  // controller: up/down pick a row, left/right change it
  nav(dir, delta) {
    if (dir) { this.sel = (this.sel + dir + this.rows.length) % this.rows.length; this.refresh(); this.rows[this.sel].row.scrollIntoView({ block: 'nearest' }); }
    if (delta) {
      const { r } = this.rows[this.sel];
      if (r.seg) { const i = r.seg.indexOf(T[r.k]); this.set(r, r.seg[Math.max(0, Math.min(r.seg.length - 1, i + delta))]); }
      else if (!r.button) this.set(r, +Math.max(r.min, Math.min(r.max, T[r.k] + delta * r.step * (r.max - r.min > 3 ? 2 : 1))).toFixed(3));
    }
  }
  press() { const { r } = this.rows[this.sel]; if (r.button) this.reset(); }
}
