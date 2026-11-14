// Bravo's synthetic scenarios (from bravo's compare.js, unchanged except: the wave
// scenario also moves v, like bravo's test.js) with three detectors: old detect() (b1dd5a9), alpha's v2
// detect() (dsp.js as of 066099f), and bravo's RobustDetector.
const R = require('../../web/robust.js');
let seed = 1;
const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
const gauss = () => { let u = 0; for (let i = 0; i < 6; i++) u += rnd(); return (u - 3) / Math.sqrt(0.5); };
const FPS = 60, DT = 1000 / FPS;
const bump = (t, t0, dur, peak) => (t < t0 || t > t0 + dur ? 0 : peak * 0.5 * (1 - Math.cos(2 * Math.PI * (t - t0) / dur)));

function frames(secs, evs, { jitter = 1, drift = 0, step = null } = {}) {
  const out = [];
  for (let i = 0; i < secs * FPS; i++) {
    const t = i * DT;
    let up = -45 + jitter * gauss() + drift * t / 1000, dn = -45 + jitter * gauss() + drift * t / 1000, noise = -95 + 0.8 * gauss(), v = 0;
    if (step && t > step.t) up += step.db;
    for (const e of evs) {
      const bu = bump(t, e.t, e.dur, e.up || 0), bd = bump(t, e.t, e.dur, e.dn || 0);
      up += bu; dn += bd; noise += bump(t, e.t, e.dur, e.noise || 0);
      if (bu > 1 || bd > 1) v += (e.v || 0);
      if (e.osc && t >= e.t && t <= e.t + e.dur) {
        const s = Math.sin(2 * Math.PI * e.osc * (t - e.t) / 1000);
        up += Math.max(0, s) * e.oscDb; dn += Math.max(0, -s) * e.oscDb; v += s * 1.0;
      }
    }
    out.push({ t, up, down: dn, noise, snr: 40, v });
  }
  return out;
}
const med = (a) => Float64Array.from(a).sort()[a.length >> 1];

function oldDetect(fr) {
  const cal = fr.slice(0, 90);
  const base = { up: med(cal.map((f) => f.up)), down: med(cal.map((f) => f.down)) };
  let cand = null, n = 0, last = -1e9; const got = [];
  for (const f of fr.slice(90)) {
    const dUp = f.up - base.up, dDn = f.down - base.down;
    let c = null;
    if (dUp > 6 && dUp - dDn > 3) c = 'push'; else if (dDn > 6 && dDn - dUp > 3) c = 'pull';
    if (c && c === cand) n++; else { cand = c; n = c ? 1 : 0; }
    if (c && n >= 2 && f.t - last > 450) { last = f.t; got.push(c); }
    if (!c) { base.up += (f.up - base.up) * 0.01; base.down += (f.down - base.down) * 0.01; }
  }
  return got;
}

// port of alpha's dsp.js v2 detect() (mono): autoK x wobble threshold, far-band rise subtraction,
// wave = 4 v-sign flips in 1 s, hold push/pull during fast flips, drift + wobble adaptation when idle
function v2Detect(fr) {
  const cal = fr.slice(18, 90);
  const calU = cal.map((f) => f.up), calD = cal.map((f) => f.down);
  const base = { up: med(calU), down: med(calD) };
  const mad = (xs, m) => med(xs.map((x) => Math.abs(x - m))) * 1.4826;
  const wob = { up: Math.max(0.5, mad(calU, base.up)), down: Math.max(0.5, mad(calD, base.down)) };
  const noiseBase = med(cal.map((f) => f.noise));
  let cand = null, n = 0, lastFire = -1e9, flips = [], lastSign = 0, lastWave = -1e9;
  const got = [];
  for (const f of fr.slice(90)) {
    const now = f.t, rise = Math.max(0, f.noise - noiseBase);
    const dUp = f.up - base.up - rise, dDown = f.down - base.down - rise;
    const th = { up: Math.max(6, 4 * wob.up), down: Math.max(6, 4 * wob.down) };
    const moving = dUp > th.up * 0.6 || dDown > th.down * 0.6;
    const sign = moving && Math.abs(f.v) > 0.12 ? Math.sign(f.v) : 0;
    if (sign && lastSign && sign !== lastSign) flips.push(now);
    if (sign) lastSign = sign;
    flips = flips.filter((t) => now - t < 1000);
    if (flips.length >= 4 && now - lastWave > 1200) { lastWave = now; lastFire = now; flips = []; cand = null; n = 0; got.push('wave'); continue; }
    if (flips.filter((t) => now - t < 350).length >= 2) { cand = null; n = 0; continue; }
    let c = null;
    if (dUp > th.up && dUp - dDown > 3) c = 'push'; else if (dDown > th.down && dDown - dUp > 3) c = 'pull';
    if (c && c === cand) n++; else { cand = c; n = c ? 1 : 0; }
    if (c && n >= 2 && now - lastFire > 450) { lastFire = now; got.push(c); }
    if (!c && !moving) {
      base.up += (f.up - base.up) * 0.01; base.down += (f.down - base.down) * 0.01;
      wob.up = Math.max(0.5, wob.up * 0.995 + Math.abs(dUp) * 1.25 * 0.005);
      wob.down = Math.max(0.5, wob.down * 0.995 + Math.abs(dDown) * 1.25 * 0.005);
    }
  }
  return got;
}

function robust(fr) {
  const d = new R.RobustDetector(); fr.slice(0, 90).forEach((f) => d.learn(f));
  const got = []; for (const f of fr.slice(90)) { const g = d.update(f); if (g) got.push(g.kind); } return got;
}

const T = 2000;
const S = [
  ['push, slow return', () => frames(5, [{ t: T, dur: 300, up: 16, v: 0.7 }, { t: T + 350, dur: 700, dn: 4, v: -0.2 }]), ['push']],
  ['push, fast return', () => frames(5, [{ t: T, dur: 300, up: 16, v: 0.7 }, { t: T + 420, dur: 300, dn: 10, v: -0.5 }]), ['push']],
  ['pull', () => frames(5, [{ t: T, dur: 300, dn: 15, v: -0.7 }]), ['pull']],
  ['5 pushes', () => frames(13, [0, 1, 2, 3, 4].map((i) => ({ t: T + 2000 * i, dur: 300, up: 14, v: 0.6 }))), ['push', 'push', 'push', 'push', 'push']],
  ['clap', () => frames(5, [{ t: T, dur: 60, up: 22, dn: 20, noise: 25 }]), []],
  ['lopsided clap', () => frames(5, [{ t: T, dur: 80, up: 25, dn: 8, noise: 22 }]), []],
  ['3 s chatter', () => frames(7, [{ t: T, dur: 3000, up: 4, dn: 4, noise: 10 }]), []],
  ['push in loud music', () => frames(10, [{ t: T, dur: 8000, noise: 12, up: 3, dn: 3 }, { t: T + 4000, dur: 300, up: 16, v: 0.7 }]), ['push']],
  ['walker 1.5 m (+5 dB, 2.5 s)', () => frames(6, [{ t: T, dur: 2500, up: 5, v: 1.2 }]), []],
  ['drift +0.2 dB/s', () => frames(22, [], { drift: 0.2 }), []],
  ['noisy laptop (3 dB), idle 20 s', () => frames(20, [], { jitter: 3 }), []],
  ['noisy laptop, push', () => frames(6, [{ t: T, dur: 300, up: 20, v: 0.7 }], { jitter: 3 }), ['push']],
  ['wave 4 Hz 1.2 s', () => frames(5, [{ t: T, dur: 1200, osc: 4, oscDb: 14 }]), 'wave'],
  ['step +10 dB, pull at 10 s', () => frames(14, [{ t: 10000, dur: 300, dn: 15, v: -0.7 }], { step: { t: T, db: 10 } }), 'pull-after-step'],
];
const N = Number(process.argv[2] || 200);
console.log(`scenario                               old      v2       robust   (pass rate, ${N} seeds)`);
const tot = { o: 0, v: 0, r: 0 };
for (const [name, gen, exp] of S) {
  const p = { o: 0, v: 0, r: 0 };
  for (let s = 1; s <= N; s++) {
    seed = s * 7919; const fr = gen();
    const ok = (got, waveAware) => {
      if (exp === 'wave') return waveAware ? (got.filter((k) => k !== 'wave').length <= 1 && got.includes('wave')) : got.length <= 1;
      if (exp === 'pull-after-step') return got.includes('pull');
      return JSON.stringify(got) === JSON.stringify(exp);
    };
    p.o += ok(oldDetect(fr), false); p.v += ok(v2Detect(fr), true); p.r += ok(robust(fr), true);
  }
  tot.o += p.o; tot.v += p.v; tot.r += p.r;
  const pc = (x) => `${(100 * x / N).toFixed(0).padStart(5)}%`;
  console.log(`${name.padEnd(38)} ${pc(p.o)}   ${pc(p.v)}   ${pc(p.r)}`);
}
const pt = (x) => `${(100 * x / (N * S.length)).toFixed(1).padStart(5)}%`;
console.log(`${'ALL'.padEnd(38)} ${pt(tot.o)}   ${pt(tot.v)}   ${pt(tot.r)}`);
